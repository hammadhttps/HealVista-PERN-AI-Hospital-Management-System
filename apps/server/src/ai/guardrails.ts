import { z } from "zod";
import { AppError } from "../utils/AppError.js";
import { logger } from "../utils/logger.js";
import { AiProviderError, type AIProvider, type GenerationImage } from "./ai.provider.js";
import { findDiagnosticLanguageIn } from "./diagnosticLanguage.js";

/**
 * The shared guardrail system prompt, prepended to **every** generation in the
 * project. Features may add feature-specific instructions on top, never remove
 * these rules (ai-rag.md §6).
 */
export const GUARDRAIL_SYSTEM_PROMPT = `You are MediCore's clinical assistant. Your output supports hospital staff and patients, and the following rules are absolute:

1. NEVER diagnose. You may suggest a specialty or department to see, and you may explain what a test or note says — but you must never name a condition as a fact.
2. NEVER contradict a doctor's note. If the information given conflicts with the question's premise, say so rather than resolving it.
3. NEVER give general medical advice unrelated to the records or context provided. Stay in scope.
4. If the information provided does not cover the question, say "I don't know" — never fill the gap from your own knowledge.
5. Emergency symptoms are never handled here — refer to emergency services immediately.
6. Your output is assistive. A clinician reviews everything you generate before it becomes part of a record.
7. Be concise and patient-safe. Use plain language for patients, precise terminology for staff.`;

/**
 * A typed error meaning "the AI layer is not available / produced unusable
 * output". Every caller treats this as the signal to run its non-AI fallback.
 */
export class AiGenerationError extends AppError {
  constructor(message: string, statusCode = 502) {
    super(message, statusCode);
    this.name = "AiGenerationError";
    // AppError sets the prototype to its own; restore the subclass chain so
    // `instanceof AiGenerationError` works (it is how callers pick their fallback).
    Object.setPrototypeOf(this, AiGenerationError.prototype);
  }
}

export interface GenerateValidatedOptions<T> {
  /** Human-readable feature name for the interaction log, e.g. "symptom-match". */
  feature: string;
  prompt: string;
  schema: z.ZodType<T>;
  system?: string;
  maxTokens?: number;
  /** Inline base64 images for the vision path (OCR). */
  images?: GenerationImage[];
  /** Retries on transient failure and malformed output. Default 1. */
  retries?: number;
  /**
   * A deterministic post-check on the parsed output. Return a description of the
   * problem to reject it (it is retried once with that description, then the
   * caller's fallback runs), or null to accept it. See `noDiagnosis`.
   */
  check?: (output: T) => string | null;
}

/** Thrown when output parses but fails a deterministic guardrail check. */
class GuardrailViolation extends Error {
  constructor(readonly problem: string) {
    super(problem);
    this.name = "GuardrailViolation";
  }
}

/**
 * The guardrail-#1 check: rejects output that names or implies a condition. Used
 * on everything a patient reads and on clinical drafts; not on surfaces that quote
 * a doctor's own note back to that doctor, or on the knowledge base.
 */
export function noDiagnosis(output: unknown): string | null {
  const hit = findDiagnosticLanguageIn(output);
  return hit
    ? `It names or implies a medical condition ("${hit}"). Describe what the information shows and what happens next without naming or suggesting any condition.`
    : null;
}

/**
 * The doctor-facing variant: the AI may restate a condition the treating clinician
 * already recorded (`clinicianText`), but may not introduce one. A follow-up
 * recommendation that says "for the viral URTI noted in the assessment" is quoting
 * the doctor; one that offers "possible meniscus tear" from a complaint is not.
 */
export function noNewDiagnosis(clinicianText: string): (output: unknown) => string | null {
  return (output) => {
    const hit = findDiagnosticLanguageIn(output, { clinicianText });
    return hit
      ? `It suggests a condition the clinician has not recorded ("${hit}"). Only restate conditions written in the provided note; never propose new ones.`
      : null;
  };
}

/**
 * The only entry point feature services use to generate.
 *
 * - Passes the Zod schema to the model as its `responseSchema` (a hint).
 * - **Zod-validates the result** — a hint is not a guarantee, so a malformed
 *   payload is caught here, retried once, and only then surfaced as
 *   `AiGenerationError` so the caller's fallback runs.
 */
export async function generateValidated<T>(
  provider: AIProvider,
  opts: GenerateValidatedOptions<T>,
): Promise<T> {
  const retries = opts.retries ?? 1;
  let lastError: unknown;
  let prompt = opts.prompt;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await provider.generate({
        prompt,
        schema: opts.schema,
        system: opts.system
          ? `${GUARDRAIL_SYSTEM_PROMPT}\n\n${opts.system}`
          : GUARDRAIL_SYSTEM_PROMPT,
        maxTokens: opts.maxTokens,
        images: opts.images,
      });
      const parsed = opts.schema.parse(raw);
      const problem = opts.check?.(parsed) ?? null;
      if (problem) throw new GuardrailViolation(problem);
      return parsed;
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) break;
      // A repeat of the identical prompt returns the identical mistake. Tell the
      // model what was wrong so the retry has a chance of differing.
      if (err instanceof z.ZodError) prompt = `${opts.prompt}\n\n${repairNote(err)}`;
      if (err instanceof GuardrailViolation) {
        prompt = `${opts.prompt}\n\nYour previous reply was rejected: ${err.problem}`;
      }
      // Small models drop a bracket or a quote in longer replies; say so, and ask
      // for a shorter one, which is where that mistake happens least.
      if (err instanceof AiProviderError && /unparseable/i.test(err.message)) {
        prompt = `${opts.prompt}\n\nYour previous reply was not valid JSON (a bracket, quote or comma was missing). Reply again with one complete, valid JSON object, and keep every list short.`;
      }
    }
  }

  const failure = toAiError(lastError);
  // Every fallback is logged. A provider outage used to look exactly like normal
  // operation — each feature quietly served its fallback and nothing anywhere said so.
  logger.warn(
    {
      feature: opts.feature,
      status: failure.statusCode,
      reason: failure.message,
      issues:
        lastError instanceof z.ZodError
          ? lastError.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`)
          : undefined,
    },
    "AI generation failed — serving the non-AI fallback",
  );
  throw failure;
}

/**
 * Whether another attempt could succeed. Malformed output and transient provider
 * failures can; an unconfigured provider (503), a safety decline (422) and a request
 * the provider rejects as invalid cannot, and retrying them only delays the fallback.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof z.ZodError || err instanceof GuardrailViolation) return true;
  if (err instanceof AiProviderError) return err.retryable;
  if (err instanceof AppError) return err.statusCode !== 503 && err.statusCode !== 422;
  return true;
}

function repairNote(err: z.ZodError): string {
  const problems = err.issues
    .slice(0, 5)
    .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  return `Your previous reply was rejected because it did not match the required JSON:\n${problems}\nReturn the corrected JSON object only, using exactly the keys in the example.`;
}

function toAiError(err: unknown): AiGenerationError {
  if (err instanceof AiGenerationError) return err;
  if (err instanceof AppError && err.statusCode) {
    return new AiGenerationError(err.message, err.statusCode);
  }
  if (err instanceof z.ZodError) {
    return new AiGenerationError("The AI output did not match the expected structure");
  }
  if (err instanceof GuardrailViolation) {
    return new AiGenerationError(`The AI output failed a safety check: ${err.problem}`);
  }
  return new AiGenerationError(err instanceof Error ? err.message : "AI generation failed", 502);
}
