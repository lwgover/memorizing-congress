"""Small logos for endorsing groups -> public/logos/, public/data/logos.json

Each group's own site icon (apple-touch-icon / icon links, largest first, else /favicon.ico),
fetched from the group's official domain and saved locally so the site never hotlinks.
Used only to identify who endorsed or targeted a member, next to the group's name.

Manual logos win: drop data/overrides/logos/<slug>.(png|svg|jpg|ico) to set or replace one
(e.g. United Democracy Project, whose site blocks automated requests).

Output: public/logos/<slug>.<ext>, public/data/logos.json ({group name: "logos/<slug>.<ext>"}),
        data/reports/logos.md
Usage:  uv run scripts/13_fetch_logos.py [--force]
"""

from __future__ import annotations

import html
import re
import shutil
import sys
from urllib.parse import urljoin

from common import OVERRIDES, PUBLIC, PUBLIC_DATA, http_get, log, write_json, write_report

# group names exactly as they appear in targeting / issuePacSupport -> (slug, official domain)
GROUPS = {
    "DCCC": ("dccc", "dccc.org"),
    "NRCC": ("nrcc", "nrcc.org"),
    "Club for Growth PAC": ("club-for-growth", "clubforgrowth.org"),
    "Club for Growth Action": ("club-for-growth", "clubforgrowth.org"),
    "EMILYs List": ("emilys-list", "emilyslist.org"),
    "Women Vote! (EMILYs List)": ("emilys-list", "emilyslist.org"),
    "New Democrat Coalition Action Fund": ("new-dem-action-fund", "newdemactionfund.com"),
    "Blue Dog PAC": ("blue-dog-pac", "bluedogdems.com"),
    "Fairshake": ("fairshake", "fairshakepac.com"),
    "LCV Action Fund": ("lcv", "lcv.org"),
    "LCV Victory Fund": ("lcv", "lcv.org"),
    "United Democracy Project (AIPAC)": ("udp", "uniteddemocracyproject.org"),
    "Leading the Future": ("leading-the-future", "leadingthefuture.ai"),
}
LOGOS = PUBLIC / "logos"
EXT = {"image/png": "png", "image/svg+xml": "svg", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico",
       "image/jpeg": "jpg", "image/webp": "webp"}


def icon_candidates(domain: str) -> list[str]:
    r = http_get(f"https://{domain}/", retries=2)
    if r.status_code != 200:
        return [f"https://{domain}/favicon.ico"]
    links = re.findall(r"<link[^>]+>", r.text, re.I)
    found = []
    for l in links:
        rel = re.search(r'rel="([^"]*)"', l, re.I)
        href = re.search(r'href="([^"]+)"', l, re.I)
        if not rel or not href or "icon" not in rel.group(1).lower():
            continue
        url = urljoin(r.url, html.unescape(href.group(1)))
        size = re.search(r'sizes="(\d+)x\d+"', l, re.I)
        n = int(size.group(1)) if size else max([int(x) for x in re.findall(r"(\d{2,3})x\d{2,3}", url)] + [0])
        apple = "apple" in rel.group(1).lower()
        found.append((apple, n, url))
    # prefer large icons (apple-touch / 150+px) but not huge originals; svg is always crisp
    found.sort(key=lambda t: (t[2].endswith(".svg"), t[0], min(t[1], 400)), reverse=True)
    return [u for _, _, u in found] + [f"https://{domain}/favicon.ico"]


def main() -> None:
    force = "--force" in sys.argv
    LOGOS.mkdir(parents=True, exist_ok=True)
    manual_dir = OVERRIDES / "logos"
    manual_dir.mkdir(parents=True, exist_ok=True)
    paths: dict[str, str] = {}
    done: dict[str, str] = {}
    report = []
    for group, (slug, domain) in GROUPS.items():
        if slug in done:
            if done[slug]:
                paths[group] = done[slug]
            continue
        manual = next(iter(sorted(manual_dir.glob(f"{slug}.*"))), None)
        existing = next(iter(sorted(LOGOS.glob(f"{slug}.*"))), None)
        if manual:
            dest = LOGOS / manual.name
            shutil.copyfile(manual, dest)
            done[slug] = f"logos/{dest.name}"
            report.append(f"- {slug}: manual ({manual.name})")
        elif existing and not force:
            done[slug] = f"logos/{existing.name}"
            report.append(f"- {slug}: cached")
        else:
            done[slug] = ""
            try:
                for url in icon_candidates(domain):
                    r = http_get(url, retries=2)
                    ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
                    if r.status_code == 200 and ctype in EXT and len(r.content) > 100:
                        dest = LOGOS / f"{slug}.{EXT[ctype]}"
                        dest.write_bytes(r.content)
                        done[slug] = f"logos/{dest.name}"
                        report.append(f"- {slug}: {url}")
                        break
            except Exception as e:  # noqa: BLE001
                report.append(f"- {slug}: failed ({e})")
            if not done[slug]:
                report.append(f"- {slug}: no logo from {domain}; add data/overrides/logos/{slug}.png to set one")
        if done[slug]:
            paths[group] = done[slug]
    write_json(PUBLIC_DATA / "logos.json", paths)
    write_report("logos", "Endorser logos", {"Logos": report})
    log(f"13: logos for {len(set(paths.values()))} groups ({len(paths)} names) -> {LOGOS}")


if __name__ == "__main__":
    main()
