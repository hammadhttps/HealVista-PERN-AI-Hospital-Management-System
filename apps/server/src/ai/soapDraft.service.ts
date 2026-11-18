import { z } from "zod";
import { prisma } from "../config/db.js";
import { AppError } from "../utils/AppError.js";
import { getProvider, isAiConfigured } from "./index.js";
import { generateValidated, AiGenerationError, noNewDiagnosis } from "./guardrails.js";
import { stripPII } from "./pii.js";
import { logInteraction } from "./aiInteraction.service.js";
import { storeDraft, type SoapDraft } from "./soapDraft.store.js";
import type { Actor } from "../services/access.service.js";
import { assertTreatingDoctor } from "../services/note.service.js";

/**
 * SOAP draft generation (Phase 5.4).
 *
 * `POST /api/appointments/:appointmentId/note/draft` returns a draft SOAP note
 * assembled from the complaint, vitals, recent labs, and any existing note for this
 * visit. **It persists nothing to the record** — the draft is returned, cached
 * briefly in Redis so the "unedited draft cannot be submitted" rule is enforceable,
 * and lands in the editor as unsaved content the doctor must edit before signing.
 * The client records `aiAssisted: true` on the save.
 *
 * The non-AI fallback is a rules-based skeleton from the recorded complaint — a
 * provider outage still hands the doctor a starting point, never an error.
 */

/**
 * The model drafts S, A and P only. The objective section is assembled from the
 * recorded vitals and verified labs: given a complaint and two vital signs, the
 * model invented examination findings ("swollen and tender, unable to bear
 * weight") and a diastolic pressure nobody measured. Examination findings belong
 * to the clinician who examined the patient.
 */
const soapDraftOutputSchema = z.object({
  subjective: z.string().min(1).max(4000),
  assessment: z.string().min(1).max(4000),
  plan: z.string().min(1).max(4000),
});

const EXAM_PLACEHOLDER = "Examination: [to be completed by the examining clinician]";

/** The most recent reading of each vital type (readings arrive newest first). */
function latestPerType<T extends { type: string }>(readings: T[]): T[] {
  const seen = new Set<string>();
  return readings.filter((r) => (seen.has(r.type) ? false : (seen.add(r.type), true)));
}

export interface SoapDraftResult {
  draft: { subjective: string; objective: string; assessment: string; plan: string };
  source: "ai" | "rules";
  fallback: boolean;
}

export async function generateDraft(appointmentId: string, actor: Actor): Promise<SoapDraftResult> {
  // Only the treating doctor drafts their own visit's note.
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

  const [labs, vitals] = await Promise.all([
    prisma.labOrder.findMany({
      where: { patientId: appointment.patientId, status: "VERIFIED" },
      include: { items: { include: { labTest: { select: { name: true, code: true } } } } },
      orderBy: { verifiedAt: "desc" },
      take: 3,
    }),
    prisma.vitalReading.findMany({
      where: { patientId: appointment.patientId },
      orderBy: { recordedAt: "desc" },
      take: 5,
    }),
  ]);

  const vitalsLine =
    vitals.length > 0
      ? `Vitals: ${latestPerType(vitals)
          .map((v) => `${v.type} ${Number(v.value)} ${v.unit}`)
          .join(", ")}`
      : "";
  const labsLine =
    labs.length > 0
      ? `Recent verified labs:\n${labs
          .map((o) =>
            o.items
              .map(
                (i) =>
                  `${i.labTest.name}: ${i.resultValue ?? "pending"} ${i.unit ?? ""}${i.flag ? ` [${i.flag}]` : ""}`,
              )
              .join(", "),
          )
          .join("\n")}`
      : "";

  // Built from the record, never generated — see soapDraftOutputSchema.
  const objective = [vitalsLine, labsLine, EXAM_PLACEHOLDER].filter(Boolean).join("\n");

  const rulesDraft = {
    subjective: appointment.reasonNote ? `Patient presents with: ${appointment.reasonNote}` : "",
    objective,
    assessment: "",
    plan: "",
  };

  if (!isAiConfigured()) {
    await logInteraction({
      userId: actor.userId,
      feature: "soap-draft",
      question: appointmentId,
      wasFallback: true,
    });
    return { draft: rulesDraft, source: "rules", fallback: true };
  }

  const prompt = [
    "Draft three sections of a SOAP consultation note from the information below: subjective, assessment and plan.",
    "Subjective: restate the complaint and history exactly as recorded. Never add symptoms, durations or details that are not written below.",
    "Assessment: summarise the presenting problem and the relevant recorded data. Do not name, suggest or rank any diagnosis — the clinician writes that.",
    "Plan: list next steps the information supports (examination, results to review, follow-up). Do not introduce new medicines or treatments.",
    "Where information is missing, keep the section brief and factual rather than filling gaps.",
    "A clinician will edit and sign this note; mark nothing as final.",
    "---",
    `Complaint as recorded: ${appointment.reasonNote ?? "not recorded"}`,
    appointment.note?.signedAt
      ? `Existing note: A: ${appointment.note.assessment} P: ${appointment.note.plan}`
      : "",
    appointment.prescription
      ? `Prescription: ${appointment.prescription.items
          .map((i) => `${i.medicineName} ${i.dosage} ${i.frequency} for ${i.durationDays} day(s)`)
          .join("; ")}`
      : "",
    labsLine,
    vitalsLine,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const generated = await generateValidated(getProvider(), {
      feature: "soap-draft",
      prompt: stripPII(prompt, { knownNames: [appointment.patient.fullName] }),
      schema: soapDraftOutputSchema,
      maxTokens: 1500,
      // The clinician's own signed assessment (if any) may be restated; nothing new.
      check: noNewDiagnosis(
        [appointment.reasonNote, appointment.note?.signedAt ? appointment.note.assessment : ""]
          .filter(Boolean)
          .join("\n"),
      ),
    });
    const result = { ...generated, objective };

    const stored: SoapDraft = { ...result, source: "ai", createdAt: new Date().toISOString() };
    await storeDraft(appointmentId, stored);

    const usage = getProvider().lastUsage();
    await logInteraction({
      userId: actor.userId,
      feature: "soap-draft",
      question: appointmentId,
      responseRef: result.assessment,
      latencyMs: usage.latencyMs,
      tokensUsed: usage.tokensUsed,
      wasFallback: false,
    });

    return { draft: result, source: "ai", fallback: false };
  } catch (err) {
    if (!(err instanceof AiGenerationError)) throw err;
    await logInteraction({
      userId: actor.userId,
      feature: "soap-draft",
      question: appointmentId,
      wasFallback: true,
    });
    return { draft: rulesDraft, source: "rules", fallback: true };
  }
}
