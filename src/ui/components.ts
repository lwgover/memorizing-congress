/** Shared UI pieces: party chip, photo, sparkline, mini district maps, the reveal card. */
import { geoConicEqualArea, geoPath, geoCentroid, type GeoPermissibleObjects } from "d3-geo";
import type { AppData } from "../data/load";
import { assetUrl, seatId, seatLabel } from "../data/load";
import type { Member, Party, WarPoint } from "../data/types";
import { getState, update } from "../store";
import { fmtMoney, fmtPct, h, initials, s } from "./dom";

export const PARTY_NAME: Record<Party, string> = { D: "Democrat", R: "Republican", I: "Independent" };
export const PARTY_VAR: Record<Party, string> = { D: "var(--dem)", R: "var(--rep)", I: "var(--ind)" };

const DELEGATE_STATES = new Set(["DC", "AS", "GU", "MP", "VI"]);

/** "Senator", "Representative", "Delegate" (DC + territories) or "Resident Commissioner" (PR). */
export function roleLabel(m: Member): string {
  if (m.chamber === "senate") return "Senator";
  if (m.state === "PR") return "Resident Commissioner";
  if (DELEGATE_STATES.has(m.state)) return "Delegate";
  return "Representative";
}

/** Solid badge for the Senate, outlined for the House, so the two read differently at a glance. */
export function roleChip(m: Member): HTMLElement {
  return h(`span.role.${m.chamber}`, { title: m.chamber === "senate" ? "U.S. Senate" : "U.S. House" }, roleLabel(m));
}

/** Big name for prompts, with the role badge next to it. */
export function promptName(m: Member, text: string = m.name): HTMLElement {
  return h("div.row", { style: "gap:10px;align-items:center" }, h("div.prompt-name", text), roleChip(m));
}

const PROGRAM_LABEL: Record<string, string> = {
  "DCCC|Red to Blue": "DCCC Red to Blue", "DCCC|Frontline": "DCCC Frontline", "DCCC|Districts in Play": "DCCC Districts in Play",
  "NRCC|MAGA Majority": "NRCC MAGA Majority", "NRCC|Patriot Program": "NRCC Patriot Program", "NRCC|Target list": "NRCC target list",
};

/** "2026 race": how they won (raceRole), whether the seat flipped, which lists targeted it, PAC backing. */
export function raceSection(m: Member): HTMLElement | null {
  const lists = (m.targeting ?? []).map((t) => PROGRAM_LABEL[`${t.committee}|${t.program}`] ?? `${t.committee} ${t.program}`);
  const pacs = m.issuePacSupport ?? [];
  if (!m.raceRole && !m.seatFlipped && !lists.length && !pacs.length) return null;
  const flip = m.seatFlipped
    ? h("span.flip", { style: `--c:${PARTY_VAR[m.party]}`, title: "The winner's party differs from the party that held the seat" }, `Flipped to ${m.party === "D" ? "Democrats" : m.party === "R" ? "Republicans" : "an independent"}`)
    : null;
  return h("div.stack", { style: "gap:8px" },
    h("div.eyebrow", "2026 race"),
    m.raceRole || flip ? h("div.row", { style: "gap:8px" }, m.raceRole ? h("b", m.raceRole) : null, flip) : null,
    lists.length ? h("div.chips", ...lists.map((l) => h("span.caucus", l))) : null,
    pacs.length ? h("p.small", h("span.muted", "Backed by: "), pacs.join(", ")) : null);
}

/** Flag for members the DCCC put on its Red to Blue list (top challengers in GOP-held seats). */
export function redToBlueChip(m: Member): HTMLElement | null {
  if (!m.redToBlue) return null;
  return h("span.r2b", { title: `On the DCCC's Red to Blue list for ${m.redToBlue}: a top Democratic challenger in a Republican-held or competitive seat` },
    `Red to Blue ’${String(m.redToBlue).slice(2)}`);
}

export function partyChip(p: Party): HTMLElement {
  return h(`span.party.${p}`, PARTY_NAME[p]);
}

export function photo(m: Member, cls = "photo"): HTMLElement {
  if (m.photo) {
    return h("img", { class: cls, src: assetUrl(m.photo), alt: m.name, loading: "lazy", width: 225, height: 275 });
  }
  return h(`div.${cls}`, { role: "img", "aria-label": `${m.name} (no photo yet)` }, initials(m.name));
}

export function fmtWar(v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;
}

/** WAR is a two-candidate race, so it is always shown with the opponent: "2024 vs. Gerald Malloy (R)". */
export function warRace(p: WarPoint): string {
  return `${p.year} vs. ${p.opponent} (${p.opponentParty})`;
}

export function sparkline(war: WarPoint[], party: Party, w = 120, hgt = 36, scale = 6): SVGElement {
  const svg = s("svg", { viewBox: `0 0 ${w} ${hgt}`, width: "100%", height: hgt, role: "img", "aria-label": `WAR ${war.map((p) => p.value).join(", ")}` });
  const mid = hgt / 2;
  svg.append(s("line", { x1: 0, x2: w, y1: mid, y2: mid, stroke: "var(--line)", "stroke-dasharray": "3 3" }));
  if (!war.length) return svg;
  const y = (v: number) => mid - Math.max(-scale, Math.min(scale, v)) * (mid - 4) / scale;
  const x = (i: number) => (war.length === 1 ? w / 2 : 6 + i * (w - 12) / (war.length - 1));
  const color = PARTY_VAR[party];
  svg.append(s("polyline", { points: war.map((p, i) => `${x(i)},${y(p.value)}`).join(" "), fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round" }));
  war.forEach((p, i) => {
    const dot = s("circle", { cx: x(i), cy: y(p.value), r: i === war.length - 1 ? 3.5 : 2.2, fill: color });
    const t = s("title");
    t.textContent = `${warRace(p)}: ${fmtWar(p.value)}`;
    dot.append(t);
    svg.append(dot);
  });
  return svg;
}

/**
 * A state's districts on their own projection. highlight = district id (or state id for senators).
 * silhouette = draw only the highlighted shape, no context (District -> Name hard mode).
 */
export function districtMini(data: AppData, state: string, opts: { highlight?: string | null; color?: string; silhouette?: boolean; size?: number } = {}): SVGElement {
  const size = opts.size ?? 340;
  const feats = opts.silhouette
    ? [data.districtById.get(opts.highlight ?? "") ?? data.stateById.get(state)!].filter(Boolean)
    : data.districts.filter((d) => d.properties.state === state);
  const fc = { type: "FeatureCollection", features: feats.length ? feats : [data.stateById.get(state)!] } as any;
  const [lon, lat] = geoCentroid(fc);
  const proj = geoConicEqualArea().parallels([lat - 3, lat + 3]).rotate([-lon, 0]).center([0, lat]);
  proj.fitExtent([[10, 10], [size - 10, size - 10]], fc);
  const path = geoPath(proj);
  const svg = s("svg", { viewBox: `0 0 ${size} ${size}`, role: "img", "aria-label": opts.silhouette ? "District shape" : `Map of ${data.stateNames.get(state) ?? state}` });
  for (const f of fc.features) {
    const id = f.properties.id;
    const hl = opts.highlight && (id === opts.highlight || (opts.highlight === state && !opts.silhouette));
    svg.append(s("path", {
      d: path(f as GeoPermissibleObjects) ?? "",
      fill: hl ? (opts.color ?? "var(--ink)") : "var(--map-land)",
      stroke: "var(--map-edge)", "stroke-width": 1.5, "stroke-linejoin": "round",
    }));
  }
  return svg;
}

export function promptMap(data: AppData, m: Member, opts: { silhouette?: boolean; color?: string } = {}): HTMLElement {
  const hl = m.chamber === "house" ? seatId(m) : m.state;
  return h("div.map-box.static", { style: "padding:12px;display:grid;place-items:center" },
    h("div", { style: "width:100%;max-width:340px" }, districtMini(data, m.state, { highlight: hl, silhouette: opts.silhouette, color: opts.color })));
}

function kamalaText(m: Member): HTMLElement {
  switch (m.kamala2WaySource) {
    case "pending": return h("span.v.sm", "Pending. Redrawn for 2026");
    case "missing": return h("span.v.sm", "Not loaded yet");
    case "n/a": return h("span.v.sm", "No presidential vote");
    default: return h("span.v", fmtPct(m.kamala2Way));
  }
}

const TRAJ: Record<string, string> = { rising: "Rising", falling: "Falling", steady: "Steady", volatile: "Volatile", single: "One race" };

/** The elaboration screen after every answer (SCAFFOLD 5.4). */
export function revealCard(data: AppData, m: Member, opts: { showMnemonic?: boolean; missed?: boolean } = {}): HTMLElement {
  const since = m.newToCongress ? "New for 2027" : `First elected ${m.firstElectedYear} · ${m.yearsInCongress} yr`;
  const war = m.war;
  const last = war.at(-1);
  const facts = m.funFacts.length ? h("p.small.muted", h("b", { style: "color:var(--ink)" }, "Fun fact: "), m.funFacts[0]) : null;
  const card = h("div.panel.stack", { style: "gap:18px" },
    h("div.who-row",
      photo(m),
      h("div",
        h("div.name", m.name),
        h("div.meta", roleChip(m), partyChip(m.party), redToBlueChip(m), h("span.code", seatLabel(m)), h("span", since)))),
    h("div.grid-2", { style: "grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap:14px; align-items:start" },
      h("div", { style: "max-width:220px" }, districtMini(data, m.state, { highlight: m.chamber === "house" ? seatId(m) : m.state, color: PARTY_VAR[m.party], size: 220 })),
      h("div.stack", { style: "gap:8px" },
        h("div.eyebrow", m.chamber === "house" ? "In the district" : "Biggest cities"),
        h("div.chips", ...m.districtCities.map((c) => h("span", c))),
        m.districtCounties.length ? h("p.small.muted", m.districtCounties.slice(0, 4).join(", ")) : null)),
    leanMeter(m),
    raceSection(m),
    caucusRow(m),
    h("div.stats",
      h("div.stat", h("span.k", m.last2Way ? `${m.last2Way.year} two-way` : "Last two-way"),
        m.last2Way ? h("span.v", fmtPct(m.last2Way.share)) : h("span.v.sm", "Not loaded yet")),
      h("div.stat", h("span.k", m.chamber === "senate" || !m.district ? "Harris two-way (state)" : "Harris two-way"), kamalaText(m)),
      h("div.stat", h("span.k", war.length ? `WAR, ${war[0].year} to ${last!.year}` : "WAR"),
        war.length ? sparkline(war, m.party) : h("span.v.sm", "No contested race"),
        war.length ? h("span.k", `${TRAJ[m.warTrajectory ?? "single"]} · ${fmtWar(last!.value)} vs. ${last!.opponent} (${last!.opponentParty}), ${last!.year}`) : null),
      h("div.stat", h("span.k", m.fundraising ? "Raised, 2025–26" : "Committees"),
        m.fundraising ? h("span.v", fmtMoney(m.fundraising.receipts))
          : h("span.v.sm", m.committees.length ? m.committees.slice(0, 2).map((c) => c.name.replace(/^(House|Senate|Joint) Committee on (the )?/, "")).join(", ") : "None yet"))),
    war.length ? warTable(m) : null,
    facts,
    opts.showMnemonic === false ? null : mnemonicEditor(m, !!opts.missed));
  return card;
}

/** Every race behind the WAR line: year, opponent, result. */
export function warTable(m: Member): HTMLElement {
  return h("div.stack", { style: "gap:6px" },
    h("div.eyebrow", "WAR by race"),
    h("div.table-wrap", h("table", { class: "war-table" },
      h("thead", h("tr", h("th", "Year"), h("th", "Race"), h("th", { style: "text-align:right" }, "WAR"))),
      h("tbody", ...[...m.war].reverse().map((p) => h("tr",
        h("td.num", String(p.year)),
        h("td", `${p.chamber === "senate" ? "Senate" : "House"} vs. `, h("b", p.opponent), " ", h(`span.party.${p.opponentParty}`, { style: "margin-left:4px" }, p.opponentParty)),
        h("td.num", { style: `text-align:right;font-weight:700;color:${p.value >= 0 ? "var(--good)" : "var(--muted)"}` }, fmtWar(p.value))))))),
    h("p.muted.small", "WAR (wins above replacement): how far they ran ahead of (+) or behind (−) what a generic candidate of their party would get against that opponent."));
}

export function mnemonicEditor(m: Member, emphasize: boolean): HTMLElement {
  const current = getState().mnemonics[m.id] ?? "";
  const ta = h("textarea.mnemonic", { id: `mn-${m.id}`, placeholder: "Write a mnemonic for this member. It shows after a miss." }) as HTMLTextAreaElement;
  ta.value = current;
  ta.addEventListener("change", () => update((st) => {
    const v = ta.value.trim();
    if (v) st.mnemonics[m.id] = v;
    else delete st.mnemonics[m.id];
  }));
  ta.addEventListener("keydown", (e) => e.stopPropagation());
  return h("div.stack", { style: "gap:6px" },
    h("label.small", { for: `mn-${m.id}`, style: emphasize && current ? "font-weight:700" : "color:var(--muted)" },
      emphasize && current ? `Your mnemonic: ${current}` : "Your mnemonic"),
    ta);
}

const PARTY_PLURAL: Record<Party, string> = { D: "Democrats", R: "Republicans", I: "independents" };

/**
 * Democratic share of the two-party vote in the member's latest race, from their own share
 * and their opponent's party. null when it isn't a D-vs-R race (e.g. California D vs D).
 */
export function raceDShare(m: Member): { d: number | null; note: string } {
  const l = m.last2Way;
  if (!l) return { d: null, note: "Results not loaded yet" };
  const side: Party | null = m.party !== "I" ? m.party
    : l.opponentParty === "R" ? "D" : l.opponentParty === "D" ? "R" : (m.partyCaucus ?? null);
  if (l.opponentParty && m.party !== "I" && l.opponentParty === m.party) {
    return { d: null, note: `${m.party} vs ${m.party} race · ${fmtPct(l.share)} vs. ${l.opponent}` };
  }
  if (!l.opponent) return { d: side === "D" ? 1 : side === "R" ? 0 : null, note: "Unopposed" };
  if (side !== "D" && side !== "R") return { d: null, note: `${fmtPct(l.share)} vs. ${l.opponent}` };
  const d = side === "D" ? l.share : 1 - l.share;
  return { d, note: `vs. ${l.opponent} (${l.opponentParty ?? "?"})` };
}

function margin(d: number): string {
  const pts = Math.abs(d - 0.5) * 200;
  return pts < 0.05 ? "Even" : `${d > 0.5 ? "D" : "R"}+${pts.toFixed(1)}`;
}

/** "How blue": red-to-blue track with the latest race (●) and Harris 2024 (◆). */
export function leanMeter(m: Member): HTMLElement {
  const race = raceDShare(m);
  const pres = m.kamala2Way;
  const lo = 0.15, hi = 0.85;
  const pos = (d: number) => `${(100 * (Math.max(lo, Math.min(hi, d)) - lo)) / (hi - lo)}%`;
  const chamberWord = m.chamber === "senate" ? "Senate" : m.state === "PR" ? "Resident Commissioner" : m.district === 0 && m.state !== "PR" && ["DC", "AS", "GU", "MP", "VI"].includes(m.state) ? "Delegate" : "House";
  const raceLabel = m.last2Way ? `${m.last2Way.year} ${chamberWord} race` : "Latest race";
  const presLabel = m.chamber === "senate" || !m.district ? "Harris 2024 (statewide)" : "Harris 2024";
  const presNote = m.kamala2WaySource === "pending" ? "Pending: district redrawn for 2026"
    : m.kamala2WaySource === "missing" ? "Not loaded yet" : m.kamala2WaySource === "n/a" ? "No presidential vote" : "";
  return h("div.lean.stack", { style: "gap:8px" },
    h("div.eyebrow", "How blue"),
    h("div.lean-track", { role: "img", "aria-label": `${raceLabel}: ${race.d === null ? race.note : margin(race.d)}. ${presLabel}: ${pres === null ? presNote : margin(pres)}.` },
      h("span.lean-mid"),
      pres !== null ? h("span.lean-mark.pres", { style: `left:${pos(pres)}`, title: `${presLabel}: ${fmtPct(pres)} Harris` }) : null,
      race.d !== null ? h("span.lean-mark.race", { style: `left:${pos(race.d)}`, title: `${raceLabel}: ${fmtPct(race.d)} D` }) : null),
    h("div.lean-scale", h("span", "R+70"), h("span", "Even"), h("span", "D+70")),
    h("div.lean-legend",
      h("div", h("span.lean-key.race"), h("b", raceLabel), " ",
        race.d !== null ? h("span", h("b.num", { style: `color:${race.d >= 0.5 ? "var(--dem)" : "var(--rep)"}` }, margin(race.d)), ` · ${fmtPct(race.d)} D · ${race.note}`) : h("span.muted", race.note)),
      h("div", h("span.lean-key.pres"), h("b", presLabel), " ",
        pres !== null ? h("span", h("b.num", { style: `color:${pres >= 0.5 ? "var(--dem)" : "var(--rep)"}` }, margin(pres)), ` · ${fmtPct(pres)} Harris`) : h("span.muted", presNote))));
}

export function caucusRow(m: Member): HTMLElement | null {
  const chips: HTMLElement[] = [];
  if (m.partyCaucus) chips.push(h("span", { class: "caucus party-caucus", style: `border-color:${PARTY_VAR[m.partyCaucus]}` }, `Caucuses with ${PARTY_PLURAL[m.partyCaucus]}`));
  for (const c of m.caucuses ?? []) chips.push(h(`span.caucus.${c.kind}`, c.name));
  if (!chips.length) {
    return m.newToCongress ? h("div.stack", { style: "gap:6px" }, h("div.eyebrow", "Caucuses"), h("p.muted.small", "New members join caucuses after they're sworn in.")) : null;
  }
  return h("div.stack", { style: "gap:6px" }, h("div.eyebrow", "Caucuses"), h("div.chips", ...chips));
}

/** Daily goal ring: outer = reviews, inner = new members. */
export function goalRing(rev: [number, number], fresh: [number, number]): SVGElement {
  const c1 = 2 * Math.PI * 46, c2 = 2 * Math.PI * 31;
  const f1 = rev[1] ? Math.min(1, rev[0] / rev[1]) : 0;
  const f2 = fresh[1] ? Math.min(1, fresh[0] / fresh[1]) : 0;
  return s("svg", { width: 112, height: 112, viewBox: "0 0 112 112", role: "img", "aria-label": `Reviews ${rev[0]} of ${rev[1]}, new ${fresh[0]} of ${fresh[1]}` },
    s("circle", { cx: 56, cy: 56, r: 46, fill: "none", stroke: "var(--surface)", "stroke-width": 10 }),
    s("circle", { cx: 56, cy: 56, r: 46, fill: "none", stroke: "var(--teal)", "stroke-width": 10, "stroke-linecap": "round", "stroke-dasharray": `${(c1 * f1).toFixed(1)} ${c1.toFixed(1)}`, transform: "rotate(-90 56 56)", opacity: f1 ? 1 : 0 }),
    s("circle", { cx: 56, cy: 56, r: 31, fill: "none", stroke: "var(--surface)", "stroke-width": 10 }),
    s("circle", { cx: 56, cy: 56, r: 31, fill: "none", stroke: "var(--raspberry)", "stroke-width": 10, "stroke-linecap": "round", "stroke-dasharray": `${(c2 * f2).toFixed(1)} ${c2.toFixed(1)}`, transform: "rotate(-90 56 56)", opacity: f2 ? 1 : 0 }));
}

export function partySplit(members: Member[], label: string): HTMLElement {
  const n = { D: 0, R: 0, I: 0 };
  members.forEach((m) => n[m.party]++);
  return h("div.split",
    h("div.split-head", h("span", label), h("span.num",
      h("b", { style: "color:var(--dem)" }, `${n.D} D`), " · ", h("b", { style: "color:var(--rep)" }, `${n.R} R`),
      n.I ? h("span", " · ", h("b", { style: "color:var(--ind)" }, `${n.I} I`)) : null)),
    h("div.split-bar", { role: "img", "aria-label": `${n.D} Democrats, ${n.R} Republicans, ${n.I} independents` },
      n.D ? h("span", { style: `flex:${n.D};background:var(--dem)` }) : null,
      n.I ? h("span", { style: `flex:${n.I};background:var(--ind)` }) : null,
      n.R ? h("span", { style: `flex:${n.R};background:var(--rep)` }) : null));
}
