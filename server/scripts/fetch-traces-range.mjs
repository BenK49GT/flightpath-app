#!/usr/bin/env node
/**
 * Try to download public globe_history trace JSON per day (ADS-B Exchange URL shape).
 * Respects provider terms — run only where you have rights to use the data.
 *
 * Usage:
 *   node scripts/fetch-traces-range.mjs --reg N49GT --from 2026-04-20 --to 2026-04-26
 *   node scripts/fetch-traces-range.mjs --icao a60e67 --from 2026-04-20 --to 2026-04-26 --delay-ms 750
 *
 * Writes: server/data/traces/YYYYMMDD_icao.json (normalized { points: [...] })
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { eachUtcDayInclusive, parseYmdUtc, ymdFromUtcMs } from "../src/lib/dates.js";
import { fetchGlobeHistoryJson } from "../src/lib/globeHistory.js";
import { nToHex } from "../src/lib/nnumberLocal.js";
import { normalizeRawTraceToPoints } from "./traceNormalize.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function globeHistoryUrl(y, m, d, folder, icao, kind) {
  const ic = icao.toLowerCase();
  return `https://globe.adsbexchange.com/globe_history/${y}/${m}/${d}/traces/${folder}/${kind}_${ic}.json`;
}

async function fetchJson(url) {
  return fetchGlobeHistoryJson(url);
}

async function main() {
  const regArg = arg("--reg");
  const icaoArg = (arg("--icao") || "").toLowerCase();
  const from = arg("--from");
  const to = arg("--to");
  const delayMs = Number(arg("--delay-ms") || "600");

  let icao = icaoArg;
  if (regArg) {
    try {
      icao = nToHex(regArg.trim().toUpperCase()).toLowerCase();
    } catch (e) {
      console.error(e.message || e);
      process.exit(1);
    }
  }

  if (!icao || !from || !to) {
    console.error(
      "Usage: node scripts/fetch-traces-range.mjs --reg N49GT --from YYYY-MM-DD --to YYYY-MM-DD [--delay-ms 600]",
    );
    console.error("   or: node scripts/fetch-traces-range.mjs --icao a60e67 --from ... --to ...");
    process.exit(1);
  }
  if (!/^[0-9a-f]{6}$/.test(icao)) {
    console.error("icao must be 6 hex chars");
    process.exit(1);
  }
  if (parseYmdUtc(from) === null || parseYmdUtc(to) === null) {
    console.error("from/to must be YYYY-MM-DD");
    process.exit(1);
  }

  const folder = icao.slice(-2);
  const dayStarts = eachUtcDayInclusive(from, to);
  const outDir = path.join(__dirname, "..", "data", "traces");
  await fs.mkdir(outDir, { recursive: true });

  let hits = 0;
  for (const dayMs of dayStarts) {
    const ymd = ymdFromUtcMs(dayMs);
    const [y, m, d] = ymd.split("-");
    const ymdCompact = ymd.replaceAll("-", "");

    let saved = false;
    for (const kind of ["trace_full", "trace_recent"]) {
      const url = globeHistoryUrl(y, m, d, folder, icao, kind);
      process.stderr.write(`GET ${url} … `);
      const { ok, data, status } = await fetchJson(url);
      if (!ok) {
        console.error(status);
        continue;
      }
      const points = normalizeRawTraceToPoints(data);
      if (!points || points.length === 0) {
        console.error("no parseable points");
        continue;
      }
      const outfile = path.join(outDir, `${ymdCompact}_${icao}.json`);
      await fs.writeFile(outfile, JSON.stringify({ points }, null, 2), "utf8");
      console.error(`ok → ${points.length} points → ${path.relative(process.cwd(), outfile)}`);
      hits += 1;
      saved = true;
      break;
    }
    if (!saved) {
      console.error(`no data for ${ymd}`);
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  console.error(`Done. Days with saved traces: ${hits} / ${dayStarts.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
