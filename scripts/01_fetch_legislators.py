"""Fetch unitedstates/congress-legislators YAML files into data/raw/legislators/.

Usage: uv run scripts/01_fetch_legislators.py [--force]
"""

import sys

from common import RAW, download, log, now_iso, write_json

BASE = "https://raw.githubusercontent.com/unitedstates/congress-legislators/main/"
FILES = [
    "legislators-current.yaml",
    "legislators-historical.yaml",
    "committees-current.yaml",
    "committee-membership-current.yaml",
]


def main() -> None:
    force = "--force" in sys.argv
    out = RAW / "legislators"
    for f in FILES:
        download(BASE + f, out / f, force=force)
    write_json(out / "_fetched.json", {"fetched_at": now_iso(), "source": BASE, "files": FILES})
    log(f"01: legislators files in {out}")


if __name__ == "__main__":
    main()
