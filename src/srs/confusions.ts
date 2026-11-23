/** Mixed-up pairs: when you answer B but the answer was A. */
import { getState, update } from "../store";

export function recordConfusion(answerId: string, givenId: string): void {
  if (!givenId || answerId === givenId) return;
  update((s) => {
    const key = `${answerId}|${givenId}`;
    s.confusions[key] = (s.confusions[key] ?? 0) + 1;
  });
}

/** Pairs ranked by total mix-ups in either direction. */
export function topConfusions(n = 10): { a: string; b: string; count: number }[] {
  const merged = new Map<string, { a: string; b: string; count: number }>();
  for (const [key, count] of Object.entries(getState().confusions)) {
    const [x, y] = key.split("|");
    const [a, b] = [x, y].sort();
    const k = `${a}|${b}`;
    const cur = merged.get(k) ?? { a, b, count: 0 };
    cur.count += count;
    merged.set(k, cur);
  }
  return [...merged.values()].sort((p, q) => q.count - p.count).slice(0, n);
}
