"""Download official member photos from unitedstates/images into public/photos/.

Source: https://unitedstates.github.io/images/congress/225x275/{bioguide}.jpg
(public domain, keyed by bioguide ID). 225x275 keeps the site light.

New members (provisional "NEW-" IDs) have no photo yet. To add one manually,
drop a public-domain/official JPEG at data/overrides/photos/{id}.jpg where {id}
is the provisional or real bioguide ID; it is copied over and wins.

Output: public/photos/*.jpg, data/interim/photos.csv, data/reports/photos.md
Usage:  uv run scripts/04_fetch_photos.py [--force]
"""

import shutil
import sys
from concurrent.futures import ThreadPoolExecutor

import pandas as pd

from common import INTERIM, OVERRIDES, PHOTOS, http_get, log, write_report

URL = "https://unitedstates.github.io/images/congress/225x275/{}.jpg"


def fetch(bid: str, force: bool) -> tuple[str, str]:
    dest = PHOTOS / f"{bid}.jpg"
    manual = OVERRIDES / "photos" / f"{bid}.jpg"
    if manual.exists():
        shutil.copyfile(manual, dest)
        return bid, "manual"
    if bid.startswith("NEW-"):
        return bid, "missing"
    if dest.exists() and not force:
        return bid, "cached"
    r = http_get(URL.format(bid))
    if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
        dest.write_bytes(r.content)
        return bid, "downloaded"
    return bid, "missing"


def main() -> None:
    force = "--force" in sys.argv
    (OVERRIDES / "photos").mkdir(exist_ok=True)
    roster = pd.read_csv(INTERIM / "roster_120.csv")
    ids = roster.bioguide_id.dropna().tolist()
    with ThreadPoolExecutor(8) as ex:
        results = dict(ex.map(lambda b: fetch(b, force), ids))
    stale = [f for f in PHOTOS.glob("*.jpg") if f.stem not in set(ids)]
    for f in stale:  # members who left (e.g. lost a 2026 primary)
        f.unlink()
    if stale:
        log(f"04: removed {len(stale)} stale photos")
    df = pd.DataFrame({"bioguide_id": list(results), "photo_status": list(results.values())})
    df["photo"] = df.apply(lambda r: f"photos/{r.bioguide_id}.jpg" if r.photo_status != "missing" else "", axis=1)
    df.to_csv(INTERIM / "photos.csv", index=False)
    names = roster.set_index("bioguide_id").name.to_dict()
    missing = [f"- {b}: {names.get(b)}" for b, s in results.items() if s == "missing"]
    write_report("photos", "Member photos", {"Missing photos": missing})
    log(f"04: photos {df.photo_status.value_counts().to_dict()}")


if __name__ == "__main__":
    main()
