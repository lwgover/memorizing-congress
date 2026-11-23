/** Tests (SCAFFOLD 6.2, 6.3): Name -> District and District -> Name, plus the confusables drill. */
import type { GeoPermissibleObjects } from "d3-geo";
import { roman, seatId, seatLabel } from "../data/load";
import type { Member } from "../data/types";
import { tapScore } from "../games/districtTap";
import { parseSeat } from "../games/match";
import { rng, shuffle } from "../games/seed";
import { shareResult, shareText, squares } from "../games/share";
import type { Ctx } from "../main";
import { distanceToFeature } from "../map/geometry";
import { UsMap } from "../map/usMap";
import { recordConfusion, topConfusions } from "../srs/confusions";
import { today, update } from "../store";
import { PARTY_VAR, districtMini, partyChip, photo, promptMap, promptName, roleChip } from "./components";
import { h } from "./dom";
import { answerInput, skipButton } from "./answer";
import { playfield } from "./playfield";

type Mode = "n2d" | "d2n";
type Format = "quick" | "state" | "sweep" | "sprint";
const FORMAT_LABEL: Record<Format, string> = { quick: "Quick 10", state: "Single state", sweep: "Full sweep", sprint: "60-second sprint" };

export function testView(root: HTMLElement, ctx: Ctx, params: URLSearchParams) {
  if (params.get("mode") === "confusables") return confusablesView(root, ctx);
  let mode: Mode = params.get("mode") === "d2n" ? "d2n" : "n2d";
  let format: Format = "quick";
  let answerMode: "type" | "map" | "normal" | "hard" = mode === "n2d" ? "type" : "normal";
  let state = "TX";

  const setup = h("section.stack", { style: "gap:18px" });
  let stopQuiz: (() => void) | undefined;
  root.append(setup);
  renderSetup();

  function seg<T extends string>(options: [T, string][], value: T, onPick: (v: T) => void) {
    return h("div.seg", { role: "group" }, ...options.map(([v, label]) =>
      h("button", { type: "button", "aria-pressed": String(v === value), onclick: () => { onPick(v); renderSetup(); } }, label)));
  }

  function renderSetup() {
    const states = [...ctx.data.stateNames.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const select = h("select.input", { id: "test-state", style: "max-width:260px" },
      ...states.map(([id, name]) => h("option", { value: id, selected: id === state }, name))) as HTMLSelectElement;
    select.addEventListener("change", () => { state = select.value; });
    setup.replaceChildren(
      h("h2", "Tests"),
      h("div.panel.stack", { style: "gap:16px" },
        h("div.stack", { style: "gap:6px" }, h("span.eyebrow", "Test"),
          seg<Mode>([["n2d", "Name → District"], ["d2n", "District → Name"]], mode, (v) => { mode = v; answerMode = v === "n2d" ? "type" : "normal"; })),
        h("div.stack", { style: "gap:6px" }, h("span.eyebrow", "Format"),
          seg<Format>([["quick", "Quick 10"], ["state", "Single state"], ["sweep", "Full sweep"], ["sprint", "60-second sprint"]], format, (v) => { format = v; })),
        format === "state" ? h("div.stack", { style: "gap:6px" }, h("label.eyebrow", { for: "test-state" }, "State"), select) : null,
        h("div.stack", { style: "gap:6px" }, h("span.eyebrow", "Answer with"),
          mode === "n2d"
            ? seg([["type", "Typing (TX-35)"], ["map", "Clicking the map"]] as ["type" | "map", string][], answerMode as "type" | "map", (v) => { answerMode = v; })
            : seg([["normal", "Normal"], ["hard", "Hard: shape only, no hints"]] as ["normal" | "hard", string][], answerMode as "normal" | "hard", (v) => { answerMode = v; })),
        h("p.muted.small", mode === "n2d"
          ? "Exact district = 100. Right state, wrong district = 40 (in map mode, scored by distance like District Tap). Senators: right state, wrong class = 60."
          : "Exact = 100. Last name alone is fine. Naming someone else from the same delegation logs a mix-up."),
        h("div.row", h("button.btn", { type: "button", onclick: start }, `Start ${FORMAT_LABEL[format]}`))),
    );
  }

  function start() {
    const r = rng(`test-${Date.now()}`);
    let pool = ctx.data.members;
    if (format === "state") pool = pool.filter((m) => m.state === state);
    const qs = shuffle(pool, r);
    const list = format === "quick" ? qs.slice(0, 10) : qs;
    setup.remove();
    stopQuiz = runQuiz(root, ctx, { mode, format, answerMode, members: list, stateName: ctx.data.stateNames.get(state) ?? state });
  }
  return () => stopQuiz?.();
}

interface QuizOpts { mode: Mode; format: Format; answerMode: string; members: Member[]; stateName: string }

function runQuiz(root: HTMLElement, ctx: Ctx, o: QuizOpts) {
  const { data, matcher } = ctx;
  const scores: number[] = [];
  let i = 0;
  let deadline = o.format === "sprint" ? Date.now() + 60000 : 0;
  let timer = 0;
  let answered = false;
  const validStates = new Set(data.stateNames.keys());

  const head = h("div.sec-head");
  const body = h("div.stack", { style: "gap:14px" });
  const map = o.mode === "n2d" && o.answerMode === "map" ? new UsMap(data, { interactive: true, onClick: onMapClick }) : null;
  // map mode uses the MapTap layout: full-screen map, the name floats on top so it never scrolls away
  const pf = map ? playfield(map) : null;
  root.append(h("section.stack", { style: "gap:16px" }, head, body));

  if (deadline) {
    timer = window.setInterval(() => {
      renderHead();
      if (Date.now() >= deadline) finish();
    }, 250);
  }
  ask();

  function renderHead() {
    const total = o.format === "sprint" ? "" : ` of ${o.members.length}`;
    const left = deadline ? ` · ${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}s left` : "";
    head.replaceChildren(
      h("h2", `${o.mode === "n2d" ? "Name → District" : "District → Name"} · ${o.format === "state" ? o.stateName : FORMAT_LABEL[o.format]}`),
      h("span.muted.num", `Question ${i + 1}${total} · ${scores.reduce((a, b) => a + b, 0)} pts${left}`));
    if (pf) {
      pf.score.replaceChildren(
        h("div.pf-total", h("b.num", String(scores.reduce((a, b) => a + b, 0))), h("span.muted", " pts")),
        h("span.small.muted.num", `Question ${i + 1}${total}${left}`));
    }
  }

  function current(): Member {
    return o.members[i % o.members.length];
  }

  function ask() {
    answered = false;
    renderHead();
    const m = current();
    if (o.mode === "n2d") askN2D(m);
    else askD2N(m);
  }

  // ---------- Name -> District
  function askN2D(m: Member) {
    const prompt = h("div.stack", { style: "gap:4px" },
      h("span.eyebrow", m.chamber === "senate" ? "Which state, and which class?" : "Which district?"),
      promptName(m));
    const skip = () => {
      if (map) {
        const f = m.chamber === "senate" ? data.stateById.get(m.state)! : data.districtById.get(seatId(m))!;
        map.showTarget(f as GeoPermissibleObjects, PARTY_VAR[m.party]);
        map.zoomTo([f as GeoPermissibleObjects], true, 12);
      }
      reveal(m, 0, "I don't know");
    };
    if (map && pf) {
      map.clearOverlay();
      map.reset(false);
      if (!body.contains(pf.el)) body.replaceChildren(pf.el);
      pf.prompt.replaceChildren(
        h("div.pf-text",
          h("span.eyebrow", m.chamber === "senate" ? "Which state?" : "Which district?"),
          h("div.pf-name", m.name),
          h("div.row", { style: "gap:8px" }, roleChip(m),
            h("span.muted.small", m.chamber === "senate" ? "Click anywhere in their state" : "Click their district"))),
        skipButton(skip));
      return;
    }
    if (m.chamber === "senate") {
      let cls = 0;
      const clsSeg = h("div.seg", { role: "group", "aria-label": "Senate class" }, ...[1, 2, 3].map((c) =>
        h("button", { type: "button", "aria-pressed": "false", onclick: (e: Event) => {
          cls = c;
          clsSeg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget)));
          (body.querySelector("input") as HTMLInputElement | null)?.focus();
        } }, `Class ${roman(c)}`)));
      body.replaceChildren(prompt,
        h("div.row", h("span.small.muted", "Class"), clsSeg),
        answerInput({
          id: "ans-state", placeholder: "State, e.g. TX", width: "200px", onSkip: skip,
          invalidHint: "Type a state, like MD or Maryland.",
          onSubmit: (v) => {
            const parsed = parseSeat(v, validStates, data.stateNames);
            if (!parsed) return false;
            const st = parsed.state;
            const score = st === m.state ? (cls === m.senateClass ? 100 : 60) : 0;
            reveal(m, score, `${st}${cls ? ` · Class ${roman(cls)}` : " · no class picked"}`);
          },
        }));
      (body.querySelector("input") as HTMLInputElement).focus();
      return;
    }
    body.replaceChildren(prompt, answerInput({
      id: "ans-seat", placeholder: "e.g. TX-35 or WY-AL", width: "240px", onSkip: skip,
      invalidHint: "Type a district like MD-03 (or Maryland 3). At-large: WY-AL.",
      instant: (v) => {
        const p = parseSeat(v, validStates, data.stateNames);
        return !!p && p.state === m.state && p.district === (m.district ?? 0) && (/\d\d$|AL$/i.test(v.trim()) || (m.district ?? 0) >= 10);
      },
      onSubmit: (v) => {
        const p = parseSeat(v, validStates, data.stateNames);
        if (!p) return false; // unreadable: keep the box open
        const exact = p.state === m.state && (p.district ?? 0) === (m.district ?? 0);
        const score = exact ? 100 : p.state === m.state ? 40 : 0;
        reveal(m, score, p.district === null ? p.state : seatId({ state: p.state, district: p.district }));
      },
    }));
    (body.querySelector("input") as HTMLInputElement).focus();
  }

  function onMapClick(lonlat: [number, number]) {
    if (answered) return;
    const m = current();
    const f = m.chamber === "senate" ? data.stateById.get(m.state)! : data.districtById.get(seatId(m))!;
    const { miles, nearest } = distanceToFeature(f, lonlat);
    const score = miles === 0 ? 100 : tapScore(miles);
    map!.showTarget(f as GeoPermissibleObjects, PARTY_VAR[m.party]);
    if (miles > 0) map!.link(lonlat, nearest);
    map!.marker(lonlat);
    map!.zoomTo([f as GeoPermissibleObjects, { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: lonlat } } as GeoPermissibleObjects], true, 12);
    reveal(m, score, miles === 0 ? "Inside" : `${Math.round(miles)} mi away`, true);
  }

  // ---------- District -> Name
  function askD2N(m: Member) {
    const hard = o.answerMode === "hard";
    const label = m.chamber === "senate" ? (hard ? `Class ${roman(m.senateClass!)}` : seatLabel(m)) : hard ? "" : seatId(m);
    const box = answerInput({
      id: "ans-name", placeholder: "Name (last name is fine)",
      onSkip: () => reveal(m, 0, "I don't know"),
      // instant feedback: an exactly-right name counts once you pause typing
      instant: (v) => matcher.isExact(v, m),
      // names only: showing districts in the list would give the answer away
      suggest: hard ? undefined : (v) => matcher.suggest(v, 6).map((x) => x.name),
      onSubmit: (v) => {
        if (matcher.isMatch(v, m)) return reveal(m, 100, v);
        const given = matcher.best(v);
        if (given && given.id !== m.id && given.state === m.state) recordConfusion(m.id, given.id);
        reveal(m, 0, given ? given.name : v);
      },
    });
    body.replaceChildren(
      h("div.grid-2",
        promptMap(data, m, { silhouette: hard }),
        h("div.stack",
          h("span.eyebrow", hard ? "Who represents this shape?" : m.chamber === "senate" ? "Which senator holds this seat?" : "Who represents this district?"),
          h("div.row", { style: "gap:10px;align-items:center" }, label ? h("div.prompt-name.code", label) : null, roleChip(m)),
          box,
          hard ? h("p.muted.small", "Hard mode: no autocomplete, no label.") : null)),
    );
    (body.querySelector("input") as HTMLInputElement).focus();
  }

  // ---------- feedback
  function reveal(m: Member, score: number, given: string, viaMap = false) {
    if (answered) return;
    answered = true;
    body.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, .seg button, .stack > .row button").forEach((el) => { el.disabled = true; });
    scores.push(score);
    renderHead();
    const verdict = score >= 100 ? "Correct" : score > 0 ? `Partly right · ${score} pts` : "Not quite";
    if (pf) {
      const nextBtn = o.format === "sprint" ? null : h("button.btn.next", { type: "button", id: "q-next", onclick: next }, i + 1 >= o.members.length ? "Results " : "Next ", h("span.arrow", { "aria-hidden": "true" }, "→"));
      pf.prompt.replaceChildren(...[
        photo(m, "photo pf-photo"),
        h("div.pf-text",
          h("div", { class: `verdict ${score >= 100 ? "ok" : "no"}` }, verdict, h("span.muted", { style: "font-weight:500" }, ` · ${given}`)),
          h("div.pf-name", m.name),
          h("div.row", { style: "gap:8px" }, roleChip(m), partyChip(m.party), h("span.code.small", seatLabel(m)))),
        nextBtn,
      ].filter((x): x is HTMLElement => x !== null));
      if (o.format === "sprint") window.setTimeout(next, score >= 100 ? 500 : 1300);
      else nextBtn?.focus();
      return;
    }
    const fb = h("div.panel.stack", { style: "gap:12px" },
      h("div", { class: `verdict ${score >= 100 ? "ok" : "no"}` }, verdict, score < 100 && !viaMap ? h("span.muted", { style: "font-weight:500" }, ` · you said ${given}`) : viaMap ? h("span.muted", { style: "font-weight:500" }, ` · ${given}`) : null),
      h("div.who-row", photo(m),
        h("div", h("div.name", m.name), h("div.meta", roleChip(m), partyChip(m.party), h("span.code", seatLabel(m)),
          m.districtCities.length ? h("span", m.districtCities.slice(0, 3).join(", ")) : null))),
      o.format === "sprint" ? null : h("div.row", h("button.btn.next", { type: "button", id: "q-next", onclick: next }, i + 1 >= o.members.length ? "See results " : "Next ", h("span.arrow", { "aria-hidden": "true" }, "→"))),
    );
    body.append(fb);
    if (o.format === "sprint") window.setTimeout(next, score >= 100 ? 500 : 1300);
    else (document.getElementById("q-next") as HTMLButtonElement)?.focus();
  }

  function next() {
    if (deadline && Date.now() >= deadline) return finish();
    i++;
    if (o.format !== "sprint" && i >= o.members.length) return finish();
    ask();
  }

  function finish() {
    if (timer) clearInterval(timer);
    timer = 0;
    deadline = 0;
    const total = scores.reduce((a, b) => a + b, 0);
    const max = scores.length * 100;
    const correct = scores.filter((s) => s >= 100).length;
    update((s) => { s.tests.push({ date: today(), mode: o.mode, format: o.format, score: total, max }); });
    const title = `${o.mode === "n2d" ? "Name → District" : "District → Name"} · ${o.format === "state" ? o.stateName : FORMAT_LABEL[o.format]}`;
    const emoji = o.format === "sprint" ? `${correct} correct in 60 seconds` : squares(scores.slice(0, 50));
    const text = shareText(title, emoji, `${total}/${max}`, "test");
    head.replaceChildren(h("h2", "Results"));
    body.replaceChildren(h("div.panel.stack",
      h("div.prompt-name", `${total} / ${max}`),
      h("p.muted", `${correct} of ${scores.length} exactly right${o.answerMode === "hard" ? " in hard mode" : ""}.`),
      h("pre.share", text),
      h("div.row",
        h("button.btn", { type: "button", onclick: () => shareResult(text) }, "Share result"),
        h("a.btn.line", { href: `#/test?mode=${o.mode}&t=${Date.now()}` }, "New test"))));
  }

  return () => { if (timer) clearInterval(timer); };
}

// ---------- Confusables: mixed-up pairs side by side, then a two-choice drill
function confusablesView(root: HTMLElement, { data }: Ctx) {
  const pairs = topConfusions(12).map((p) => [data.byId.get(p.a), data.byId.get(p.b), p.count] as const).filter(([a, b]) => a && b) as [Member, Member, number][];
  const section = h("section.stack", { style: "gap:16px" }, h("h2", "Confusables"));
  root.append(section);
  if (!pairs.length) {
    section.append(h("div.panel", h("p.muted", "No mix-ups logged yet. When you answer one member for another, the pair shows up here.")));
    return;
  }
  const card = (m: Member) => h("div.panel.stack", { style: "gap:10px" },
    h("div.who-row", photo(m), h("div", h("div.name", m.name), h("div.meta", roleChip(m), partyChip(m.party), h("span.code", seatLabel(m))))),
    h("div", { style: "max-width:220px" }, districtMini(data, m.state, { highlight: m.chamber === "house" ? seatId(m) : m.state, color: PARTY_VAR[m.party], size: 220 })),
    h("div.chips", ...m.districtCities.slice(0, 4).map((c) => h("span", c))));
  for (const [a, b, n] of pairs) {
    section.append(h("div.stack", { style: "gap:8px" },
      h("span.eyebrow", `Mixed up ${n} time${n === 1 ? "" : "s"}`),
      h("div.grid-2", { style: "grid-template-columns:1fr 1fr" }, card(a), card(b))));
  }
  section.append(h("div.row", h("button.btn", { type: "button", onclick: drill }, "Drill these pairs")));

  function drill() {
    const r = rng(`conf-${Date.now()}`);
    const qs = shuffle(pairs.flatMap(([a, b]) => [[a, b], [b, a]] as [Member, Member][]), r);
    let k = 0, right = 0;
    const box = h("div.stack");
    section.replaceChildren(h("h2", "Confusables drill"), box);
    ask();
    function ask() {
      if (k >= qs.length) {
        box.replaceChildren(h("div.panel", h("div.prompt-name", `${right} / ${qs.length}`), h("a.btn.line", { href: `#/test?mode=confusables&t=${Date.now()}` }, "Back to pairs")));
        return;
      }
      const [ans, other] = qs[k];
      const opts = shuffle([ans, other], r);
      box.replaceChildren(h("div.grid-2",
        promptMap(data, ans),
        h("div.stack", h("span.eyebrow", "Who represents this?"), h("div.row", { style: "gap:10px;align-items:center" }, h("div.prompt-name.code", seatLabel(ans)), roleChip(ans)),
          h("div.big-choices", ...opts.map((m) => h("button.btn.line", { type: "button", onclick: () => {
            const ok = m.id === ans.id;
            if (ok) right++; else recordConfusion(ans.id, m.id);
            k++;
            box.prepend(h("div", { class: `verdict ${ok ? "ok" : "no"}` }, ok ? "Correct" : `That was ${ans.name}`));
            window.setTimeout(ask, ok ? 500 : 1400);
          } }, m.name))))));
    }
  }
}
