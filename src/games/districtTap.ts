/** District Tap rules (SCAFFOLD 6.1): who is in today's puzzle, scoring, emoji. */
import { TAP_HOUSE_ROUNDS, TAP_SCALE_MILES, TAP_SENATE_ROUNDS } from "../config";
import type { AppData } from "../data/load";
import type { Member } from "../data/types";
import { rng, shuffle } from "./seed";

/** Members we can draw on the map (everything has a shape, territories included). */
function eligible(data: AppData): { house: Member[]; senate: Member[] } {
  return {
    house: data.members.filter((m) => m.chamber === "house" && data.districtById.has(`${m.state}-${m.district ? String(m.district).padStart(2, "0") : "AL"}`)),
    senate: data.members.filter((m) => m.chamber === "senate" && data.stateById.has(m.state)),
  };
}

export function puzzleMembers(data: AppData, seed: string): Member[] {
  const r = rng(`district-tap:${seed}`);
  const { house, senate } = eligible(data);
  const picks = [...shuffle(house, r).slice(0, TAP_HOUSE_ROUNDS), ...shuffle(senate, r).slice(0, TAP_SENATE_ROUNDS)];
  return shuffle(picks, r);
}

export function tapScore(miles: number): number {
  return Math.round(100 * Math.exp(-miles / TAP_SCALE_MILES));
}

export function tapEmoji(miles: number): string {
  if (miles <= 0) return "🎯";
  if (miles < 25) return "🔥";
  if (miles < 75) return "🌶️";
  if (miles < 150) return "☀️";
  if (miles < 400) return "🧊";
  return "💀";
}
