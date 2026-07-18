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

UK retailers publish their pump prices as open JSON feeds under the
[gov.uk fuel price transparency scheme](https://www.gov.uk/guidance/access-fuel-price-data).
`scripts/fetch-prices.mjs` pulls every feed, drops any feed whose data is more
than 7 days stale, normalises prices (E10 / E5 / B7 / SDV, pence per litre),
de-duplicates sites, and writes `docs/data/stations.json`.

Currently-live feeds include Asda, Esso, Morrisons-branded MFG sites, Moto,
Jet, SGN and the Motor Fuel Group feed (which carries many BP / Shell / Texaco
branded forecourts). Feeds that are stale or blocked are skipped automatically
and logged.

Refresh the data any time:

```
node scripts/fetch-prices.mjs
```

`.github/workflows/update-prices.yml` does this automatically every 30 minutes
— note GitHub only runs scheduled workflows on the **default branch**, so merge
this branch to `main` (or trigger it manually from the Actions tab) for
auto-refresh.

## Files

| Path                        | Purpose                                    |
|-----------------------------|--------------------------------------------|
| `docs/index.html`           | The whole app (self-contained + vendored Leaflet). |
| `docs/vendor/`              | Leaflet 1.9.4 (no CDN dependency).         |
| `docs/data/stations.json`   | Latest aggregated prices.                  |
| `scripts/fetch-prices.mjs`  | Price feed aggregator.                     |
| `.github/workflows/update-prices.yml` | 30-minute auto-refresh.          |

Map data © OpenStreetMap contributors. Price data © the respective retailers,
published under the UK fuel price transparency scheme.
