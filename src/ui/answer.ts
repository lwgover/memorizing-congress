/**
 * The typed-answer box used by Study and Tests.
 *  - instant: accepted the moment what you've typed is right (no Enter needed)
 *  - "I don't know" button, or Enter twice on an empty box
 *  - optional suggestions (names only, so the list never gives away the district)
 */
import { h } from "./dom";

export interface AnswerOpts {
  placeholder: string;
  id?: string;
  onSubmit: (v: string) => void;
  onSkip: () => void;
  /** Return true if this value is already correct; it's then submitted immediately. */
  instant?: (v: string) => boolean;
  suggest?: (v: string) => string[];
  width?: string;
}

export function answerInput(o: AnswerOpts): HTMLElement {
  const input = h("input.input", { id: o.id, placeholder: o.placeholder, autocomplete: "off", autocapitalize: "off", spellcheck: "false" }) as HTMLInputElement;
  const hint = h("span.muted.small", { "aria-live": "polite" });
  const list = h("ul", { role: "listbox", hidden: true });
  let done = false;
  let blankAt = 0;
  let sel = -1;

  const finish = (fn: () => void) => {
    if (done) return;
    done = true;
    list.hidden = true;
    fn();
  };
  const submit = () => {
    const v = input.value.trim();
    if (!v) return;
    finish(() => o.onSubmit(v));
  };
  const skip = () => finish(o.onSkip);

  input.addEventListener("input", () => {
    hint.textContent = "";
    const v = input.value.trim();
    if (o.instant && v.length >= 2 && o.instant(v)) {
      input.classList.add("ok");
      finish(() => o.onSubmit(v));
      return;
    }
    if (o.suggest) {
      const items = v ? o.suggest(v) : [];
      sel = -1;
      list.replaceChildren(...items.map((label) => h("li", { role: "option", onmousedown: (e: Event) => { e.preventDefault(); input.value = label; submit(); } }, label)));
      list.hidden = !items.length;
    }
  });

  input.addEventListener("keydown", (e) => {
    const items = [...list.querySelectorAll("li")];
    if (!list.hidden && items.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach((li, k) => li.setAttribute("aria-selected", String(k === sel)));
      return;
    }
    if (e.key === "Escape") { list.hidden = true; return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    if (!input.value.trim()) {
      if (Date.now() - blankAt < 2500) return skip();
      blankAt = Date.now();
      hint.textContent = "Press Enter again if you don't know.";
      return;
    }
    if (!list.hidden && sel >= 0) input.value = items[sel].textContent ?? input.value;
    submit();
  });

  return h("div.stack", { style: "gap:6px" },
    h("div.row", { style: "flex-wrap:nowrap" },
      h("div.ta", { style: `flex:1;${o.width ? `max-width:${o.width}` : ""}` }, input, list),
      h("button.btn", { type: "button", onclick: submit }, "Check"),
      h("button.btn.line", { type: "button", onclick: skip }, "I don't know")),
    hint);
}

/** "I don't know" for button/choice cards. */
export function skipButton(onSkip: () => void): HTMLElement {
  return h("button.btn.line.sm", { type: "button", onclick: onSkip, style: "justify-self:start" }, "I don't know");
}
