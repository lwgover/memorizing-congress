/** Hash routing (#/today, #/tap, ...) so deep links work on GitHub Pages without 404 tricks. */
export type View = (root: HTMLElement, params: URLSearchParams) => void | (() => void);

export class Router {
  private cleanup: (() => void) | void = undefined;

  constructor(private root: HTMLElement, private routes: Record<string, View>, private fallback: string) {
    window.addEventListener("hashchange", () => this.render());
  }

  render() {
    const raw = location.hash.replace(/^#\/?/, "");
    const [name, query] = raw.split("?");
    const route = this.routes[name] ? name : this.fallback;
    if (typeof this.cleanup === "function") this.cleanup();
    this.root.replaceChildren();
    window.scrollTo(0, 0);
    this.cleanup = this.routes[route](this.root, new URLSearchParams(query ?? ""));
    document.querySelectorAll<HTMLAnchorElement>("#nav a").forEach((a) => {
      if (a.getAttribute("href") === `#/${route}`) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }

  go(path: string) {
    if (location.hash === `#/${path}`) this.render();
    else location.hash = `#/${path}`;
  }
}
