#!/usr/bin/env node
/**
 * Fuel Finder — price aggregator.
 *
 * Pulls the UK CMA fuel-price-transparency feeds (one JSON file per retailer),
 * normalises every station to a compact record, drops stale feeds, and writes
 * docs/data/stations.json for the app to consume.
 *
 * Run locally:  node scripts/fetch-prices.mjs
 * In CI:        .github/workflows/update-prices.yml runs this on a schedule.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "data", "stations.json");
const MAX_FEED_AGE_DAYS = 7;
const UA = "Mozilla/5.0 (FuelFinder personal project)";

/** Official retailer feeds published under the gov.uk fuel price scheme. */
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

function coord(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && isFinite(n) ? n : null;
}

function price(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return null;
  // A few retailers publish pounds (1.389) instead of pence (138.9).
  const pence = n < 10 ? n * 100 : n;
  if (pence < 80 || pence > 350) return null; // implausible → drop
  return Math.round(pence * 10) / 10;
}

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
    // Some retailers (Tesco, BP) reject Node's TLS/client signature but accept curl.
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
    if (lat < 49 || lat > 61.5 || lng < -8.7 || lng > 2.1) continue; // UK bounds sanity
    stations.push({
      b: s.brand || feed.retailer,
      a: s.address || "",
      pc: s.postcode || "",
      lat: Math.round(lat * 1e5) / 1e5,
      lng: Math.round(lng * 1e5) / 1e5,
      e10, e5, b7, sdv,
    });
  }
  return { feed, updated, stations };
}

const results = await Promise.allSettled(FEEDS.map(fetchFeed));
const all = [];
const sources = [];
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
  all.push(...stations);
}

// De-duplicate sites that appear in two feeds (e.g. brand + group operator):
// same rounded coordinate cell keeps the first occurrence.
const seen = new Set();
const deduped = all.filter((s) => {
  const key = `${Math.round(s.lat * 5000)}:${Math.round(s.lng * 5000)}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

if (deduped.length < 500) {
  console.error(`ABORT: only ${deduped.length} stations collected — refusing to overwrite good data.`);
  process.exit(1);
}

const out = {
  generated: new Date().toISOString(),
  count: deduped.length,
  sources,
  stations: deduped,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.error(`WROTE ${OUT}: ${deduped.length} stations from ${sources.filter((s) => s.ok).length} feeds`);
