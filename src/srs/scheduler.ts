/** Thin wrapper around ts-fsrs: stored (JSON-safe) cards, reviews, interval previews. */
import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Card, type Grade } from "ts-fsrs";

export { Rating, State };
export type { Grade };

export interface StoredCard {
  due: string;
  stability: number;
  difficulty: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  learning_steps: number;
  state: number;
  last_review?: string;
}

const engine = fsrs(generatorParameters({ enable_fuzz: true, request_retention: 0.9 }));

export function newCard(now = new Date()): StoredCard {
  return toStored(createEmptyCard(now));
}

function toCard(c: StoredCard): Card {
  return {
    ...c,
    due: new Date(c.due),
    last_review: c.last_review ? new Date(c.last_review) : undefined,
    elapsed_days: 0,
  } as Card;
}

function toStored(c: Card): StoredCard {
  return {
    due: c.due.toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    scheduled_days: c.scheduled_days,
    reps: c.reps,
    lapses: c.lapses,
    learning_steps: c.learning_steps,
    state: c.state,
    last_review: c.last_review ? c.last_review.toISOString() : undefined,
  };
}

export function review(c: StoredCard, rating: Grade, now = new Date()): StoredCard {
  return toStored(engine.next(toCard(c), now, rating).card);
}

/** Human-readable next interval for each rating, for the rating buttons. */
export function previews(c: StoredCard, now = new Date()): Record<Grade, string> {
  const out = {} as Record<Grade, string>;
  for (const g of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as Grade[]) {
    out[g] = humanInterval(engine.next(toCard(c), now, g).card.due.getTime() - now.getTime());
  }
  return out;
}

export function humanInterval(ms: number): string {
  const min = ms / 60000;
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  const hr = min / 60;
  if (hr < 24) return `${Math.round(hr)} hr`;
  const d = hr / 24;
  if (d < 30) return `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"}`;
  const mo = d / 30;
  if (mo < 12) return `${Math.round(mo)} mo`;
  return `${(d / 365).toFixed(1)} yr`;
}

export function isDue(c: StoredCard, now = new Date()): boolean {
  return new Date(c.due).getTime() <= now.getTime();
}
