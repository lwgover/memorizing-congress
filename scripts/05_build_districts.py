"""District shapes (2026 lines) -> TopoJSON, plus cities/counties per district.

Sources (Census Bureau, no key needed):
  - TIGER/Line 2026 congressional districts, 120th Congress: tl_2026_{fips}_cd120.zip
    (all 50 states + DC + AS, GU, MP, PR, VI)
  - Cartographic boundary 2025 states 1:500k (land-clipped)  -> clip districts to land
  - Cartographic boundary 2025 places + counties 1:500k
  - Population Estimates Vintage 2025: sub-est2025.csv (incorporated places),
    co-est2025-alldata.csv (counties)
  - Optional: CENSUS_API_KEY in .env adds 2020 Census CDP populations (unincorporated
    places like Honolulu, Bethesda, Paradise NV).

Steps
  1. Read every cd120 file, drop CD "ZZ" (water / undefined).
  2. Clip each district to its state's land outline.
  3. Topology-preserving simplification with shapely.coverage_simplify (shared edges stay shared).
  4. Write public/data/districts.topo.json + states.topo.json (states = dissolved districts).
  5. Cities: places intersected with full-resolution districts in an equal-area projection.
     A place's population is split by area share; top N by estimated population are kept
     (places with < MIN_PLACE_AREA_SHARE of their area in the district are ignored).
     Counties: same, top N.

Output: public/data/{districts,states}.topo.json, data/interim/district_places.csv,
        data/interim/districts_full.parquet (full-res, used by 06), data/reports/districts.md
Usage:  uv run scripts/05_build_districts.py [--force]
"""

from __future__ import annotations

import json
import os
import sys

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
import topojson as tp
from dotenv import load_dotenv

from common import (ABBR_TO_NAME, FIPS_TO_ABBR, INTERIM, PUBLIC_DATA, RAW, STATES, download, http_get,
                    log, seat_key, write_report)
from config import (MIN_PLACE_AREA_SHARE, SIMPLIFY_TOLERANCE, TOP_CITIES, TOP_COUNTIES,
                    TOPO_QUANTIZATION)

TIGER_CD = "https://www2.census.gov/geo/tiger/TIGER2026/CD/tl_2026_{fips}_cd120.zip"
GENZ = "https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_{layer}_500k.zip"
POPEST_PLACES = "https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/cities/totals/sub-est2025.csv"
POPEST_PR = "https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/puerto-rico/asrh/cc-est2025-agesex-72.csv"
POPEST_COUNTIES = "https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/counties/totals/co-est2025-alldata.csv"
EQUAL_AREA = "EPSG:5070"  # CONUS Albers; equal-area, fine for area *ratios* everywhere


def load_cd120(force: bool) -> gpd.GeoDataFrame:
    frames = []
    for abbr, fips, _, _ in STATES:
        z = download(TIGER_CD.format(fips=fips), RAW / "tiger" / "cd120" / f"tl_2026_{fips}_cd120.zip", force=force)
        frames.append(gpd.read_file(z))
    g = pd.concat(frames, ignore_index=True)
    g = gpd.GeoDataFrame(g, geometry="geometry", crs=frames[0].crs).to_crs("EPSG:4326")
    cdcol = next(c for c in g.columns if c.startswith("CD") and c.endswith("FP"))
    g = g[g[cdcol] != "ZZ"].copy()
    g["state"] = g["STATEFP"].map(FIPS_TO_ABBR)
    g["district"] = g[cdcol].map(lambda v: 0 if v in ("00", "98") else int(v))
    g["id"] = [seat_key("house", s, d) for s, d in zip(g.state, g.district)]
    return g[["id", "state", "district", "geometry"]]


def clip_to_land(d: gpd.GeoDataFrame, force: bool) -> gpd.GeoDataFrame:
    z = download(GENZ.format(layer="state"), RAW / "genz" / "cb_2025_us_state_500k.zip", force=force)
    land = gpd.read_file(z).to_crs("EPSG:4326")
    land["state"] = land["STATEFP"].map(FIPS_TO_ABBR)
    land = land.dropna(subset=["state"]).set_index("state").geometry
    out = []
    for st, grp in d.groupby("state"):
        if st not in land.index:
            out.append(grp)
            continue
        g = grp.copy()
        g["geometry"] = shapely.intersection(shapely.make_valid(g.geometry.values), land[st])
        out.append(g)
    res = gpd.GeoDataFrame(pd.concat(out), crs=d.crs)
    res["geometry"] = res.geometry.map(lambda geom: shapely.make_valid(geom))
    # keep polygonal parts only
    res["geometry"] = res.geometry.map(
        lambda geom: shapely.MultiPolygon([p for p in getattr(geom, "geoms", [geom])
                                           if p.geom_type in ("Polygon", "MultiPolygon")
                                           for p in getattr(p, "geoms", [p])]) if geom.geom_type == "GeometryCollection" else geom)
    return res


def simplify(d: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    s = d.copy()
    s["geometry"] = shapely.coverage_simplify(d.geometry.values, SIMPLIFY_TOLERANCE)
    s["geometry"] = s.geometry.map(shapely.make_valid)
    return s


def to_topojson(g: gpd.GeoDataFrame, name: str, path) -> None:
    topo = tp.Topology(g, object_name=name, prequantize=TOPO_QUANTIZATION, topology=True)
    path.write_text(topo.to_json())


# ------------------------------------------------------------------ populations

def place_population(force: bool) -> pd.DataFrame:
    p = download(POPEST_PLACES, RAW / "popest" / "sub-est2025.csv", force=force)
    df = pd.read_csv(p, dtype=str, encoding="latin-1")
    df = df[df.SUMLEV.isin(["162", "170"])]  # incorporated places, consolidated cities
    df = df.assign(GEOID=df.STATE + df.PLACE, pop=df.POPESTIMATE2025.astype(int))
    df = df.sort_values("SUMLEV").drop_duplicates("GEOID")
    out = df[["GEOID", "pop"]].assign(pop_source="popest2025")
    load_dotenv()
    key = os.getenv("CENSUS_API_KEY")
    if key:
        cache = RAW / "popest" / "cdp_pl2020.csv"
        if not cache.exists() or force:
            rows = []
            for abbr, fips, _, _ in STATES:
                if fips in {"60", "66", "69", "78"}:
                    continue
                r = http_get("https://api.census.gov/data/2020/dec/pl",
                             params={"get": "NAME,P1_001N", "for": "place:*", "in": f"state:{fips}", "key": key})
                if r.ok:
                    j = r.json()
                    rows += [{"GEOID": x[2] + x[3], "pop": int(x[1])} for x in j[1:]]
            pd.DataFrame(rows).to_csv(cache, index=False)
        cdp = pd.read_csv(cache, dtype={"GEOID": str}).assign(pop_source="pl2020")
        out = pd.concat([out, cdp[~cdp.GEOID.isin(out.GEOID)]])
    return out


def county_population(force: bool) -> pd.DataFrame:
    p = download(POPEST_COUNTIES, RAW / "popest" / "co-est2025-alldata.csv", force=force)
    df = pd.read_csv(p, dtype=str, encoding="latin-1")
    df = df[df.SUMLEV == "050"]
    us = pd.DataFrame({"GEOID": df.STATE + df.COUNTY, "pop": df.POPESTIMATE2025.astype(int)})
    # Puerto Rico municipios live in a separate file; keep the latest YEAR row
    pr = pd.read_csv(download(POPEST_PR, RAW / "popest" / "cc-est2025-agesex-72.csv", force=force),
                     dtype={"MUNICIPIO": str}, encoding="latin-1")
    pr = pr.sort_values("YEAR").groupby("MUNICIPIO").tail(1)
    pr = pd.DataFrame({"GEOID": "72" + pr.MUNICIPIO, "pop": pr.POPESTIMATE.astype(int)})
    return pd.concat([us, pr], ignore_index=True)


NYC_BOROUGHS = {"New York County": "Manhattan", "Kings County": "Brooklyn", "Queens County": "Queens",
                "Bronx County": "The Bronx", "Richmond County": "Staten Island"}
TERRITORY_SUFFIXES = (" Municipio", " Municipality", " Island", " District", " County")


def overlay_est(districts: gpd.GeoDataFrame, units: gpd.GeoDataFrame, name_col: str) -> pd.DataFrame:
    """Intersect units with districts; split each unit's population by area share."""
    u = units.to_crs(EQUAL_AREA)
    u["unit_area"] = u.geometry.area
    d = districts.to_crs(EQUAL_AREA)
    inter = gpd.overlay(u[[name_col, "GEOID", "pop", "unit_area", "geometry"]], d[["id", "geometry"]],
                        how="intersection", keep_geom_type=True)
    inter["share"] = inter.geometry.area / inter["unit_area"]
    inter["est_pop"] = inter["pop"] * inter["share"]
    return pd.DataFrame(inter.drop(columns="geometry")).rename(columns={name_col: "name"})


def top_names(inter: pd.DataFrame, keep: pd.Series, top: int) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for did, grp in inter[keep].sort_values("est_pop", ascending=False).groupby("id", sort=False):
        out[did] = list(dict.fromkeys(grp["name"].tolist()))[:top]
    return out


def main() -> None:
    force = "--force" in sys.argv
    log("05: loading cd120 districts")
    raw = load_cd120(force)
    log(f"05: {len(raw)} districts; clipping to land")
    full = clip_to_land(raw, force)
    full.to_parquet(INTERIM / "districts_full.parquet")

    log("05: simplifying (coverage-preserving)")
    simp = simplify(full)
    simp["name"] = [f"{ABBR_TO_NAME[s]} {'at-large' if d == 0 else d}" for s, d in zip(simp.state, simp.district)]
    simp = simp.sort_values("id").reset_index(drop=True)
    to_topojson(simp[["id", "state", "district", "name", "geometry"]], "districts", PUBLIC_DATA / "districts.topo.json")

    states = simp.dissolve(by="state", as_index=False)[["state", "geometry"]]
    # states are drawn at national scale: simplify harder (still coverage-preserving)
    states["geometry"] = shapely.coverage_simplify(states.geometry.values, SIMPLIFY_TOLERANCE * 4)
    states["name"] = states.state.map(ABBR_TO_NAME)
    states["id"] = states.state
    to_topojson(states[["id", "name", "geometry"]], "states", PUBLIC_DATA / "states.topo.json")

    log("05: cities and counties")
    pz = download(GENZ.format(layer="place"), RAW / "genz" / "cb_2025_us_place_500k.zip", force=force)
    places = gpd.read_file(pz).merge(place_population(force), on="GEOID", how="inner")
    cz = download(GENZ.format(layer="county"), RAW / "genz" / "cb_2025_us_county_500k.zip", force=force)
    counties = gpd.read_file(cz).merge(county_population(force), on="GEOID", how="left").fillna({"pop": 0})
    ci = overlay_est(full, places, "NAME")
    co = overlay_est(full, counties, "NAMELSAD")
    dist_pop = co.groupby("id").est_pop.sum()
    co["dist_share"] = co.est_pop / co.id.map(dist_pop).clip(lower=1)
    # counties: drop boundary slivers (< 1% of the district's people); territories have pop 0 -> keep by area
    ctys = top_names(co, (co.dist_share >= 0.01) | ((co["pop"] == 0) & (co.share >= 0.05)), TOP_COUNTIES)
    # places: meaningful area share, or a big chunk of a big city (Manhattan is < 5% of NYC's area)
    cities = top_names(ci, (ci.share >= MIN_PLACE_AREA_SHARE) | (ci.est_pop >= 50_000), TOP_CITIES)
    for did, names in cities.items():
        if "New York" in names and did.startswith("NY-"):
            boroughs = [NYC_BOROUGHS[c] for c in ctys.get(did, []) if c in NYC_BOROUGHS]
            i = names.index("New York")
            cities[did] = list(dict.fromkeys(names[:i] + boroughs + names[i + 1:]))[:TOP_CITIES]
    for did in simp.id:  # territories / PR: no incorporated places in popest -> use municipios etc.
        st = did.split("-")[0]
        if did not in cities and st in {"PR", "AS", "GU", "MP", "VI"}:
            names = ctys.get(did, [])
            for suf in TERRITORY_SUFFIXES:
                names = [n.removesuffix(suf) for n in names]
            cities[did] = names[:TOP_CITIES]
    dp = pd.DataFrame({"id": simp.id})
    dp["cities"] = dp.id.map(lambda i: json.dumps(cities.get(i, []), ensure_ascii=False))
    dp["counties"] = dp.id.map(lambda i: json.dumps(ctys.get(i, []), ensure_ascii=False))
    dp.to_csv(INTERIM / "district_places.csv", index=False)

    sizes = {f: f"{(PUBLIC_DATA / f).stat().st_size / 1e6:.2f} MB" for f in ("districts.topo.json", "states.topo.json")}
    no_city = [f"- {i}" for i in dp.id if i not in cities]
    write_report("districts", "District geometry build", {
        "Files": [f"- {k}: {v}" for k, v in sizes.items()],
        "Districts with no cities found": no_city,
    })
    log(f"05: {len(simp)} districts, {len(states)} states, sizes {sizes}, no-city districts {len(no_city)}")


if __name__ == "__main__":
    main()
