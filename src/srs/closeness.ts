/** Numeric answers are scored on how close you were (SCAFFOLD 5.2), then mapped to FSRS ratings. */
import { Rating, type Grade } from "./scheduler";

export type NumericFact = "war" | "share" | "year" | "money";

const ENDPOINTS: Record<NumericFact, [number, number]> = {
  war: [0.5, 5],      // absolute WAR points
  share: [1, 10],     // absolute percentage points
  year: [0, 10],      // years
  money: [0.05, 1],   // |log10(guess / actual)|
};

/** 0-100, linear between "perfect at" and "zero at". */
export function closeness(fact: NumericFact, guess: number, actual: number): number {
  let err: number;
  if (fact === "money") err = Math.abs(Math.log10(Math.max(guess, 1) / Math.max(actual, 1)));
  else if (fact === "share") err = Math.abs(guess - actual) * (Math.abs(actual) <= 1 ? 100 : 1);
  else err = Math.abs(guess - actual);
  const [full, zero] = ENDPOINTS[fact];
  if (err <= full) return 100;
  if (err >= zero) return 0;
  return Math.round(100 * (1 - (err - full) / (zero - full)));
}

export function ratingForScore(score: number): Grade {
  if (score >= 90) return Rating.Easy;
  if (score >= 70) return Rating.Good;
  if (score >= 40) return Rating.Hard;
  return Rating.Again;
}

/** Exact cards: correct and fast = Easy, correct = Good, correct and slow = Hard, wrong = Again. */
export function ratingForExact(correct: boolean, ms: number, fastMs: number, slowMs: number, partial = false): Grade {
  if (!correct) return partial ? Rating.Hard : Rating.Again;
  if (ms <= fastMs) return Rating.Easy;
  if (ms >= slowMs) return Rating.Hard;
  return Rating.Good;
}
