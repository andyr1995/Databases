#!/usr/bin/env node
/**
 * Fuel Finder — price aggregator (full UK coverage).
 *
 * Two layers, merged:
 *
 *  1. BASE — the statutory Fuel Finder scheme dataset (every UK forecourt must
 *     report prices within 30 minutes by law, Motor Fuel Price (Open Data)
 *     Regulations 2025). Accessed via FuelCosts.co.uk's free mirror of the
 *     official data (the gov.uk portal blocks non-residential IPs). ~8,300
 *     stations. The two CSVs are ~110 MB, so the parsed base is cached in
 *     docs/data/ff-base.json and refreshed only when older than BASE_TTL.
 *
 *  2. OVERLAY — the retailers' own direct feeds (the old CMA scheme URLs,
 *     still updated continuously). Fresher than the base for those brands;
 *     merged on top by location.
 *
 * Output: docs/data/stations.json (compact, consumed by docs/index.html).
 *
 * Run locally:  node scripts/fetch-prices.mjs
 * In CI:        .github/workflows/update-prices.yml runs this on a schedule.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync, createReadStream, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "data", "stations.json");
const BASE_CACHE = join(ROOT, "docs", "data", "ff-base.json");
const OSM_CACHE = join(ROOT, "docs", "data", "osm-base.json");
const BASE_TTL_H = 6;           // refetch the ~110MB base CSVs at most every 6h
const OSM_TTL_H = 24 * 7;       // stations don't move; refresh OSM weekly
const MAX_PRICE_AGE_DAYS = 365; // keep prices up to a year, app shows their age
const MAX_FEED_AGE_DAYS = 7;    // drop overlay feeds staler than this
const UA = "Mozilla/5.0 (FuelFinder personal project)";

const FF_STATIONS_URL = "https://fuelcosts.co.uk/api/download/stations";
const FF_PRICES_URL = "https://fuelcosts.co.uk/api/download/price-history";
const OVERPASS_ENDPOINTS = [
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const OVERPASS_QUERY = '[out:json][timeout:300];area["ISO3166-1"="GB"][admin_level="2"]->.uk;nwr["amenity"="fuel"](area.uk);out center tags;';

/** Retailer direct feeds (legacy CMA scheme URLs — still live and fast). */
const FEEDS = [
  { retailer: "Applegreen",   url: "https://applegreenstores.com/fuel-prices/data.json" },
  { retailer: "Ascona",       url: "https://fuelprices.asconagroup.co.uk/newfuel.json" },
  { retailer: "Asda",         url: "https://storelocator.asda.com/fuel_prices_data.json" },
  { retailer: "BP",           url: "https://www.bp.com/en_gb/united-kingdom/home/fuelprices/fuel_prices_data.json" },
  { retailer: "Esso",         url: "https://fuelprices.esso.co.uk/latestdata.json" },
  { retailer: "Jet",          url: "https://jetlocal.co.uk/fuel_prices_data.json" },
  { retailer: "Morrisons",    url: "https://www.morrisons.com/fuel-prices/fuel.json" },
  { retailer: "Moto",         url: "https://moto-way.com/fuel-price/fuel_prices.json" },
  { retailer: "MFG",          url: "https://fuel.motorfuelgroup.com/fuel_prices_data.json" },
  { retailer: "Rontec",       url: "https://www.rontec-servicestations.co.uk/fuel-prices/data/fuel_prices_data.json" },
  { retailer: "Sainsbury's",  url: "https://api.sainsburys.co.uk/v1/exports/latest/fuel_prices_data.json" },
  { retailer: "SGN",          url: "https://www.sgnretail.uk/files/data/SGN_daily_fuel_prices.json" },
  { retailer: "Shell",        url: "https://www.shell.co.uk/fuel-prices-data.html" },
  { retailer: "Tesco",        url: "https://www.tesco.com/fuel_prices/fuel_prices_data.json" },
];

/* ------------------------------ helpers -------------------------------- */

function coord(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && isFinite(n) ? n : null;
}

function price(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return null;
  const pence = n < 10 ? n * 100 : n; // a few sources publish pounds
  if (pence < 80 || pence > 350) return null;
  return Math.round(pence * 10) / 10;
}

function inUK(lat, lng) {
  return lat >= 49 && lat <= 61.5 && lng >= -8.7 && lng <= 2.1;
}

function cellKey(lat, lng) {
  return `${Math.round(lat * 5000)}:${Math.round(lng * 5000)}`; // ~22m cells
}

/** Feed dates look like "18/07/2026 11:00:00" (dd/mm/yyyy). */
function parseFeedDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})[ T]?(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?/);
  if (!m) {
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }
  return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
}

/** Minimal RFC-4180 CSV line splitter (handles quoted commas/quotes). */
function splitCsv(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function download(url, dest) {
  execFileSync("curl", ["-sL", "--fail", "--max-time", "600", "-A", UA, "-o", dest, url],
    { stdio: ["ignore", "ignore", "inherit"] });
  return statSync(dest).size;
}

function tidyBrand(b) {
  if (!b) return "Unknown";
  const t = b.trim();
  if (/^(bp|jet|mfg|sgn|hks|gb|emo)$/i.test(t)) return t.toUpperCase();
  // Title-case ALL-CAPS or all-lower brands, leave mixed case alone
  if (t === t.toUpperCase() || t === t.toLowerCase()) {
    return fixApostropheS(titleCase(t));
  }
  return fixApostropheS(t);
}

function tidyName(n) {
  if (!n) return "";
  const t = n.trim();
  if (t === t.toUpperCase() && t.length > 3) return fixApostropheS(titleCase(t));
  return fixApostropheS(t);
}

/** Capitalise word starts but not after apostrophes (Sainsbury's, not Sainsbury'S). */
function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s\-\/(&.,])([a-z])/g, (m, pre, c) => pre + c.toUpperCase());
}

/** The source data itself contains forms like "Sainsbury'S". */
function fixApostropheS(s) {
  return s.replace(/'S(?=\s|$)/g, "'s");
}

/* --------------------- layer 1: Fuel Finder base ----------------------- */

const FUEL_MAP = { E10: "e10", E5: "e5", B7_STANDARD: "b7", B7_PREMIUM: "sdv" };

async function buildBase() {
  const tmp = tmpdir();
  const stFile = join(tmp, "ff-stations.csv");
  const prFile = join(tmp, "ff-prices.csv");
  console.error(`BASE  downloading stations CSV…`);
  console.error(`BASE  stations: ${(download(FF_STATIONS_URL, stFile) / 1e6).toFixed(1)} MB`);
  console.error(`BASE  downloading price history CSV (large)…`);
  console.error(`BASE  prices:   ${(download(FF_PRICES_URL, prFile) / 1e6).toFixed(1)} MB`);

  // stations: node_id -> station record
  const byNode = new Map();
  {
    const rl = createInterface({ input: createReadStream(stFile), crlfDelay: Infinity });
    let header = null, buf = "";
    for await (const rawLine of rl) {
      // rejoin lines split inside quoted fields
      buf = buf ? buf + "\n" + rawLine : rawLine;
      if ((buf.match(/"/g) || []).length % 2 !== 0) continue;
      const line = buf; buf = "";
      if (!header) { header = splitCsv(line); continue; }
      const f = splitCsv(line);
      const g = (name) => f[header.indexOf(name)];
      if (g("is_permanently_closed") === "true" || g("is_temporarily_closed") === "true") continue;
      const lat = coord(g("latitude")), lng = coord(g("longitude"));
      if (lat == null || lng == null || !inUK(lat, lng)) continue;
      byNode.set(g("node_id"), {
        b: tidyBrand(g("brand_name") || g("organisation_name") || g("trading_name")),
        a: tidyName(g("trading_name")) || g("address_line_1") || "",
        pc: (g("postcode") || "").toUpperCase(),
        lat: Math.round(lat * 1e5) / 1e5,
        lng: Math.round(lng * 1e5) / 1e5,
        e10: null, e5: null, b7: null, sdv: null,
        _t: { e10: 0, e5: 0, b7: 0, sdv: 0 },
      });
    }
  }
  console.error(`BASE  stations parsed: ${byNode.size}`);

  // prices: keep the latest per (node, fuel)
  {
    const rl = createInterface({ input: createReadStream(prFile), crlfDelay: Infinity });
    let first = true, idx = null;
    for await (const line of rl) {
      if (first) {
        const h = splitCsv(line);
        idx = { node: h.indexOf("node_id"), fuel: h.indexOf("fuel_type"), price: h.indexOf("price_pence"), upd: h.indexOf("source_updated_at") };
        first = false;
        continue;
      }
      const f = splitCsv(line);
      const st = byNode.get(f[idx.node]);
      if (!st) continue;
      const key = FUEL_MAP[f[idx.fuel]];
      if (!key) continue;
      const p = price(f[idx.price]);
      if (p == null) continue;
      const t = Date.parse(f[idx.upd]) || 0;
      if (t >= st._t[key]) { st._t[key] = t; st[key] = p; }
    }
  }

  const cutoff = Date.now() - MAX_PRICE_AGE_DAYS * 86400000;
  const stations = [];
  let priced = 0;
  for (const st of byNode.values()) {
    let newest = 0;
    for (const k of ["e10", "e5", "b7", "sdv"]) {
      if (st[k] != null && st._t[k] < cutoff) st[k] = null;
      if (st[k] != null && st._t[k] > newest) newest = st._t[k];
    }
    // Stations that have never reported a price still exist — keep them.
    const rec = { b: st.b, a: st.a, pc: st.pc, lat: st.lat, lng: st.lng, e10: st.e10, e5: st.e5, b7: st.b7, sdv: st.sdv };
    if (newest) { rec.u = new Date(newest).toISOString().slice(0, 10); priced++; }
    stations.push(rec);
  }
  console.error(`BASE  stations kept: ${stations.length} (${priced} with prices)`);
  return { fetched: new Date().toISOString(), stations };
}

/* ------------------- layer 3: OpenStreetMap stations -------------------- */

async function buildOsm() {
  let body = null;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      console.error(`OSM   querying ${new URL(ep).host}…`);
      body = execFileSync("curl", ["-s", "--fail", "--max-time", "360", "-A", UA,
        "-X", "POST", ep, "--data-urlencode", `data=${OVERPASS_QUERY}`],
        { maxBuffer: 256 << 20, encoding: "utf8" });
      const parsed = JSON.parse(body);
      if (!parsed.elements?.length) throw new Error("empty result");
      const stations = [];
      for (const e of parsed.elements) {
        const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
        if (lat == null || lng == null || !inUK(lat, lng)) continue;
        const t = e.tags || {};
        if (t.access === "private" || t.fuel === "electric") continue;
        stations.push({
          b: tidyBrand(t.brand || t.operator || t.name || "Fuel station"),
          a: tidyName(t.name || [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ")) || "",
          pc: (t["addr:postcode"] || "").toUpperCase(),
          lat: Math.round(lat * 1e5) / 1e5,
          lng: Math.round(lng * 1e5) / 1e5,
        });
      }
      console.error(`OSM   stations: ${stations.length}`);
      return { fetched: new Date().toISOString(), stations };
    } catch (err) {
      console.error(`OSM   ${new URL(ep).host} failed: ${err.message?.slice(0, 120)}`);
    }
  }
  return null;
}

async function loadOsm() {
  if (existsSync(OSM_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(OSM_CACHE, "utf8"));
      const ageH = (Date.now() - Date.parse(cached.fetched)) / 3600000;
      if (ageH < OSM_TTL_H && cached.stations?.length > 4000) {
        console.error(`OSM   using cache (${(ageH / 24).toFixed(1)}d old, ${cached.stations.length} stations)`);
        return cached;
      }
    } catch { /* rebuild below */ }
  }
  const osm = await buildOsm();
  if (osm && osm.stations.length > 4000) {
    mkdirSync(dirname(OSM_CACHE), { recursive: true });
    writeFileSync(OSM_CACHE, JSON.stringify(osm));
    return osm;
  }
  // fall back to a stale cache rather than nothing
  if (existsSync(OSM_CACHE)) {
    try { return JSON.parse(readFileSync(OSM_CACHE, "utf8")); } catch { /* ignore */ }
  }
  return { fetched: null, stations: [] };
}

async function loadBase() {
  if (existsSync(BASE_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(BASE_CACHE, "utf8"));
      const ageH = (Date.now() - Date.parse(cached.fetched)) / 3600000;
      if (ageH < BASE_TTL_H && cached.stations?.length > 4000) {
        console.error(`BASE  using cache (${ageH.toFixed(1)}h old, ${cached.stations.length} stations)`);
        return cached;
      }
    } catch { /* rebuild below */ }
  }
  const base = await buildBase();
  if (base.stations.length > 4000) {
    mkdirSync(dirname(BASE_CACHE), { recursive: true });
    writeFileSync(BASE_CACHE, JSON.stringify(base));
  }
  return base;
}

/* -------------------- layer 2: direct retailer feeds -------------------- */

async function fetchBody(url) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    // Some retailers (Tesco) reject Node's TLS/client signature but accept curl.
    try {
      return execFileSync("curl", ["-sL", "--fail", "--max-time", "30", "-A", UA, url],
        { maxBuffer: 64 << 20, encoding: "utf8" });
    } catch {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}

async function fetchFeed(feed) {
  const body = await fetchBody(feed.url);
  const json = JSON.parse(body.replace(/^﻿/, ""));
  const updated = parseFeedDate(json.last_updated);
  const ageDays = updated ? (Date.now() - updated.getTime()) / 86400000 : null;
  if (ageDays != null && ageDays > MAX_FEED_AGE_DAYS) {
    return { feed, updated, stations: [], skipped: `stale (${Math.round(ageDays)}d old)` };
  }
  const stations = [];
  for (const s of json.stations || []) {
    const lat = coord(s.location?.latitude), lng = coord(s.location?.longitude);
    const p = s.prices || {};
    const e10 = price(p.E10), e5 = price(p.E5), b7 = price(p.B7), sdv = price(p.SDV ?? p.B7S ?? p.SD);
    if (lat == null || lng == null || (e10 == null && b7 == null && e5 == null)) continue;
    if (!inUK(lat, lng)) continue;
    stations.push({
      b: tidyBrand(s.brand || feed.retailer),
      a: s.address || "",
      pc: (s.postcode || "").toUpperCase(),
      lat: Math.round(lat * 1e5) / 1e5,
      lng: Math.round(lng * 1e5) / 1e5,
      e10, e5, b7, sdv,
    });
  }
  return { feed, updated, stations };
}

/* -------------------------------- main ---------------------------------- */

const base = await loadBase();

const results = await Promise.allSettled(FEEDS.map(fetchFeed));
const sources = [{ retailer: "Fuel Finder scheme (via FuelCosts mirror)", ok: base.stations.length > 0, count: base.stations.length, updated: base.fetched }];
const overlay = [];
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  if (r.status === "rejected") {
    console.error(`FAIL  ${FEEDS[i].retailer}: ${r.reason?.message || r.reason}`);
    sources.push({ retailer: FEEDS[i].retailer, ok: false });
    continue;
  }
  const { feed, updated, stations, skipped } = r.value;
  if (skipped) {
    console.error(`SKIP  ${feed.retailer}: ${skipped}`);
    sources.push({ retailer: feed.retailer, ok: false, reason: skipped });
    continue;
  }
  console.error(`OK    ${feed.retailer}: ${stations.length} stations (updated ${updated ? updated.toISOString() : "unknown"})`);
  sources.push({ retailer: feed.retailer, ok: true, count: stations.length, updated: updated?.toISOString() ?? null });
  overlay.push(...stations);
}

// Merge: base first; overlay refreshes matching forecourts; OSM adds any
// physical station neither source knows about.
const GRID = 800; // ~140m cells

function makeIndex(list) {
  const coarse = new Map();
  const add = (s) => {
    const k = `${Math.round(s.lat * GRID)}:${Math.round(s.lng * GRID)}`;
    const arr = coarse.get(k) || [];
    arr.push(s);
    coarse.set(k, arr);
  };
  list.forEach(add);
  return {
    add,
    nearest(s) {
      const cy = Math.round(s.lat * GRID), cx = Math.round(s.lng * GRID);
      let best = null, bestD = Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const c of coarse.get(`${cy + dy}:${cx + dx}`) || []) {
            const dLat = (c.lat - s.lat) * 111320;
            const dLng = (c.lng - s.lng) * 111320 * 0.62; // cos(52°)
            const d = Math.hypot(dLat, dLng);
            if (d < bestD) { bestD = d; best = c; }
          }
        }
      }
      return { station: best, dist: bestD };
    },
  };
}

const sameBrand = (a, b) => {
  const ka = String(a).toLowerCase().split(/[\s']/)[0], kb = String(b).toLowerCase().split(/[\s']/)[0];
  return ka && kb && (ka === kb || ka.startsWith(kb) || kb.startsWith(ka));
};

const stations = [...base.stations];
const index = makeIndex(stations);
const today = new Date().toISOString().slice(0, 10);

// Overlay feeds: same brand within 150m (GPS drift) is the same forecourt;
// different brands must be within 50m to count as the same site.
let refreshed = 0, addedFeed = 0;
for (const s of overlay) {
  const { station: hit, dist } = index.nearest(s);
  if (hit && (dist <= 50 || (dist <= 150 && sameBrand(s.b, hit.b)))) {
    for (const k of ["e10", "e5", "b7", "sdv"]) if (s[k] != null) hit[k] = s[k];
    hit.u = today;
    refreshed++;
  } else {
    s.u = today;
    stations.push(s);
    index.add(s);
    addedFeed++;
  }
}
console.error(`MERGE overlay refreshed ${refreshed}, added ${addedFeed}`);

// OSM completeness layer: add stations with no counterpart within 120m.
// They carry no prices — the app shows them as "no price reported".
const osm = await loadOsm();
let addedOsm = 0;
for (const s of osm.stations) {
  const { dist } = index.nearest(s);
  if (dist <= 120) continue;
  stations.push({ b: s.b, a: s.a, pc: s.pc, lat: s.lat, lng: s.lng, e10: null, e5: null, b7: null, sdv: null });
  index.add(s);
  addedOsm++;
}
console.error(`MERGE OSM added ${addedOsm} unpriced stations`);
if (stations.length < 500) {
  console.error(`ABORT: only ${stations.length} stations collected — refusing to overwrite good data.`);
  process.exit(1);
}

sources.push({ retailer: "OpenStreetMap (physical stations)", ok: osm.stations.length > 0, count: addedOsm, updated: osm.fetched });

const pricedCount = stations.filter((s) => s.e10 != null || s.e5 != null || s.b7 != null || s.sdv != null).length;
const out = {
  generated: new Date().toISOString(),
  count: stations.length,
  priced: pricedCount,
  sources,
  stations,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.error(`WROTE ${OUT}: ${stations.length} stations`);
