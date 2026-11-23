/** Settings: pace, Tier 3 facts, theme, backup (export/import), reset. */
import type { Ctx } from "../main";
import { TIER3_FACTS, syncUnlocks } from "../srs/cards";
import { exportState, getState, importState, resetState, update } from "../store";
import { applyTheme, refreshStreak } from "./chrome";
import { h, toast } from "./dom";

export function settingsView(root: HTMLElement, { data }: Ctx) {
  const st = getState();

  const pace = h("input.input", { id: "new-per-day", type: "number", min: 0, max: 100, value: st.settings.newPerDay, style: "max-width:120px" }) as HTMLInputElement;
  pace.addEventListener("change", () => {
    const n = Math.max(0, Math.min(100, Math.round(Number(pace.value) || 0)));
    pace.value = String(n);
    update((s) => { s.settings.newPerDay = n; });
    toast("Saved");
  });

  const hold = h("input", { type: "checkbox", id: "hold-after-state" }) as HTMLInputElement;
  hold.checked = st.settings.holdAfterState;
  hold.addEventListener("change", () => { update((s) => { s.settings.holdAfterState = hold.checked; }); toast("Saved"); });

  const theme = h("div.seg", { role: "group", "aria-label": "Theme" });
  const renderTheme = () => theme.replaceChildren(...(["system", "light", "dark"] as const).map((t) =>
    h("button", { type: "button", "aria-pressed": String(getState().settings.theme === t), onclick: () => {
      update((s) => { s.settings.theme = t; });
      applyTheme();
      renderTheme();
    } }, t === "system" ? "Match system" : t === "light" ? "Light" : "Dark")));
  renderTheme();

  const tier3 = h("div.stack", { style: "gap:8px" }, ...TIER3_FACTS.map((f) => {
    const cb = h("input", { type: "checkbox", id: `t3-${f.type}` }) as HTMLInputElement;
    cb.checked = !!st.settings.tier3[f.type];
    cb.addEventListener("change", () => {
      update((s) => { s.settings.tier3[f.type] = cb.checked; });
      syncUnlocks(data);
    });
    return h("label.row", { for: `t3-${f.type}`, style: "gap:8px" }, cb, f.label);
  }));

  const exportBox = h("textarea.mnemonic", { id: "export-box", readonly: true, style: "min-height:120px;font-family:var(--mono);font-size:12px" }) as HTMLTextAreaElement;
  exportBox.hidden = true;
  const file = h("input", { type: "file", accept: "application/json,.json", id: "import-file", hidden: true }) as HTMLInputElement;
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      importState(await f.text());
      applyTheme();
      refreshStreak();
      toast("Progress imported");
      location.hash = "#/today";
    } catch (e) {
      toast((e as Error).message);
    }
  });

  let confirmReset = false;
  const resetBtn = h("button.btn.line", { type: "button" }, "Reset all progress") as HTMLButtonElement;
  resetBtn.addEventListener("click", () => {
    if (!confirmReset) {
      confirmReset = true;
      resetBtn.textContent = "Click again to erase everything";
      return;
    }
    resetState();
    applyTheme();
    refreshStreak();
    toast("Progress reset");
    location.hash = "#/today";
  });

  const counts = `${Object.keys(st.cards).length} cards · ${Object.keys(st.mnemonics).length} mnemonics · ${st.tap.length} District Tap games`;

  root.append(h("section.stack", { style: "gap:16px;max-width:720px" },
    h("h2", "Settings"),
    h("div.panel.stack",
      h("h3", "Pace"),
      h("label.row", { for: "new-per-day" }, pace, h("span.muted", "new members per day")),
      h("p.muted.small", "Members are introduced one state delegation at a time, in a fixed route around the map. Faces and party unlock for a member once you know their district well."),
      h("label.row", { for: "hold-after-state", style: "gap:8px;align-items:flex-start" }, hold,
        h("span", h("b", "Lock in each state before starting the next. "),
          h("span.muted", "New members never cross into a new state on the same day, and after you finish a state they wait until every core card for it would be remembered for 3+ days. Study → Drill a state lets you practice it any time.")))),
    h("div.panel.stack",
      h("h3", "Fun facts (Tier 3)"),
      h("p.muted.small", "Numbers are graded on how close you get. These cards appear for members you already know well."),
      tier3),
    h("div.panel.stack", h("h3", "Theme"), theme),
    h("div.panel.stack",
      h("h3", "Backup"),
      h("p.muted.small", `Your progress lives in this browser only (${counts}). Export it to move to another device or keep a copy.`),
      h("div.row",
        h("button.btn", { type: "button", onclick: async () => {
          const text = exportState();
          exportBox.value = text;
          exportBox.hidden = false;
          exportBox.select();
          try { await navigator.clipboard.writeText(text); toast("Copied. Paste it into a file to keep it."); } catch { toast("Select the text below and copy it."); }
        } }, "Export progress"),
        h("button.btn.line", { type: "button", onclick: () => file.click() }, "Import from file"),
        file),
      exportBox),
    h("div.panel.stack", h("h3", "Start over"), h("p.muted.small", "Erases every card, streak, mnemonic and game in this browser."), h("div.row", resetBtn)),
  ));
}
