/** App-wide settings. Data-pipeline settings live in scripts/config.py. */

export const SITE_URL = "https://lwgover.github.io/memorizing-congress/";

/** Day 1 of District Tap. Puzzle number = days since this date + 1. */
export const LAUNCH_DATE = "2026-11-22";

/** Committee assignments shown in the app come from this Congress (flip with the pipeline). */
export const COMMITTEE_CONGRESS = 119;

/** Default new members introduced per day (changeable in Settings). */
export const DEFAULT_NEW_PER_DAY = 15;

/** Tier 2 cards unlock once all of a member's Tier 1 cards reach this stability (days). */
export const TIER2_STABILITY_DAYS = 7;

/**
 * After you finish a state, new members wait until every core card for that state
 * (name <-> district, Senate class) has at least this stability (days) — i.e. it sticks.
 */
export const STATE_SOLID_DAYS = 3;

/** Only delegations this big trigger the hold; smaller ones (DC, DE, VT, WY, ...) roll into the next state. */
export const HOLD_MIN_MEMBERS = 4;

/** A card counts as "mastered" on the mastery map at this stability (days). */
export const MASTERED_STABILITY_DAYS = 21;

/** District Tap: rounds per day, House/Senate split, scoring scale (miles). */
export const TAP_HOUSE_ROUNDS = 4;
export const TAP_SENATE_ROUNDS = 1;
export const TAP_SCALE_MILES = 150;

/** Answer speed thresholds for exact cards (ms): faster than FAST = Easy, slower than SLOW = Hard. */
export const FAST_MS = 4000;
export const SLOW_MS = 12000;

/**
 * Fixed route around the map for introducing state delegations (contiguous where possible),
 * starting in the mid-Atlantic. Every jurisdiction appears exactly once.
 */
export const STATE_ROUTE = [
  "DC", "MD", "VA", "DE", "PA", "NJ", "NY", "CT", "RI", "MA", "VT", "NH", "ME",
  "OH", "WV", "KY", "TN", "NC", "SC", "GA", "FL", "AL", "MS", "LA", "AR", "MO",
  "IN", "MI", "IL", "WI", "MN", "IA", "NE", "KS", "OK", "TX", "NM", "CO", "WY",
  "SD", "ND", "MT", "ID", "UT", "AZ", "NV", "CA", "OR", "WA", "AK", "HI",
  "PR", "VI", "GU", "MP", "AS",
];
