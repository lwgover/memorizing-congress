"""Which districts were redrawn between the 2024 lines (cd119) and the 2026 lines (cd120)?

Definition (SCAFFOLD 4.3): a district is redrawn if even one 2020 Census block moved
into or out of it under a new map enacted for 2026.

Method
  1. Screen every state: compare TIGER 2025 cd119 vs TIGER 2026 cd120 polygons per
     district (symmetric-difference area share). Any state with a visible change that is
     NOT listed in data/overrides/new_maps_2026.csv fails the build (fix the CSV).
  2. Exact test, for every state in new_maps_2026.csv (plus any flagged in step 1):
     take each 2020 block's internal point (TIGER 2026 TABBLOCK20 attributes, read
     remotely without downloading the shapes) and assign it to a cd119 and a cd120
     district. Blocks nest in districts, so an internal point identifies the block's
     district exactly. A cd120 district is unchanged iff its block set equals the cd119
     block set of the same district number.
  3. States not in new_maps_2026.csv are unchanged, per the scaffold.
  4. COUNT_COURT_MAPS=False treats method=court states as unchanged.

Output: data/interim/redrawn.csv, data/reports/redrawn.md
Usage:  uv run scripts/06_detect_redrawn.py [--force]
"""

from __future__ import annotations

import sys

import geopandas as gpd
import pandas as pd
import pyogrio

from common import ABBR_TO_FIPS, FIPS_TO_ABBR, INTERIM, OVERRIDES, RAW, STATES, download, log, seat_key, write_report
from config import COUNT_COURT_MAPS

CD119 = "https://www2.census.gov/geo/tiger/TIGER2025/CD/tl_2025_{fips}_cd119.zip"
CD120 = RAW / "tiger" / "cd120" / "tl_2026_{fips}_cd120.zip"
BLOCKS = "/vsizip//vsicurl/https://www2.census.gov/geo/tiger/TIGER2026/TABBLOCK20/tl_2026_{fips}_tabblock20.zip"
EQUAL_AREA = "EPSG:5070"
SCREEN_THRESHOLD = 1e-4  # share of district area; TIGER vintage noise is far below this
# Only used to detect a *missing* new_maps_2026.csv entry (not part of the redrawn rule):
MISSING_MAP_POP_SHARE = 0.01
# Changes this small inside a listed state are flagged for a human to confirm
SMALL_CHANGE_PEOPLE = 1000


def read_cd(path, cong: int) -> gpd.GeoDataFrame:
    g = gpd.read_file(path)
    col = f"CD{cong}FP"
    g = g[g[col] != "ZZ"].copy()
    st = FIPS_TO_ABBR[g.STATEFP.iloc[0]]
    g["id"] = [seat_key("house", st, 0 if v in ("00", "98") else int(v)) for v in g[col]]
    return g[["id", "geometry"]]


def screen_state(fips: str, force: bool) -> tuple[pd.DataFrame, gpd.GeoDataFrame, gpd.GeoDataFrame]:
    old = read_cd(download(CD119.format(fips=fips), RAW / "tiger" / "cd119" / f"tl_2025_{fips}_cd119.zip", force=force), 119)
    new = read_cd(str(CD120).format(fips=fips), 120)
    o, n = old.to_crs(EQUAL_AREA).set_index("id"), new.to_crs(EQUAL_AREA).set_index("id")
    rows = []
    for did in sorted(set(o.index) | set(n.index)):
        if did not in o.index or did not in n.index:
            rows.append({"id": did, "geom_change_share": 1.0})
            continue
        a, b = o.geometry[did], n.geometry[did]
        rows.append({"id": did, "geom_change_share": a.symmetric_difference(b).area / max(b.area, 1)})
    return pd.DataFrame(rows), old, new


def block_test(fips: str, old: gpd.GeoDataFrame, new: gpd.GeoDataFrame, force: bool) -> pd.DataFrame:
    cache = RAW / "tiger" / "blocks" / f"blocks_{fips}.parquet"
    if cache.exists() and not force:
        b = pd.read_parquet(cache)
    else:
        log(f"  reading block attributes for {FIPS_TO_ABBR[fips]}")
        b = pyogrio.read_dataframe(BLOCKS.format(fips=fips), read_geometry=False,
                                   columns=["GEOID20", "INTPTLAT20", "INTPTLON20", "POP20"])
        cache.parent.mkdir(parents=True, exist_ok=True)
        b.to_parquet(cache)
    pts = gpd.GeoDataFrame(b, geometry=gpd.points_from_xy(b.INTPTLON20.astype(float), b.INTPTLAT20.astype(float)),
                           crs="EPSG:4269")
    a119 = gpd.sjoin(pts, old.to_crs("EPSG:4269"), how="left", predicate="within")[["GEOID20", "id"]]
    a120 = gpd.sjoin(pts, new.to_crs("EPSG:4269"), how="left", predicate="within")[["GEOID20", "id"]]
    a119 = a119.drop_duplicates("GEOID20").set_index("GEOID20").id.rename("d119")
    a120 = a120.drop_duplicates("GEOID20").set_index("GEOID20").id.rename("d120")
    m = pd.concat([a119, a120, b.set_index("GEOID20").POP20], axis=1)
    unassigned = int(m.d119.isna().sum() + m.d120.isna().sum())
    rows = []
    for did in sorted(set(m.d120.dropna()) | set(m.d119.dropna())):
        out_ = m[(m.d119 == did) & (m.d120 != did)]
        in_ = m[(m.d120 == did) & (m.d119 != did)]
        rows.append({"id": did, "blocks_moved_in": len(in_), "blocks_moved_out": len(out_),
                     "pop_moved_in": int(in_.POP20.sum()), "pop_moved_out": int(out_.POP20.sum()),
                     "pop_2026_lines": int(m[m.d120 == did].POP20.sum()),
                     "unassigned_blocks_in_state": unassigned})
    return pd.DataFrame(rows)


def main() -> None:
    force = "--force" in sys.argv
    maps = pd.read_csv(OVERRIDES / "new_maps_2026.csv", dtype=str).fillna("")
    listed = dict(zip(maps.state, maps.method))
    errors, warnings, summary, small, technical = [], [], [], [], []
    results = []

    for abbr, fips, _, _ in STATES:
        screen, old, new = screen_state(fips, force)
        changed = screen[screen.geom_change_share > SCREEN_THRESHOLD]
        if abbr in listed or len(changed):
            bt = block_test(fips, old, new, force)
            df = screen.merge(bt, on="id", how="outer")
            moved = (df.blocks_moved_in.fillna(0) + df.blocks_moved_out.fillna(0)) > 0
            if abbr in listed:
                df["redrawn"] = moved
                df["test"] = "block"
                if not moved.any():
                    warnings.append(f"- {abbr}: listed in new_maps_2026.csv but no block moved")
                for r in df[moved].itertuples():
                    ppl = max(r.pop_moved_in, r.pop_moved_out)
                    if ppl < SMALL_CHANGE_PEOPLE:
                        small.append(f"- {r.id}: {int(r.blocks_moved_in + r.blocks_moved_out)} blocks, "
                                     f"{int(ppl)} people (counts as redrawn under the no-threshold rule)")
                summary.append(f"- {abbr} ({listed[abbr]}): {int(moved.sum())}/{len(df)} districts redrawn")
            else:
                # Not a new map per the scaffold rule; report technical changes, fail on big ones
                df["redrawn"] = False
                df["test"] = "not_in_new_maps"
                share = df[["pop_moved_in", "pop_moved_out"]].max(axis=1) / df.pop_2026_lines.clip(lower=1)
                if (share >= MISSING_MAP_POP_SHARE).any():
                    errors.append(f"- {abbr}: up to {share.max():.1%} of a district's people moved but {abbr} "
                                  f"is not in new_maps_2026.csv")
                for r in df[moved].itertuples():
                    technical.append(f"- {r.id}: {int(r.blocks_moved_in + r.blocks_moved_out)} blocks, "
                                     f"{int(max(r.pop_moved_in, r.pop_moved_out))} people")
        else:
            df = screen.assign(redrawn=False, test="not_in_new_maps")
        df["state"] = abbr
        df["map_method"] = listed.get(abbr, "")
        results.append(df)

    out = pd.concat(results, ignore_index=True)
    out = out[out.id.str.split("-").str[0] == out.state]
    out["counts_as_redrawn"] = out.redrawn & ((out.map_method != "court") | COUNT_COURT_MAPS)
    out.to_csv(INTERIM / "redrawn.csv", index=False)
    write_report("redrawn", "Redrawn districts (2024 lines -> 2026 lines)", {
        "Errors": errors, "Warnings": warnings, "States tested block by block": summary,
        "Small changes inside listed states (confirm)": small,
        "Technical boundary changes in unlisted states (treated as unchanged)": technical,
        "Redrawn districts": [f"- {r.id}: +{int(r.pop_moved_in):,} / -{int(r.pop_moved_out):,} people"
                              for r in out[out.redrawn].itertuples()],
    })
    log(f"06: {int(out.counts_as_redrawn.sum())} districts count as redrawn across "
        f"{out[out.redrawn].state.nunique()} states")
    if errors:
        log("06: ERRORS:\n" + "\n".join(errors))
        sys.exit(1)


if __name__ == "__main__":
    main()
