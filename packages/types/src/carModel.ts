/**
 * `Item.carModel` is free-text fitment typed by hand in the POS, e.g.
 *
 *   "COROLLA 97~04, COROLLA AXIO 2006-2012, RAV4 1995~2000"
 *   "AVALON 2006-2010, CAMRY 2007-2011,LEXUS ES350 2009-2012"
 *
 * The storefront needs three things from it: a short label to print on a
 * card, a curated list of models to offer as a filter, and a way to know
 * whether a chosen model matches a part. All three come from here so the
 * API and the shop UI never disagree about what a model is.
 *
 * Filtering always matches case-insensitively against the *raw* text, so a
 * token label that this parser gets slightly wrong still filters correctly —
 * the parse only decides what the option list looks like.
 */

/** Splits one carModel value into its individual fitment segments. */
const SEGMENT_SPLIT = /[,;|\n]|\band\b/gi;

/**
 * Year range / lone year. Replaced with a comma, not a space: the source
 * often runs two models together ("2010-2015 Lexus RX450h 2010-2015 Lexus
 * RX350") and the year is the only separator between them.
 *
 * The optional leading letters let "HYBRID1999-2006" be removed whole
 * without swallowing a model name separated by a space ("CAMRY 2001-2006").
 */
const YEAR_RANGE =
  /[A-Za-z]*(?:19|20)?\d{2}\s*[–—~\-]\s*(?:19|20)?\d{2}(?![\d])/g;
const LONE_YEAR = /(?:^|(?<=[\s,('"']))(?:19|20)\d{2}(?![\d\-–—~])/g;
/** Years wrapped in brackets, e.g. "4RUNNER(2018-2020)". */
const EMPTY_BRACKETS = /[()[\]]/g;
/** A leading part code, e.g. "CET-121/2 CAMRY" or "ACV4 GSV40". */
const LEADING_PART_CODE = /^[A-Za-z][\w\-/]*\d[\w\-/]*\s+/;
/** Part numbers and codes: "23300-21010", "DAC387340ABS". */
const PART_NUMBER_TOKEN = /^(?=.*\d)[A-Za-z0-9\-/]{5,}$/;
/** "6pk", "3m", "mk2" — digits glued to a short suffix. */
const SHORT_CODE_TOKEN = /^\d+[A-Za-z]{1,3}$/;
/** Model designations worth keeping even though they carry digits. */
const MODEL_DESIGNATION = /^[A-Za-z]{1,5}\d{2,4}[A-Za-z]?$/;

/**
 * Generic words, accessories and brands that are not vehicle models. Matched
 * against the letters-only form, so "T-Shirt" and "TSHIRT" both hit.
 */
const NON_MODEL_WORDS = new Set(
  [
    "air",
    "all",
    "amp",
    "axle",
    "bearing",
    "belt",
    "benz",
    "blower",
    "box",
    "car",
    "cars",
    "chain",
    "class",
    "cooker",
    "coil",
    "coolant",
    "cruise",
    "cushion",
    "detriot",
    "digital",
    "dryer",
    "duster",
    "electric",
    "end",
    "ex",
    "fan",
    "filter",
    "flush",
    "fluid",
    "front",
    "fuel",
    "gauge",
    "genuine",
    "harr",
    "hair",
    "high",
    "ils",
    "inches",
    "inch",
    "injector",
    "inflator",
    "kit",
    "lex",
    "lens",
    "lithium",
    "luxury",
    "masuma",
    "mod",
    "model",
    "multifunctional",
    "new",
    "oil",
    "only",
    "outer",
    "oem",
    "pad",
    "patch",
    "quality",
    "radiator",
    "rear",
    "rice",
    "rod",
    "rotor",
    "seal",
    "set",
    "smart",
    "steering",
    "stethoscope",
    "tester",
    "txs",
    "tie",
    "tire",
    "tshirt",
    "type",
    "van",
    "veas",
    "vital",
    "vonos",
    "watt",
    "wheel",
    "washer",
  ].map((word) => word.toLowerCase()),
);

/** Spellings we force for makes; applied to any token, however it is cased. */
const MAKE_FIXES: Record<string, string> = {
  ACURA: "Acura",
  AUDI: "Audi",
  BUICK: "Buick",
  CADILLACE: "Cadillac",
  CADILLAC: "Cadillac",
  CHEVROLET: "Chevrolet",
  CHEVY: "Chevrolet",
  CHRYSLER: "Chrysler",
  CHRYSER: "Chrysler",
  CHRYSTER: "Chrysler",
  CIVC: "Civic",
  CRUISE: "Cruze",
  CRUZE: "Cruze",
  DODGE: "Dodge",
  FORD: "Ford",
  GMC: "GMC",
  HODA: "Honda",
  HONDA: "Honda",
  HYUNDAI: "Hyundai",
  INFINITI: "Infiniti",
  INFINITY: "Infiniti",
  ISUZU: "Isuzu",
  JEEP: "Jeep",
  KIA: "Kia",
  LANDCRUISER: "Land Cruiser",
  LEXUS: "Lexus",
  MAZDA: "Mazda",
  MERCURY: "Mercury",
  MERCEDESBENZ: "Mercedes-Benz",
  MERCEDES: "Mercedes-Benz",
  MERCERDES: "Mercedes-Benz",
  MERCEDS: "Mercedes-Benz",
  MITSUBISHI: "Mitsubishi",
  MUSTIBUSHI: "Mitsubishi",
  NISAAN: "Nissan",
  NISSAN: "Nissan",
  OYOTA: "Toyota",
  PONTIAC: "Pontiac",
  PEOGEOT: "Peugeot",
  PEUGEOT: "Peugeot",
  PORSCHE: "Porsche",
  RENAULT: "Renault",
  SKODA: "Skoda",
  SPINTER: "Sprinter",
  SUBARU: "Subaru",
  SUZUKI: "Suzuki",
  TACOMA: "Tacoma",
  TACOMMA: "Tacoma",
  TOYOTA: "Toyota",
  VOLKSWAGEN: "Volkswagen",
  VOLVO: "Volvo",
};

/** Words that open a make but are not makes themselves. */
const MAKE_LEAD_WORDS = new Set([
  "LAND",
  "RANGE",
  "ROVER",
  "MERCEDESBENZ",
  "BENZ",
]);

/** Makes listed first in a label; stripped when canonicalising an option. */
const MAKE_WORDS = new Set(Object.keys(MAKE_FIXES));

function lettersOnly(value: string): string {
  return value.replace(/[^A-Za-z]/g, "");
}

function cleanSegment(segment: string): string {
  return segment
    .replace(YEAR_RANGE, ",")
    .replace(LONE_YEAR, ",")
    .replace(EMPTY_BRACKETS, " ")
    .replace(LEADING_PART_CODE, " ")
    .replace(/,\s*,/g, ",")
    .replace(/\s+/g, " ")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .trim();
}

function keepToken(token: string): boolean {
  if (token.length < 3) return false;
  const key = lettersOnly(token).toLowerCase();
  if (!key) return false;
  if (NON_MODEL_WORDS.has(key)) return false;
  if (SHORT_CODE_TOKEN.test(token)) return false;
  if (MODEL_DESIGNATION.test(token)) return true;
  // "M-Class", "S-Class", "MX-5" — hyphenated designations, never noise.
  if (/^[A-Za-z]{1,4}-[A-Za-z]{1,5}\d*$/.test(token)) return true;
  // Part numbers ("23300-21010") but not model designations ("ES350").
  if (PART_NUMBER_TOKEN.test(token) && token.replace(/\D/g, "").length >= 5) {
    return false;
  }
  // "Patch/Tire", "Es300h 2.5l" — nothing left once the noise words go.
  const words = token.split(/[^A-Za-z]+/).filter((word) => word.length >= 3);
  if (
    words.length > 0 &&
    words.every((word) => NON_MODEL_WORDS.has(word.toLowerCase()))
  ) {
    return false;
  }
  // "2.5l" — a stray unit left behind after the year was stripped.
  if (lettersOnly(token).length < 3) return false;
  return /[A-Za-z]/.test(token);
}

/** Title-case one token, applying known make spellings. */
function formatToken(token: string): string {
  const key = lettersOnly(token).toUpperCase();
  if (MAKE_FIXES[key]) return MAKE_FIXES[key];
  return token
    .split(/([\s\-./])/)
    .map((part) => {
      const partKey = lettersOnly(part).toUpperCase();
      if (MAKE_FIXES[partKey]) return MAKE_FIXES[partKey];
      if (!/[A-Za-z]/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join("")
    .replace(/Mercedes-Benz-Benz/gi, "Mercedes-Benz")
    .replace(/Mercedes-Benz\s+Benz/gi, "Mercedes-Benz");
}

/**
 * Drop a leading make so "Toyota Camry" and "Camry" become one option.
 * Matching is a raw substring test, so the option still finds both.
 */
function canonicalise(label: string): string {
  let rest = label.trim();
  let changed = true;
  while (changed) {
    changed = false;
    const head = rest.match(/^([A-Za-z-]+)\s+(.*)$/);
    const headKey = head ? lettersOnly(head[1]!).toUpperCase() : "";
    if (head && (MAKE_WORDS.has(headKey) || MAKE_LEAD_WORDS.has(headKey))) {
      const remainder = head[2]!.trim();
      if (remainder && /[A-Za-z]/.test(remainder)) {
        rest = remainder;
        changed = true;
        continue;
      }
    }
    // "Highlander Toyota" — a make repeated after the model.
    const tail = rest.match(/^(.*?)\s+([A-Za-z-]+)$/);
    const tailKey = tail ? lettersOnly(tail[2]!).toUpperCase() : "";
    if (tail && MAKE_WORDS.has(tailKey) && lettersOnly(tail[1]!).length >= 3) {
      rest = tail[1]!.trim();
      changed = true;
    }
  }
  return rest || label.trim();
}

/** Raw fitment segments, cleaned of year ranges but otherwise unaltered. */
export function splitCarModelSegments(
  raw: string | null | undefined,
): string[] {
  if (!raw) return [];
  return raw
    .split(SEGMENT_SPLIT)
    .map(cleanSegment)
    .filter((segment) => segment.length > 0 && /[A-Za-z]/.test(segment));
}

/**
 * Curated model labels for one fitment value, e.g.
 * ["Corolla", "Corolla Axio", "Rav4"].
 */
export function carModelTokens(raw: string | null | undefined): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();

  for (const segment of splitCarModelSegments(raw)) {
    for (const piece of segment.split(",")) {
      const words = piece.split(/\s+/).filter(keepToken);
      if (words.length === 0) continue;
      const label = canonicalise(formatToken(words.join(" ")));
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tokens.push(label);
    }
  }

  return tokens;
}

/** Deduped, alphabetised model options across every fitment value. */
export function collectCarModelOptions(
  values: Array<string | null | undefined>,
): string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    for (const token of carModelTokens(value)) {
      const key = token.toLowerCase();
      if (!seen.has(key)) seen.set(key, token);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Case-insensitive fitment match — used for the filter dropdown. */
export function carModelMatches(
  raw: string | null | undefined,
  needle: string | null | undefined,
): boolean {
  const wanted = needle?.trim().toLowerCase();
  if (!wanted) return true;
  if (!raw) return false;
  return raw.toLowerCase().includes(wanted);
}

/**
 * Short label for a product card: the first couple of fitment segments,
 * truncated so a long blob never wraps the card.
 */
export function carModelSummary(
  raw: string | null | undefined,
  maxSegments = 2,
  maxLength = 44,
): string | null {
  const segments = splitCarModelSegments(raw);
  if (segments.length === 0) return null;

  const shown: string[] = [];
  for (const segment of segments) {
    if (shown.length >= maxSegments) break;
    const next = [...shown, segment].join(" · ");
    if (shown.length > 0 && next.length > maxLength) break;
    shown.push(segment);
  }

  const hidden = segments.length - shown.length;
  const suffix = hidden > 0 ? ` +${hidden}` : "";
  const text = `${shown.join(" · ")}${suffix}`;
  return text;
}
