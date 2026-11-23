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
