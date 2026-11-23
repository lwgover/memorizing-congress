"""LCV Action Fund 2025-2026 endorsements -> data/targeting_2026/generated/lcv_action_fund.csv

Fills one of the issue-PAC gaps in data/targeting_2026/README.md. The list is paginated
(?result_page=N); each entry reads party / first name / last name / district ("AZ-06",
"NM-Sen", or just "OH" for some Senate specials) / optional "Incumbent".

Writes the same columns as issue_pac_lists.csv so 12_targeting.py can read it alongside the
team's file (which is left untouched).

Usage: uv run scripts/12a_fetch_lcv.py [--force]
"""

from __future__ import annotations

import html
import re
import sys
import time

import pandas as pd

from common import DATA, RAW, http_get, log, now_iso

URL = "https://www.lcv.org/2025-2026-endorsements/"
OUT = DATA / "targeting_2026" / "generated" / "lcv_action_fund.csv"
CACHE = RAW / "lcv"
CODE = re.compile(r"^([A-Z]{2})(?:-(\d{1,2}|AL|Sen))?$")
PARTY = {"D", "R", "I"}


def page_lines(n: int, force: bool) -> list[str]:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"page{n}.html"
    if not path.exists() or force:
        r = http_get(URL, params={"result_page": n})
        r.raise_for_status()
        path.write_text(r.text, encoding="utf-8")
        time.sleep(1.0)
    t = re.sub(r"<script.*?</script>|<style.*?</style>", "", path.read_text(encoding="utf-8", errors="ignore"), flags=re.S)
    lines = [html.unescape(l).replace("\xa0", " ").strip() for l in re.sub(r"<[^>]+>", "\n", t).split("\n")]
    lines = [l for l in lines if l]
    # the endorsement list sits between the "House"/"Senate" tabs and the "Endorsing Climate Champions" blurb
    start = lines.index("Senate") + 1 if "Senate" in lines else 0
    end = next((i for i, l in enumerate(lines) if l.startswith("Endorsing Climate Champions")), len(lines))
    return lines[start:end]


def parse(lines: list[str]) -> list[dict]:
    """Walk tokens; each district code closes an entry whose name is the 1-2 tokens before it."""
    out, buf = [], []
    for tok in lines:
        m = CODE.match(tok)
        if m and buf:
            names = [b for b in buf if b not in PARTY and b != "Incumbent"]
            party = next((b for b in reversed(buf) if b in PARTY), "")
            if len(names) >= 2:
                st, d = m.group(1), m.group(2)
                district = f"{st}-SEN" if (d is None or d == "Sen") else f"{st}-{'AL' if d == 'AL' else d.zfill(2)}"
                out.append({"first": names[-2], "last": names[-1], "party": party or "D", "state": st, "district": district})
            buf = []
        elif tok == "Incumbent":
            if out:
                out[-1]["incumbent"] = True
        else:
            buf.append(tok)
            buf = buf[-4:]
    return out


def main() -> None:
    force = "--force" in sys.argv
    seen, rows = set(), []
    for n in range(1, 15):
        entries = parse(page_lines(n, force))
        new = [e for e in entries if (e["district"], e["last"]) not in seen]
        if not new:
            break
        for e in new:
            seen.add((e["district"], e["last"]))
            rows.append({"committee": "LCV Action Fund", "program": "Endorsement", "side": "support", "state": e["state"],
                         "district": e["district"], "candidate": f"{e['first']} {e['last']}", "party": e["party"],
                         "date_added": "", "date_precision": "unknown", "status": "active",
                         "note": f"scraped {now_iso()[:10]}, page {n}" + ("; incumbent" if e.get("incumbent") else ""),
                         "source_url": f"{URL}?result_page={n}"})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_csv(OUT, index=False)
    log(f"12a: LCV Action Fund endorsements: {len(rows)} -> {OUT}")


if __name__ == "__main__":
    main()
