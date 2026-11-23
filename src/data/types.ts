/** Shape of public/data/members.json (see DATA_SOURCES.md for how each field is built). */
export type Party = "D" | "R" | "I";
export type Chamber = "house" | "senate";

export interface Committee { code: string; name: string; role?: string }
/** One race: WAR from the member's side (positive = ran ahead of baseline) against a named opponent. */
export interface WarPoint { year: number; value: number; chamber: Chamber; opponent: string; opponentParty: Party }

export interface Member {
  id: string;
  provisionalId: boolean;
  name: string;
  lastName: string;
  aliases: string[];
  party: Party;
  chamber: Chamber;
  state: string;
  district?: number;      // 0 = at-large or delegate
  senateClass?: 1 | 2 | 3;
  status: "continuing" | "reelected" | "elected";
  newToCongress: boolean;
  photo: string | null;
  firstElectedYear: number;
  yearsInCongress: number;
  committees: Committee[];
  committeeCongress: number;
  districtCities: string[];
  districtCounties: string[];
  kamala2Way: number | null;
  kamala2WaySource: "2024-lines" | "new-lines" | "pending" | "statewide" | "missing" | "n/a";
  /** Member's share of the top two in their latest general, and who that opponent was. */
  last2Way: { year: number; share: number; opponent: string | null; opponentParty: Party | null } | null;
  caucuses: { code: string; name: string; kind: "ideological" | "identity" }[];
  /** For independents: the party they caucus with. */
  partyCaucus?: "D" | "R";
  /** 2026 winner's party differs from the party that held the seat going in. */
  seatFlipped: boolean;
  /** e.g. "Red to Blue, flipped it", "Frontline incumbent on NRCC's target list, survived"; null if none. */
  raceRole: string | null;
  /** Party committee lists this member or seat was on in 2026. */
  targeting: { committee: string; program: string; dateAdded: string | null }[];
  /** Issue PACs that backed them, e.g. ["Club for Growth PAC", "Fairshake"]. */
  issuePacSupport: string[];
  /** Groups that spent against them or backed their 2026 general-election opponent. */
  issuePacOpposition: { group: string; why: string }[];
  /** Cycle they were on the DCCC's Red to Blue list (e.g. 2026). */
  redToBlue?: number;
  war: WarPoint[];
  warTrajectory: "rising" | "falling" | "steady" | "volatile" | "single" | null;
  fundraising?: { cycle: number; receipts: number; cashOnHand: number; disbursements: number };
  funFacts: string[];
}

export interface PendingSeat {
  seat: string;
  chamber: Chamber;
  state: string;
  district?: number;
  senateClass?: number;
  status: string;
  candidates: { name: string; party: string }[];
}
