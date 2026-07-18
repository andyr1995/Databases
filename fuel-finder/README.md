# Fuel Finder

A mobile-first web app that shows fuel prices on a live map with a nearby-station
list and one-tap **Navigate** hand-off to Google Maps. Built to run on your phone
today with self-contained demo data, and designed to swap in real live prices later
without touching the UI.

## Run it

It's a single self-contained file — no build step, no dependencies.

- **On your phone:** open `index.html` in a browser. Tap the browser's share menu →
  *Add to Home Screen* to launch it full-screen like a native app.
- **Locally:** open `index.html` directly, or serve the folder
  (`python3 -m http.server` then visit `/fuel-finder/`).

> **Live location note:** the app requests your location on open and anchors the
> stations around you. Browsers only allow geolocation over `https://` (or
> `localhost`) — over plain `file://` or an insecure host it falls back to a demo
> area near Reading. Host it over HTTPS to get real live tracking.

## What it does

- **Live map** with a branded price pin at each station (brand + price, coloured
  cheap→dear). Pan, pinch-zoom, and tap a pin to sync it with the list.
- **Station list** sortable by **Cheapest** or **Nearest**, with distance from you
  and a "Cheapest" badge.
- **Petrol (E10) / Diesel (B7)** toggle re-prices and re-colours everything.
- **Navigate** opens Google Maps directions to the station
  (`https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>`).
- **Live location** tracking that follows you as you move.
- Light/dark theme aware, tuned for phone screens.

## Architecture: demo now, real database later

All data flows through one swappable seam near the top of the `<script>`:

```js
var DemoSource = { getStations: function () { /* bundled sample data */ } };
// var LiveSource = { getStations: function () { /* fetch real feeds */ } };
var DataSource = DemoSource;   // <-- flip to LiveSource when the backend is ready
```

`getStations()` returns an array of this shape, and nothing else in the app needs
to change:

```js
{ brand: "Tesco", name: "Tesco Extra, Napier Rd",
  lat: 51.4632, lng: -0.9668,
  prices: { petrol: 138.9, diesel: 144.9 } }   // pence per litre
```

### Going live with real UK prices

The UK Government's **fuel price transparency scheme** (run via the CMA) requires
major retailers to publish their prices in an open, standard JSON format, updated
throughout the day. Each retailer hosts a feed (e.g. Tesco, Asda, Sainsbury's, BP,
Shell, Morrisons, Esso, Applegreen, …), each listing every site with its address,
lat/lng, and per-fuel prices (`E10`, `E5`, `B7`, …).

Because a browser page can't fetch those third-party feeds directly (CORS + the
prices refresh server-side), the live path is:

```
retailer JSON feeds  ─►  small backend (proxy/cache/normalise)  ─►  LiveSource.getStations()
```

Recommended shape for the backend:

1. **Fetch & cache** each retailer feed on a schedule (e.g. every 15–30 min).
2. **Normalise** every site to the `{ brand, name, lat, lng, prices }` shape above
   (map `E10`→`petrol`, `B7`→`diesel`).
3. **Store** them — this is where your existing MySQL project fits: a `station`
   table (brand, name, lat, lng) and a `price` table (station_id, fuel_type,
   pence, updated_at). See `../movie_review_website.mwb` for the modelling style;
   a starter schema is in `schema.sql`.
4. **Expose** one endpoint, e.g. `GET /api/stations?lat=..&lng=..&radius=..`,
   returning the normalised array.
5. In the app, implement `LiveSource.getStations()` to `fetch()` that endpoint and
   set `DataSource = LiveSource`.

That keeps the phone app exactly as-is while the prices become real and live.

## Files

| File         | Purpose                                                        |
|--------------|---------------------------------------------------------------|
| `index.html` | The whole app — HTML, CSS, and JS in one file.                |
| `schema.sql` | Starter MySQL schema for caching normalised stations/prices.  |
| `README.md`  | This file.                                                    |
