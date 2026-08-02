# Rail Live — passenger &amp; freight trains moving live on a map

A mobile web app that plots **real trains, from real on-board GPS, moving in real
time** — passenger and freight together on one map. Tap any train for its speed,
punctuality, next stop and full calling pattern.

Live at `https://andyr1995.github.io/Databases/trains/` once the branch is merged
to `main` (see *Deploying* below).

## What it does

- **Every tracked train, live.** Positions refresh every 3 s and each marker is
  interpolated between fixes, so trains glide continuously rather than jumping.
  Markers are chevrons rotated to the train's actual heading; stationary trains
  become dots.
- **Passenger vs freight, at a glance.** Blue = commuter, purple = long-distance,
  **orange = freight**, grey = shunting/engineering. Filter chips toggle each
  class and show a live count; "Moving only" hides anything stationary.
- **Tap a train** for speed, minutes late, next stop and the whole timetable —
  booked times struck through where the train has been retimed.
- **Follow mode** keeps the map locked to a moving train.
- Train-number search, your own location, dark mode, and installable to a phone
  home screen as a PWA.

## Where the data comes from

**Fintraffic's Digitraffic open rail API** (`rata.digitraffic.fi`), licensed
CC BY 4.0. It is used because it is the only national feed that is
simultaneously free, key-less, CORS-enabled **and publishes genuine on-board GPS
for freight as well as passenger trains** — which is exactly what this app needs.
No API key, no backend, no server: the page talks to the API directly, so it runs
as a plain static site.

| Endpoint | Used for |
|---|---|
| `/train-locations/latest/` | GPS position + speed for every tracked train (~1 s cadence) |
| `/trains/{date}` | category (Cargo / Commuter / Long-distance), operator, full timetable |
| `/metadata/stations` | station names and coordinates |

A typical daytime sample: **~100 trains tracked, of which ~26 are freight.**

Map tiles © OpenStreetMap contributors.

## Why this covers Finland and not the UK

This is the honest constraint, and it is worth stating plainly: **there is no
free, key-less API for live UK train positions**, for passenger or freight.

- GB positions come from **Network Rail's open data feeds** — TRUST (movement
  reports), TD (signalling berth steps), SCHEDULE, plus CORPUS/SMART to turn
  berths into coordinates. Freight *is* well covered there, which is the good
  news.
- But those feeds are **push-only STOMP** and need a (free) registered account.
  A browser cannot hold a STOMP subscription, and credentials cannot be shipped
  in a static page.
- GB train positions are also **inferred, not measured** — estimated between
  timing points — whereas the feed used here is real GPS with a reported speed.

So a UK version is a different shape of project: a small always-on relay that
holds the Network Rail subscription, geolocates berth/timing-point reports, and
serves state to this same front end. The map, the animation, the passenger/
freight split and the detail panel would all carry over unchanged — only the
data adapter changes. Ask if you want that built; it needs a free Network Rail
Open Data account and somewhere to run the relay.

## Deploying

`.github/workflows/update-prices.yml` already uploads the whole `docs/` folder to
GitHub Pages, so this app ships with it automatically — **no workflow change is
needed**. That workflow only deploys from the default branch, so the app goes
live once this branch is merged to `main`.

To run it locally, serve the `docs` folder over HTTP (opening the file directly
will not work — the API call needs a real origin):

```
cd docs && python3 -m http.server 8000
# then open http://localhost:8000/trains/
```

## Files

| Path | Purpose |
|---|---|
| `docs/trains/index.html` | The entire app — markup, styles and logic, self-contained. |
| `docs/trains/manifest.webmanifest` | PWA manifest (installable to a home screen). |
| `docs/trains/icon.svg` | App icon. |
| `docs/vendor/leaflet.*` | Leaflet 1.9.4, vendored — shared with Fuel Finder, no CDN. |

Trains are drawn on a single `<canvas>` rather than as Leaflet markers: ~100
moving DOM markers visibly stutter, while one canvas redrawn each animation
frame stays smooth and allows per-train rotation.
