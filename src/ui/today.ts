/** Home: daily goal, today's District Tap, most-confused pair, quick stats. */
import { seatLabel } from "../data/load";
import type { Ctx } from "../main";
import { dueCards, dueForecast, introducedToday, masteryLevel, newRemainingToday, nextNewMembers, stateHold, syncUnlocks, unseenCards } from "../srs/cards";
import { topConfusions } from "../srs/confusions";
import { puzzleNumber } from "../games/seed";
import { getState, studyStreak, streakFrom, today, todayLog, update } from "../store";
import { goalRing, partySplit, roleChip } from "./components";
import { h } from "./dom";
import { tapEmoji } from "../games/districtTap";

function greeting(): string {
  const hr = new Date().getHours();
  return hr < 5 ? "Up late." : hr < 12 ? "Good morning." : hr < 18 ? "Good afternoon." : "Good evening.";
}

export function todayView(root: HTMLElement, { data }: Ctx) {
  syncUnlocks(data);
  const st = getState();
  const due = dueCards(data).length;
  const unseen = unseenCards(data).length;
  const newLeft = newRemainingToday();
  const queued = nextNewMembers(data, newLeft);
  const hold = stateHold(data);
  const holdName = hold ? data.stateNames.get(hold.state) ?? hold.state : "";
  const log = todayLog();
  const reviewedToday = log.reviews;
  const introToday = introducedToday();
  const total = due + unseen + queued.length * 2;
  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const states = [...new Set(queued.map((m) => data.stateNames.get(m.state) ?? m.state))];

  const headline = total === 0 ? `${greeting()} You're done for today.` : `${greeting()} ${total} card${total === 1 ? "" : "s"} to go today.`;
  const sub = total === 0
    ? (hold ? `New members are on hold while ${holdName} sinks in. Drill it, or come back tomorrow for reviews.` : "Come back tomorrow for new members and reviews, or play District Tap.")
    : `${due} review${due === 1 ? "" : "s"} due${queued.length ? `, and ${queued.length} new member${queued.length === 1 ? "" : "s"} queued from ${states.slice(0, 2).join(" and ")}${states.length > 2 ? " and more" : ""}` : ""}.`;

  // District Tap status
  const t = today();
  const played = st.tap.find((r) => r.date === t);
  const tapStreak = streakFrom(new Set(st.tap.map((r) => r.date)));

  // Retention, last 7 days
  const week = st.log.filter((l) => Date.now() - Date.parse(`${l.date}T12:00:00`) < 7 * 86400000);
  const wr = week.reduce((a, l) => a + l.reviews, 0), wc = week.reduce((a, l) => a + l.correct, 0);

  const conf = topConfusions(1)[0];
  const a = conf && data.byId.get(conf.a), b = conf && data.byId.get(conf.b);

  const introduced = Object.keys(st.introduced).filter((id) => data.byId.has(id)).length;
  const mastered = data.members.filter((m) => masteryLevel(m) === 5).length;
  const forecast = dueForecast(data, 14);
  const fmax = Math.max(1, ...forecast);

  root.append(
    h("section.stack", { style: "gap:22px" },
      h("div.stack", { style: "gap:6px" },
        h("span.eyebrow", `${dateStr} · 120th Congress`),
        h("h1", headline),
        h("p.muted", sub)),
      h("div.grid-3",
        h("div.panel",
          h("h3", "Daily goal"),
          h("div.goal",
            goalRing([reviewedToday, reviewedToday + due], [introToday, introToday + queued.length]),
            h("div.legend",
              h("div", h("span.sw", { style: "background:var(--teal)" }), "Reviews ", h("b", `${reviewedToday} / ${reviewedToday + due}`)),
              h("div", h("span.sw", { style: "background:var(--raspberry)" }), "New members ", h("b", `${introToday} / ${introToday + queued.length}`)),
              h("div.muted.small", "Retention this week: ", h("b", { style: "color:var(--ink)" }, wr ? `${Math.round((100 * wc) / wr)}%` : "—")))),
          queued.length ? partySplit(queued, "New today") : null,
          hold ? holdPanel() : null,
          h("a.btn", { href: "#/study" }, total ? (reviewedToday || introToday ? "Continue studying" : "Start studying") : "Review anyway")),
        h("div.panel",
          h("div.sec-head", h("h3", "District Tap ", h("span.muted.num", `#${puzzleNumber(t)}`)),
            h("span.muted.small", tapStreak ? `${tapStreak}-day streak` : "Resets at midnight")),
          played
            ? h("div.stack", { style: "gap:10px" },
                h("div.squares", played.miles.map(tapEmoji).join("")),
                h("p", h("b.num", `${played.total}`), h("span.muted", " / 500 today")),
                h("a.btn.line", { href: "#/tap" }, "See results"))
            : h("div.stack", { style: "gap:10px" },
                h("p.muted.small", "Five names. Tap where their district is. Same five for everyone today."),
                h("div.squares", ...Array.from({ length: 5 }, () => h("span.empty"))),
                h("a.btn", { href: "#/tap" }, "Play today's puzzle"))),
        h("div.panel.fill",
          h("h3", "Most confused"),
          a && b
            ? h("div.stack", { style: "gap:10px" },
                h("div.pair",
                  h("div.who", h("b", a.name), h("span.row", { style: "gap:6px" }, h("span.code.muted", seatLabel(a)), roleChip(a))),
                  h("span.vs", "vs"),
                  h("div.who", h("b", b.name), h("span.row", { style: "gap:6px" }, h("span.code.muted", seatLabel(b)), roleChip(b)))),
                h("p.muted.small", `Mixed up ${conf.count} time${conf.count === 1 ? "" : "s"}.`),
                h("a.btn.line", { href: "#/test?mode=confusables" }, "Drill confusables"))
            : h("p.muted.small", "Members you mix up will show here, so you can drill them side by side."))),
    ),
    h("section.grid-3",
      h("div.panel", h("span.eyebrow", "Progress"),
        h("p", h("b.num", { style: "font-size:26px" }, `${introduced}`), h("span.muted", ` of ${data.members.length} members introduced`)),
        h("p.muted.small", `${mastered} mastered · study streak ${studyStreak()} day${studyStreak() === 1 ? "" : "s"}`),
        h("a.btn.line.sm", { href: "#/map" }, "Open mastery map")),
      h("div.panel", h("span.eyebrow", "Reviews due, next 14 days"),
        h("div.hist", { role: "img", "aria-label": `Reviews due per day: ${forecast.join(", ")}` },
          ...forecast.map((n) => h("span", { style: `height:${(100 * n) / fmax}%`, title: `${n}` }))),
        h("p.muted.small", `${forecast[0]} due today · ${forecast.slice(1, 8).reduce((x, y) => x + y, 0)} over the next week`)),
      h("div.panel", h("span.eyebrow", "Tests"),
        h("p.small.muted", "Quick 10, a single state, the full sweep of all members, or a 60-second sprint."),
        h("div.row", h("a.btn.line.sm", { href: "#/test?mode=n2d" }, "Name → District"), h("a.btn.line.sm", { href: "#/test?mode=d2n" }, "District → Name"),
          h("a.btn.line.sm", { href: "#/test?mode=d2n&who=senate" }, "Senators")))),
  );

  /** New members paused until the state you just finished sticks. */
  function holdPanel(): HTMLElement {
    const pct = hold!.cards ? Math.round((100 * hold!.solid) / hold!.cards) : 0;
    return h("div.hold.stack", { style: "gap:8px" },
      h("div.split-head", h("span", `Locking in ${holdName}`), h("span.num", `${hold!.solid} / ${hold!.cards} cards solid`)),
      h("div.split-bar", { role: "img", "aria-label": `${pct}% of ${holdName}'s core cards have stuck` },
        h("span", { style: `flex:${hold!.solid};background:var(--teal)` }), h("span", { style: `flex:${hold!.cards - hold!.solid}` })),
      h("p.muted.small", `You finished ${holdName}. New members wait until every core card would be remembered for 3+ days.`),
      h("div.row",
        h("a.btn.line.sm", { href: `#/study?mode=drill&state=${hold!.state}&t=${Date.now()}` }, `Drill ${holdName}`),
        h("button.ghost", { type: "button", onclick: () => {
          update((x) => { x.settings.holdOverride = today(); });
          location.hash = `#/today?t=${Date.now()}`;
        } }, "Add new members anyway")));
  }
}
