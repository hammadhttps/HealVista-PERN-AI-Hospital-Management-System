/**
 * Deterministic check that model prose agrees with the flags the source document
 * carries — in both directions.
 *
 * jina-vlm gets this wrong often enough to matter. In testing it told a patient a
 * CRITICAL blood count was "within the normal range", and, summarising a lab sheet
 * whose only flags were a LOW haemoglobin and a HIGH glucose, called the unflagged
 * white count and platelets "high, above the reference range" (7.2 against a
 * 4.0–11.0 range). A patient believes the sentence, not the table beside it, so a
 * sentence that contradicts the document is rejected — the caller retries once with
 * the correction, then falls back to the document's own values.
 */

export interface FlaggedTest {
  /** Every name the prose might use for the test: "Complete Blood Count", "CBC". */
  names: string[];
  /** The document's flag, or null/"NORMAL" when it carries none. */
  flag: string | null;
}

const ABNORMAL_FLAG = /^(?:HIGH|LOW|CRITICAL|ABNORMAL|H|L|HH|LL)$/i;
const CALLED_NORMAL =
  /\b(?:with)?in (?:the )?(?:normal|reference) range\b|\bis normal\b|\bnormal (?:level|value|result|range)s?\b|\bhealthy (?:level|range)\b/i;
const CALLED_ABNORMAL =
  /\b(?:high|higher|low|lower|elevated|raised|decreased|reduced|abnormal|above|below|outside)\b/i;
/** Words that make a "normal" sentence about a flagged test correct ("not normal", "outside the normal range"). */
const QUALIFIES_NORMAL =
  /\b(?:not|outside|above|below|higher|lower|flagged|abnormal|critical|high|low)\b/i;
/** Words that make an "abnormal" sentence about an unflagged test correct ("not high"). */
const NEGATES_ABNORMAL = /\b(?:not|no|neither|nor|within)\b/i;

/**
 * Names prose uses for common tests. The model writes "white blood cell count" for
 * a line the report calls "WBC"; without these, a contradiction about it slipped
 * through in testing.
 */
const SYNONYMS: string[][] = [
  ["wbc", "white blood cell", "white cell", "leukocyte", "leucocyte", "tlc"],
  ["rbc", "red blood cell", "red cell", "erythrocyte"],
  ["haemoglobin", "hemoglobin", "hb", "hgb"],
  ["platelet", "plt", "thrombocyte"],
  ["glucose", "blood sugar", "sugar level"],
  ["hba1c", "a1c", "glycated", "glycosylated"],
  ["creatinine", "cr"],
  ["sodium", "na"],
  ["potassium"],
  ["tsh", "thyroid stimulating"],
  ["alt", "sgpt"],
  ["ast", "sgot"],
  ["ldl", "bad cholesterol"],
  ["hdl", "good cholesterol"],
  ["esr", "sedimentation"],
  ["crp", "c-reactive"],
  ["hematocrit", "haematocrit", "hct", "pcv"],
];

/** A test's names plus every synonym of any of them, singular and lower-case. */
function expandNames(names: string[]): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    out.add(name);
    if (name.length > 4 && name.endsWith("s")) out.add(name.slice(0, -1));
    for (const group of SYNONYMS) {
      if (group.some((term) => name === term || (term.length > 3 && name.includes(term)))) {
        for (const term of group) out.add(term);
      }
    }
  }
  return [...out];
}

/** Splits prose into clauses, so "A is low and B is normal" is judged per test. */
function clauses(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+|;|,\s+(?:and|but|while|whereas)\s+|\s+(?:and|but|while|whereas)\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

function mentions(clause: string, names: string[]): boolean {
  const lower = clause.toLowerCase();
  return expandNames(names).some((name) => {
    if (name.length < 2) return false;
    return name.length <= 4
      ? new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower)
      : lower.includes(name);
  });
}

/** Returns a correction for the first contradiction, or null when the prose agrees. */
export function flagMismatch(text: string, tests: FlaggedTest[]): string | null {
  const parts = clauses(text);
  for (const test of tests) {
    const abnormal = Boolean(test.flag && ABNORMAL_FLAG.test(test.flag.trim()));
    const label = test.names[0];
    for (const clause of parts) {
      if (!mentions(clause, test.names)) continue;
      if (abnormal && CALLED_NORMAL.test(clause) && !QUALIFIES_NORMAL.test(clause)) {
        return `It calls ${label} normal ("${clause.slice(0, 140)}"), but the document flags it ${test.flag!.toUpperCase()}. State the flag exactly as the document does.`;
      }
      if (!abnormal && CALLED_ABNORMAL.test(clause) && !NEGATES_ABNORMAL.test(clause)) {
        return `It calls ${label} abnormal ("${clause.slice(0, 140)}"), but the document does not flag it. Only describe values the document flags as high or low.`;
      }
    }
  }
  return null;
}

/**
 * Reads test lines out of a transcribed report: "Haemoglobin: 10.9 g/dL (ref
 * 12.0-15.5) LOW" → { names: ["Haemoglobin"], flag: "LOW" }. Lines that are not a
 * name followed by a number are ignored.
 */
export function testsFromTranscription(text: string): FlaggedTest[] {
  const tests: FlaggedTest[] = [];
  for (const line of text.split(/\n+/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9 .,()/-]{1,50}?)\s*[:=]\s*[<>]?\s*\d/);
    if (!match) continue;
    const flag = line.match(/\[?\b(HIGH|LOW|CRITICAL|ABNORMAL|HH|LL|H|L)\b\]?\s*$/)?.[1] ?? null;
    tests.push({ names: [match[1].trim()], flag });
  }
  return tests;
}
