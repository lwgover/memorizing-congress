/**
 * Everything the app remembers about you, in localStorage under one key.
 * Export/import in Settings moves it between devices. Mnemonics live only here.
 */
import { DEFAULT_NEW_PER_DAY } from "./config";
import type { StoredCard } from "./srs/scheduler";

export interface TapRecord { date: string; puzzle: number; scores: number[]; miles: number[]; total: number }

export interface AppState {
  version: 1;
  settings: {
    newPerDay: number;
    tier3: Record<string, boolean>;
    theme: "system" | "light" | "dark";
    tapPhoto: boolean;
    /** Pause new members after finishing a state until it sticks. */
    holdAfterState: boolean;
    /** Date (YYYY-MM-DD) you chose "add new members anyway" despite the hold. */
    holdOverride?: string;
  };
  cards: Record<string, StoredCard>;        // card id -> FSRS state
  introduced: Record<string, string>;       // member id -> date first introduced (YYYY-MM-DD)
  mnemonics: Record<string, string>;        // member id -> your mnemonic
  confusions: Record<string, number>;       // "A|B" (answer|given) -> count
  log: { date: string; reviews: number; correct: number; newCount: number }[];
  tap: TapRecord[];
  tests: { date: string; mode: string; format: string; score: number; max: number }[];
}

const KEY = "memorizing-congress:v1";

function fresh(): AppState {
  return {
    version: 1,
    settings: { newPerDay: DEFAULT_NEW_PER_DAY, tier3: {}, theme: "system", tapPhoto: true, holdAfterState: true },
    cards: {}, introduced: {}, mnemonics: {}, confusions: {}, log: [], tap: [], tests: [],
  };
}

let state: AppState = load();

function load(): AppState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const parsed = JSON.parse(raw);
    return { ...fresh(), ...parsed, settings: { ...fresh().settings, ...(parsed.settings ?? {}) } };
  } catch {
    return fresh();
  }
}

export function getState(): AppState {
  return state;
}

export function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // storage full or blocked; the app keeps working for this session
  }
}

export function update(fn: (s: AppState) => void): void {
  fn(state);
  save();
}

export function exportState(): string {
  return JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
}

export function importState(text: string): void {
  const parsed = JSON.parse(text);
  if (parsed?.version !== 1 || typeof parsed.cards !== "object") {
    throw new Error("That file isn't a Memorizing Congress export.");
  }
  delete parsed.exportedAt;
  state = { ...fresh(), ...parsed, settings: { ...fresh().settings, ...(parsed.settings ?? {}) } };
  save();
}

export function resetState(): void {
  state = fresh();
  save();
}

/** Local calendar date as YYYY-MM-DD. */
export function today(d = new Date()): string {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayLog() {
  const t = today();
  let entry = state.log.find((l) => l.date === t);
  if (!entry) {
    entry = { date: t, reviews: 0, correct: 0, newCount: 0 };
    state.log.push(entry);
  }
  return entry;
}

/** Consecutive days ending today (or yesterday) with at least one review. */
export function studyStreak(): number {
  const days = new Set(state.log.filter((l) => l.reviews > 0).map((l) => l.date));
  return streakFrom(days);
}

export function streakFrom(days: Set<string>): number {
  const d = new Date();
  if (!days.has(today(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (days.has(today(d))) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}
