/**
 * Emergency detection — deterministic on purpose.
 *
 * A model that occasionally misses "chest pain" is not an acceptable triage layer
 * (ai-rag.md §6). This runs **before** any model call and short-circuits to an
 * emergency-services message. It never invents a diagnosis — it flags red-flag
 * phrasing and directs the user to emergency care.
 *
 * Coverage is deliberately broad: a false positive costs one unnecessary "call
 * emergency services" message, a false negative can cost a life. The earlier,
 * narrower list caught 1 of 10 common phrasings — "I think I am having a heart
 * attack" was routed to a cardiology booking and "I took an overdose" to "describe
 * your symptoms in more detail". Every phrasing in emergency.test.ts is a case a
 * real patient types.
 *
 * Patterns match against normalised text: lower-cased, curly quotes straightened,
 * whitespace collapsed. Common Roman-Urdu and Urdu phrasings are included because
 * the patient app ships an Urdu locale.
 */

const EMERGENCY_PATTERNS: Array<{ pattern: RegExp; advice: string }> = [
  {
    pattern:
      /\b(heart attack|cardiac arrest|chest (?:pain|tightness|pressure|hurts?|is (?:hurting|tight|heavy))|(?:pain|pressure|tightness|heaviness|crushing|squeezing)\b[^.]{0,30}\bchest|crushing (?:pain|chest)|pain (?:spreading|going|radiating) (?:to|down|into) (?:my |the )?(?:left )?(?:arm|jaw)|dil ka daura|seene? (?:mein|me) (?:dard|dabao))/,
    advice: "Chest pain, pressure or a suspected heart attack can be a heart emergency.",
  },
  {
    pattern:
      /\b(difficulty breathing|trouble breathing|hard to breathe|struggling to breathe|shortness of breath|short of breath|can'?t (?:breathe?|breath|catch (?:my|his|her|their) breath)|cannot breathe?|not breathing|stopped breathing|isn'?t breathing|gasping|choking|turning blue|lips? (?:are |is |turning )?blue|blue lips|saans? (?:nahi|nahin|nai) (?:aa|a) ?rahi)/,
    advice: "Breathing difficulty can be a sign of a life-threatening emergency.",
  },
  {
    pattern:
      /\b(suicid\w*|self[- ]?harm\w*|harm(?:ing)? myself|hurt(?:ing)? myself|cut(?:ting)? myself|kill(?:ing)? myself|end (?:my|it all|my own) life|end it all|take my (?:own )?life|want to die|wanna die|wish i (?:was|were) dead|better off dead|don'?t want to (?:live|be alive|wake up)|no reason to live|khud ?kushi|khudkushi|mar(?:na)? (?:jana )?chahta|mar(?:na)? (?:jana )?chahti)/,
    advice: "Thoughts of suicide or self-harm are a crisis. You deserve immediate help.",
  },
  {
    pattern:
      /\b(overdos\w*|o\.?d\.?'?d|took (?:too many|a lot of|all (?:my|the|of my)|an entire|a whole) (?:\w+ )?(?:pills|tablets|medicines?|meds|capsules)|swallowed (?:\w+ )?(?:bleach|poison|pills|tablets|chemicals?|detergent|battery|batteries|kerosene|acid)|drank (?:\w+ )?(?:bleach|poison|kerosene|acid|chemicals?)|poison(?:ed|ing)|zeher|zehar)/,
    advice: "A possible overdose or poisoning needs emergency care right away.",
  },
  {
    pattern:
      /\b(unconscious|unresponsive|passed out|fainted|collapsed|won'?t wake up|not waking up|can'?t wake (?:him|her|them|up)|blacked out|loss of consciousness|lost consciousness|behosh)/,
    advice: "Loss of consciousness is an emergency.",
  },
  {
    pattern:
      /\b(severe bleeding|heavy bleeding|bleeding (?:heavily|badly|a lot|that won'?t stop|won'?t stop|that will not stop|non-?stop)|bleeding profusely|losing (?:a lot of )?blood|(?:coughing|vomiting|throwing) up blood|blood in (?:my |the )?vomit|(?:haemorrhag|hemorrhag)\w*)/,
    advice: "Uncontrolled or internal bleeding is an emergency.",
  },
  {
    pattern:
      /\b(stroke|face (?:is )?droop\w*|droop\w* face|facial droop|(?:face|mouth) (?:is )?(?:drooping|twisted|uneven)|slurred speech|slurring|can'?t (?:speak|talk) properly|sudden(?:ly)? (?:can'?t|cannot) (?:speak|talk|see|move)|weakness (?:on|in) one side|one side of (?:my|his|her|the) (?:body|face)|sudden numbness|arm (?:went|is|feels) (?:numb|weak|dead)|falij|lakwa)/,
    advice: "Sudden stroke symptoms need emergency care right away.",
  },
  {
    pattern:
      /\b(worst headache (?:of|in) my life|thunderclap headache|sudden (?:and )?severe headache|severe headache (?:that came on |)suddenly|headache (?:after|with) (?:a )?(?:head injury|fall|hitting my head))/,
    advice: "A sudden, severe headache can be a sign of bleeding in the brain.",
  },
  {
    pattern: /\b(seizure|seizing|convuls\w*|fitting|having a fit|mirgi|daura pad)/,
    advice: "Seizures can be emergencies, especially when prolonged.",
  },
  {
    pattern:
      /\b(anaphyla\w*|severe allergic reaction|(?:throat|tongue|lips?|face) (?:is )?(?:swelling|swollen|closing)|swelling (?:of|in) (?:the |my )?(?:throat|tongue)|throat (?:is )?closing|can'?t swallow)/,
    advice: "Signs of a severe allergic reaction need immediate emergency care.",
  },
  {
    pattern:
      /\b((?:baby|infant|newborn|child) (?:is )?(?:not breathing|turning blue|limp|unresponsive|won'?t wake)|(?:baby|infant|newborn) (?:has (?:a )?)?(?:high )?fever (?:and|with) (?:is )?(?:limp|floppy|not feeding))/,
    advice: "A baby or child who is not breathing, limp or unresponsive needs emergency care now.",
  },
  {
    pattern:
      /\b(pregnant\b[^.]{0,40}\b(?:bleeding|severe pain|water broke|fits?|seizure)|(?:bleeding|severe pain)[^.]{0,40}\bpregnan\w*)/,
    advice: "Bleeding or severe pain in pregnancy needs urgent medical care.",
  },
  {
    pattern:
      /\b(severe burns?|burned (?:badly|my (?:face|whole))|electric(?:al)? shock|electrocuted|hit by a (?:car|bus|truck|vehicle)|car (?:accident|crash)|road accident|fell from (?:a )?(?:height|roof|ladder|building)|stab(?:bed|bing)|gunshot|shot (?:in|by))/,
    advice: "A serious injury needs emergency care right away.",
  },
];

export interface EmergencyResult {
  isEmergency: boolean;
  advice?: string;
}

/** Lower-cases, straightens quotes and collapses whitespace so patterns stay simple. */
function normalise(input: string): string {
  return input
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Urdu-script red flags, matched without word boundaries (\b is ASCII-only). */
const URDU_PATTERNS: Array<{ pattern: RegExp; advice: string }> = [
  { pattern: /دل کا دورہ|سینے میں درد/, advice: EMERGENCY_PATTERNS[0].advice },
  { pattern: /سانس نہیں|سانس لینے میں (?:دشواری|مشکل)/, advice: EMERGENCY_PATTERNS[1].advice },
  { pattern: /خودکشی|خود کشی|مرنا چاہتا|مرنا چاہتی/, advice: EMERGENCY_PATTERNS[2].advice },
  { pattern: /زہر/, advice: EMERGENCY_PATTERNS[3].advice },
  { pattern: /بے ہوش|بےہوش/, advice: EMERGENCY_PATTERNS[4].advice },
  { pattern: /فالج|لقوہ/, advice: EMERGENCY_PATTERNS[6].advice },
];

/**
 * Deterministic keyword check. Returns `isEmergency: true` with the advice string
 * when the input contains a red-flag phrase. The caller must **skip the model
 * entirely** and return this message.
 */
export function detectEmergency(input: string): EmergencyResult {
  if (!input) return { isEmergency: false };

  const text = normalise(input);
  for (const { pattern, advice } of EMERGENCY_PATTERNS) {
    if (pattern.test(text)) return { isEmergency: true, advice };
  }
  for (const { pattern, advice } of URDU_PATTERNS) {
    if (pattern.test(input)) return { isEmergency: true, advice };
  }
  return { isEmergency: false };
}
