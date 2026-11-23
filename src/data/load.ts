import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { Member, PendingSeat } from "./types";
import { rewind } from "../map/geometry";

export interface DistrictProps { id: string; state: string; district: number; name: string }
export interface StateProps { id: string; name: string }
export type DistrictFeature = Feature<Geometry, DistrictProps>;
export type StateFeature = Feature<Geometry, StateProps>;

export interface AppData {
  members: Member[];
  byId: Map<string, Member>;
  /** House member (or pending seat) by district id, e.g. "TX-35" */
  houseBySeat: Map<string, Member>;
  senatorsByState: Map<string, Member[]>;
  districts: DistrictFeature[];
  districtById: Map<string, DistrictFeature>;
  states: StateFeature[];
  stateById: Map<string, StateFeature>;
  pending: PendingSeat[];
  stateNames: Map<string, string>;
}

const base = import.meta.env.BASE_URL;

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${base}${path}`);
  if (!r.ok) throw new Error(`Couldn't load ${path} (${r.status})`);
  return r.json() as Promise<T>;
}

export function assetUrl(path: string): string {
  return `${base}${path}`;
}

export function seatId(m: { state: string; district?: number }): string {
  return `${m.state}-${!m.district ? "AL" : String(m.district).padStart(2, "0")}`;
}

/** Display label: "TX-35", "DC-AL", or "TX · Class II" for senators. */
export function seatLabel(m: Member): string {
  return m.chamber === "senate" ? `${m.state} · Class ${roman(m.senateClass!)}` : seatId(m);
}

export function roman(n: number): string {
  return ["", "I", "II", "III"][n] ?? String(n);
}

export async function loadData(): Promise<AppData> {
  const [members, dTopo, sTopo, pending] = await Promise.all([
    getJson<Member[]>("data/members.json"),
    getJson<any>("data/districts.topo.json"),
    getJson<any>("data/states.topo.json"),
    getJson<PendingSeat[]>("data/pending_seats.json").catch(() => [] as PendingSeat[]),
  ]);
  const districts = (feature(dTopo, dTopo.objects.districts) as unknown as FeatureCollection<Geometry, DistrictProps>).features.map(rewind);
  const states = (feature(sTopo, sTopo.objects.states) as unknown as FeatureCollection<Geometry, StateProps>).features.map(rewind);

  const byId = new Map(members.map((m) => [m.id, m]));
  const houseBySeat = new Map<string, Member>();
  const senatorsByState = new Map<string, Member[]>();
  for (const m of members) {
    if (m.chamber === "house") houseBySeat.set(seatId(m), m);
    else senatorsByState.set(m.state, [...(senatorsByState.get(m.state) ?? []), m]);
  }
  for (const list of senatorsByState.values()) list.sort((a, b) => a.senateClass! - b.senateClass!);
  return {
    members, byId, houseBySeat, senatorsByState, pending,
    districts, districtById: new Map(districts.map((d) => [d.properties.id, d])),
    states, stateById: new Map(states.map((s) => [s.properties.id, s])),
    stateNames: new Map(states.map((s) => [s.properties.id, s.properties.name])),
  };
}
