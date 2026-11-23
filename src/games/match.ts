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

  /** Is `input` an acceptable answer for `target`? */
  isMatch(input: string, target: Member): boolean {
    const n = norm(input);
    if (!n) return false;
    const accepted = [target.name, target.lastName, ...target.aliases].map(norm);
    if (accepted.includes(n)) return true;
    const last = norm(target.lastName);
    if (n === last || n.endsWith(` ${last}`)) return true;
    // typo tolerance: best fuzzy hit must be the target and clearly ahead of the rest
    const hits = this.fuse.search(n, { limit: 2 });
    return hits[0]?.item.m.id === target.id && (hits[0].score ?? 1) < 0.3;
  }

  /** Who did they probably mean? (for the confusion log) */
  best(input: string): Member | null {
    const n = norm(input);
    if (!n) return null;
    const hit = this.fuse.search(n, { limit: 1 })[0];
    return hit && (hit.score ?? 1) < 0.35 ? hit.item.m : null;
  }

  suggest(input: string, n = 6): Member[] {
    const q = norm(input);
    return q ? this.fuse.search(q, { limit: n }).map((r) => r.item.m) : [];
  }

  get all(): Member[] {
    return this.members;
  }
}

/** "TX-35", "tx35", "TX 35", "DC", "AK-AL", "wy at large" -> {state, district}; district 0 = at-large. */
export function parseSeat(input: string, validStates: Set<string>): { state: string; district: number | null } | null {
  const s = input.trim().toUpperCase().replace(/AT[\s-]*LARGE/, "AL");
  const m = s.match(/^([A-Z]{2})\s*[-–]?\s*(\d{1,2}|AL)?$/);
  if (!m || !validStates.has(m[1])) return null;
  const d = m[2] === undefined ? null : m[2] === "AL" ? 0 : Number(m[2]);
  return { state: m[1], district: d };
}
