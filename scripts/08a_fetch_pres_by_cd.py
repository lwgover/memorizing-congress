"""2024 presidential results by congressional district, on the lines used in 2026.

Source: The Downballot's "2020 & 2024 presidential election results for congressional districts
used in the 2026 elections" (Jeff Singer, Daniel Donner, David Nir; sponsored by Grassroots
Analytics), published as a public Google Sheet (via Vote Hub). Cite as The Downballot,
https://the-db.co/presbycd.

We use the "Vote totals" tab (exact Harris / Trump votes), so the two-way share is computed from
votes, not from rounded percentages. District numbers are 2026 lines, matching our seats.

Output: data/inputs/downballot_pres_2024_cd2026.csv (state, district, harris, trump, total,
        source, source_url). 08_join_results.py uses it for every district: unchanged districts
        (2026 lines = 2024 lines) and redrawn ones. Hand entries in
        data/overrides/kamala_new_districts.csv still win.
Usage:  uv run scripts/08a_fetch_pres_by_cd.py [--force]
"""

from __future__ import annotations

import csv
import io
import re
import sys

import pandas as pd

from common import DATA, RAW, http_get, log

SHEET = "1eZfaFI-c-PFOoKx1-zZA2MP0_dxRq_LVK0re3BOQqy0"
VOTES_GID = "1491069057"
URL = f"https://docs.google.com/spreadsheets/d/{SHEET}/export?format=csv&gid={VOTES_GID}"
CITE = "https://the-db.co/presbycd"
OUT = DATA / "inputs" / "downballot_pres_2024_cd2026.csv"


def num(s: str) -> int | None:
    s = re.sub(r"[^\d]", "", s or "")
    return int(s) if s else None


def main() -> None:
    force = "--force" in sys.argv
    cache = RAW / "downballot" / "pres_by_cd_votes.csv"
    if force or not cache.exists():
        r = http_get(URL)
        r.raise_for_status()
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(r.text, encoding="utf-8")
    rows = list(csv.reader(io.StringIO(cache.read_text(encoding="utf-8"))))
    # header row with "Harris","Trump","Total" tells us the 2024 columns
    hdr = next(i for i, r in enumerate(rows) if "Harris" in r and "Total" in r)
    cols = rows[hdr]
    ih, it, itot = cols.index("Harris"), cols.index("Trump"), cols.index("Total")
    out = []
    for r in rows[hdr + 1:]:
        if not r or not re.fullmatch(r"[A-Z]{2}-(\d{2}|AL)", r[0].strip()):
            continue
        st, d = r[0].strip().split("-")
        harris, trump, total = num(r[ih]), num(r[it]), num(r[itot])
        if harris is None or trump is None:
            continue
        out.append({"state": st, "district": 0 if d == "AL" else int(d), "harris": harris, "trump": trump, "total": total,
                    "source": "The Downballot (2026 lines)", "source_url": CITE})
    df = pd.DataFrame(out)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT, index=False)
    log(f"08a: {len(df)} districts with 2024 Harris/Trump votes on 2026 lines -> {OUT}")


if __name__ == "__main__":
    main()
