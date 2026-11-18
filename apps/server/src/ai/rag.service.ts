import { z } from "zod";
import { prisma } from "../config/db.js";
import { AppError } from "../utils/AppError.js";
import {
  keywordRetrieve,
  resolveRetrievalScope,
  retrieveWithFallback,
  type RetrievalScope,
  type RetrievedChunk,
} from "./retrieval.js";
import { getProvider, isAiConfigured } from "./index.js";
import { generateValidated, AiGenerationError, noDiagnosis } from "./guardrails.js";
import { stripPII } from "./pii.js";
import { logInteraction } from "./aiInteraction.service.js";
import { answerCacheKey, getCachedAnswer, setCachedAnswer } from "./answerCache.js";
import { assertClinicalAccess, type Actor } from "../services/access.service.js";

/**
 * RAG features (Phase 5.5) — retrieval-backed answers over a patient's records.
 *
 * Every path here follows the pipeline in ai-rag.md §3:
 *   scope resolved first → pgvector search filtered by that scope → assemble
 *   prompt from the retrieved chunks → the model generates → Zod-validates → answer
 *   with citations. `retrieve` puts the scope in the SQL WHERE clause, so the
 *   vector search never even sees unauthorised rows.
 *
 * The `fallback` flag means "the model was not available". It never means "no
 * relevant records" — that is a designed, non-fallback answer per guardrail #5.
 */

export interface Citation {
  sourceType: string;
  sourceId: string;
  patientId: string | null;
  similarity: number;
}

export interface AssistantResult {
  answer: string;
  citations: Citation[];
  fallback: boolean;
}

/** One citation per source record, ranked by similarity. */
function buildCitations(chunks: RetrievedChunk[]): Citation[] {
  const bestBySource = new Map<string, RetrievedChunk>();
  for (const chunk of chunks) {
    const existing = bestBySource.get(chunk.sourceId);
    if (!existing || chunk.similarity > existing.similarity)
      bestBySource.set(chunk.sourceId, chunk);
  }
  return [...bestBySource.values()]
    .sort((a, b) => b.similarity - a.similarity)
    .map((c) => ({
      sourceType: c.sourceType,
      sourceId: c.sourceId,
      patientId: c.patientId,
      similarity: c.similarity,
    }));
}

const assistantOutputSchema = z.object({
  answer: z.string().min(1).max(4000),
});

const FLAG_RE = /\[(HIGH|LOW|CRITICAL|ABNORMAL)\]/gi;
const ALL_NORMAL_RE =
  /\b(?:all|everything|every (?:result|value|test))\b[^.]{0,60}\b(?:normal|fine|healthy|unremarkable)\b|\bno (?:abnormal\w*|concerning (?:results?|values?)|flags?)\b/i;

/**
 * Rejects an answer that misstates the flags in the excerpts it was given.
 *
 * In testing the doctor assistant answered "the recent lab abnormalities are all
 * within normal ranges" over an excerpt marked [CRITICAL]. A summary that drops or
 * contradicts a flag is worse than no summary, so: never call flagged results
 * normal, and (when `mustSurfaceCritical`) never leave a CRITICAL result out.
 */
export function flagConsistencyProblem(
  answer: string,
  chunks: RetrievedChunk[],
  mustSurfaceCritical: boolean,
): string | null {
  const flags = new Set(
    chunks.flatMap((c) => [...c.content.matchAll(FLAG_RE)].map((m) => m[1].toUpperCase())),
  );
  if (flags.size === 0) return null;
  if (ALL_NORMAL_RE.test(answer)) {
    return `It describes the results as normal, but the excerpts flag some as ${[...flags].join(", ")}. Report each flag exactly as the excerpt states it.`;
  }
  if (mustSurfaceCritical && flags.has("CRITICAL") && !/critical/i.test(answer)) {
    return "It leaves out a result the excerpts flag as CRITICAL. Every CRITICAL result must be mentioned.";
  }
  return null;
}

/**
 * Lines the records themselves flag CRITICAL, listed ahead of a generated summary.
 *
 * Asked to "mention every CRITICAL result", the model still left them out. A
 * summary of someone's history that omits a critical value is worse than none, so
 * the critical lines are copied from the records verbatim — never generated.
 */
export function withCriticalPreamble(summary: string, chunks: RetrievedChunk[]): string {
  const critical = [
    ...new Set(
      chunks.flatMap((c) =>
        c.content
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /\[CRITICAL\]/i.test(line)),
      ),
    ),
  ];
  if (critical.length === 0) return summary;
  const list = critical.map((line) => `• ${line}`).join("\n");
  return `Flagged CRITICAL in the records:\n${list}\n\n${summary}`;
}

/** The checks an assistant answer must pass, by audience. */
function answerChecks(
  actor: Actor,
  chunks: RetrievedChunk[],
  mustSurfaceCritical: boolean,
): (text: string) => string | null {
  return (text) =>
    flagConsistencyProblem(text, chunks, mustSurfaceCritical) ??
    // A patient reads the answer as advice; a doctor reading their own notes back
    // is reading diagnoses that a clinician wrote, which are not the AI's to censor.
    (actor.role === "PATIENT" ? noDiagnosis(text) : null);
}

const NO_RESULTS_ANSWER =
  "I couldn't find anything in the records that covers this. If you think a record should exist, ask your care team.";

async function buildAssistantAnswer(
  question: string,
  scope: RetrievalScope,
  actor: Actor,
  feature: string,
): Promise<AssistantResult> {
  const { chunks, degraded } = await retrieveWithFallback(question, scope, {
    k: 8,
    minSimilarity: 0.3,
    actor,
    feature,
  });

  if (chunks.length === 0) {
    await logInteraction({ userId: actor.userId, feature, question, wasFallback: degraded });
    return { answer: NO_RESULTS_ANSWER, citations: [], fallback: degraded };
  }

  const citations = buildCitations(chunks);
  // Present the excerpts in document order (source, then chunk position) so the
  // model reads each record as a coherent passage instead of similarity-ordered
  // fragments. Citations keep their similarity ranking for the UI.
  const context = chunks
    .slice()
    .sort((a, b) => (a.sourceId === b.sourceId ? a.chunkIndex - b.chunkIndex : 0))
    .map((c) => `[${c.sourceType} ${c.sourceId}]\n${c.content}`)
    .join("\n\n");

  try {
    const result = await generateValidated(getProvider(), {
      feature,
      prompt: `Question from the user:\n"${stripPII(question)}"\n\nRelevant record excerpts:\n${context}`,
      schema: assistantOutputSchema,
      system:
        "Answer the question using ONLY the record excerpts provided. If the excerpts do not answer it, say so. Report any [HIGH], [LOW] or [CRITICAL] flag exactly as written — never describe a flagged value as normal. Cite the records you used by their [source] markers. Do not give general medical advice beyond the records. Answer in the same language the user asked in. Prefer short paragraphs and bullet points.",
      maxTokens: 700,
      check: (out) => answerChecks(actor, chunks, false)(out.answer),
    });

    const usage = getProvider().lastUsage();
    await logInteraction({
      userId: actor.userId,
      feature,
      question,
      responseRef: result.answer,
      citedChunks: chunks.map((c) => c.id),
      latencyMs: usage.latencyMs,
      tokensUsed: usage.tokensUsed,
      wasFallback: degraded,
    });

    return { answer: result.answer, citations, fallback: degraded };
  } catch (err) {
    if (!(err instanceof AiGenerationError)) throw err;
    await logInteraction({ userId: actor.userId, feature, question, wasFallback: true });
    // Non-AI fallback: surface the retrieved excerpts verbatim rather than nothing.
    const answer = chunks
      .slice(0, 3)
      .map((c) => `From a ${c.sourceType.replace("_", " ")}:\n${c.content.slice(0, 300)}`)
      .join("\n\n");
    return { answer, citations, fallback: true };
  }
}

async function runAssistant(
  question: string,
  actor: Actor,
  scope: RetrievalScope,
  feature: string,
): Promise<AssistantResult> {
  const cacheKey = answerCacheKey(
    feature,
    question.trim().toLowerCase(),
    scope.patientIds.slice().sort().join(","),
  );
  const cached = await getCachedAnswer<AssistantResult>(cacheKey);
  if (cached) return cached;

  // People type their own (or their child's) name into questions. The question is
  // embedded and sent to the provider, so the names of everyone in scope are
  // redacted first — not just the ones a word list happens to know.
  const patients = await prisma.patient.findMany({
    where: { id: { in: scope.patientIds.slice(0, 20) } },
    select: { fullName: true },
  });
  const safeQuestion = stripPII(question, { knownNames: patients.map((p) => p.fullName) });

  // No early "AI unavailable" return: without a key, retrieval falls back to a
  // keyword search and generation to the excerpts themselves, so the caller still
  // gets the matching records.
  const result = await buildAssistantAnswer(safeQuestion, scope, actor, feature);
  if (!result.fallback) await setCachedAnswer(cacheKey, result);
  return result;
}

/**
 * The patient/doctor assistant. A patient's scope is themselves plus dependants;
 * a doctor must name the patient and the service verifies them against the
 * doctor's retrieval scope first.
 */
export async function assistant(
  question: string,
  actor: Actor,
  patientId?: string,
): Promise<AssistantResult> {
  if (actor.role === "PATIENT") {
    const scope = await resolveRetrievalScope(actor);
    if (scope.patientIds.length === 0) throw new AppError("Patient record not found", 404);
    let target = scope.patientIds;
    if (patientId) {
      if (!target.includes(patientId)) {
        throw new AppError("Not authorised to access this patient's records", 403);
      }
      target = [patientId];
    }
    return runAssistant(question, actor, { patientIds: target }, "patient-assistant");
  }

  if (actor.role === "DOCTOR") {
    if (!patientId) throw new AppError("Specify the patient you are asking about", 400);
    const scope = await resolveRetrievalScope(actor);
    if (!scope.patientIds.includes(patientId)) {
      throw new AppError("Not authorised to access this patient's records", 403);
    }
    return runAssistant(question, actor, { patientIds: [patientId] }, "doctor-assistant");
  }

  // Pharmacists and lab technicians get *contextual* clinical access in the
  // access model — a pharmacist while a prescription is waiting to dispense, a lab
  // technician while a lab order exists. Route their AI through that same gate so
  // it reads exactly the patients the rest of the app lets them read. Receptionist
  // and accountant stay excluded (`NON_CLINICAL_ROLES`) and admin stays KB-only by
  // the retrieval design — they all still throw 403 here via assertClinicalAccess.
  if (actor.role === "PHARMACIST" || actor.role === "LAB_TECHNICIAN") {
    if (!patientId) throw new AppError("Specify the patient you are asking about", 400);
    await assertClinicalAccess(patientId, actor);
    return runAssistant(
      question,
      actor,
      { patientIds: [patientId] },
      `${actor.role.toLowerCase()}-assistant`,
    );
  }

  throw new AppError("Only patients and doctors can use the assistant", 403);
}

const timelineOutputSchema = z.object({
  summary: z.string().min(1).max(4000),
});

export interface TimelineSummaryResult {
  summary: string;
  citations: Citation[];
  fallback: boolean;
}

/** Throws 403 unless `patientId` is inside the caller's retrieval scope. */
async function assertPatientInScope(patientId: string, actor: Actor): Promise<void> {
  const scope = await resolveRetrievalScope(actor);
  if (!scope.patientIds.includes(patientId)) {
    throw new AppError("Not authorised to access this patient's records", 403);
  }
}

/**
 * Timeline summary — patient (own history) or doctor (named patient). Retrieves
 * the most relevant chunks across the history rather than loading it all, then
 * summarises chronologically.
 */
export async function timelineSummary(
  patientId: string,
  actor: Actor,
): Promise<TimelineSummaryResult> {
  await assertPatientInScope(patientId, actor);

  const feature = "timeline-summary";
  // Audience is part of the key: the patient's summary passes the no-diagnosis
  // check, the clinician's does not, so they are not interchangeable.
  const cacheKey = answerCacheKey(
    feature,
    patientId,
    actor.role === "PATIENT" ? "patient" : "clinician",
  );
  const cached = await getCachedAnswer<TimelineSummaryResult>(cacheKey);
  if (cached) return cached;

  if (!isAiConfigured()) {
    return {
      summary: "The timeline assistant is not available right now.",
      citations: [],
      fallback: true,
    };
  }

  const question =
    "Summarise this patient's recent medical history: what happened across their visits, prescriptions, lab results, and reports, in order.";
  const { chunks, degraded } = await retrieveWithFallback(
    question,
    { patientIds: [patientId] },
    { k: 10, minSimilarity: 0.28, actor, feature },
  );

  if (chunks.length === 0) {
    await logInteraction({ userId: actor.userId, feature, question, wasFallback: degraded });
    return {
      summary: "No clinical records found for this patient yet.",
      citations: [],
      fallback: degraded,
    };
  }

  const citations = buildCitations(chunks);
  const context = chunks
    .slice()
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((c) => `[${c.sourceType} ${c.sourceId}]\n${c.content}`)
    .join("\n\n");

  try {
    const result = await generateValidated(getProvider(), {
      feature,
      prompt: `Relevant record excerpts for one patient:\n${context}\n\nProduce a concise chronological summary of the patient's recent history. If a topic is not covered by the excerpts, do not invent it.`,
      schema: timelineOutputSchema,
      system:
        "Summarise ONLY what the excerpts contain. Do not diagnose and do not recommend actions the records do not state. Mention every [CRITICAL] result and report every flag exactly as written. Note gaps rather than filling them. Answer in the same language the user asked in. Prefer short paragraphs and bullet points.",
      maxTokens: 700,
      check: (out) => answerChecks(actor, chunks, false)(out.summary),
    });

    const usage = getProvider().lastUsage();
    await logInteraction({
      userId: actor.userId,
      feature,
      question,
      responseRef: result.summary,
      citedChunks: chunks.map((c) => c.id),
      latencyMs: usage.latencyMs,
      tokensUsed: usage.tokensUsed,
      wasFallback: degraded,
    });

    const out: TimelineSummaryResult = {
      summary: withCriticalPreamble(result.summary, chunks),
      citations,
      fallback: degraded,
    };
    if (!degraded) await setCachedAnswer(cacheKey, out);
    return out;
  } catch (err) {
    if (!(err instanceof AiGenerationError)) throw err;
    await logInteraction({ userId: actor.userId, feature, question, wasFallback: true });
    const summary = chunks
      .slice(0, 3)
      .map((c) => `From a ${c.sourceType.replace("_", " ")}:\n${c.content.slice(0, 300)}`)
      .join("\n\n");
    return { summary, citations, fallback: true };
  }
}

export interface SearchHit {
  id: string;
  sourceType: string;
  sourceId: string;
  patientId: string | null;
  content: string;
  chunkIndex: number;
  similarity: number;
}

/**
 * Semantic record search — doctor-facing, retrieval only (no generation). Returns
 * the matching chunks with their citations so the doctor opens the source record.
 */
export async function semanticSearch(
  query: string,
  patientId: string,
  actor: Actor,
  k = 8,
): Promise<{ results: SearchHit[]; fallback: boolean }> {
  await assertPatientInScope(patientId, actor);

  const scope = { patientIds: [patientId] };
  const opts = { k, minSimilarity: 0.35, actor, feature: "semantic-search" };
  // Unconfigured or failing embeddings degrade to a scoped keyword search — the
  // doctor still gets matches, never an empty page or a 502.
  const { chunks, degraded } = isAiConfigured()
    ? await retrieveWithFallback(query, scope, opts)
    : { chunks: await keywordRetrieve(query, scope, opts), degraded: true };

  await logInteraction({
    userId: actor.userId,
    feature: "semantic-search",
    question: query,
    citedChunks: chunks.map((c) => c.id),
    wasFallback: degraded,
  });

  return {
    results: chunks.map((c) => ({
      id: c.id,
      sourceType: c.sourceType,
      sourceId: c.sourceId,
      patientId: c.patientId,
      content: c.content,
      chunkIndex: c.chunkIndex,
      similarity: c.similarity,
    })),
    fallback: degraded,
  };
}

export interface ScopeSearchHit extends SearchHit {
  patientName: string | null;
}

/**
 * Scope-wide semantic search — doctor-facing. Searches the doctor's *whole*
 * retrieval scope (all shared-appointment and accepted-referral patients) rather
 * than one named patient, then attaches each patient's display name so the results
 * read like a panel, not a jumble of ids. Scope still lands in the SQL WHERE
 * clause via `retrieve` — a doctor can only ever surface their own patients.
 */
export async function semanticSearchAll(
  query: string,
  actor: Actor,
  k = 12,
): Promise<{ results: ScopeSearchHit[]; fallback: boolean }> {
  const scope = await resolveRetrievalScope(actor);
  if (scope.patientIds.length === 0) {
    return { results: [], fallback: false };
  }

  const opts = { k, minSimilarity: 0.35, actor, feature: "semantic-search-all" };
  const { chunks, degraded } = isAiConfigured()
    ? await retrieveWithFallback(query, scope, opts)
    : { chunks: await keywordRetrieve(query, scope, opts), degraded: true };

  await logInteraction({
    userId: actor.userId,
    feature: "semantic-search-all",
    question: query,
    citedChunks: chunks.map((c) => c.id),
    wasFallback: degraded,
  });

  const patientIds = [...new Set(chunks.map((c) => c.patientId).filter(Boolean))] as string[];
  const patients = await prisma.patient.findMany({
    where: { id: { in: patientIds } },
    select: { id: true, fullName: true, mrn: true },
  });
  const nameById = new Map(patients.map((p) => [p.id, p]));

  return {
    results: chunks.map((c) => ({
      id: c.id,
      sourceType: c.sourceType,
      sourceId: c.sourceId,
      patientId: c.patientId,
      patientName: c.patientId ? (nameById.get(c.patientId)?.fullName ?? null) : null,
      content: c.content,
      chunkIndex: c.chunkIndex,
      similarity: c.similarity,
    })),
    fallback: degraded,
  };
}
