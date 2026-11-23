/**
 * The national district map: SVG, pan/zoom, click -> lon/lat, fills, highlights, overlays.
 * Uses Albers USA with territory insets so DC, PR, GU, VI, AS and MP are all clickable.
 */
import { geoPath, type GeoPermissibleObjects } from "d3-geo";
import { geoAlbersUsaTerritories } from "d3-composite-projections";
import { select } from "d3-selection";
import "d3-transition";
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import type { AppData, DistrictFeature } from "../data/load";
import { h, s } from "../ui/dom";

const W = 975;
const H = 610;

export interface MapOptions {
  interactive?: boolean;            // pan/zoom + clicks
  showDistricts?: boolean;          // false = states only
  onClick?: (lonlat: [number, number], districtId: string | null) => void;
  label?: string;
}

export class UsMap {
  readonly el: HTMLElement;
  private svg: SVGSVGElement;
  private g: SVGGElement;
  private overlay: SVGGElement;
  private paths = new Map<string, SVGPathElement>();
  private zoomer: ZoomBehavior<SVGSVGElement, unknown> | null = null;
  private k = 1;
  readonly projection = geoAlbersUsaTerritories().fitExtent([[8, 8], [W - 8, H - 8]], { type: "Sphere" } as any);
  readonly path = geoPath(this.projection);

  constructor(private data: AppData, private opts: MapOptions = {}) {
    // Fit to the actual shapes rather than the sphere
    this.projection.fitExtent([[10, 10], [W - 10, H - 10]], { type: "FeatureCollection", features: data.states } as any);
    this.svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.label ?? "Map of U.S. congressional districts" }) as SVGSVGElement;
    this.g = s("g") as SVGGElement;
    this.overlay = s("g") as SVGGElement;
    this.svg.append(this.g);

    if (opts.showDistricts !== false) {
      for (const d of data.districts) {
        const p = s("path", { d: this.path(d as GeoPermissibleObjects) ?? "", class: "district" }) as SVGPathElement;
        p.dataset.id = d.properties.id;
        this.paths.set(d.properties.id, p);
        this.g.append(p);
      }
    }
    for (const st of data.states) {
      const p = s("path", { d: this.path(st as GeoPermissibleObjects) ?? "", class: opts.showDistricts === false ? "district" : "state" }) as SVGPathElement;
      if (opts.showDistricts === false) {
        p.dataset.id = st.properties.id;
        this.paths.set(st.properties.id, p);
      }
      this.g.append(p);
    }
    this.g.append(this.overlay);

    const tools = h("div.map-tools");
    this.el = h("div.map-box", { class: opts.interactive ? "" : "static" }, this.svg, opts.interactive ? tools : null);

    if (opts.interactive) {
      this.zoomer = d3zoom<SVGSVGElement, unknown>()
        .scaleExtent([1, 60])
        .translateExtent([[-W * 0.25, -H * 0.25], [W * 1.25, H * 1.25]])
        .clickDistance(6)
        .on("zoom", (ev: { transform: ZoomTransform }) => this.applyTransform(ev.transform));
      select(this.svg).call(this.zoomer).on("dblclick.zoom", null);
      this.svg.addEventListener("click", (ev) => this.handleClick(ev));
      tools.append(
        h("button", { type: "button", "aria-label": "Zoom in", onclick: () => this.zoomBy(1.8) }, "+"),
        h("button", { type: "button", "aria-label": "Zoom out", onclick: () => this.zoomBy(1 / 1.8) }, "−"),
        h("button", { type: "button", "aria-label": "Reset view", onclick: () => this.reset() }, "⟲"),
      );
    }
  }

  private applyTransform(t: ZoomTransform) {
    this.k = t.k;
    this.g.setAttribute("transform", t.toString());
    this.overlay.querySelectorAll<SVGCircleElement>("circle[data-r]").forEach((c) => {
      c.setAttribute("r", String(Number(c.dataset.r) / this.k));
    });
  }

  private handleClick(ev: MouseEvent) {
    if (!this.opts.onClick) return;
    const pt = this.svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const ctm = this.g.getScreenCTM();
    if (!ctm) return;
    const local = pt.matrixTransform(ctm.inverse());
    const lonlat = this.projection.invert?.([local.x, local.y]);
    const target = ev.target as SVGElement;
    const id = target?.dataset?.id ?? null;
    if (lonlat && Number.isFinite(lonlat[0])) this.opts.onClick(lonlat as [number, number], id);
  }

  zoomBy(f: number) {
    if (this.zoomer) select(this.svg).transition().duration(250).call(this.zoomer.scaleBy as any, f);
  }

  reset(animate = true) {
    if (!this.zoomer) {
      this.applyTransform(zoomIdentity);
      return;
    }
    const sel = select(this.svg);
    (animate ? sel.transition().duration(400) : sel).call(this.zoomer.transform as any, zoomIdentity);
  }

  /** Zoom so the given features fill the view (works with or without interaction). */
  zoomTo(features: GeoPermissibleObjects[], animate = true, maxK = 40) {
    const fc = { type: "FeatureCollection", features } as any;
    const [[x0, y0], [x1, y1]] = this.path.bounds(fc);
    const k = Math.min(maxK, 0.85 / Math.max((x1 - x0) / W, (y1 - y0) / H));
    const t = zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    if (this.zoomer) {
      const sel = select(this.svg);
      (animate ? sel.transition().duration(500) : sel).call(this.zoomer.transform as any, t);
    } else {
      this.applyTransform(t);
    }
  }

  /** Set each district's (or state's) fill; return value is a CSS color or null for default. */
  fill(fn: (id: string) => string | null) {
    for (const [id, p] of this.paths) {
      const c = fn(id);
      if (c) p.style.fill = c;
      else p.style.removeProperty("fill");
    }
  }

  setClass(ids: Iterable<string>, cls: string) {
    for (const p of this.paths.values()) p.classList.remove(cls);
    for (const id of ids) this.paths.get(id)?.classList.add(cls);
  }

  /** Outline + tint one feature, e.g. the District Tap answer. */
  showTarget(f: GeoPermissibleObjects, color: string) {
    this.overlay.append(s("path", {
      d: this.path(f) ?? "", class: "target", fill: `color-mix(in srgb, ${color} 24%, transparent)`, stroke: color,
      "vector-effect": "non-scaling-stroke",
    }));
  }

  marker(lonlat: [number, number], r = 6) {
    const p = this.projection(lonlat);
    if (!p) return;
    const c = s("circle", { cx: p[0], cy: p[1], r: r / this.k, class: "marker" }) as SVGCircleElement;
    c.dataset.r = String(r);
    this.overlay.append(c);
  }

  link(a: [number, number], b: [number, number]) {
    const pa = this.projection(a), pb = this.projection(b);
    if (!pa || !pb) return;
    this.overlay.prepend(s("line", { x1: pa[0], y1: pa[1], x2: pb[0], y2: pb[1], class: "link" }));
  }

  clearOverlay() {
    while (this.overlay.firstChild) this.overlay.firstChild.remove();
  }

  district(id: string): DistrictFeature | undefined {
    return this.data.districtById.get(id);
  }
}
