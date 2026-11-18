/**
 * Deterministic detector for diagnostic language in model output.
 *
 * The guardrail prompt tells the model never to name a condition, and a 2.4B model
 * does not reliably listen: in testing it told a patient a high glucose "could
 * indicate that you may have diabetes" and drafted "possible ligament or meniscus
 * tear" into a SOAP note from a complaint and two vital signs. A prompt is a
 * request; this is the check (CLAUDE.md §7: safety-critical checks are
 * deterministic).
 *
 * A sentence is flagged when it pairs a hedged clinical claim ("may have",
 * "suggests", "sign of", "possible") with a named condition. Negated sentences
 * ("no signs of infection") are left alone — repeating a record's negative finding
 * is not a diagnosis.
 */

const CONDITIONS = [
  // Unnamed conditions count too: "these results suggest you may have a medical
  // condition" (seen in testing) alarms a patient without telling them anything.
  "(?:an? |some )?(?:medical|underlying|serious|health) (?:condition|problem|issue)s?",
  "disease",
  "disorder",
  "illness",
  "diabetes",
  "prediabetes",
  "pre-diabetes",
  "hypertension",
  "high blood pressure",
  "anaemia",
  "anemia",
  "cancer",
  "tumour",
  "tumor",
  "malignan\\w*",
  "leuka?emia",
  "lymphoma",
  "infection",
  "pneumonia",
  "tuberculosis",
  "hepatitis",
  "cirrhosis",
  "kidney disease",
  "renal (?:failure|disease)",
  "heart (?:disease|failure|attack)",
  "myocardial infarction",
  "stroke",
  "arthritis",
  "fracture",
  "(?:ligament|meniscus|muscle|tendon) (?:tear|injury|rupture)",
  "tear",
  "sprain",
  "asthma",
  "copd",
  "covid(?:-19)?",
  "dengue",
  "malaria",
  "typhoid",
  "thyroid (?:disease|disorder)",
  "hypo-?thyroidism",
  "hyper-?thyroidism",
  "depression",
  "anxiety disorder",
  "migraine",
  "epilepsy",
  "dementia",
  "sepsis",
  "appendicitis",
  "ulcer",
  "gastritis",
  "deficiency",
];

const CLAIMS = [
  "may have",
  "might have",
  "could have",
  "likely (?:have|has)",
  "probably (?:have|has)",
  "suffering from",
  "indicat\\w*",
  "suggest\\w*",
  "sign of",
  "signs of",
  "consistent with",
  "diagnos\\w*",
  "possib\\w*",
  "probable",
  "suspected",
  "at risk (?:of|for)",
  "points to",
  "due to",
];

const CONDITION_RE = new RegExp(`\\b(?:${CONDITIONS.join("|")})\\b`, "i");
const CLAIM_RE = new RegExp(`\\b(?:${CLAIMS.join("|")})\\b`, "i");
const NEGATION_RE = /\b(?:no|not|without|negative for|rules? out|ruled out)\b/i;

export interface DiagnosticLanguageOptions {
  /**
   * Text a clinician wrote (the visit's signed note, the recorded complaint). A
   * condition that already appears here is the treating doctor's own assessment
   * being restated — not the AI diagnosing — and is allowed. Used only on
   * doctor-facing drafts; patient-facing text gets no such allowance.
   */
  clinicianText?: string;
}

/**
 * Returns the first offending sentence, or null when the text names no condition.
 * Callers treat a hit like a validation failure: retry once with a correction, then
 * fall back.
 */
export function findDiagnosticLanguage(
  text: string | null | undefined,
  options: DiagnosticLanguageOptions = {},
): string | null {
  if (!text) return null;
  const allowed = options.clinicianText?.toLowerCase() ?? "";
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    const claim = CLAIM_RE.exec(sentence);
    const condition = CONDITION_RE.exec(sentence);
    if (!claim || !condition) continue;
    // Negation before the claim ("no signs of infection") is a reported finding.
    if (NEGATION_RE.test(sentence.slice(0, claim.index + claim[0].length))) continue;
    if (allowed && allowed.includes(condition[0].toLowerCase())) continue;
    return sentence.trim().slice(0, 200);
  }
  return null;
}

/** Checks every string in a (possibly nested) model output. */
export function findDiagnosticLanguageIn(
  value: unknown,
  options: DiagnosticLanguageOptions = {},
): string | null {
  if (typeof value === "string") return findDiagnosticLanguage(value, options);
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findDiagnosticLanguageIn(item, options);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const hit = findDiagnosticLanguageIn(item, options);
      if (hit) return hit;
    }
  }
  return null;
}
