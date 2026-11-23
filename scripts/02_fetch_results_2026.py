"""Fetch 2026 House + Senate results from Wikipedia's results tables.

This is a *provisional* source for who won each 2026 race. Anything in
data/overrides/results_2026.csv takes precedence in 03_build_roster.py.

Parses the raw wikitext of:
  - 2026 United States House of Representatives elections  (rows: !{{ushr|ST|N|X}})
  - 2026 United States Senate elections                    (rows: ! [[... election in State|State]])
A winner is the candidate marked {{aye}}. Seats with no {{aye}} are "uncalled".

Pins the exact page revision (oldid) so every value is traceable.

Output: data/interim/results_2026_wiki.csv
Usage:  uv run scripts/02_fetch_results_2026.py [--force]
"""

import json
import re
import sys

import pandas as pd

from common import INTERIM, log, party_code, seat_key
from wiki import drop_special_sections, fetch_page, parse_house, parse_senate

PAGES = {
    "house": "2026 United States House of Representatives elections",
    "senate": "2026 United States Senate elections",
}


def main() -> None:
    force = "--force" in sys.argv
    records = []
    for chamber, title in PAGES.items():
        text, revid, ts = fetch_page(title, force)
        if chamber == "house":  # House specials end Jan 3; Senate specials carry into the next Congress
            text = drop_special_sections(text)
        parsed = parse_house(text) if chamber == "house" else parse_senate(text)
        best: dict[str, dict] = {}
        def rank(r):
            n_win = sum(c["winner"] for c in r["candidates"])
            return (n_win == 1, len(r["candidates"]))
        for r in parsed:
            key = seat_key(r["chamber"], r["state"], r["district"], r["senate_class"])
            if key not in best or rank(r) > rank(best[key]):
                best[key] = r
        for key, r in best.items():
            winners = [c for c in r["candidates"] if c["winner"]]
            w = winners[0] if len(winners) == 1 else None
            records.append({
                "seat": key, "chamber": r["chamber"], "state": r["state"],
                "district": r["district"], "senate_class": r["senate_class"],
                "incumbent_name": r["incumbent_name"],
                "called": w is not None,
                "winner_name": w["name"] if w else None,
                "winner_wiki_title": w["wiki_title"] if w else None,
                "winner_party": party_code(w["party"]) if w else None,
                "winner_party_label": w["party"] if w else None,
                "candidates": json.dumps(r["candidates"], ensure_ascii=False),
                "source": "wikipedia",
                "source_url": f"https://en.wikipedia.org/w/index.php?oldid={revid}",
                "source_revision_ts": ts,
            })
    df = pd.DataFrame.from_records(records)
    df["district"] = df["district"].astype("Int64")
    df["senate_class"] = df["senate_class"].astype("Int64")
    out = INTERIM / "results_2026_wiki.csv"
    df.to_csv(out, index=False)
    h, s = df[df.chamber == "house"], df[df.chamber == "senate"]
    log(f"02: house seats parsed={len(h)} called={h.called.sum()} | "
        f"senate races parsed={len(s)} called={s.called.sum()} -> {out}")


if __name__ == "__main__":
    main()
