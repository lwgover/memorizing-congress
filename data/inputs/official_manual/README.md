# Hand-entered official House results

For states whose results sites block scripts (e.g. New York's nyenr.elections.ny.gov is behind a
Cloudflare challenge). The numbers below are placeholders. Open the official site in your browser and copy the U.S. House races into
`<STATE>.csv` here, e.g. `NY.csv`:

```csv
district,candidate,party,votes,source_url
1,Candidate A,R,123456,https://nyenr.elections.ny.gov/
1,Candidate B,D,98765,https://nyenr.elections.ny.gov/
```

- `district`: the number (use `AL` for at-large); `party`: D / R / I (or DEM / REP / ...); `votes`: integer.
- One row per candidate. Fusion-ballot states (NY): add up each candidate's party lines into one row.
- Then run `uv run scripts/08b_fetch_official_results.py`, `08_join_results.py`, `99_build_members_json.py`.
  The report `data/reports/official_results.md` flags any winner that doesn't match the roster.
