import "./styles/palette.css";
import "./styles/app.css";
import { loadData } from "./data/load";
import { NameMatcher } from "./games/match";
import { Router } from "./router";
import { applyTheme, refreshStreak } from "./ui/chrome";
import { h } from "./ui/dom";
import { masteryView } from "./ui/mastery";
import { settingsView } from "./ui/settings";
import { studyView } from "./ui/study";
import { tapView } from "./ui/tap";
import { testView } from "./ui/tests";
import { todayView } from "./ui/today";

async function boot() {
  applyTheme();
  refreshStreak();
  const app = document.getElementById("app")!;
  try {
    const data = await loadData();
    const matcher = new NameMatcher(data.members);
    const ctx = { data, matcher };
    const router = new Router(app, {
      today: (root) => todayView(root, ctx),
      study: (root, p) => studyView(root, ctx, p),
      tap: (root, p) => tapView(root, ctx, p),
      test: (root, p) => testView(root, ctx, p),
      map: (root) => masteryView(root, ctx),
      settings: (root) => settingsView(root, ctx),
    }, "today");
    router.render();
  } catch (err) {
    app.replaceChildren(h("div.panel", h("h2", "The data didn't load"),
      h("p.muted", String((err as Error).message)),
      h("p.muted", "Check your connection and reload. If you're running locally, run ./run_pipeline.sh first.")));
  }
}

export interface Ctx { data: Awaited<ReturnType<typeof loadData>>; matcher: NameMatcher }

boot();
