import { z } from "zod";
import { prisma } from "../config/db.js";
import { env } from "../config/env.js";
import { isRedisEnabled } from "../config/redis.js";
import { AppError } from "../utils/AppError.js";
import { writeAuditLog } from "../utils/audit.js";
import { addSummaryJob } from "../config/bull.js";
import {
  assertClinicalAccess,
  assertNoteReadAccess,
  type Actor,
} from "../services/access.service.js";
import { assertTreatingDoctor } from "../services/note.service.js";
import { signDeliveryUrl, extractRecordText } from "../services/record.service.js";
import { canSeeResults } from "../services/labVisibility.js";
import { getProvider, isAiConfigured } from "./index.js";
import { generateValidated, AiGenerationError, noDiagnosis, noNewDiagnosis } from "./guardrails.js";
import { stripPII } from "./pii.js";
import { flagMismatch, testsFromTranscription } from "./flagConsistency.js";
import { logInteraction } from "./aiInteraction.service.js";

/**
 * Direct-prompt features (Phase 5.4) — data the caller already holds, no retrieval.
 *
 * Every function here follows the same shape: load → **PII-strip before any
 * outbound call** → `generateValidated` (Zod-validated, one retry) → log the
 * `AiInteraction` → return. Every path has a non-AI fallback: when the provider is
 * unconfigured or generation fails, the caller still gets a successful, usable
 * response with `fallback: true` — never a hard failure.
 *
 * Report summaries are the one queued feature (free-tier burst shaping): the worker
 * in `workers/summaries.worker.ts` calls `summarizeRecord`, which writes
 * `MedicalRecord.aiSummary`.
 */

const MAX_SUMMARY_CHARS = 30_000;

// ─── Lab report explanation ──────────────────────────────────────────────────

/**
 * The model writes prose only. Test names, values and flags in the highlights come
 * from the record itself: in testing the model relabelled a white-cell count as red
 * cells, and nothing stopped it restating a flag differently from the report. A
 * value the patient reads must be the value the lab produced.
 */
const labExplainOutputSchema = z.object({
  explanation: z.string().min(1).max(4000),
  notes: z
    .array(z.object({ test: z.string().min(1).max(200), note: z.string().min(1).max(600) }))
    .max(60)
    .default([]),
});

/**
 * Rejects an explanation that contradicts the lab's own flags — a flagged result
 * called normal, or an unflagged one called high or low (see flagConsistency.ts).
 *
 * In testing the model told a patient their CBC "is within the normal range"
 * while the lab had flagged it CRITICAL. The highlights carry the real flag, but a
 * reassuring sentence beside it is exactly what a patient believes.
 */
export function labFlagProblem(
  out: { explanation: string; notes: Array<{ test: string; note: string }> },
  items: Array<{ flag: string | null; labTest: { name: string; code: string } }>,
): string | null {
  const text = [out.explanation, ...out.notes.map((n) => `${n.test}: ${n.note}`)].join("\n");
  return flagMismatch(
    text,
    items.map((i) => ({ names: [i.labTest.name, i.labTest.code], flag: i.flag })),
  );
}

export interface LabExplainResult {
  explanation: string | null;
  highlights: Array<{ test: string; value: string; flag: string | null; note: string }>;
  fallback: boolean;
}

export async function explainLabReport(orderId: string, actor: Actor): Promise<LabExplainResult> {
  const order = await prisma.labOrder.findUnique({
    where: { id: orderId },
    include: {
      items: { include: { labTest: { select: { name: true, code: true } } } },
      patient: { select: { fullName: true } },
    },
  });
  if (!order) throw new AppError("Lab order not found", 404);
  await assertClinicalAccess(order.patientId, actor);
  // The same rule the lab module enforces: a patient sees nothing until a
  // pathologist has verified it. This endpoint used to skip it and hand patients
  // unverified values — a CRITICAL one included — through the AI explainer.
  if (!canSeeResults(actor.role, order.status)) {
    throw new AppError("These results are not available until they have been verified", 403);
  }

  const items = order.items.filter((i) => i.resultValue && i.resultValue.trim());
  if (items.length === 0) {
    throw new AppError("There are no result values to explain yet", 400);
  }

  const highlights = items.map((i) => ({
    test: i.labTest.name,
    value: [i.resultValue ?? "", i.unit ?? ""].join(" ").trim(),
    flag: i.flag ?? null,
    note: i.referenceRange ? `Reference range: ${i.referenceRange}` : "",
  }));

  const fail = async (): Promise<LabExplainResult> => {
    await logInteraction({
      userId: actor.userId,
      feature: "lab-explain",
      question: orderId,
      wasFallback: true,
    });
    return { explanation: null, highlights, fallback: true };
  };

  if (!isAiConfigured()) return fail();

  const lines = items.map(
    (i) =>
      `${i.labTest.code} ${i.labTest.name}: ${i.resultValue} ${i.unit ?? ""}${i.referenceRange ? ` (ref ${i.referenceRange})` : ""}${i.flag ? ` [${i.flag}]` : ""}`,
  );
  const prompt = [
    "Explain these laboratory results to a patient in plain language.",
    "For each value, say what the test measures and what the result means in everyday terms.",
    "Never name a condition as a fact. Never contradict what the report itself shows.",
    "When a value is outside its reference range, say it is flagged and that the treating doctor will interpret it.",
    "In notes, give one short plain-language note per test, naming the test exactly as written below.",
    ...lines,
  ].join("\n");

  try {
    const result = await generateValidated(getProvider(), {
      feature: "lab-explain",
      prompt: stripPII(prompt, { knownNames: [order.patient.fullName] }),
      schema: labExplainOutputSchema,
      // Long answers are where the provider times out; a patient needs a page, not an essay.
      maxTokens: 700,
      check: (out) => labFlagProblem(out, items) ?? noDiagnosis(out),
    });

    const usage = getProvider().lastUsage();
    await logInteraction({
      userId: actor.userId,
      feature: "lab-explain",
      question: orderId,
      responseRef: result.explanation,
      latencyMs: usage.latencyMs,
      tokensUsed: usage.tokensUsed,
      wasFallback: false,
    });
    const noteFor = (name: string, code: string): string | undefined => {
      const n = name.toLowerCase();
      const c = code.toLowerCase();
      return result.notes.find((entry) => {
        const t = entry.test.toLowerCase();
        return t.includes(n) || t.includes(c) || n.includes(t);
      })?.note;
    };
    return {
      explanation: result.explanation,
      highlights: items.map((i, idx) => ({
        ...highlights[idx],
        note: noteFor(i.labTest.name, i.labTest.code) ?? highlights[idx].note,
      })),
      fallback: false,
    };
  } catch (err) {
    if (!(err instanceof AiGenerationError)) throw err;
    return fail();
  }
}

// ─── Prescription explanation ────────────────────────────────────────────────

/**
 * The model never writes the dosing. Asked "how to take" a prescription for
 * Aspirin 75mg once daily, it answered "one tablet every 4 to 6 hours as needed" —
 * a different regimen from the one the doctor prescribed. `howToTake` is the
 * prescription itself, rendered from the record; the model only adds context.
 */
const rxExplainOutputSchema = z.object({
  purpose: z.string().min(1).max(500),
  // A model routinely omits a list it has nothing to put in; that is an empty list,
  // not a failed answer.
  sideEffects: z.array(z.string().min(1).max(400)).max(40).default([]),
  lifestyleNotes: z.array(z.string().min(1).max(400)).max(30).default([]),
  warnings: z.array(z.string().min(1).max(400)).max(30).default([]),
});

const DOSE_AMOUNT_RE =
  /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|g|gm|ml|iu|units?|tablets?|tabs?|capsules?|drops?|puffs?)\b/i;
const STOP_MEDICINE_RE =
  /\b(?:do not|don't|never)\s+(?:take|use)\b[^.]*\bif\b|\bstop (?:taking|using)\b|\bdiscontinue\b/i;

/**
 * Medication-safety check on the AI's context around a prescription.
 *
 * The dose is shown from the prescription itself, so the model has no reason to
 * state an amount — and when it did, it was dangerous: for a patient on 75 mg
 * aspirin it volunteered "do not exceed 8160 mg in 24 hours". It also told the
 * patient "do not take if you have a history of heart disease" about a medicine
 * their doctor had just prescribed. Such a line is never shown: the purpose sentence
 * is checked strictly (retry, then fallback), and unsafe list items are dropped.
 * Concerns belong in "tell your doctor if …".
 */
export function rxUnsafeReason(line: string, prescribedText: string[] = []): string | null {
  // Amounts the prescription itself states ("Aspirin 75mg") are the doctor's, not
  // the model's — strip them before looking for any other amount.
  let rest = line;
  for (const text of prescribedText) {
    if (text.trim()) rest = rest.split(text).join(" ");
  }
  if (DOSE_AMOUNT_RE.test(rest)) {
    return `It states a dose or amount ("${line.slice(0, 120)}"). The prescription already gives the dose — never mention amounts or maximum doses.`;
  }
  if (STOP_MEDICINE_RE.test(line)) {
    return `It tells the patient not to take or to stop a prescribed medicine ("${line.slice(0, 120)}"). Phrase concerns as "tell your doctor if …" instead.`;
  }
  return null;
}

/** Drops list items that fail `rxUnsafeReason` — an unsafe line is never shown. */
export function safeRxLines(lines: string[], prescribedText: string[]): string[] {
  return lines.filter((line) => rxUnsafeReason(line, prescribedText) === null);
}

export interface RxExplainResult {
  purpose: string | null;
  howToTake: string | null;
  sideEffects: string[];
  lifestyleNotes: string[];
  warnings: string[];
  fallback: boolean;
}

export async function explainPrescription(
  prescriptionId: string,
  actor: Actor,
): Promise<RxExplainResult> {
  const prescription = await prisma.prescription.findUnique({
    where: { id: prescriptionId },
    include: {
      items: true,
      appointment: { select: { patientId: true, patient: { select: { fullName: true } } } },
    },
  });
  if (!prescription || prescription.deletedAt) throw new AppError("Prescription not found", 404);
  if (prescription.isDraft) throw new AppError("Draft prescriptions cannot be explained", 400);
  await assertClinicalAccess(prescription.appointment.patientId, actor);

  // The doctor's own words, which the AI's text may repeat without being 'an amount'.
  const prescribedText = prescription.items.flatMap((i) => [i.medicineName, i.dosage]);

  // The prescribed regimen, exactly as written — shown with or without the AI.
  const howToTake = prescription.items
    .map(
      (i) =>
        `${i.medicineName}: ${i.dosage}, ${i.frequency} for ${i.durationDays} day(s)${i.instructions ? ` — ${i.instructions}` : ""}`,
    )
    .join("\n");

  const empty: RxExplainResult = {
    purpose: null,
    howToTake,
    sideEffects: [],
    lifestyleNotes: [],
    warnings: [],
    fallback: true,
  };
  const fail = async (): Promise<RxExplainResult> => {
    await logInteraction({
      userId: actor.userId,
      feature: "rx-explain",
      question: prescriptionId,
      wasFallback: true,
    });
    return empty;
  };

  if (!isAiConfigured()) return fail();

  const lines = prescription.items.map(
    (i) =>
      `${i.medicineName} — ${i.dosage}, ${i.frequency} for ${i.durationDays} day(s)${i.instructions ? ` (${i.instructions})` : ""}`,
  );
  const prompt = [
    "Explain this prescription to the patient taking it.",
    "Cover the likely purpose, the most common side effects, and lifestyle notes for each medicine.",
    "Never name a condition as a fact. If the purpose is not clear from the prescription, say so rather than guessing.",
    "Do not restate or change the dose, frequency or duration — the prescription is shown to the patient exactly as written.",
    "Never mention any amount or maximum dose, and never tell the patient not to take or to stop a medicine — phrase any concern as 'tell your doctor if …'.",
    // A five-medicine prescription otherwise produced a reply long enough to be cut
    // off mid-JSON at the token limit, which parses as nothing at all.
    "Be brief: purpose under 80 words; at most 6 sideEffects, 4 lifestyleNotes and 4 warnings, each under 20 words.",
    ...lines,
    prescription.notes ? `Prescription notes: ${prescription.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const result = await generateValidated(getProvider(), {
      feature: "rx-explain",
      prompt: stripPII(prompt, { knownNames: [prescription.appointment.patient.fullName] }),
      schema: rxExplainOutputSchema,
      check: (out) => rxUnsafeReason(out.purpose, prescribedText) ?? noDiagnosis(out),
      maxTokens: 1000,
    });

    const usage = getProvider().lastUsage();
    await logInteraction({
      userId: actor.userId,
      feature: "rx-explain",
      question: prescriptionId,
      responseRef: result.purpose,
      latencyMs: usage.latencyMs,
      tokensUsed: usage.tokensUsed,
      wasFallback: false,
    });
    return {
      purpose: result.purpose,
      howToTake,
      sideEffects: safeRxLines(result.sideEffects, prescribedText).slice(0, 15),
      lifestyleNotes: safeRxLines(result.lifestyleNotes, prescribedText).slice(0, 10),
      warnings: safeRxLines(result.warnings, prescribedText).slice(0, 10),
      fallback: false,
    };
  } catch (err) {
    if (!(err instanceof AiGenerationError)) throw err;
    return fail();
  }
}

// ─── Follow-up recommendation ────────────────────────────────────────────────

const followUpOutputSchema = z.object({
  intervalDays: z.number().int().min(1).max(365),
  instructions: z.string().min(1).max(1500),
  rationale: z.string().min(1).max(1500),
});

export interface FollowUpResult {
  intervalDays: number | null;
  instructions: string | null;
  rationale: string | null;
  fallback: boolean;
}

export async function recommendFollowUp(
  appointmentId: string,
  actor: Actor,
): Promise<FollowUpResult> {
  // Only the treating doctor asks for a follow-up recommendation on their own visit.
  await assertTreatingDoctor(appointmentId, actor);

  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      note: true,
      prescription: { include: { items: true } },
      patient: { select: { fullName: true } },
    },
  });
  if (!appointment) throw new AppError("Appointment not found", 404);

  const labs = await prisma.labOrder.findMany({
    where: { patientId: appointment.patientId, status: "VERIFIED" },
    include: { items: { include: { labTest: { select: { name: true, code: true } } } } },
    orderBy: { verifiedAt: "desc" },
    take: 3,
  });

  const fail = async (): Promise<FollowUpResult> => {
    await logInteraction({
      userId: actor.userId,
      feature: "follow-up",
      question: appointmentId,
      wasFallback: true,
    });
    return { intervalDays: null, instructions: null, rationale: null, fallback: true };
  };
  if (!isAiConfigured()) return fail();

  const note = appointment.note;
  const noteText = note
    ? `Assessment: ${note.assessment}\nPlan: ${note.plan}`
    : "No signed note for this visit yet.";
  const rxText = appointment.prescription
    ? appointment.prescription.items
        .map((i) => `${i.medicineName} — ${i.dosage} ${i.frequency} for ${i.durationDays} day(s)`)
        .join("\n")
    : "No prescription.";
  const labText =
    labs.length > 0
      ? labs
          .map((o) =>
            o.items
              .map(
                (i) =>
                  `${i.labTest.name}: ${i.resultValue ?? "pending"} ${i.unit ?? ""} [${i.flag ?? "N/A"}]`,
              )
              .join(", "),
          )
          .join("\n")
      : "No verified lab results.";

  const prompt = [
    "Recommend a follow-up interval for this patient based on the consultation below.",
    "Return the number of days, concrete instructions for the follow-up, and a one-paragraph rationale grounded in the provided content.",
    "If the information does not support a recommendation, say so in the rationale rather than inventing one.",
    "This is a suggestion for the treating doctor to confirm — never a diagnosis.",
    `Complaint as recorded: ${appointment.reasonNote ?? "not recorded"}`,
    `Note: ${noteText}`,
    `Prescription: ${rxText}`,
    `Recent verified labs: ${labText}`,
  ].join("\n");

  try {
    const result = await generateValidated(getProvider(), {
      feature: "follow-up",
      prompt: stripPII(prompt, { knownNames: [appointment.patient.fullName] }),
      schema: followUpOutputSchema,
      // Doctor-facing: may restate the treating doctor's recorded assessment, may not
      // propose a condition of its own.
      check: noNewDiagnosis(`${appointment.reasonNote ?? ""}\n${noteText}`),
      maxTokens: 1024,
    });

    const usage = getProvider().lastUsage();
    await logInteraction({
      userId: actor.userId,
      feature: "follow-up",
      question: appointmentId,
      responseRef: result.instructions,
      latencyMs: usage.latencyMs,
      tokensUsed: usage.tokensUsed,
      wasFallback: false,
    });
    return {
      intervalDays: result.intervalDays,
      instructions: result.instructions,
      rationale: result.rationale,
      fallback: false,
    };
  } catch (err) {
    if (!(err instanceof AiGenerationError)) throw err;
    return fail();
  }
}

// ─── OCR summary ─────────────────────────────────────────────────────────────

const ocrSummarySchema = z.object({
  summary: z.string().min(1).max(2000),
});

export interface OcrResult {
  /** Verbatim transcription by the OCR model — what the page says. */
  extractedText: string | null;
  /** Plain-language summary of that text, or null when it could not be produced. */
  summary: string | null;
  /** True when nothing could be read at all (AI unavailable, image unreadable). */
  fallback: boolean;
}

const OCR_IMAGE_TYPES = ["png", "jpeg", "jpg"];
const MAX_OCR_SUMMARY_INPUT = 12_000;

/**
 * Reads a photographed report (handwritten prescription, scanned lab sheet) in two
 * steps: Jina's dedicated OCR model transcribes the page verbatim, then the text
 * model summarises that transcription under the no-diagnosis check.
 *
 * One general vision call used to do both — slowly (~40 s), and it misread a
 * reference range as "low". The OCR model returns the exact text in about a second,
 * and the summary now works from text a human can check against the image.
 *
 * The image is downloaded server-side behind its short-lived signed URL and sent
 * inline — the signed URL never leaves the server. Nothing is written to the
 * record: the transcription is shown, not saved (AI never writes to the record).
 * If only the summary fails, the transcription is still returned.
 */
export async function ocrRecord(recordId: string, actor: Actor): Promise<OcrResult> {
  const record = await prisma.medicalRecord.findUnique({
    where: { id: recordId },
    include: { patient: { select: { fullName: true } } },
  });
  if (!record || record.deletedAt) throw new AppError("Record not found", 404);
  await assertClinicalAccess(record.patientId, actor);

  if (!OCR_IMAGE_TYPES.includes(record.fileType.toLowerCase())) {
    throw new AppError("Only image records (PNG/JPEG) can be read this way", 400);
  }

  await writeAuditLog({
    actorUserId: actor.userId,
    action: "MEDICAL_RECORD_OCR",
    targetType: "medical_record",
    targetId: recordId,
    metadata: { patientId: record.patientId, title: record.title },
  });

  const fail = async (): Promise<OcrResult> => {
    await logInteraction({
      userId: actor.userId,
      feature: "ocr-summary",
      question: recordId,
      wasFallback: true,
    });
    return { extractedText: null, summary: null, fallback: true };
  };
  if (!isAiConfigured()) return fail();

  let image: { mimeType: string; data: string };
  try {
    const url = signDeliveryUrl(record.fileUrl, record.fileType);
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Failed to fetch record (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    image = {
      mimeType: record.fileType.toLowerCase() === "png" ? "image/png" : "image/jpeg",
      data: buf.toString("base64"),
    };
  } catch {
    return fail();
  }

  let extractedText: string;
  try {
    extractedText = await getProvider().transcribe(image);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return fail();
  }
  const ocrUsage = getProvider().lastUsage();

  let summary: string | null = null;
  try {
    const result = await generateValidated(getProvider(), {
      feature: "ocr-summary",
      prompt: [
        "Summarise this transcribed medical document for the patient in plain language, in a few sentences.",
        "Say what kind of document it is and what it records. Report flagged values exactly as written.",
        "Never name a condition as a fact and never contradict what the document says.",
        "---",
        stripPII(extractedText, { knownNames: [record.patient.fullName] }).slice(
          0,
          MAX_OCR_SUMMARY_INPUT,
        ),
      ].join("\n"),
      schema: ocrSummarySchema,
      // The summary must not contradict the page: no condition named, and no value
      // called high/low unless the page flags it (nor a flagged one called normal).
      check: (out) =>
        flagMismatch(out.summary, testsFromTranscription(extractedText)) ??
        noDiagnosis(out.summary),
      maxTokens: 400,
    });
    summary = result.summary;
  } catch (err) {
    if (!(err instanceof AiGenerationError)) throw err;
    // The transcription stands on its own; only the summary is missing.
  }

  await logInteraction({
    userId: actor.userId,
    feature: "ocr-summary",
    question: recordId,
    responseRef: summary ?? extractedText.slice(0, 500),
    latencyMs: ocrUsage.latencyMs,
    tokensUsed: ocrUsage.tokensUsed,
    wasFallback: summary === null,
  });
  return { extractedText, summary, fallback: false };
}

// ─── Medical report summary (queued) ─────────────────────────────────────────

const reportSummaryOutputSchema = z.object({
  keyValues: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        value: z.string().min(1).max(200),
        referenceRange: z.string().max(200).nullable(),
      }),
    )
    .max(40),
  flags: z.array(z.string().min(1).max(300)).max(20),
  plainLanguageSummary: z.string().min(1).max(2000),
});

/** True for the `{ fallback: true }` marker a failed generation leaves behind. */
function isFallbackSummary(summary: unknown): boolean {
  return Boolean(
    summary && typeof summary === "object" && (summary as { fallback?: unknown }).fallback === true,
  );
}

/**
 * Runs inside the summaries worker (never in a request) — or inline from
 * `enqueueReportSummary` when Redis is off and no worker can run. Generates the
 * report summary and writes `MedicalRecord.aiSummary`. Idempotent — a record that
 * already has a real summary is skipped, and a failure writes a deterministic
 * `fallback` marker so the queue stops retrying instead of hammering the free tier.
 *
 * The marker does **not** block a later attempt: it used to, which meant one
 * failed generation (an outage, a cold start) left the record unsummarisable
 * forever — "Summarize" answered 202 and changed nothing. The marker stops
 * automatic retries because this function does not throw on failure; an explicit
 * request to summarise again is allowed to try.
 */
export async function summarizeRecord(recordId: string): Promise<void> {
  let record = await prisma.medicalRecord.findUnique({ where: { id: recordId } });
  if (!record || record.deletedAt) return;
  if (record.aiSummary && !isFallbackSummary(record.aiSummary)) return;

  // A PDF uploaded while the queue was down may never have been extracted. Pull
  // the text inline so the summary still has something to read.
  if (!record.extractedText?.trim() && record.fileType === "pdf") {
    try {
      const { extracted } = await extractRecordText(recordId);
      if (extracted) {
        record = await prisma.medicalRecord.findUnique({ where: { id: recordId } });
      }
    } catch (err) {
      console.error("[summaries] Inline text extraction failed:", err);
    }
  }

  // The reassignment above widens the narrowed type; re-narrow before use.
  if (!record || record.deletedAt) return;
  if (!record.extractedText || !record.extractedText.trim()) return;

  const logUser = record.uploadedById ? { userId: record.uploadedById, role: "SYSTEM" } : null;
  const patientName = (
    await prisma.patient.findUnique({ where: { id: record.patientId }, select: { fullName: true } })
  )?.fullName;

  // Unconfigured: nothing to generate and nothing to mark — the record simply has
  // no summary, which the UI renders as "unavailable".
  if (!isAiConfigured()) return;

  const markFallback = async () => {
    await prisma.medicalRecord.update({
      where: { id: recordId },
      data: { aiSummary: { fallback: true, generatedAt: new Date().toISOString() } },
    });
    if (logUser) {
      await logInteraction({
        userId: logUser.userId,
        feature: "report-summary",
        question: recordId,
        wasFallback: true,
      });
    }
  };

  const prompt = [
    "Summarise this extracted medical report for the patient.",
    "Extract the key measured values with their reference ranges, flag anything abnormal, and write a plain-language summary.",
    "Never name a condition as a fact. Never contradict what the report itself says.",
    `Report title: ${record.title}`,
    "---",
    stripPII(record.extractedText, { knownNames: patientName ? [patientName] : [] }).slice(
      0,
      MAX_SUMMARY_CHARS,
    ),
  ].join("\n");

  try {
    const result = await generateValidated(getProvider(), {
      feature: "report-summary",
      prompt,
      schema: reportSummaryOutputSchema,
      // keyValues and flags restate the report; the plain-language summary is the
      // AI's own voice, and the part a patient reads as advice.
      check: (out) => noDiagnosis(out.plainLanguageSummary),
      maxTokens: 1200,
    });

    await prisma.medicalRecord.update({
      where: { id: recordId },
      data: {
        aiSummary: {
          keyValues: result.keyValues,
          flags: result.flags,
          plainLanguageSummary: result.plainLanguageSummary,
          generatedAt: new Date().toISOString(),
          model: env.JINA_CHAT_MODEL,
        },
      },
    });

    const usage = getProvider().lastUsage();
    if (logUser) {
      await logInteraction({
        userId: logUser.userId,
        feature: "report-summary",
        question: recordId,
        responseRef: result.plainLanguageSummary,
        latencyMs: usage.latencyMs,
        tokensUsed: usage.tokensUsed,
        wasFallback: false,
      });
    }
  } catch (err) {
    if (!(err instanceof AiGenerationError)) throw err;
    await markFallback();
  }
}

/** The stored summary, or null when none exists yet. */
export async function getReportSummary(recordId: string, actor: Actor) {
  const record = await prisma.medicalRecord.findUnique({ where: { id: recordId } });
  if (!record || record.deletedAt) throw new AppError("Record not found", 404);
  await assertClinicalAccess(record.patientId, actor);

  await writeAuditLog({
    actorUserId: actor.userId,
    action: "MEDICAL_RECORD_SUMMARY_VIEWED",
    targetType: "medical_record",
    targetId: recordId,
    metadata: { patientId: record.patientId },
  });

  return record.aiSummary;
}

/** Enqueues a (re)summarise job for a record with extractable text. */
export async function enqueueReportSummary(
  recordId: string,
  actor: Actor,
): Promise<{ queued: boolean }> {
  const record = await prisma.medicalRecord.findUnique({ where: { id: recordId } });
  if (!record || record.deletedAt) throw new AppError("Record not found", 404);
  await assertClinicalAccess(record.patientId, actor);

  // A PDF that was uploaded while the queue was down may never have had its text
  // extracted. Pull it inline so the record is summarisable either way.
  if (!record.extractedText?.trim() && record.fileType === "pdf") {
    try {
      await extractRecordText(recordId);
    } catch (err) {
      console.error("[record] Failed to extract text for summary:", err);
    }
  }

  const fresh = await prisma.medicalRecord.findUnique({ where: { id: recordId } });
  if (!fresh || !fresh.extractedText || !fresh.extractedText.trim()) {
    throw new AppError("This record has no extractable text to summarise", 400);
  }

  // Without Redis the BullMQ summary worker cannot run — summarise inline so the
  // caller still gets a result. Idempotent: a record already summarised is skipped.
  if (!isRedisEnabled) {
    await summarizeRecord(recordId);
    return { queued: false };
  }

  await addSummaryJob(recordId);
  return { queued: true };
}

// ─── Appointment assistant (patient + doctor) ────────────────────────────────

const appointmentOutputSchema = z.object({
  answer: z.string().min(1).max(3000),
});

export interface AppointmentAssistResult {
  answer: string | null;
  factSheet: string;
  fallback: boolean;
}

/**
 * Guided AI answer about a specific appointment.
 *
 * Access: a doctor only for an appointment they treat (or were referred into);
 * everyone else passes the standard clinical gate — a patient for their own
 * appointment (and guardians), admins, and contextual pharmacy/lab roles. The
 * deterministic `factSheet` is always returned and doubles as the non-AI fallback,
 * so an outage never leaves the caller without the appointment's own facts.
 */
export async function explainAppointment(
  appointmentId: string,
  actor: Actor,
  question?: string,
): Promise<AppointmentAssistResult> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      doctor: {
        include: { departments: { include: { department: { select: { name: true } } } } },
      },
      slot: true,
      patient: { select: { fullName: true } },
      note: { select: { signedAt: true } },
      prescription: { select: { items: true } },
      labOrders: { take: 5, orderBy: { orderedAt: "desc" } },
    },
  });
  if (!appointment || appointment.deletedAt) throw new AppError("Appointment not found", 404);

  if (actor.role === "DOCTOR") {
    await assertNoteReadAccess(appointmentId, actor);
  } else {
    await assertClinicalAccess(appointment.patientId, actor);
  }

  const department = appointment.doctor.departments[0]?.department?.name ?? null;
  const factSheet = [
    `Appointment ${appointment.appointmentNo}`,
    `Doctor: ${appointment.doctor.fullName}${department ? ` (${department})` : ""}`,
    `Scheduled: ${appointment.slot.startTime.toISOString()} – ${appointment.slot.endTime.toISOString()}`,
    `Status: ${appointment.status}`,
    appointment.reasonNote ? `Reason given: ${appointment.reasonNote}` : "",
    appointment.note?.signedAt
      ? "A signed consultation note exists for this visit."
      : "No signed consultation note yet.",
    appointment.prescription && appointment.prescription.items.length > 0
      ? `A prescription covering ${appointment.prescription.items.length} item(s) was written.`
      : "No prescription on record.",
    appointment.labOrders.length > 0
      ? `${appointment.labOrders.length} lab order(s): ${appointment.labOrders
          .map((o) => o.orderNumber)
          .join(", ")}`
      : "No lab orders linked.",
  ]
    .filter(Boolean)
    .join("\n");

  const fail = async (): Promise<AppointmentAssistResult> => {
    await logInteraction({
      userId: actor.userId,
      feature: "appointment-assist",
      question: `${appointmentId}${question ? ` :: ${question}` : ""}`,
      wasFallback: true,
    });
    return { answer: null, factSheet, fallback: true };
  };
  if (!isAiConfigured()) return fail();

  const knownNames = [appointment.patient.fullName];
  const prompt = [
    question
      ? "Answer the following question using ONLY the appointment details below."
      : "Give a short, practical guide for this appointment — what to expect, and what to do before and at it.",
    ...(question ? [`Question: "${stripPII(question, { knownNames })}"`] : []),
    `Appointment details:\n${stripPII(factSheet, { knownNames })}`,
    "Never name a condition as a fact. This is an administrative and preparation assistant — do not give medical advice beyond the appointment details.",
  ].join("\n");

  try {
    const result = await generateValidated(getProvider(), {
      feature: "appointment-assist",
      prompt,
      schema: appointmentOutputSchema,
      check: noDiagnosis,
      maxTokens: 1024,
    });

    const usage = getProvider().lastUsage();
    await writeAuditLog({
      actorUserId: actor.userId,
      action: "AI_APPOINTMENT_ASSIST",
      targetType: "appointment",
      targetId: appointmentId,
      metadata: { patientId: appointment.patientId, hasQuestion: Boolean(question) },
    });
    await logInteraction({
      userId: actor.userId,
      feature: "appointment-assist",
      question: appointmentId,
      responseRef: result.answer,
      latencyMs: usage.latencyMs,
      tokensUsed: usage.tokensUsed,
      wasFallback: false,
    });
    return { answer: result.answer, factSheet, fallback: false };
  } catch (err) {
    if (!(err instanceof AiGenerationError)) throw err;
    return fail();
  }
}
