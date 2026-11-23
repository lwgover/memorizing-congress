/** Mastery map: every district shaded by how well you know its member. */
import { seatId, seatLabel } from "../data/load";
import type { Member } from "../data/types";
import type { Ctx } from "../main";
import { UsMap } from "../map/usMap";
import { masteryLevel } from "../srs/cards";
import { getState } from "../store";
import { PARTY_VAR, leanMeter, partyChip, photo, roleChip } from "./components";
import { h } from "./dom";

type Lens = "mastery" | "party" | "harris";

export function masteryView(root: HTMLElement, { data }: Ctx) {
  let lens: Lens = "mastery";
  const info = h("div.panel.stack", { style: "gap:10px" }, h("p.muted.small", "Click a district to see who represents it."));
  const map = new UsMap(data, {
    interactive: true,
    label: "Map of districts shaded by mastery",
    onClick: (_ll, id) => { if (id) showInfo(id); },
  });

  const delegations = new Map<string, Member[]>();
  for (const m of data.members) delegations.set(m.state, [...(delegations.get(m.state) ?? []), m]);
  const mastered = [...delegations.entries()].filter(([, ms]) => ms.every((m) => masteryLevel(m) === 5)).map(([st]) => st).sort();
  const introduced = Object.keys(getState().introduced).filter((id) => data.byId.has(id)).length;
  const masteredCount = data.members.filter((m) => masteryLevel(m) === 5).length;

  const lensSeg = h("div.seg", { role: "group", "aria-label": "Map coloring" });
  const legend = h("div.scale");
  root.append(h("section.stack", { style: "gap:16px" },
    h("div.sec-head", h("h2", "Mastery map"), lensSeg),
    h("p.muted", `${introduced} of ${data.members.length} members introduced · ${masteredCount} mastered`),
    map.el,
    legend,
    h("div.grid-2",
      info,
      h("div.panel.stack", { style: "gap:10px" },
        h("h3", "Delegations mastered"),
        mastered.length ? h("div.badges", ...mastered.map((s) => h("span.badge", { title: data.stateNames.get(s) ?? s }, s)))
          : h("p.muted.small", "A state earns a badge when every senator and representative from it is mastered. DC, with a single delegate, is the quickest first badge."),
        h("p.muted.small", `Mastered means each of the member's core cards would be remembered for three weeks or more.`)))));
  render();

  function render() {
    lensSeg.replaceChildren(...([["mastery", "Mastery"], ["party", "Party"], ["harris", "Harris share"]] as [Lens, string][]).map(([v, label]) =>
      h("button", { type: "button", "aria-pressed": String(v === lens), onclick: () => { lens = v; render(); } }, label)));
    map.fill((id) => {
      const m = data.houseBySeat.get(id);
      if (!m) return "var(--surface)";
      if (lens === "party") return PARTY_VAR[m.party];
      if (lens === "harris") return harrisColor(m.kamala2Way);
      const lvl = masteryLevel(m);
      return lvl === null ? null : `var(--m${lvl})`;
    });
    legend.replaceChildren(...legendFor(lens));
  }

  function legendFor(l: Lens): (HTMLElement | string)[] {
    if (l === "mastery") return [h("span", "Not started"), h("span.sw", { style: "background:var(--map-land);width:18px;height:10px" }),
      h("span", "New"), h("span.bar", ...[0, 1, 2, 3, 4, 5].map((k) => h("span", { style: `background:var(--m${k})` }))), h("span", "Mastered")];
    if (l === "party") return [h("span.row", { style: "gap:6px" }, h("span.sw", { style: "background:var(--dem)" }), "Democrat"),
      h("span.row", { style: "gap:6px" }, h("span.sw", { style: "background:var(--rep)" }), "Republican"),
      h("span.row", { style: "gap:6px" }, h("span.sw", { style: "background:var(--ind)" }), "Independent"),
      h("span.row", { style: "gap:6px" }, h("span.sw", { style: "background:var(--surface);border:1px solid var(--line)" }), "Seat pending")];
    return [h("span", "Trump +40"), h("span.bar", ...[0.3, 0.4, 0.47, 0.53, 0.6, 0.7].map((v) => h("span", { style: `background:${harrisColor(v)}` }))), h("span", "Harris +40"),
      h("span.muted", { style: "margin-left:auto" }, "Gray: redrawn for 2026 or not loaded yet")];
  }

  function showInfo(id: string) {
    const m = data.houseBySeat.get(id);
    const pend = data.pending.find((p) => p.seat === id);
    if (!m) {
      info.replaceChildren(h("h3", id), h("p.muted.small", pend ? `Not called yet. Candidates: ${pend.candidates.map((c) => c.name).join(", ")}` : "No member data for this seat."));
      return;
    }
    const lvl = masteryLevel(m);
    const sens = data.senatorsByState.get(m.state) ?? [];
    info.replaceChildren(
      h("div.who-row", photo(m), h("div", h("div.name", m.name), h("div.meta", roleChip(m), partyChip(m.party), h("span.code", seatId(m))))),
      h("p.small.muted", lvl === null ? "Not introduced yet." : `Mastery ${lvl} of 5.`),
      leanMeter(m),
      ...(sens.length ? [h("p.small", h("span.muted", "Senators: "), sens.map((s) => `${s.name} (${s.party}, ${seatLabel(s).split(" · ")[1]})`).join(" · "))] : []));
  }
}

/** Diverging blue-red scale on Harris 2-way share; gray when unknown. */
function harrisColor(v: number | null): string {
  if (v === null) return "var(--map-land)";
  const t = Math.max(-1, Math.min(1, (v - 0.5) / 0.4));
  const pct = Math.round(Math.abs(t) * 100);
  return `color-mix(in srgb, ${t >= 0 ? "var(--dem)" : "var(--rep)"} ${pct}%, var(--map-land))`;
}
