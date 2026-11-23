# Memorizing Congress

Learn every member of the 120th Congress: spaced repetition on districts, faces and facts,
plus daily map games. Static site, hosted on GitHub Pages.

- Plan: [`SCAFFOLD.md`](SCAFFOLD.md)
- Data sources and how they're collected: [`DATA_SOURCES.md`](DATA_SOURCES.md)

## Run it

```sh
npm install
npm run dev        # http://localhost:5173/memorizing-congress/
npm run build      # type-check + production build into dist/
npm run preview    # serve dist/
```

## Rebuild the data

```sh
./run_pipeline.sh          # writes public/data/*.json, public/photos/
./run_pipeline.sh --force  # refetch every source
```

The pipeline runs locally (Python via `uv`) and its outputs are committed, so hosting stays static
and API keys (`.env`) never ship.

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`, which builds and publishes to Pages.
One-time setup: GitHub repo → Settings → Pages → Source: **GitHub Actions**.

## Layout

| Path | What |
|---|---|
| `src/data/` | Loading `members.json` and the TopoJSON maps |
| `src/map/` | National map (pan/zoom, click → lon/lat) and distance math |
| `src/srs/` | Card types, FSRS scheduling, closeness scoring, mix-up log |
| `src/games/` | District Tap rules, daily seed, answer matching, share text |
| `src/ui/` | Views: Today, Study, District Tap, Tests, Mastery map, Settings |
| `src/styles/` | `palette.css` (color tokens) and `app.css` |
| `scripts/` | Data pipeline |
| `design/vibe.html` | The look-and-feel mock |

Progress is stored in the browser (`localStorage`); Settings has export/import.
