/** Page chrome shared by views: theme and the header streak pill. */
import { getState, studyStreak } from "../store";

export function applyTheme(): void {
  const t = getState().settings.theme;
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}

export function refreshStreak(): void {
  const n = studyStreak();
  const pill = document.getElementById("streak-pill");
  const text = document.getElementById("streak-text");
  if (!pill || !text) return;
  pill.hidden = n === 0;
  text.textContent = `${n}-day streak`;
}
