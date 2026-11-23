/** Answer checking: fuzzy names (last name alone is fine) and seat strings like "TX-35". */
import Fuse from "fuse.js";
import type { Member } from "../data/types";

export function norm(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\(.*?\)|["“”']/g, "")
    .replace(/[^a-z\s-]/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter((t) => t && !["jr", "sr", "ii", "iii", "iv"].includes(t))
    .join(" ");
}

export class NameMatcher {
  private fuse: Fuse<{ m: Member; keys: string[] }>;

  constructor(private members: Member[]) {
    const docs = members.map((m) => ({ m, keys: [m.name, m.lastName, ...m.aliases].map(norm) }));
    this.fuse = new Fuse(docs, { keys: ["keys"], threshold: 0.34, ignoreLocation: true, includeScore: true });
  }

  /**
   * Is `input` an acceptable answer for `target`? The rule, in order:
   *  1. Their full name, an alias, or their last name (also "First Last") counts.
   *  2. Exactly typing someone else's name never counts: that's a different person.
   *  3. Small slips count: one edit (wrong, missing, extra or swapped letter) from any of
   *     their names, two for names of 7+ letters, as long as no other member is closer.
   *     Ties go to the person you were asked about ("Kin" on a Kim card is Kim).
   *  4. Partial compound names ("Ocasio" for Ocasio-Cortez) via the fuzzy index.
   */
  isMatch(input: string, target: Member): boolean {
    const n = norm(input);
    if (!n) return false;
    const mine = this.keysOf(target);
    const last = norm(target.lastName);
    if (mine.includes(n) || n === last || n.endsWith(` ${last}`)) return true;
    if (this.members.some((m) => m.id !== target.id && this.keysOf(m).includes(n))) return false;

    const dMine = Math.min(...mine.map((k) => typoDistance(k, n)));
    const budget = (len: number) => (len >= 7 ? 2 : 1);
    if (dMine <= Math.max(...mine.map((k) => (typoDistance(k, n) === dMine ? budget(k.length) : 0)))) {
      const dOther = Math.min(...this.members.filter((m) => m.id !== target.id)
        .flatMap((m) => this.keysOf(m).map((k) => typoDistance(k, n))));
      if (dMine <= dOther) return true;
    }
    // partial compound names, spacing: best fuzzy hit must be the target
    const hits = this.fuse.search(n, { limit: 2 });
    return hits[0]?.item.m.id === target.id && (hits[0].score ?? 1) < 0.3;
  }

  private keyCache = new Map<string, string[]>();
  private keysOf(m: Member): string[] {
    let k = this.keyCache.get(m.id);
    if (!k) {
      k = [...new Set([m.name, m.lastName, ...m.aliases].map(norm).filter(Boolean))];
      this.keyCache.set(m.id, k);
    }
    return k;
  }

  /**
   * Strict check for instant feedback while typing: the full name, an alias, or the exact
   * last name. No typo tolerance, so a half-typed name never counts.
   */
  isExact(input: string, target: Member): boolean {
    const n = norm(input);
    if (!n) return false;
    return [target.name, target.lastName, ...target.aliases].map(norm).includes(n);
  }

  /**
   * Who did they clearly mean? Used to log mix-ups ("you said Deluzio"), so it must be
   * confident: the input has to be another member's name, alias or last name, or within
   * one typo of it, and nobody else can be that close. A guess like "Deluria" (meant
   * Luria) is just wrong, not a mix-up with Deluzio. Returns null when unsure.
   */
  best(input: string): Member | null {
    const n = norm(input);
    if (n.length < 3) return null;
    const candidates = this.fuse.search(n, { limit: 8 }).map((r) => r.item.m);
    const close = candidates.filter((m) => {
      const keys = [m.name, m.lastName, ...m.aliases].map(norm);
      return keys.some((k) => k === n || (k.length >= 5 && typoDistance(k, n) <= 1));
    });
    return close.length === 1 ? close[0] : null;
  }

  suggest(input: string, n = 6): Member[] {
    const q = norm(input);
    return q ? this.fuse.search(q, { limit: n }).map((r) => r.item.m) : [];
  }

  get all(): Member[] {
    return this.members;
  }
}

/**
 * "TX-35", "tx35", "TX 35", "DC", "AK-AL", "wy at large", and with full names:
 * "Maryland", "Maryland 3", "Maryland's 3rd", "District of Columbia" -> {state, district}.
 * district 0 = at-large; null = only a state was given.
 */
export function parseSeat(input: string, validStates: Set<string>, stateNames?: Map<string, string>): { state: string; district: number | null } | null {
  let s = input.trim().toUpperCase().replace(/AT[\s-]*LARGE/, "AL").replace(/[’']S\b/, "").replace(/(\d)(ST|ND|RD|TH)\b/, "$1");
  if (stateNames) {
    // swap a leading full state name for its abbreviation (longest names first: "West Virginia" before "Virginia")
    const names = [...stateNames.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [abbr, name] of names) {
      const n = name.toUpperCase();
      if (s === n || s.startsWith(`${n} `) || s.startsWith(`${n}-`)) {
        s = abbr + s.slice(n.length);
        break;
      }
    }
  }
  s = s.replace(/\bDISTRICT\b|\bCD\b|#/g, " ").replace(/\s+/g, " ").trim();
  const m = s.match(/^([A-Z]{2})\s*[-–]?\s*(\d{1,2}|AL)?$/);
  if (!m || !validStates.has(m[1])) return null;
  const d = m[2] === undefined ? null : m[2] === "AL" ? 0 : Number(m[2]);
  return { state: m[1], district: d };
}

/**
 * Typo distance: edits needed, where a wrong, missing or extra letter, or two neighboring
 * letters swapped ("Luira" for "Luria"), each count as one. Capped at 3 for speed.
 */
export function typoDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return Math.min(3, d[a.length][b.length]);
}
