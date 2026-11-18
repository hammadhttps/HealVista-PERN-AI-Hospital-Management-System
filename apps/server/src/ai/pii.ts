/**
 * PII stripping — the control that makes sending clinical text to an external LLM
 * acceptable at all (security.md §6).
 *
 * One tested helper, applied before **every** outbound call — embedding and
 * generation alike. Nothing here is optional: a regex that misses a name or a
 * phone number is how the free-tier caveat becomes a real breach.
 *
 * Matching is intentionally conservative — it strips a *superset* of what could be
 * identifying. Over-stripping costs the model a little context; under-stripping
 * costs the patient their privacy.
 */

const REDACTED_NAME = "[NAME]";
const REDACTED_PHONE = "[PHONE]";
const REDACTED_EMAIL = "[EMAIL]";
const REDACTED_ID = "[ID]";
const REDACTED_ADDRESS = "[ADDRESS]";
const REDACTED_DATE = "[DATE]";

/** Common given names — catches "John called yesterday" without a structured field. */
const COMMON_NAMES = new Set([
  "john",
  "james",
  "robert",
  "michael",
  "william",
  "david",
  "richard",
  "joseph",
  "thomas",
  "charles",
  "christopher",
  "daniel",
  "matthew",
  "anthony",
  "mark",
  "donald",
  "steven",
  "paul",
  "andrew",
  "joshua",
  "kenneth",
  "kevin",
  "brian",
  "george",
  "timothy",
  "ronald",
  "edward",
  "jason",
  "jeffrey",
  "ryan",
  "jacob",
  "gary",
  "nicholas",
  "eric",
  "jonathan",
  "stephen",
  "larry",
  "justin",
  "scott",
  "brandon",
  "benjamin",
  "samuel",
  "gregory",
  "alexander",
  "frank",
  "patrick",
  "raymond",
  "jack",
  "dennis",
  "jerry",
  "tyler",
  "aaron",
  "jose",
  "adam",
  "nathan",
  "henry",
  "douglas",
  "zachary",
  "peter",
  "kyle",
  "walter",
  "ethan",
  "jeremy",
  "harold",
  "keith",
  "christian",
  "roger",
  "noah",
  "gerald",
  "carl",
  "terry",
  "sean",
  "austin",
  "arthur",
  "lawrence",
  "jesse",
  "dylan",
  "bryan",
  "joe",
  "jordan",
  "billy",
  "bruce",
  "albert",
  "willie",
  "gabriel",
  "logan",
  "alan",
  "juan",
  "wayne",
  "roy",
  "ralph",
  "randy",
  "eugene",
  "vincent",
  "russell",
  "elijah",
  "louis",
  "bobby",
  "philip",
  "johnny",
  "mary",
  "patricia",
  "jennifer",
  "linda",
  "elizabeth",
  "barbara",
  "susan",
  "jessica",
  "sarah",
  "karen",
  "lisa",
  "nancy",
  "betty",
  "margaret",
  "sandra",
  "ashley",
  "kimberly",
  "emily",
  "donna",
  "michelle",
  "carol",
  "amanda",
  "dorothy",
  "melissa",
  "deborah",
  "stephanie",
  "rebecca",
  "sharon",
  "laura",
  "cynthia",
  "amy",
  "kathleen",
  "angela",
  "shirley",
  "anna",
  "brenda",
  "pamela",
  "emma",
  "nicole",
  "helen",
  "samantha",
  "katherine",
  "christine",
  "debra",
  "rachel",
  "carolyn",
  "janet",
  "catherine",
  "maria",
  "heather",
  "diane",
  "ruth",
  "julie",
  "olivia",
  "joyce",
  "virginia",
  "victoria",
  "kelly",
  "lauren",
  "christina",
  "joan",
  "evelyn",
  "judith",
  "megan",
  "andrea",
  "cheryl",
  "hannah",
  "jacqueline",
  "martha",
  "gloria",
  "teresa",
  "ann",
  "sara",
  "madison",
  "frances",
  "kathryn",
  "janice",
  "jean",
  "abigail",
  "alice",
  "julia",
  "judy",
  "sophia",
  "grace",
  "denise",
  "amber",
  "doris",
  "marilyn",
  "danielle",
  "beverly",
  "isabella",
  "theresa",
  "diana",
  "natalie",
  "brittany",
  "charlotte",
  "marie",
  "kayla",
  "alexis",
  "lori",
  "jane",
  "ahmed",
  "mohammed",
  "ali",
  "fatima",
  "omar",
  "hassan",
  "hussein",
  "yusuf",
  "ibrahim",
  "khalid",
  "amina",
  "zainab",
  "bilal",
  "nadia",
  "samir",
  "layla",
]);

/**
 * Names common in this hospital's patient population, and common surnames.
 *
 * The list above is English given names only, so "Alex Johnson", "Ayesha
 * Siddiqui" and every surname reached the model untouched. This is still only a
 * backstop: the real control is `knownNames` — callers pass the actual patient's
 * name from the record, which no list can anticipate.
 *
 * Words that are also clinical or everyday English (Burns, Stone, White, Brown,
 * Rose, Park, Long, Grant…) are deliberately absent: redacting "White" in "White
 * cell count" would cost the model the content it needs.
 */
const REGIONAL_AND_SURNAMES = [
  // South Asian given names
  "muhammad",
  "mohammad",
  "ahmad",
  "usman",
  "umar",
  "hamza",
  "hammad",
  "zain",
  "saad",
  "asad",
  "faisal",
  "imran",
  "kamran",
  "adnan",
  "farhan",
  "rizwan",
  "shahid",
  "tariq",
  "waqas",
  "junaid",
  "salman",
  "haris",
  "danish",
  "abdullah",
  "rehan",
  "raheel",
  "naveed",
  "arif",
  "asif",
  "aamir",
  "amir",
  "nasir",
  "zahid",
  "sajid",
  "babar",
  "shoaib",
  "irfan",
  "khurram",
  "mehmood",
  "mahmood",
  "zubair",
  "yasir",
  "aslam",
  "akram",
  "aisha",
  "ayesha",
  "maryam",
  "sana",
  "hina",
  "saima",
  "rabia",
  "mehwish",
  "iqra",
  "amna",
  "zara",
  "hira",
  "noor",
  "nida",
  "sadia",
  "asma",
  "bushra",
  "farah",
  "fariha",
  "kiran",
  "mahnoor",
  "rimsha",
  "sobia",
  "shazia",
  "uzma",
  "nazia",
  "samina",
  "sidra",
  "alina",
  "anum",
  "laiba",
  "fiza",
  "javeria",
  "saba",
  "sumaira",
  "rahul",
  "priya",
  "amit",
  "anjali",
  "rohit",
  "pooja",
  "sunil",
  "vikram",
  "neha",
  "deepak",
  "arjun",
  "meera",
  "alex",
  "carlos",
  "ivan",
  "khalid",
  "lucia",
  "sofia",
  "tara",
  "umar",
  "victor",
  "quinn",
  "dina",
  "hina",
  "elena",
  "rafael",
  // Surnames
  "khan",
  "hussain",
  "shah",
  "malik",
  "siddiqui",
  "qureshi",
  "raza",
  "butt",
  "chaudhry",
  "chaudhary",
  "sheikh",
  "mirza",
  "baig",
  "awan",
  "abbasi",
  "akhtar",
  "iqbal",
  "javed",
  "rashid",
  "rehman",
  "rahman",
  "hashmi",
  "bukhari",
  "naqvi",
  "rizvi",
  "zaidi",
  "jafri",
  "gillani",
  "ansari",
  "farooq",
  "farooqi",
  "saleem",
  "haider",
  "nawaz",
  "sharif",
  "anwar",
  "kazmi",
  "durrani",
  "yousaf",
  "sultan",
  "memon",
  "baloch",
  "khattak",
  "afridi",
  "niazi",
  "bibi",
  "begum",
  "sharma",
  "patel",
  "gupta",
  "singh",
  "kumar",
  "verma",
  "reddy",
  "nair",
  "iyer",
  "smith",
  "johnson",
  "williams",
  "jones",
  "garcia",
  "miller",
  "davis",
  "rodriguez",
  "martinez",
  "hernandez",
  "lopez",
  "gonzalez",
  "wilson",
  "anderson",
  "taylor",
  "moore",
  "jackson",
  "martin",
  "thompson",
  "harris",
  "clark",
  "lewis",
  "robinson",
  "walker",
  "wright",
  "adams",
  "nelson",
  "carter",
  "mitchell",
  "roberts",
  "turner",
  "phillips",
  "campbell",
  "parker",
  "evans",
  "edwards",
  "collins",
  "stewart",
  "morris",
  "rogers",
  "reed",
  "morgan",
  "murphy",
  "bailey",
  "cooper",
  "richardson",
  "howard",
  "torres",
  "peterson",
  "ramirez",
  "watson",
  "sanders",
  "bennett",
  "henderson",
  "coleman",
  "jenkins",
  "powell",
  "patterson",
  "hughes",
  "flores",
  "simmons",
  "foster",
  "bryant",
  "russell",
  "griffin",
  "diaz",
  "hayes",
  "myers",
  "hamilton",
  "sullivan",
  "wallace",
  "reynolds",
  "fisher",
  "harrison",
  "gibson",
  "mcdonald",
  "marshall",
  "ortiz",
  "gomez",
  "murray",
  "freeman",
  "simpson",
  "stevens",
  "tucker",
  "crawford",
  "kennedy",
  "warren",
  "dixon",
  "ramos",
  "reyes",
  "robertson",
  "daniels",
  "nichols",
  "ferguson",
  "hawkins",
  "perkins",
  "hudson",
  "spencer",
  "gardner",
  "stephens",
  "matthews",
  "wagner",
  "watkins",
  "olson",
  "cunningham",
  "bradley",
  "andrews",
  "ruiz",
  "harper",
  "armstrong",
  "carpenter",
  "elliott",
  "chavez",
  "franklin",
  "lawson",
  "chen",
  "wang",
  "zhang",
  "liu",
  "okafor",
  "nguyen",
  "reyes",
  "lin",
];
for (const name of REGIONAL_AND_SURNAMES) COMMON_NAMES.add(name);

// ─── Patterns ───────────────────────────────────────────────────────────────

/** Makes a literal word match in any letter case, for the label/title alternations. */
function anyCase(word: string): string {
  return word.replace(/[a-z]/gi, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`);
}

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

/**
 * International phone numbers: +923001234567, 0300-1234567, (021) 3456 7890, etc.
 * Never starts inside an identifier: digits glued to letters ("LAB-20260801-0012",
 * "APT-1234") are record numbers the model needs for citations, not phone numbers.
 */
const PHONE_RE =
  /(?<![A-Za-z0-9])(?<![A-Za-z]-)(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{4,6}\b/g;

/** National ids — 13-digit CNIC, 9-digit SSN with dashes, 8-10 digit passports. */
const ID_RE =
  /\b\d{5}[-.\s]?\d{7}[-.\s]?\d\b|\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b|\b\d{13}\b|\bMRN[:#.\s-]*\d{3,}/gi;

/** DOB markers — "DOB 05/17/1990", "date of birth: 1990-05-17". */
const DOB_RE = /\b(?:dob|date\s+of\s+birth|born)\b[:\s-]{0,3}\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}\b/gi;

/** Addresses — house number + street name. "221B Baker Street", "14 Park Road". */
const ADDRESS_RE =
  /\b(?:no\.?|plot|house|flat|apt\.?|suite|#)?\s*\d{1,4}[a-z]?[,\s]+(?:[A-Z][a-z]+[\s-]?){1,3}(?:street|st\.?|road|rd\.?|avenue|ave\.?|lane|ln\.?|drive|dr\.?|boulevard|blvd\.?|court|ct\.?|plaza|square|main|colony|nagar|town|gali|mohalla)\b/gi;

/**
 * A capitalised name: "Ayesha", "Ayesha Khan", "Al-Hassan".
 *
 * The salutation and label patterns below are case-insensitive for the *prefix*
 * only. They used to carry the `i` flag on the whole pattern, which made this
 * name group match any lowercase words too: "Patient: reports headache for two
 * days" became "Patient: [NAME] [NAME] [NAME] two days", and "Miss dose of" lost
 * "dose of" — the clinical content the model was being sent to read.
 */
const NAME = "([A-Z][a-z]+(?:[\\s-][A-Z][a-z]+)?)";

const TITLES = [
  "dr",
  "mrs",
  "mr",
  "ms",
  "miss",
  "mx",
  "prof",
  "sir",
  "madam",
  "sheikh",
  "syed",
  "smt",
  "shri",
].map(anyCase);

/** Salutation + name — "Dr. John Smith", "Mr Patel", "Mrs. Ayesha Khan". */
const TITLE_NAME_RE = new RegExp(`\\b(?:${TITLES.join("|")})\\.?\\s+${NAME}`, "g");

const LABELS = [
  "patient",
  "guardian",
  "attendant",
  "caregiver",
  "next of kin",
  "referring doctor",
  "treating doctor",
  "consultant",
  "attending",
  "reported by",
].map((l) => l.split(" ").map(anyCase).join("\\s+"));

/** Labelled names — "patient: John Smith", "Guardian: Ayesha Bibi". */
const LABELED_NAME_RE = new RegExp(
  `\\b(?:${LABELS.join("|")})\\s*[:#]\\s*([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})`,
  "g",
);

// ─── Implementation ─────────────────────────────────────────────────────────

export interface StripPIIOptions {
  /**
   * Names known to belong to people in this text — the patient's full name, a
   * guardian's — taken from the record. Each full name and each of its words
   * (three letters or more) is redacted wherever it appears capitalised. This is
   * the only reliable way to catch a name no list contains.
   */
  knownNames?: Array<string | null | undefined>;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Redacts each known name, whole first, then word by word. */
function redactKnownNames(text: string, names: Array<string | null | undefined>): string {
  const fullNames = names
    .map((n) => (n ?? "").trim())
    .filter((n) => n.length >= 3)
    .sort((a, b) => b.length - a.length);
  if (fullNames.length === 0) return text;

  let out = text;
  for (const full of fullNames) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(full)}\\b`, "gi"), (m) =>
      m
        .split(/\s+/)
        .map(() => REDACTED_NAME)
        .join(" "),
    );
  }

  const words = new Set(
    fullNames.flatMap((n) => n.split(/[\s.,'-]+/)).filter((w) => w.length >= 3),
  );
  for (const word of words) {
    // Capitalised or upper-case only: a patient called "Will" or "Hope" must not
    // cost the model every "will" and "hope" in the note.
    const cap = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    out = out.replace(
      new RegExp(`\\b(?:${escapeRegExp(cap)}|${escapeRegExp(word.toUpperCase())})\\b`, "g"),
      REDACTED_NAME,
    );
  }
  return out;
}

export function stripPII(text: string, options: StripPIIOptions = {}): string {
  if (!text) return text;

  let out = text;

  // Known names first: they are certain, and later passes could split them.
  if (options.knownNames?.length) out = redactKnownNames(out, options.knownNames);

  // Emails first — they are unambiguous and their substrings (a local part could
  // look like a name) would otherwise be mangled by later passes.
  out = out.replace(EMAIL_RE, REDACTED_EMAIL);

  // DoB markers before generic dates so the labelled date is never left behind.
  out = out.replace(DOB_RE, (m) => m.replace(/\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}\b/, REDACTED_DATE));

  out = out.replace(ID_RE, REDACTED_ID);
  out = out.replace(PHONE_RE, REDACTED_PHONE);
  out = out.replace(ADDRESS_RE, REDACTED_ADDRESS);

  // Names: labelled first, then salutations, then the standalone name list.
  out = out.replace(
    LABELED_NAME_RE,
    (_m, names: string) =>
      `${_m.slice(0, _m.indexOf(names))}${names
        .split(/\s+/)
        .map(() => REDACTED_NAME)
        .join(" ")}`,
  );

  out = out.replace(TITLE_NAME_RE, (_m, name: string) =>
    _m.replace(
      name,
      name
        .split(/[\s-]+/)
        .map(() => REDACTED_NAME)
        .join(" "),
    ),
  );

  out = out.replace(/(?<![A-Za-z])([A-Z][a-z]{2,})(?![A-Za-z])/g, (word) =>
    COMMON_NAMES.has(word.toLowerCase()) ? REDACTED_NAME : word,
  );

  return out;
}

export const PII_TEST_TOKENS = {
  REDACTED_NAME,
  REDACTED_PHONE,
  REDACTED_EMAIL,
  REDACTED_ID,
  REDACTED_ADDRESS,
  REDACTED_DATE,
};
