/**
 * Card generation per member (SCAFFOLD 5.1) and the daily study queue (5.3).
 * Card id = "<memberId>:<type>".
 */
import { HOLD_MIN_MEMBERS, MASTERED_STABILITY_DAYS, STATE_ROUTE, STATE_SOLID_DAYS, TIER2_STABILITY_DAYS } from "../config";
import type { AppData } from "../data/load";
import type { Member } from "../data/types";
import { getState, today, update } from "../store";
import { isDue, newCard, type StoredCard } from "./scheduler";

export type CardType =
  | "district->name" | "name->district" | "senator->class"
  | "face->name" | "name->face" | "name->party" | "shape->district"
  | "war" | "war-trajectory" | "kamala-2way" | "last-2way" | "first-elected" | "fundraising" | "committees";

export const TIER3_FACTS: { type: CardType; label: string }[] = [
  { type: "war", label: "WAR (latest race)" },
  { type: "war-trajectory", label: "WAR trajectory" },
  { type: "kamala-2way", label: "Harris 2-way share" },
  { type: "last-2way", label: "Last 2-way share" },
  { type: "first-elected", label: "First election year" },
  { type: "fundraising", label: "2026 fundraising" },
  { type: "committees", label: "Committees" },
];

export const CARD_LABEL: Record<CardType, string> = {
  "district->name": "District to name",
  "name->district": "Name to district",
  "senator->class": "Senate class",
  "face->name": "Face to name",
  "name->face": "Name to face",
  "name->party": "Party",
  "shape->district": "Shape to district",
  "war": "WAR",
  "war-trajectory": "WAR trajectory",
  "kamala-2way": "Harris 2-way",
  "last-2way": "Last 2-way",
  "first-elected": "First elected",
  "fundraising": "2026 fundraising",
  "committees": "Committees",
};

export function cardId(memberId: string, type: CardType): string {
  return `${memberId}:${type}`;
}

export function parseCardId(id: string): { memberId: string; type: CardType } {
  const i = id.indexOf(":");
  return { memberId: id.slice(0, i), type: id.slice(i + 1) as CardType };
}

export function tier1Types(m: Member): CardType[] {
  return m.chamber === "senate" ? ["district->name", "name->district", "senator->class"] : ["district->name", "name->district"];
}

export function tier2Types(m: Member, data: AppData): CardType[] {
  const t: CardType[] = ["name->party"];
  if (m.photo) {
    t.push("face->name");
    if (data.members.filter((x) => x.photo).length >= 4) t.push("name->face");
  }
  if (m.chamber === "house") {
    t.push("shape->district");
  }
  return t;
}

export function tier3Types(m: Member): CardType[] {
  const on = getState().settings.tier3;
  const t: CardType[] = [];
  if (on["war"] && m.war.length) t.push("war");
  if (on["war-trajectory"] && m.war.length >= 2 && m.warTrajectory) t.push("war-trajectory");
  if (on["kamala-2way"] && m.kamala2Way !== null) t.push("kamala-2way");
  if (on["last-2way"] && m.last2Way) t.push("last-2way");
  if (on["first-elected"]) t.push("first-elected");
  if (on["fundraising"] && m.fundraising) t.push("fundraising");
  if (on["committees"] && m.committees.length) t.push("committees");
  return t;
}

function stability(id: string): number {
  return getState().cards[id]?.stability ?? 0;
}

export function tier1Stable(m: Member): boolean {
  return tier1Types(m).every((t) => stability(cardId(m.id, t)) >= TIER2_STABILITY_DAYS);
}

/** 0 (just introduced) .. 5 (mastered); null if not introduced yet. */
export function masteryLevel(m: Member): number | null {
  if (!getState().introduced[m.id]) return null;
  const s = Math.min(...tier1Types(m).map((t) => stability(cardId(m.id, t))));
  const cuts = [1, 3, 7, 14, MASTERED_STABILITY_DAYS];
  let lvl = 0;
  for (const c of cuts) if (s >= c) lvl++;
  return lvl;
}

/** Members in introduction order: state route, then senators before House, then district number. */
export function introductionOrder(data: AppData): Member[] {
  const rank = new Map(STATE_ROUTE.map((s, i) => [s, i]));
  return [...data.members].sort((a, b) =>
    (rank.get(a.state) ?? 99) - (rank.get(b.state) ?? 99) ||
    (a.chamber === b.chamber ? 0 : a.chamber === "senate" ? -1 : 1) ||
    (a.district ?? 0) - (b.district ?? 0) || (a.senateClass ?? 0) - (b.senateClass ?? 0));
}

/** How well a state's delegation has stuck: core cards at STATE_SOLID_DAYS stability or more. */
export function stateProgress(data: AppData, state: string) {
  const st = getState();
  const members = data.members.filter((m) => m.state === state);
  const introduced = members.filter((m) => st.introduced[m.id]);
  const cards = introduced.flatMap((m) => tier1Types(m).map((t) => cardId(m.id, t)));
  const solid = cards.filter((id) => (st.cards[id]?.stability ?? 0) >= STATE_SOLID_DAYS).length;
  return { state, members: members.length, introduced: introduced.length, cards: cards.length, solid };
}

/**
 * The state holding up new members, if any: the most recently finished state (every member
 * introduced) whose core cards haven't all stuck yet. null when nothing is on hold.
 */
export function stateHold(data: AppData): ReturnType<typeof stateProgress> | null {
  const s = getState().settings;
  if (!s.holdAfterState || s.holdOverride === today()) return null;
  const intro = getState().introduced;
  const order = introductionOrder(data);
  const started = STATE_ROUTE.filter((st) => order.some((m) => m.state === st && intro[m.id]));
  const size = (st: string) => order.filter((m) => m.state === st).length;
  const finished = started.filter((st) => size(st) >= HOLD_MIN_MEMBERS && order.filter((m) => m.state === st).every((m) => intro[m.id]));
  const last = finished.at(-1);
  if (!last) return null;
  // a later state already underway (e.g. you added anyway) takes over; don't hold on the old one
  if (started.indexOf(last) !== started.length - 1) return null;
  const p = stateProgress(data, last);
  return p.solid >= p.cards ? null : p;
}

/**
 * Next members to introduce, in route order. With the hold on, a day never crosses into a
 * new state, and nothing new comes while the last finished state is still sinking in.
 */
export function nextNewMembers(data: AppData, n: number): Member[] {
  const intro = getState().introduced;
  const rest = introductionOrder(data).filter((m) => !intro[m.id]);
  if (!getState().settings.holdAfterState || getState().settings.holdOverride === today()) return rest.slice(0, n);
  if (stateHold(data)) return [];
  // take members in order, but stop at the end of a big delegation so it can sink in
  const out: Member[] = [];
  for (const m of rest) {
    if (out.length >= n) break;
    out.push(m);
    const stateDone = !rest.some((x) => x.state === m.state && !out.includes(x));
    if (stateDone && data.members.filter((x) => x.state === m.state).length >= HOLD_MIN_MEMBERS) break;
  }
  return out;
}

/** Every live card for the introduced members of one state, weakest first (for drills). */
export function stateCards(data: AppData, state: string): string[] {
  const st = getState();
  return liveCards(data)
    .filter(([id]) => data.byId.get(parseCardId(id).memberId)?.state === state)
    .sort((a, b) => (a[1].stability - b[1].stability) || (b[1].lapses - a[1].lapses))
    .map(([id]) => id)
    .filter((id) => st.introduced[parseCardId(id).memberId]);
}

/** States you've started, in route order, with how well each has stuck. */
export function startedStates(data: AppData) {
  const intro = getState().introduced;
  return STATE_ROUTE.filter((st) => data.members.some((m) => m.state === st && intro[m.id])).map((st) => stateProgress(data, st));
}

export function introducedToday(): number {
  const t = today();
  return Object.values(getState().introduced).filter((d) => d === t).length;
}

export function newRemainingToday(): number {
  return Math.max(0, getState().settings.newPerDay - introducedToday());
}

/**
 * Make sure every unlocked card exists: Tier 2 for members whose Tier 1 is stable,
 * Tier 3 for those members when the fact is switched on in Settings.
 */
export function syncUnlocks(data: AppData, now = new Date()): void {
  update((s) => {
    for (const id of Object.keys(s.introduced)) {
      const m = data.byId.get(id);
      if (!m) continue;
      for (const t of tier1Types(m)) s.cards[cardId(m.id, t)] ??= newCard(now);
      if (tier1Stable(m)) {
        for (const t of [...tier2Types(m, data), ...tier3Types(m)]) s.cards[cardId(m.id, t)] ??= newCard(now);
      }
    }
  });
}

export function introduce(members: Member[], now = new Date()): void {
  const t = today(now);
  update((s) => {
    for (const m of members) {
      s.introduced[m.id] ??= t;
      for (const type of tier1Types(m)) s.cards[cardId(m.id, type)] ??= newCard(now);
    }
  });
}

/** Cards eligible right now (member still in Congress, card type still enabled). */
function liveCards(data: AppData): [string, StoredCard][] {
  const on = getState().settings.tier3;
  const tier3 = new Set(TIER3_FACTS.map((f) => f.type));
  return Object.entries(getState().cards).filter(([id]) => {
    const { memberId, type } = parseCardId(id);
    if (!data.byId.has(memberId) || !(type in CARD_LABEL)) return false; // retired card types (e.g. old city cards)
    return !tier3.has(type) || on[type];
  });
}

export function dueCards(data: AppData, now = new Date()): string[] {
  return liveCards(data)
    .filter(([, c]) => isDue(c, now) && c.reps > 0)
    .sort((a, b) => a[1].due.localeCompare(b[1].due))
    .map(([id]) => id);
}

/** Never-reviewed cards for members already introduced (new members land here). */
export function unseenCards(data: AppData): string[] {
  const order = new Map(introductionOrder(data).map((m, i) => [m.id, i]));
  const typeRank = (t: CardType) => ["district->name", "senator->class", "name->district"].indexOf(t);
  return liveCards(data)
    .filter(([, c]) => c.reps === 0)
    .map(([id]) => id)
    .sort((a, b) => {
      const pa = parseCardId(a), pb = parseCardId(b);
      return (order.get(pa.memberId) ?? 0) - (order.get(pb.memberId) ?? 0) || typeRank(pa.type) - typeRank(pb.type);
    });
}

/** Forecast of reviews due per day for the next `days` days. */
export function dueForecast(data: AppData, days = 14): number[] {
  const out = new Array(days).fill(0);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  for (const [, c] of liveCards(data)) {
    if (c.reps === 0) continue;
    const d = Math.floor((new Date(c.due).getTime() - start.getTime()) / 86400000);
    out[Math.max(0, Math.min(days - 1, d))] += d < days ? 1 : 0;
  }
  return out;
}
