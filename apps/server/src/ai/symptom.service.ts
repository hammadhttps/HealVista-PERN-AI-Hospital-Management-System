import { z } from "zod";
import { getProvider, isAiConfigured } from "./index.js";
import { generateValidated, AiGenerationError, noDiagnosis } from "./guardrails.js";
import { stripPII } from "./pii.js";
import { detectEmergency } from "./emergency.js";
import { logInteraction } from "./aiInteraction.service.js";
import type { Actor } from "../services/access.service.js";

/**
 * Symptom → department matching and the stateless symptom checker (Phase 5.4).
 *
 * Two consumers share one rule map:
 *   - `suggestDepartments` upgrades Phase 2's `POST /api/doctors/match`. It tries
 *     the AI model first and falls back to the deterministic keyword map — the rule path
 *     stays intact so an AI outage changes nothing about a feature the front desk
 *     already depends on.
 *   - `checkSymptom` is the educational triage widget. Emergency phrases are caught
 *     by `detectEmergency` **before** any model call and short-circuit to an
 *     emergency-services message. Everything the model says is a *suggestion*, never
 *     a diagnosis, and the guardrail system prompt enforces that at generation time.
 */

/** The only department slugs the model may suggest — the seeded catalogue. */
export const KNOWN_DEPARTMENT_SLUGS = [
  "cardiology",
  "general-medicine",
  "pediatrics",
  "orthopedics",
  "neurology",
  "dermatology",
  "ophthalmology",
  "ent",
  "gynecology",
  "psychiatry",
  "emergency",
  "radiology",
] as const;

/**
 * Keyword → department scoring, the deterministic non-AI path.
 *
 * This is what every patient gets whenever the model is unavailable, so it has to
 * cope with how people actually type: "headache", "I have a rash.", "my knee
 * hurts". Input is tokenised on non-letters (punctuation no longer hides a word)
 * and a trailing plural "s" is tried too ("rashes", "joints").
 */
const KEYWORD_DEPT_MAP: Record<string, string[]> = {
  // Cardiology
  heart: ["cardiology"],
  palpitation: ["cardiology"],
  palpitations: ["cardiology"],
  pressure: ["cardiology"],
  bp: ["cardiology"],
  hypertension: ["cardiology"],
  cholesterol: ["cardiology", "general-medicine"],
  chest: ["cardiology", "general-medicine"],
  // Respiratory / general
  breath: ["cardiology", "general-medicine"],
  breathless: ["general-medicine", "cardiology"],
  breathlessness: ["general-medicine", "cardiology"],
  wheeze: ["general-medicine"],
  wheezing: ["general-medicine"],
  asthma: ["general-medicine"],
  lung: ["general-medicine", "radiology"],
  cough: ["general-medicine", "pediatrics"],
  cold: ["general-medicine"],
  flu: ["general-medicine"],
  fever: ["general-medicine", "pediatrics"],
  temperature: ["general-medicine"],
  fatigue: ["general-medicine"],
  tired: ["general-medicine"],
  weakness: ["general-medicine"],
  infection: ["general-medicine"],
  diabetes: ["general-medicine"],
  sugar: ["general-medicine"],
  thyroid: ["general-medicine"],
  weight: ["general-medicine"],
  stomach: ["general-medicine"],
  abdomen: ["general-medicine"],
  abdominal: ["general-medicine"],
  belly: ["general-medicine"],
  nausea: ["general-medicine"],
  vomit: ["general-medicine"],
  vomiting: ["general-medicine"],
  diarrhea: ["general-medicine"],
  diarrhoea: ["general-medicine"],
  constipation: ["general-medicine"],
  acidity: ["general-medicine"],
  heartburn: ["general-medicine"],
  urine: ["general-medicine"],
  urinary: ["general-medicine"],
  burning: ["general-medicine"],
  dizzy: ["general-medicine", "neurology"],
  dizziness: ["general-medicine", "neurology"],
  pain: ["general-medicine", "orthopedics"],
  // Paediatrics
  child: ["pediatrics"],
  baby: ["pediatrics"],
  infant: ["pediatrics"],
  toddler: ["pediatrics"],
  kid: ["pediatrics"],
  son: ["pediatrics"],
  daughter: ["pediatrics"],
  vaccination: ["pediatrics"],
  vaccine: ["pediatrics"],
  // Orthopaedics
  bone: ["orthopedics"],
  fracture: ["orthopedics"],
  joint: ["orthopedics"],
  knee: ["orthopedics"],
  ankle: ["orthopedics"],
  hip: ["orthopedics"],
  shoulder: ["orthopedics"],
  elbow: ["orthopedics"],
  wrist: ["orthopedics"],
  back: ["orthopedics"],
  backache: ["orthopedics"],
  spine: ["orthopedics", "neurology"],
  sprain: ["orthopedics"],
  muscle: ["orthopedics"],
  // Neurology
  head: ["neurology"],
  headache: ["neurology", "general-medicine"],
  brain: ["neurology"],
  migraine: ["neurology"],
  seizure: ["neurology"],
  numb: ["neurology"],
  numbness: ["neurology"],
  tingling: ["neurology"],
  memory: ["neurology"],
  tremor: ["neurology"],
  // Dermatology
  skin: ["dermatology"],
  rash: ["dermatology"],
  itch: ["dermatology"],
  itching: ["dermatology"],
  itchy: ["dermatology"],
  acne: ["dermatology"],
  pimple: ["dermatology"],
  eczema: ["dermatology"],
  hair: ["dermatology"],
  nail: ["dermatology"],
  mole: ["dermatology"],
  // Ophthalmology
  eye: ["ophthalmology"],
  vision: ["ophthalmology"],
  sight: ["ophthalmology"],
  blurry: ["ophthalmology"],
  blurred: ["ophthalmology"],
  // ENT
  ear: ["ent"],
  earache: ["ent"],
  hearing: ["ent"],
  throat: ["ent"],
  tonsil: ["ent"],
  sinus: ["ent"],
  nose: ["ent"],
  nosebleed: ["ent"],
  neck: ["ent"],
  // Gynaecology
  pregnancy: ["gynecology"],
  pregnant: ["gynecology"],
  period: ["gynecology"],
  menstrual: ["gynecology"],
  menstruation: ["gynecology"],
  hormone: ["gynecology"],
  // Psychiatry
  anxiety: ["psychiatry"],
  anxious: ["psychiatry"],
  panic: ["psychiatry"],
  stress: ["psychiatry"],
  depression: ["psychiatry"],
  depressed: ["psychiatry"],
  sad: ["psychiatry"],
  sleep: ["psychiatry"],
  insomnia: ["psychiatry"],
  mental: ["psychiatry"],
  // Emergency
  accident: ["emergency"],
  injury: ["emergency", "orthopedics"],
  burn: ["emergency", "dermatology"],
  bleeding: ["emergency"],
};

const MAX_RULE_MATCHES = 3;

/** The departments a keyword token maps to, trying a singular form for plurals. */
function departmentsForToken(token: string): string[] | undefined {
  if (KEYWORD_DEPT_MAP[token]) return KEYWORD_DEPT_MAP[token];
  if (token.length > 3 && token.endsWith("es") && KEYWORD_DEPT_MAP[token.slice(0, -2)]) {
    return KEYWORD_DEPT_MAP[token.slice(0, -2)];
  }
  if (token.length > 3 && token.endsWith("s")) return KEYWORD_DEPT_MAP[token.slice(0, -1)];
  return undefined;
}

/**
 * The deterministic keyword path, shared with doctor.service's match endpoint.
 * Returns up to `MAX_RULE_MATCHES` ranked slugs; empty when nothing matches.
 */
export function ruleBasedDepartmentSlugs(symptom: string): string[] {
  const tokens = symptom
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);

  const departmentMatches: Record<string, number> = {};
  for (const token of tokens) {
    const depts = departmentsForToken(token);
    if (!depts) continue;
    // The first department listed for a keyword is its primary home; weight it so
    // "fever, cough" ranks general medicine above paediatrics for an adult.
    depts.forEach((d, i) => {
      departmentMatches[d] = (departmentMatches[d] || 0) + (i === 0 ? 2 : 1);
    });
  }

  return Object.entries(departmentMatches)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_RULE_MATCHES)
    .map(([slug]) => slug);
}

/** Common ways a model (or a person) names a department, mapped to its slug. */
const DEPARTMENT_ALIASES: Record<string, string> = {
  cardiac: "cardiology",
  cardiologist: "cardiology",
  "general medicine": "general-medicine",
  "internal medicine": "general-medicine",
  "family medicine": "general-medicine",
  "general practice": "general-medicine",
  gp: "general-medicine",
  paediatrics: "pediatrics",
  pediatrician: "pediatrics",
  orthopaedics: "orthopedics",
  orthopedic: "orthopedics",
  orthopaedic: "orthopedics",
  neurologist: "neurology",
  dermatologist: "dermatology",
  skin: "dermatology",
  eye: "ophthalmology",
  ophthalmologist: "ophthalmology",
  "ear nose throat": "ent",
  "ear, nose and throat": "ent",
  otolaryngology: "ent",
  gynaecology: "gynecology",
  obstetrics: "gynecology",
  "obstetrics and gynecology": "gynecology",
  "obstetrics & gynaecology": "gynecology",
  obgyn: "gynecology",
  psychiatrist: "psychiatry",
  "mental health": "psychiatry",
  "emergency medicine": "emergency",
  "emergency department": "emergency",
  er: "emergency",
};

/**
 * Maps whatever the model wrote ("Psychiatry", "General Medicine", "ENT
 * specialist") to a seeded department slug — or null. The client filters doctors by
 * this value, so an unknown string must never reach it.
 */
export function normaliseDepartmentSlug(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .toLowerCase()
    .replace(/\b(department|dept|specialist|clinic|unit)\b/g, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const asSlug = cleaned.replace(/\s+/g, "-");
  if ((KNOWN_DEPARTMENT_SLUGS as readonly string[]).includes(asSlug)) return asSlug;
  return DEPARTMENT_ALIASES[cleaned] ?? null;
}

// ─── AI department suggestions (doctors/match upgrade) ─────────────────────

const departmentSuggestionSchema = z.object({
  suggestions: z
    .array(
      z.object({
        slug: z.string().min(1).max(100),
        // Models write 0.85 or 85 interchangeably; both are normalised below.
        confidence: z.number().min(0).max(100),
        reason: z.string().max(500),
      }),
    )
    .max(10),
});

export interface DepartmentSuggestion {
  slug: string;
  confidence: number;
  reason: string;
}

/**
 * AI-ranked department suggestions for a symptom. Returns `null` when the AI path
 * is unavailable (not configured, or generation failed) — the caller then runs the
 * deterministic rule map. Never a hard failure.
 */
export async function suggestDepartments(
  symptom: string,
  actor?: Actor,
): Promise<DepartmentSuggestion[] | null> {
  if (!isAiConfigured()) return null;

  const prompt = [
    `A patient describes this symptom: "${stripPII(symptom)}"`,
    "Recommend up to 3 departments a patient should consider seeing.",
    `You may only choose slugs from this list: ${KNOWN_DEPARTMENT_SLUGS.join(", ")}.`,
    "Rank by likelihood and give a one-line reason. Never name a condition as a fact.",
  ].join("\n");

  try {
    const result = await generateValidated(getProvider(), {
      feature: "symptom-match",
      prompt,
      schema: departmentSuggestionSchema,
      system:
        "This is a specialty-referral suggestion, not a diagnosis. If the symptom sounds urgent, the department list includes 'emergency'.",
      maxTokens: 512,
      check: noDiagnosis,
    });

    // Only seeded departments survive: the model's 'Cardiology' becomes
    // 'cardiology', an invented department is dropped, duplicates collapse.
    const seen = new Set<string>();
    const suggestions: DepartmentSuggestion[] = [];
    for (const s of result.suggestions) {
      const slug = normaliseDepartmentSlug(s.slug);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      suggestions.push({
        slug,
        confidence: s.confidence > 1 ? s.confidence / 100 : s.confidence,
        reason: s.reason,
      });
      if (suggestions.length === 3) break;
    }
    if (suggestions.length === 0) return null;

    const usage = getProvider().lastUsage();
    if (actor) {
      await logInteraction({
        userId: actor.userId,
        feature: "symptom-match",
        question: symptom,
        responseRef: JSON.stringify(suggestions),
        latencyMs: usage.latencyMs,
        tokensUsed: usage.tokensUsed,
        wasFallback: false,
      });
    }

    return suggestions;
  } catch {
    if (actor) {
      await logInteraction({
        userId: actor.userId,
        feature: "symptom-match",
        question: symptom,
        wasFallback: true,
      });
    }
    return null;
  }
}

// ─── Symptom checker ────────────────────────────────────────────────────────

const symptomCheckOutputSchema = z.object({
  type: z.enum(["clarifying_question", "department_suggestion", "general_advice"]),
  response: z.string().min(1).max(1000),
  department: z.string().min(1).max(100).nullable(),
  // The model routinely asks four questions; trimming to three in code beats
  // rejecting an otherwise good answer and falling back.
  clarifyingQuestions: z.array(z.string().max(300)).max(10).nullable(),
});

export type SymptomCheckResult =
  | {
      type: "emergency";
      response: string;
      department: null;
      clarifyingQuestions: [];
      fallback: false;
    }
  | {
      type: "clarifying_question" | "department_suggestion" | "general_advice";
      response: string;
      department: string | null;
      clarifyingQuestions: string[];
      fallback: boolean;
    };

const EMERGENCY_LINE =
  "Please stop and contact emergency services immediately. If you are with someone, ask them to call for you.";

/**
 * A stateless triage turn. Emergency phrasing is detected deterministically and
 * short-circuits the model entirely (ai-rag.md §6). Everything else is either an
 * AI response or the rule-map fallback — educational framing only, no diagnosis.
 */
export async function checkSymptom(message: string, actor: Actor): Promise<SymptomCheckResult> {
  const emergency = detectEmergency(message);
  if (emergency.isEmergency) {
    await logInteraction({
      userId: actor.userId,
      feature: "symptom-check",
      question: message,
      responseRef: emergency.advice,
      wasFallback: false,
    });
    return {
      type: "emergency",
      response: `${emergency.advice} ${EMERGENCY_LINE}`,
      department: null,
      clarifyingQuestions: [],
      fallback: false,
    };
  }

  if (!isAiConfigured()) return ruleFallback(message, actor);

  try {
    const result = await generateValidated(getProvider(), {
      feature: "symptom-check",
      prompt: `The patient reports: "${stripPII(message)}"\n\nRespond as a triage assistant: ask a clarifying question, suggest a department, or give general advice. Educational framing only.`,
      schema: symptomCheckOutputSchema,
      maxTokens: 512,
      check: noDiagnosis,
    });

    const usage = getProvider().lastUsage();
    await logInteraction({
      userId: actor.userId,
      feature: "symptom-check",
      question: message,
      responseRef: result.response,
      latencyMs: usage.latencyMs,
      tokensUsed: usage.tokensUsed,
      wasFallback: false,
    });

    return {
      type: result.type,
      response: result.response,
      department: normaliseDepartmentSlug(result.department),
      clarifyingQuestions: (result.clarifyingQuestions ?? []).slice(0, 3),
      fallback: false,
    };
  } catch (err) {
    if (!(err instanceof AiGenerationError)) throw err;
    return ruleFallback(message, actor);
  }
}

async function ruleFallback(message: string, actor: Actor): Promise<SymptomCheckResult> {
  const slugs = ruleBasedDepartmentSlugs(message);
  let response: string;
  let type: "department_suggestion" | "general_advice";
  let department: string | null;

  if (slugs.length > 0) {
    type = "department_suggestion";
    department = slugs[0];
    response = `Based on your description, seeing a ${slugs[0].replace("-", " ")} specialist may help. This is only a suggestion — please confirm with a doctor.`;
  } else {
    type = "general_advice";
    department = null;
    response =
      "I couldn't match your description to a department. Please describe your symptoms in more detail, or consult a doctor directly.";
  }

  await logInteraction({
    userId: actor.userId,
    feature: "symptom-check",
    question: message,
    responseRef: response,
    wasFallback: true,
  });

  return { type, response, department, clarifyingQuestions: [], fallback: true };
}
