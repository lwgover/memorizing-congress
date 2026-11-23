#!/usr/bin/env bash
# Rebuild everything in public/data from sources. Downloads are cached in data/raw/.
#   ./run_pipeline.sh            # use caches
#   ./run_pipeline.sh --force    # refetch sources (Wikipedia, Census, legislators)
# FEC (09) is rate-limited without FEC_API_KEY; it saves progress and can be rerun alone.
set -euo pipefail
cd "$(dirname "$0")"
F="${1:-}"
uv run scripts/01_fetch_legislators.py $F
uv run scripts/02_fetch_results_2026.py $F
uv run scripts/03_build_roster.py
uv run scripts/04_fetch_photos.py $F
uv run scripts/05_build_districts.py $F
uv run scripts/06_detect_redrawn.py $F
uv run scripts/07_join_war.py
uv run scripts/08_join_results.py $F
uv run scripts/09_fetch_fec.py || echo "09: FEC step incomplete (see data/reports/fec.md)"
uv run scripts/10_fetch_caucuses.py $F
uv run scripts/12a_fetch_lcv.py $F
uv run scripts/12b_fetch_schedule_e.py || echo "12b: Schedule E incomplete (needs FEC_API_KEY)"
uv run scripts/12_targeting.py
uv run scripts/13_fetch_logos.py $F
uv run scripts/99_build_members_json.py
echo "Done. Reports in data/reports/."
