/** Members: browse every member's card without being quizzed. Filters + full card on click. */
import { seatLabel } from "../data/load";
import type { Member, Party } from "../data/types";
import type { Ctx } from "../main";
import { introductionOrder, masteryLevel } from "../srs/cards";
import { getState } from "../store";
import { partyChip, photo, revealCard, roleChip } from "./components";
import { h } from "./dom";

type Chamber = "all" | "senate" | "house";

export function browseView(root: HTMLElement, ctx: Ctx, params: URLSearchParams) {
  const { data, matcher } = ctx;
  const order = introductionOrder(data); // state route, senators first: same order you learn them
  let q = params.get("q") ?? "";
  let state = params.get("state") ?? "";
  let chamber: Chamber = (["senate", "house"] as const).find((c) => c === params.get("chamber")) ?? "all";
  let party: Party | "" = (["D", "R", "I"] as const).find((p) => p === params.get("party")) ?? "";
  let metOnly = params.get("met") === "1";
  let flippedOnly = params.get("flipped") === "1";
  let shown: Member[] = [];

  const search = h("input.input", { id: "browse-q", type: "search", placeholder: "Search names", autocomplete: "off", style: "max-width:240px" }) as HTMLInputElement;
  search.value = q;
  search.addEventListener("input", () => { q = search.value; render(); });

  const states = [...data.stateNames.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const stateSel = h("select.input", { id: "browse-state", style: "max-width:220px", "aria-label": "State" },
    h("option", { value: "" }, "All states"), ...states.map(([id, name]) => h("option", { value: id, selected: id === state }, name))) as HTMLSelectElement;
  stateSel.addEventListener("change", () => { state = stateSel.value; render(); });

  const seg = <T extends string>(label: string, options: [T, string][], get: () => T, set: (v: T) => void) => {
    const el = h("div.seg", { role: "group", "aria-label": label });
    const draw = () => el.replaceChildren(...options.map(([v, l]) =>
      h("button", { type: "button", "aria-pressed": String(get() === v), onclick: () => { set(v); draw(); render(); } }, l)));
    draw();
    return el;
  };
  const toggle = (id: string, label: string, get: () => boolean, set: (v: boolean) => void) => {
    const cb = h("input", { type: "checkbox", id }) as HTMLInputElement;
    cb.checked = get();
    cb.addEventListener("change", () => { set(cb.checked); render(); });
    return h("label.row.small", { for: id, style: "gap:6px" }, cb, label);
  };

  const count = h("span.muted.small.num");
  const grid = h("div.member-grid");
  const panel = h("div.member-panel", { hidden: true, role: "dialog", "aria-modal": "true", "aria-label": "Member card" });

  root.append(h("section.stack", { style: "gap:14px" },
    h("div.sec-head", h("h2", "Members"), count),
    h("div.row", { style: "gap:10px" }, search, stateSel,
      seg<Chamber>("Chamber", [["all", "Both"], ["senate", "Senate"], ["house", "House"]], () => chamber, (v) => { chamber = v; }),
      seg<Party | "">("Party", [["", "All"], ["D", "D"], ["R", "R"], ["I", "I"]], () => party, (v) => { party = v; })),
    h("div.row", { style: "gap:16px" },
      toggle("browse-met", "Only members I've met", () => metOnly, (v) => { metOnly = v; }),
      toggle("browse-flipped", "Only flipped seats", () => flippedOnly, (v) => { flippedOnly = v; })),
    grid), panel);
  render();

  const onKey = (e: KeyboardEvent) => {
    if (panel.hidden) return;
    if (e.key === "Escape") close();
    if (e.key === "ArrowRight") step(1);
    if (e.key === "ArrowLeft") step(-1);
  };
  window.addEventListener("keydown", onKey);
  return () => { window.removeEventListener("keydown", onKey); document.body.classList.remove("no-scroll"); };

  function matches(m: Member): boolean {
    if (state && m.state !== state) return false;
    if (chamber !== "all" && m.chamber !== chamber) return false;
    if (party && m.party !== party) return false;
    if (metOnly && !getState().introduced[m.id]) return false;
    if (flippedOnly && !m.seatFlipped) return false;
    return true;
  }

  function render() {
    let list = order.filter(matches);
    if (q.trim()) {
      // name search: fuzzy matches first, then anything with the text in the name or seat
      const hits = new Set(matcher.suggest(q, 40).map((m) => m.id));
      const t = q.trim().toLowerCase();
      list = list.filter((m) => hits.has(m.id) || m.name.toLowerCase().includes(t) || seatLabel(m).toLowerCase().includes(t));
    }
    shown = list;
    count.textContent = `${list.length} of ${data.members.length}`;
    grid.replaceChildren(...(list.length ? list.map(tile) : [h("p.muted", "No members match these filters.")]));
  }

  function tile(m: Member): HTMLElement {
    const lvl = masteryLevel(m);
    return h("button.member-tile", { type: "button", onclick: () => open(m), "aria-label": `${m.name}, ${seatLabel(m)}` },
      photo(m, "photo tile-photo"),
      h("div.tile-text",
        h("b", m.name),
        h("div.row", { style: "gap:6px" }, roleChip(m), partyChip(m.party)),
        h("span.code.small.muted", seatLabel(m)),
        h("span.small.muted", lvl === null ? "Not met yet" : `Mastery ${lvl}/5`)));
  }

  function open(m: Member) {
    const i = shown.findIndex((x) => x.id === m.id);
    panel.replaceChildren(
      h("div.member-panel-inner",
        h("div.row", { style: "justify-content:space-between" },
          h("div.row", { style: "gap:6px" },
            h("button.btn.line.sm", { type: "button", onclick: () => step(-1), disabled: i <= 0, "aria-label": "Previous member" }, "←"),
            h("button.btn.line.sm", { type: "button", onclick: () => step(1), disabled: i >= shown.length - 1, "aria-label": "Next member" }, "→"),
            h("span.small.muted.num", `${i + 1} of ${shown.length}`)),
          h("button.ghost", { type: "button", onclick: close }, "Close")),
        revealCard(data, m, { showMnemonic: true })));
    panel.dataset.index = String(i);
    panel.hidden = false;
    document.body.classList.add("no-scroll");
    panel.scrollTop = 0;
    (panel.querySelector("button.ghost") as HTMLButtonElement)?.focus({ preventScroll: true });
  }

  function step(d: number) {
    const i = Number(panel.dataset.index ?? -1) + d;
    if (i >= 0 && i < shown.length) open(shown[i]);
  }

  function close() {
    panel.hidden = true;
    document.body.classList.remove("no-scroll");
  }
}
