/**
 * Full-screen map with floating cards (the MapTap layout): the prompt sits top-left,
 * the score top-right, and results open as a panel over the map. Nothing scrolls away.
 */
import type { UsMap } from "../map/usMap";
import { h } from "./dom";

export interface Playfield { el: HTMLElement; prompt: HTMLElement; score: HTMLElement; sheet: HTMLElement }

export function playfield(map: UsMap): Playfield {
  const prompt = h("div.pf-card.pf-prompt", { "aria-live": "polite" });
  const score = h("div.pf-card.pf-score");
  const sheet = h("div.pf-card.pf-sheet", { hidden: true });
  const el = h("div.playfield", map.el, prompt, score, sheet);
  return { el, prompt, score, sheet };
}
