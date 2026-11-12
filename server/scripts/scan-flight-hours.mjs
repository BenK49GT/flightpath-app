/**
 * Live ADS-B Exchange globe_history scan (no local-cache reads).
 * Usage: node scripts/scan-flight-hours.mjs --reg N49GT --days 365 --delay-ms 450
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchGlobeTraceForDay } from "../src/lib/globeHistory.js";
import { nToHex } from "../src/lib/nnumberLocal.js";
import { ymdFromUtcMs } from "../src/lib/dates.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hours(sec) {
  return Math.round((sec / 3600) * 100) / 100;
}

async function probeDay(icao, ymd) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await fetchGlobeTraceForDay(icao, ymd, { skipLocal: true, retries: 2 });
    if (r.rateLimited) {
      const wait = 8000 * 2 ** Math.min(attempt, 4) + Math.floor(Math.random() * 800);
      console.error(`${ymd} 429 — wait ${Math.round(wait / 1000)}s (try ${attempt + 1})`);
      await sleep(wait);
      continue;
    }
    return r;
  }
  return { ok: false, ymd, rateLimited: true };
}

async function main() {
  const reg = String(arg("--reg", "N49GT")).trim().toUpperCase();
  const days = Math.min(Math.max(Number(arg("--days", "365")) || 365, 1), 400);
  const delayMs = Math.min(Math.max(Number(arg("--delay-ms", "450")) || 450, 80), 4000);
  const icao = nToHex(reg).toLowerCase();
  const now = new Date();
  const startUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff90 = startUtc - 89 * 86400000;

  console.error(`Live scrape ${reg} → ${icao} for ${days} UTC days (delay ${delayMs}ms). No local-cache reads.`);

  const hits = [];
  let empty = 0;
  let rateLimitedDays = 0;

  for (let i = 0; i < days; i++) {
    const dayMs = startUtc - i * 86400000;
    const ymd = ymdFromUtcMs(dayMs);
    const r = await probeDay(icao, ymd);
    if (r.ok) {
      hits.push({
        date: ymd,
        totalFlightSec: r.totalFlightSec ?? 0,
        kind: r.kind,
      });
      console.error(`${ymd}  ${hours(r.totalFlightSec ?? 0)} h  (${r.totalFlightSec}s)  ${r.kind}`);
    } else if (r.rateLimited) {
      rateLimitedDays += 1;
      console.error(`${ymd}  still 429 after retries`);
    } else {
      empty += 1;
    }
    if (i + 1 < days) await sleep(delayMs);
  }

  const in90 = hits.filter((h) => Date.parse(`${h.date}T00:00:00Z`) >= cutoff90);
  const sum = (arr) => arr.reduce((a, h) => a + (h.totalFlightSec || 0), 0);

  const report = {
    registration: reg,
    icao24: icao,
    asOfUtc: ymdFromUtcMs(startUtc),
    daysRequested: days,
    daysWithFlights: hits.length,
    daysEmpty: empty,
    daysRateLimited: rateLimitedDays,
    last90Days: {
      hours: hours(sum(in90)),
      totalFlightSec: sum(in90),
      daysWithFlights: in90.length,
      dates: in90.map((h) => h.date),
    },
    last365Days: {
      hours: hours(sum(hits)),
      totalFlightSec: sum(hits),
      daysWithFlights: hits.length,
      dates: hits.map((h) => h.date),
    },
    days: hits,
  };

  const out = path.join(__dirname, "..", "output", `flight_hours_${reg}_${ymdFromUtcMs(startUtc)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
  console.error(`\nWrote ${out}`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
