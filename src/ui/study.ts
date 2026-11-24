/** Study session: due reviews, then new members (introduced with a card first), FSRS-scheduled. */
import { FAST_MS, SLOW_MS } from "../config";
import { roman, seatId, seatLabel } from "../data/load";
import type { Member, Party } from "../data/types";
import { norm, parseSeat } from "../games/match";
import { shuffle } from "../games/seed";
import type { Ctx } from "../main";
import { CARD_LABEL, dueCards, introduce, newRemainingToday, nextNewMembers, parseCardId, startedStates, stateCards, stateHold, stateProgress, syncUnlocks, unmetInState, unseenCards, type CardType } from "../srs/cards";
import { closeness, ratingForExact, ratingForScore, type NumericFact } from "../srs/closeness";
import { recordConfusion } from "../srs/confusions";
import { previews, Rating, review, type Grade } from "../srs/scheduler";
import { getState, todayLog, update } from "../store";
import { refreshStreak } from "./chrome";
import { PARTY_NAME, fmtWar, photo, promptMap, promptName, revealCard, roleChip, sparkline, warRace } from "./components";
import { fmtMoney, h, toTop } from "./dom";
import { answerInput, skipButton } from "./answer";

interface Outcome { correct: boolean; score?: number; partial?: boolean; given?: string; answerText: string; suggest: Grade; copyName?: boolean }

const RATING_LABEL: [Grade, string][] = [[Rating.Again, "Again"], [Rating.Hard, "Hard"], [Rating.Good, "Good"], [Rating.Easy, "Easy"]];

type Mode = "daily" | "review" | "drill";
const MODE_LABEL: Record<Mode, string> = { daily: "Today's session", review: "Reviews only", drill: "Drill a state" };

export function studyView(root: HTMLElement, ctx: Ctx, params: URLSearchParams) {
  const { data, matcher } = ctx;
  syncUnlocks(data);
  const started = startedStates(data);
  const mode: Mode = params.get("mode") === "review" ? "review" : params.get("mode") === "drill" && started.length ? "drill" : "daily";
  const drillState = mode === "drill" ? (started.find((s) => s.state === params.get("state"))?.state ?? started.at(-1)!.state) : "";

  let queue: string[];
  if (mode === "daily") {
    const newMembers = nextNewMembers(data, newRemainingToday());
    if (newMembers.length) introduce(newMembers);
    queue = [...dueCards(data), ...unseenCards(data)];
  } else if (mode === "review") {
    queue = dueCards(data); // nothing new: just keep what you have
  } else {
    queue = stateCards(data, drillState); // every card for the state, weakest first, due or not
  }
  const introShown = new Set<string>();
  let done = 0, correct = 0;
  let keyHandler: ((e: KeyboardEvent) => void) | null = null;

  const head = h("div.sec-head");
  const stage = h("div.stack", { style: "gap:16px" });
  root.append(h("section.stack", { style: "gap:16px" }, modeBar(), unmetNotice(), head, stage));
  const onKey = (e: KeyboardEvent) => keyHandler?.(e);
  window.addEventListener("keydown", onKey);
  nextCard();
  return () => window.removeEventListener("keydown", onKey);

  function renderHead(label: string) {
    const title = mode === "drill" ? `Drill: ${data.stateNames.get(drillState)}` : MODE_LABEL[mode];
    head.replaceChildren(h("h2", title), h("span.muted.small.num", `${label} · ${queue.length} left · ${done} done`));
  }

  /** In a drill: members of this state you haven't met yet, with a way to add them. */
  function unmetNotice(): HTMLElement | null {
    if (mode !== "drill") return null;
    const unmet = unmetInState(data, drillState);
    if (!unmet.length) return null;
    const names = unmet.map((m) => `${m.name} (${m.chamber === "senate" ? "Senator" : seatId(m)})`).join(", ");
    return h("div.panel.fill.row", { style: "justify-content:space-between" },
      h("span.small", `${data.stateNames.get(drillState)} has ${unmet.length} member${unmet.length === 1 ? "" : "s"} you haven't met yet: `, h("b", names), "."),
      h("button.btn.sm", { type: "button", onclick: () => {
        introduce(unmet);
        location.hash = `#/study?mode=drill&state=${drillState}&t=${Date.now()}`;
      } }, "Add to this drill"));
  }

  /** Today's session / Reviews only / Drill a state (with how well each state has stuck). */
  function modeBar(): HTMLElement {
    const link = (m: Mode, extra = "") => h("a", { href: `#/study?mode=${m}${extra}&t=${Date.now()}`, "aria-pressed": String(mode === m), role: "button" }, MODE_LABEL[m]);
    const select = h("select.input", { id: "drill-state", style: "max-width:280px;padding:6px 10px", "aria-label": "State to drill" },
      ...started.map((p) => h("option", { value: p.state, selected: p.state === drillState },
        `${data.stateNames.get(p.state)} · ${p.solid}/${p.cards} solid`))) as HTMLSelectElement;
    select.addEventListener("change", () => { location.hash = `#/study?mode=drill&state=${select.value}&t=${Date.now()}`; });
    return h("div.row", { style: "justify-content:space-between;gap:12px" },
      h("div.seg.seg-links", link("daily"), link("review"), started.length ? link("drill", `&state=${drillState || started.at(-1)!.state}`) : null),
      mode === "drill" ? select : null);
  }

  function nextCard() {
    keyHandler = null;
    toTop(); // new person: start at the top so the prompt is in view
    const id = queue.shift();
    if (!id) return finish();
    const { memberId, type } = parseCardId(id);
    const m = data.byId.get(memberId);
    if (!m) return nextCard();
    const isNew = (getState().cards[id]?.reps ?? 0) === 0;
    if (isNew && !introShown.has(m.id) && tier1(type)) {
      introShown.add(m.id);
      queue.unshift(id);
      return showIntro(m);
    }
    renderHead(CARD_LABEL[type]);
    renderCard(id, m, type);
  }

  function tier1(t: CardType) {
    return t === "district->name" || t === "name->district" || t === "senator->class";
  }

  function showIntro(m: Member) {
    renderHead("New member");
    const btn = h("button.btn.next", { type: "button", onclick: nextCard }, "Quiz me ", h("span.arrow", { "aria-hidden": "true" }, "→"));
    stage.replaceChildren(
      h("div.stack", { style: "gap:4px" }, h("span.eyebrow", "Meet a new member"), h("p.muted.small", "Take a look, then you'll be quizzed on their district.")),
      revealCard(data, m),
      h("div.row", btn, h("span.kbd", "Enter")));
    keyHandler = (e) => { if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); nextCard(); } };
    btn.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ cards
  function renderCard(id: string, m: Member, type: CardType) {
    const t0 = performance.now();
    const elapsed = () => performance.now() - t0;
    // cards that ask you to recall a name: miss it and you write it out before moving on
    const copyName = type === "district->name" || type === "face->name";
    const finishExact = (ok: boolean, answerText: string, given?: string, partial = false) =>
      answered(id, m, { correct: ok, partial, given, answerText, suggest: ratingForExact(ok, elapsed(), FAST_MS, SLOW_MS, partial), copyName });
    const finishScore = (score: number, answerText: string, given: string) =>
      answered(id, m, { correct: score >= 70, score, partial: score > 0 && score < 70, given, answerText, suggest: ratingForScore(score) });

    const validStates = new Set(data.stateNames.keys());
    const skip = (answerText: string) => answered(id, m, { correct: false, given: "I don't know", answerText, suggest: Rating.Again, copyName });
    const nameInput = (onSubmit: (v: string) => void) => answerInput({
      placeholder: "Name (last name is fine)", onSubmit, onSkip: () => skip(m.name),
      instant: (v) => matcher.isExact(v, m),
    });
    const seatInput = (onSubmit: (v: string) => boolean | void) => answerInput({
      placeholder: m.chamber === "senate" ? "State, e.g. TX or Texas" : "District, e.g. TX-35", onSubmit, width: "260px",
      invalidHint: m.chamber === "senate" ? "Type a state, like MD or Maryland." : "Type a district like MD-03 (or Maryland 3). At-large: WY-AL.",
      onSkip: () => skip(m.chamber === "senate" ? seatLabel(m) : seatId(m)),
      // instant only once the number is unambiguous ("TX-3" could still become "TX-35")
      instant: (v) => {
        const p = parseSeat(v, validStates, data.stateNames);
        if (!p || p.state !== m.state) return false;
        if (m.chamber === "senate") return true;
        return p.district === (m.district ?? 0) && (/\d\d$|AL$/i.test(v.trim()) || (m.district ?? 0) >= 10);
      },
    });

    const checkName = (v: string) => {
      if (matcher.isMatch(v, m)) return finishExact(true, m.name, v);
      const given = matcher.best(v);
      if (given && given.id !== m.id) recordConfusion(m.id, given.id);
      finishExact(false, m.name, given && given.id !== m.id ? `${v} (that's ${given.name})` : v);
    };
    const checkSeat = (v: string): boolean => {
      const p = parseSeat(v, validStates, data.stateNames);
      if (!p) return false; // unreadable: answer box stays open with a format hint
      if (m.chamber === "senate") { finishExact(p.state === m.state, seatLabel(m), p.state); return true; }
      const exact = p.state === m.state && (p.district ?? 0) === (m.district ?? 0);
      finishExact(exact, seatId(m), p.district === null ? p.state : seatId({ state: p.state, district: p.district }), !exact && p.state === m.state);
      return true;
    };
    const nameTitle = (eyebrow: string) => h("div.stack", { style: "gap:4px" }, h("span.eyebrow", eyebrow), promptName(m));
    const seatTitle = () => h("div.row", { style: "gap:10px;align-items:center" }, h("div.prompt-name.code", seatLabel(m)), roleChip(m));

    let view: HTMLElement;
    switch (type) {
      case "district->name":
        view = h("div.grid-2", promptMap(data, m),
          h("div.stack", h("span.eyebrow", m.chamber === "senate" ? "Which senator holds this seat?" : "Who represents this district?"), seatTitle(), nameInput(checkName)));
        break;
      case "face->name":
        view = h("div.stack", { style: "max-width:420px" }, h("span.eyebrow", "Who is this?"), photo(m, "photo big"), h("div", roleChip(m)), nameInput(checkName));
        break;
      case "name->district":
        view = h("div.stack", { style: "max-width:520px" }, nameTitle(m.chamber === "senate" ? "Which state?" : "Which district?"), seatInput((v) => checkSeat(v)));
        break;
      case "senator->class":
        view = h("div.stack", nameTitle("Which Senate class?"),
          buttons([1, 2, 3].map((c) => [`Class ${roman(c)}`, () => finishExact(c === m.senateClass, `Class ${roman(m.senateClass!)}`, `Class ${roman(c)}`)]), () => skip(`Class ${roman(m.senateClass!)}`)));
        break;
      case "name->party":
        view = h("div.stack", nameTitle("Which party?"),
          buttons((["D", "R", "I"] as Party[]).map((p) => [PARTY_NAME[p], () => {
            finishExact(p === m.party, PARTY_NAME[m.party], PARTY_NAME[p]);
            if (m.id === FETTERMAN && p === "R") crystalBall();
          }]), () => skip(PARTY_NAME[m.party])));
        break;
      case "name->face": {
        const others = shuffle(data.members.filter((x) => x.photo && x.id !== m.id && x.chamber === m.chamber), Math.random)
          .sort((a, b) => Number(b.state === m.state) - Number(a.state === m.state)).slice(0, 3);
        const opts = shuffle([m, ...others], Math.random);
        const grid = h("div.choices", ...opts.map((x) => h("button.choice", { type: "button", onclick: () => {
          grid.querySelectorAll(".choice").forEach((el, k) => el.classList.add(opts[k].id === m.id ? "right" : "wrong"));
          if (x.id !== m.id) recordConfusion(m.id, x.id);
          finishExact(x.id === m.id, m.name, x.name);
        } }, photo(x, "photo"))));
        view = h("div.stack", { style: "max-width:420px" }, nameTitle("Which one is them?"), grid, skipButton(() => skip(m.name)));
        break;
      }
      case "race-role": {
        // their race role plus three others (same party first, so it isn't a party giveaway)
        const others = [...new Set(shuffle(data.members.filter((x) => x.raceRole && x.raceRole !== m.raceRole), Math.random)
          .sort((a, b) => Number(b.party === m.party) - Number(a.party === m.party))
          .map((x) => x.raceRole!))].slice(0, 3);
        const opts = shuffle([m.raceRole!, ...others], Math.random);
        view = h("div.stack", { style: "max-width:560px" }, nameTitle("How did their 2026 race go?"),
          buttons(opts.map((label) => [label, () => finishExact(label === m.raceRole, m.raceRole!, label)]), () => skip(m.raceRole!)));
        break;
      }
      case "committees": {
        const truth = new Set(m.committees.map((c) => c.name));
        const pool = [...new Set(data.members.filter((x) => x.chamber === m.chamber).flatMap((x) => x.committees.map((c) => c.name)))].filter((c) => !truth.has(c));
        const opts = shuffle([...truth, ...shuffle(pool, Math.random).slice(0, Math.max(3, 8 - truth.size))], Math.random);
        const picked = new Set<string>();
        const short = (c: string) => c.replace(/^(House|Senate|Joint) Committee on (the )?/, "");
        const chips = h("div.chips", ...opts.map((c) => h("button", { type: "button", "aria-pressed": "false", "data-c": c, onclick: (e: Event) => {
          const b = e.currentTarget as HTMLElement;
          if (picked.has(c)) picked.delete(c); else picked.add(c);
          b.setAttribute("aria-pressed", String(picked.has(c)));
        } }, short(c))));
        const check = () => {
          const tp = [...picked].filter((c) => truth.has(c)).length, fp = picked.size - tp;
          chips.querySelectorAll<HTMLElement>("button").forEach((b) => { const c = b.dataset.c!; b.classList.add(truth.has(c) ? "right" : picked.has(c) ? "wrong" : ""); });
          finishScore(Math.max(0, Math.round((100 * (tp - fp)) / truth.size)), [...truth].map(short).join(", "), [...picked].map(short).join(", ") || "nothing");
        };
        view = h("div.stack", nameTitle(`Which committees? (${m.committeeCongress}th Congress)`), chips, h("div.row", h("button.btn", { type: "button", onclick: check }, "Check"), skipButton(() => skip([...truth].map(short).join(", ")))));
        break;
      }
      case "war-trajectory": {
        const others = shuffle(data.members.filter((x) => x.id !== m.id && x.war.length >= 2 && x.warTrajectory !== m.warTrajectory), Math.random).slice(0, 3);
        const opts = shuffle([m, ...others], Math.random);
        const grid = h("div.choices", ...opts.map((x) => h("button.choice", { type: "button", onclick: () => {
          grid.querySelectorAll(".choice").forEach((el, k) => el.classList.add(opts[k].id === m.id ? "right" : "wrong"));
          finishExact(x.id === m.id, `${m.warTrajectory}`, `${x.warTrajectory}`);
        } }, sparkline(x.war, m.party, 160, 60))));
        view = h("div.stack", { style: "max-width:520px" }, nameTitle("Which line is their WAR history?"),
          h("p.muted.small", `Their races: ${m.war.map((p) => `${p.year} vs. ${p.opponent}`).join(" · ")}`), grid, skipButton(() => skip(`${m.warTrajectory}`)));
        break;
      }
      case "war": {
        const actual = m.war.at(-1)!;
        view = h("div.stack", { style: "max-width:520px" }, nameTitle("WAR in this race"),
          h("p", { style: "font-size:17px" }, h("b", warRace(actual))),
          slider({ min: -10, max: 10, step: 0.1, start: 0, fmt: fmtWar, onSubmit: (v) => finishScore(closeness("war", v, actual.value), `${fmtWar(actual.value)} vs. ${actual.opponent}`, fmtWar(v)) }),
          skipButton(() => skip(`${fmtWar(actual.value)} vs. ${actual.opponent}`)),
          h("p.muted.small", `Positive = ran ahead of a generic ${m.party === "D" ? "Democrat" : m.party === "R" ? "Republican" : "candidate"} against ${actual.opponent}.`));
        break;
      }
      case "kamala-2way":
        view = h("div.grid-2", promptMap(data, m),
          h("div.stack", h("span.eyebrow", "Harris share of the two-party vote, 2024"), seatTitle(),
            slider({ min: 0, max: 100, step: 0.5, start: 50, fmt: (v) => `${v.toFixed(1)}%`, onSubmit: (v) => numeric("share", v / 100, m.kamala2Way!, (x) => `${(x * 100).toFixed(1)}%`) }),
            skipButton(() => skip(`${(m.kamala2Way! * 100).toFixed(1)}%`))));
        break;
      case "last-2way":
        view = h("div.stack", { style: "max-width:520px" }, nameTitle(`Their share of the two-way vote, ${m.last2Way!.year}`),
          slider({ min: 30, max: 100, step: 0.5, start: 60, fmt: (v) => `${v.toFixed(1)}%`, onSubmit: (v) => numeric("share", v / 100, m.last2Way!.share, (x) => `${(x * 100).toFixed(1)}%`) }),
          skipButton(() => skip(`${(m.last2Way!.share * 100).toFixed(1)}%`)));
        break;
      case "first-elected":
        view = h("div.stack", { style: "max-width:520px" }, nameTitle("First elected to Congress in…"),
          answerInput({ placeholder: "Year, e.g. 2018", width: "200px", onSkip: () => skip(String(m.firstElectedYear)),
            onSubmit: (v) => { const y = Number(v); numeric("year", y > 1900 && y < 2100 ? y : 0, m.firstElectedYear, String); } }));
        break;
      case "fundraising": {
        const actual = m.fundraising!.receipts;
        view = h("div.stack", { style: "max-width:520px" }, nameTitle("Total raised, 2025–26 cycle"),
          slider({ min: 4, max: 8.5, step: 0.01, start: 6.3, fmt: (v) => fmtMoney(10 ** v), onSubmit: (v) => numeric("money", 10 ** v, actual, fmtMoney) }),
          skipButton(() => skip(fmtMoney(actual))));
        break;
      }
      default:
        return nextCard();
    }
    stage.replaceChildren(view);
    view.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });

    function numeric(fact: NumericFact, guess: number, actual: number, fmt: (x: number) => string) {
      finishScore(closeness(fact, guess, actual), fmt(actual), fmt(guess));
    }
  }

  // ------------------------------------------------------------------ answer + rate
  function answered(id: string, m: Member, o: Outcome) {
    const card = getState().cards[id];
    const iv = previews(card);
    const verdictText = o.score !== undefined
      ? `${o.score >= 70 ? "Close" : o.score > 0 ? "In the neighborhood" : "Not close"} · ${o.score} / 100`
      : o.correct ? "Correct" : o.partial ? "Right state, wrong district" : o.given === "I don't know" ? "Skipped" : "Not quite";
    const rate = (g: Grade) => {
      const wasNew = card.reps === 0;
      const next = review(card, g);
      update((s) => { s.cards[id] = next; });
      const log = todayLog();
      log.reviews++;
      if (o.correct) log.correct++;
      if (wasNew) log.newCount++;
      update(() => {});
      refreshStreak();
      done++;
      if (o.correct) correct++;
      // misses come back a few cards later; in a drill, every miss comes back until you get it
      if ((mode === "drill" && !o.correct) || new Date(next.due).getTime() - Date.now() < 20 * 60000) {
        if (!queue.includes(id)) queue.splice(Math.min(3, queue.length), 0, id);
      }
      nextCard();
    };
    stage.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((el) => { el.disabled = true; });
    const suggestLabel = RATING_LABEL.find(([g]) => g === o.suggest)![1];
    const nextBtn = h("button.btn.next", { type: "button", onclick: () => rate(o.suggest) },
      "Next ", h("span.arrow", { "aria-hidden": "true" }, "→"));
    const rateRow = h("div.rate.secondary", { role: "group", "aria-label": "Rate it yourself" },
      ...RATING_LABEL.map(([g, label], k) => h("button", { type: "button", class: g === o.suggest ? "suggest" : "", onclick: () => rate(g) },
        `${label} `, h("small", `${iv[g]} · ${k + 1}`))));
    // missed a name: type it out (full name) to unlock Next
    let locked = !!o.copyName && !o.correct;
    const actions = [nextBtn, ...rateRow.querySelectorAll("button")] as HTMLButtonElement[];
    let copyBox: HTMLElement | null = null;
    if (locked) {
      actions.forEach((b) => { b.disabled = true; });
      const copy = h("input.input", { type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false",
        placeholder: m.name, "aria-label": `Type ${m.name} to continue`, style: "max-width:320px" }) as HTMLInputElement;
      const hint = h("span.muted.small", { "aria-live": "polite" }, "Type their full name to continue.");
      // exact only: the full name unlocks as you finish typing it; a listed alias works on Enter
      const full = norm(m.name);
      const aliases = m.aliases.map(norm);
      const good = (v: string, enter = false) => { const n = norm(v); return !!n && (n === full || (enter && aliases.includes(n))); };
      const unlock = () => {
        locked = false;
        copy.disabled = true;
        copy.classList.add("ok");
        hint.textContent = "Got it.";
        actions.forEach((b) => { b.disabled = false; });
        nextBtn.focus({ preventScroll: true });
      };
      copy.addEventListener("input", () => { copy.classList.remove("no"); if (good(copy.value)) unlock(); });
      copy.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        e.stopPropagation();
        if (good(copy.value, true)) unlock();
        else { copy.classList.add("no"); hint.textContent = `Not quite. Type "${m.name}".`; }
      });
      copyBox = h("div.stack", { style: "gap:6px" }, h("span.rate-label", "Write it out"), copy, hint);
    }
    stage.append(
      h("div.panel.stack", { style: "gap:12px" },
        h("div", { class: `verdict ${o.correct ? "ok" : "no"}` }, verdictText,
          !o.correct || o.score !== undefined ? h("span.muted", { style: "font-weight:500" }, ` · answer: ${o.answerText}${o.given ? ` · you said ${o.given}` : ""}`) : null),
        copyBox,
        h("div.next-row", nextBtn,
          h("span.muted.small", `Counts as `, h("b", { style: "color:var(--ink)" }, suggestLabel), ` · back in ${iv[o.suggest]} · `, h("span.kbd", "Enter"))),
        h("div.stack", { style: "gap:6px" }, h("span.rate-label", "Or rate it yourself"), rateRow)),
      revealCard(data, m, { missed: !o.correct }),
    );

    keyHandler = (e) => {
      if (e.target instanceof HTMLTextAreaElement || locked) return;
      if (e.key === "Enter") { e.preventDefault(); rate(o.suggest); }
      const n = Number(e.key);
      if (n >= 1 && n <= 4) rate(RATING_LABEL[n - 1][0]);
    };
    if (locked) (copyBox!.querySelector("input") as HTMLInputElement).focus({ preventScroll: true });
    else (nextBtn as HTMLButtonElement).focus();
  }

  function finish() {
    keyHandler = null;
    renderHead("Session complete");
    const pct = done ? Math.round((100 * correct) / done) : 0;
    const hold = stateHold(data);
    let note: string;
    if (mode === "drill") {
      const p = stateProgress(data, drillState);
      note = `${data.stateNames.get(drillState)}: ${p.solid} of ${p.cards} core cards have stuck (3+ days). Spaced reviews over the next few days will finish the job.`;
    } else if (hold) {
      note = `New members are on hold until ${data.stateNames.get(hold.state)} sticks (${hold.solid} of ${hold.cards} core cards solid). Drilling it now helps, but sleeping on it is what makes it stick.`;
    } else {
      note = mode === "review" ? "All caught up on reviews." : "That's today's work. Reviews will be ready tomorrow.";
    }
    stage.replaceChildren(h("div.panel.stack",
      h("div.prompt-name", done ? `${done} cards, ${pct}% right` : "Nothing due right now"),
      h("p.muted", note),
      h("div.row",
        mode === "drill" ? h("a.btn", { href: `#/study?mode=drill&state=${drillState}&t=${Date.now()}` }, "Drill again") : hold ? h("a.btn", { href: `#/study?mode=drill&state=${hold.state}&t=${Date.now()}` }, `Drill ${data.stateNames.get(hold.state)}`) : null,
        h("a.btn.line", { href: "#/tap" }, "Play District Tap"),
        h("a.btn.line", { href: "#/map" }, "See your mastery map"))));
  }
}

// ------------------------------------------------------------------ inputs
const FETTERMAN = "F000479";

/** Easter egg: calling John Fetterman a Republican. Still graded wrong; he's a Democrat (for now). */
function crystalBall(): void {
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); close(); } };
  const overlay = h("div.egg", { role: "dialog", "aria-modal": "true", "aria-label": "Crystal ball", onclick: (e: Event) => { if (e.target === overlay) close(); } },
    h("div.egg-card",
      h("div.egg-ball", { "aria-hidden": "true" }, "🔮"),
      h("h2", "Not yet 😉"),
      h("p.muted", "Didn't know you could see the future."),
      h("button.btn", { type: "button", onclick: close }, "Back to the present")));
  document.body.append(overlay);
  document.addEventListener("keydown", onKey, true);
  (overlay.querySelector("button") as HTMLButtonElement).focus({ preventScroll: true });
}

function buttons(opts: [string, () => void][], onSkip: () => void): HTMLElement {
  return h("div.stack", { style: "gap:10px" },
    h("div.big-choices", ...opts.map(([label, fn], k) => h("button.btn.line", { type: "button", onclick: fn, "aria-keyshortcuts": String(k + 1) }, label))),
    skipButton(onSkip));
}

function slider(o: { min: number; max: number; step: number; start: number; fmt: (v: number) => string; onSubmit: (v: number) => void }): HTMLElement {
  const out = h("output.prompt-name.num", o.fmt(o.start));
  const input = h("input", { type: "range", min: o.min, max: o.max, step: o.step, value: o.start, style: "width:100%" }) as HTMLInputElement;
  input.addEventListener("input", () => { out.textContent = o.fmt(Number(input.value)); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); o.onSubmit(Number(input.value)); } });
  return h("div.stack", { style: "gap:10px" }, out, input, h("div.row", h("button.btn", { type: "button", onclick: () => o.onSubmit(Number(input.value)) }, "Lock it in")));
}
