/**
 * District Tap (SCAFFOLD 6.1): five names a day, tap where their district is.
 * Layout follows MapTap: the map fills the screen; the name, score and results float on top.
 */
import type { GeoPermissibleObjects } from "d3-geo";
import { seatId } from "../data/load";
import type { Member } from "../data/types";
import { puzzleMembers, tapEmoji, tapScore } from "../games/districtTap";
import { puzzleNumber, shortDate } from "../games/seed";
import { shareResult, shareText } from "../games/share";
import type { Ctx } from "../main";
import { distanceToFeature } from "../map/geometry";
import { UsMap } from "../map/usMap";
import { getState, streakFrom, today, update } from "../store";
import { PARTY_VAR, photo, roleChip, roleLabel } from "./components";
import { h } from "./dom";
import { playfield } from "./playfield";

interface Round { m: Member; miles: number; score: number; tap: [number, number] }

export function tapView(root: HTMLElement, { data }: Ctx, params: URLSearchParams) {
  const practice = params.get("practice") === "1";
  const date = today();
  const seed = practice ? `practice-${Date.now()}` : date;
  const members = puzzleMembers(data, seed);
  const num = puzzleNumber(date);
  const already = !practice && getState().tap.find((r) => r.date === date);

  const rounds: Round[] = [];
  let i = 0;
  let awaitingNext = false;

  const map = new UsMap(data, { interactive: true, onClick: onTap, label: "Tap the map where you think the district is" });
  const pf = playfield(map);
  root.append(
    h("section.stack", { style: "gap:10px" },
      h("div.sec-head",
        h("h2", "District Tap ", h("span.muted.num", practice ? "Practice" : `#${num}`)),
        h("span.muted.small", practice ? "Random names. Doesn't count toward your streak." : shortDate(date))),
      pf.el),
  );

  if (already) {
    pf.prompt.hidden = true;
    renderScore();
    showSummary(already.scores, already.miles, null, "You've played today's puzzle. New one at midnight.");
    return;
  }
  renderPrompt();
  renderScore();

  function target(m: Member) {
    return m.chamber === "senate" ? data.stateById.get(m.state)! : data.districtById.get(seatId(m))!;
  }

  function where(m: Member): string {
    if (m.chamber === "senate") return "Tap anywhere in their state";
    if (!m.district) return m.state === "DC" || m.state === "PR" || ["AS", "GU", "MP", "VI"].includes(m.state) ? "Tap anywhere in it" : "At-large: tap anywhere in the state";
    return "Tap their district";
  }

  function renderPrompt() {
    const m = members[i];
    const withPhoto = getState().settings.tapPhoto;
    put(pf.prompt, 
      withPhoto ? photo(m, "photo pf-photo") : null,
      h("div.pf-text",
        h("span.eyebrow", `Round ${i + 1} of ${members.length}`),
        h("div.pf-name", m.name),
        h("div.row", { style: "gap:8px" }, roleChip(m), h("span.muted.small", where(m)))),
    );
  }

  function renderScore() {
    const total = (already ? already.total : rounds.reduce((a, r) => a + r.score, 0));
    const marks = members.map((_, k) => {
      const miles = already ? already.miles[k] : rounds[k]?.miles;
      return h("span", { class: miles === undefined ? (k === i ? "now" : "todo") : "" }, miles === undefined ? "" : tapEmoji(miles));
    });
    const cb = h("input", { type: "checkbox", id: "tap-photo" }) as HTMLInputElement;
    cb.checked = getState().settings.tapPhoto;
    cb.addEventListener("change", () => {
      update((s) => { s.settings.tapPhoto = cb.checked; });
      if (!awaitingNext && i < members.length && !already) renderPrompt();
    });
    put(pf.score, 
      h("div.pf-total", h("b.num", String(total)), h("span.muted", " / 500")),
      h("div.pf-marks", ...marks),
      already ? null : h("label.small.muted.row", { for: "tap-photo", style: "gap:6px" }, cb, "Photo"),
    );
  }

  function onTap(lonlat: [number, number]) {
    if (awaitingNext || i >= members.length || already) return;
    const m = members[i];
    const f = target(m);
    const { miles, nearest } = distanceToFeature(f, lonlat);
    const rounded = Math.round(miles * 10) / 10;
    const score = tapScore(rounded);
    rounds.push({ m, miles: rounded, score, tap: lonlat });
    awaitingNext = true;

    map.clearOverlay();
    map.showTarget(f as GeoPermissibleObjects, PARTY_VAR[m.party]);
    if (miles > 0) map.link(lonlat, nearest);
    map.marker(lonlat);
    map.zoomTo([f as GeoPermissibleObjects, { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: lonlat } } as GeoPermissibleObjects], true, 12);

    const label = m.chamber === "senate" ? `${data.stateNames.get(m.state)}` : seatId(m);
    const last = i === members.length - 1;
    const nextBtn = h("button.btn.next", { type: "button", id: "tap-next", onclick: next }, last ? "Results " : "Next ", h("span.arrow", { "aria-hidden": "true" }, "→"));
    put(pf.prompt, 
      getState().settings.tapPhoto ? photo(m, "photo pf-photo") : null,
      h("div.pf-text",
        h("span.eyebrow", `Round ${i + 1} of ${members.length}`),
        h("div.pf-name", `${tapEmoji(rounded)} ${m.name}`),
        h("div.row", { style: "gap:8px" }, roleChip(m), h("span.small", h("span.code", label), " · ", miles === 0 ? "inside" : `${rounded} mi`, " · ", h("b", `${score} pts`)))),
      nextBtn,
    );
    nextBtn.focus();
    renderScore();
  }

  function next() {
    i++;
    awaitingNext = false;
    map.clearOverlay();
    map.reset();
    if (i < members.length) {
      renderPrompt();
      renderScore();
    } else {
      finish();
    }
  }

  function finish() {
    const scores = rounds.map((r) => r.score), miles = rounds.map((r) => r.miles);
    const total = scores.reduce((a, b) => a + b, 0);
    if (!practice) update((s) => { s.tap.push({ date, puzzle: num, scores, miles, total }); });
    pf.prompt.hidden = true;
    renderScore();
    showSummary(scores, miles, rounds, practice ? "Practice round complete." : "Come back tomorrow for five new names.");
  }

  function showSummary(scores: number[], miles: number[], played: Round[] | null, note: string) {
    const total = scores.reduce((a, b) => a + b, 0);
    const st = getState();
    const streak = streakFrom(new Set(st.tap.map((r) => r.date)));
    const text = shareText(
      practice ? "District Tap · Practice" : `District Tap #${num} · ${shortDate(date)}`,
      miles.map(tapEmoji).join(""),
      practice ? `${total}/500` : `${total}/500 · streak ${streak}`,
      "tap");
    const names = played ? played.map((r) => r.m) : members;
    const totals = st.tap.map((r) => r.total);
    const best = totals.length ? Math.max(...totals) : total;
    const buckets = new Array(10).fill(0);
    totals.forEach((t) => buckets[Math.min(9, Math.floor(t / 50))]++);
    const bmax = Math.max(1, ...buckets);

    const close = h("button.ghost", { type: "button", onclick: () => { pf.sheet.hidden = true; reopen.hidden = false; } }, "Show map");
    const reopen = h("button.btn.sm", { type: "button", hidden: true, onclick: () => { pf.sheet.hidden = false; reopen.hidden = true; } }, "Show results");
    pf.score.append(reopen);
    pf.sheet.hidden = false;
    pf.sheet.replaceChildren(
      h("div.row", { style: "justify-content:space-between" }, h("h3", "Results"), close),
      h("p.muted.small", note),
      h("div.rounds", ...names.map((m, k) => h("div.round",
        h("span.e", tapEmoji(miles[k])), h("span", m.name, " ", h("span.role.sm." + m.chamber, roleLabel(m) === "Senator" ? "Sen." : "Rep.")),
        h("span.d", miles[k] === 0 ? "inside" : `${miles[k]} mi`), h("span.s", String(scores[k]))))),
      h("div.total", h("span.muted", "Total"), h("b", `${total}`, h("span.muted", { style: "font-size:16px;font-weight:600" }, " / 500"))),
      h("pre.share", text),
      h("div.row",
        h("button.btn", { type: "button", onclick: () => shareResult(text) }, "Share result"),
        h("a.btn.line", { href: `#/tap?practice=1&t=${Date.now()}` }, "Practice round")),
      ...(practice ? [] : [h("div.stack", { style: "gap:8px;margin-top:6px" },
        h("span.small.muted", `Streak ${streak} · Best ${best} · Played ${totals.length}`),
        h("div.hist", { role: "img", "aria-label": "Your past totals, 0 to 500" }, ...buckets.map((n) => h("span", { style: `height:${(100 * n) / bmax}%` }))),
        h("div.row", { style: "justify-content:space-between" }, h("span.small.muted", "0"), h("span.small.muted", "500")))]),
    );
    map.clearOverlay();
    if (played) {
      for (const r of played) {
        map.showTarget(target(r.m) as GeoPermissibleObjects, PARTY_VAR[r.m.party]);
        map.marker(r.tap, 5);
      }
    } else {
      for (const m of names) map.showTarget(target(m) as GeoPermissibleObjects, PARTY_VAR[m.party]);
    }
    map.reset();
  }
}

/** replaceChildren that skips null slots (optional photo, optional toggle). */
function put(el: HTMLElement, ...kids: (Node | null)[]): void {
  el.replaceChildren(...kids.filter((k): k is Node => k !== null));
}
