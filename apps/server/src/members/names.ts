/**
 * Member names (§B.2): one name signs a person in and shows who did what, so two members must
 * never have names that look the same. A name is stored in its NFKC form, may not hold invisible
 * or format characters, and may not mix Latin with Greek or Cyrillic letters; names are compared
 * by `nameKey`, which also folds case and the letters those scripts share with Latin, and leaves
 * out spaces and punctuation.
 */

/**
 * Characters that show nothing or change how text around them shows: format characters (zero
 * width spaces and joiners, bidi controls, the soft hyphen, …), variation selectors, fillers that
 * render blank, line and paragraph separators, private-use and unassigned code points.
 */
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}ᅟᅠ⠀ㅤﾠ]/u;

/** Marks that show nothing: the grapheme joiner, Khmer and Mongolian ones, variation selectors. */
const BLANK_MARKS: ReadonlyArray<readonly [number, number]> = [
  [0x034f, 0x034f],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0xfe00, 0xfe0f],
  [0xe0100, 0xe01ef],
];

function hasInvisible(text: string): boolean {
  if (INVISIBLE.test(text)) return true;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (BLANK_MARKS.some(([from, to]) => code >= from && code <= to)) return true;
  }
  return false;
}

/** Scripts whose letters pass for Latin ones. */
const SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Greek}/u, /\p{Script=Cyrillic}/u];

/** Greek and Cyrillic capitals that read as a Latin capital. */
const CAPITALS: Record<string, string> = {
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  У: "Y",
  Ѕ: "S",
  І: "I",
  Ј: "J",
  Ԛ: "Q",
  Ԝ: "W",
  Ӏ: "I",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
};

/**
 * Lower-case letters and digits that read as the same Latin letter, after folding case. `I`,
 * `l`, `1` and `|` (and `0` and `o`) are hard to tell apart in many fonts, so they count as one.
 */
const SMALL: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  ѕ: "s",
  і: "l",
  ј: "j",
  ԁ: "d",
  ԛ: "q",
  ԝ: "w",
  һ: "h",
  ӏ: "l",
  ο: "o",
  ν: "v",
  ι: "l",
  κ: "k",
  ρ: "p",
  υ: "u",
  χ: "x",
  i: "l",
  ı: "l",
  "1": "l",
  "|": "l",
  "0": "o",
};

/** The form a name is stored in: NFKC, trimmed, inner runs of spaces made one space. */
export function normalizeName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

/** Why a name can't be used, or null. */
export function nameProblem(name: string): string | null {
  const normal = normalizeName(name);
  if (!normal) return "Enter a name.";
  if (hasInvisible(normal)) {
    return "Names can't contain invisible or formatting characters.";
  }
  const scripts = SCRIPTS.filter((script) => script.test(normal)).length;
  if (scripts > 1) {
    return "Names can't mix Latin letters with Greek or Cyrillic ones.";
  }
  return null;
}

/**
 * What names are compared by: two names with the same key look the same. Spaces and punctuation
 * don't count ("S am", "Sam." and "Sam" are one name), unless a name is nothing else.
 */
export function nameKey(name: string): string {
  const capitals = [...normalizeName(name)].map((ch) => CAPITALS[ch] ?? ch).join("");
  const folded = [...capitals.toLowerCase()].map((ch) => SMALL[ch] ?? ch).join("");
  return folded.replace(/[\s\p{P}]/gu, "") || folded;
}
