# Fuel Finder — live UK fuel prices on a real map

A mobile web app: real OpenStreetMap map with a price pill on every station
(brand + today's price, coloured cheap→dear), a draggable bottom sheet listing
nearby stations, live location tracking, postcode search, four fuel types, and
one-tap **Navigate** hand-off to Google Maps.

## Host it (recommended — GitHub Pages, free)

1. On GitHub: **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: `claude/phone-app-1ixo2c` (or `main` once merged), folder: **`/docs`**
4. Save. After a minute the app is live at
   `https://andyr1995.github.io/Databases/`
5. Open that on your phone → share menu → **Add to Home Screen**.

HTTPS hosting also unlocks browser geolocation, so the app can follow you live.

## Where the prices come from

Since February 2026, every UK fuel retailer is legally required to report price
changes within 30 minutes to the statutory **Fuel Finder** open data scheme
(Motor Fuel Price (Open Data) Regulations 2025). `scripts/fetch-prices.mjs`
builds the dataset in two layers:

1. **Base — the full country.** The complete Fuel Finder dataset (~8,000+
   stations) via FuelCosts.co.uk's free mirror of the official data (the
   gov.uk portal blocks requests from servers). The two CSVs are ~110 MB, so
   the parsed result is cached (`docs/data/ff-base.json`, gitignored; cached
   between CI runs) and refreshed every 6 hours.
2. **Overlay — extra freshness.** The retailers' own direct feeds (Asda, Esso,
   MFG, Moto, Jet, SGN, …) still update continuously; their prices are merged
   on top by location (within 150 m = same forecourt).

Prices older than 30 days and closed stations are dropped. Refresh manually:

```
node scripts/fetch-prices.mjs
```

`.github/workflows/update-prices.yml` runs this every 30 minutes and deploys
`docs/` straight to GitHub Pages — the data is never committed to git, so the
repo stays small while the live site stays fresh.

## Files

| Path                        | Purpose                                    |
|-----------------------------|--------------------------------------------|
| `docs/index.html`           | The whole app (self-contained + vendored Leaflet). |
| `docs/vendor/`              | Leaflet 1.9.4 (no CDN dependency).         |
| `docs/data/stations.json`   | Latest aggregated prices.                  |
| `scripts/fetch-prices.mjs`  | Price feed aggregator.                     |
| `.github/workflows/update-prices.yml` | 30-minute refresh + Pages deploy.   |

Map data © OpenStreetMap contributors. Price data © the respective retailers,
published under the UK fuel price transparency scheme.
