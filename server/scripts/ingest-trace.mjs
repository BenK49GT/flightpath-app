#!/usr/bin/env node
/**
 * Ingest a readsb/tar1090 style trace JSON (array-of-array points) into our normalized storage.
 * Usage:
 *   node scripts/ingest-trace.mjs --icao a60e67 --day 2026-04-24 --file ./trace_full_a60e67.json
 *
 * Heuristic field mapping (common readsb exports):
 *   [lat, lon, altFt, timeSec | ms, gs?, track?]
 * If time looks like ms (>1e12), we convert to seconds.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseYmdUtc } from "../src/lib/dates.js";
import { normalizeRawTraceToPoints } from "./traceNormalize.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

async function main() {
  const icao = (arg("--icao") || "").toLowerCase();
  const day = arg("--day");
  const file = arg("--file");
  if (!icao || !day || !file) {
    console.error("Usage: node scripts/ingest-trace.mjs --icao a60e67 --day 2026-04-24 --file trace.json");
    process.exit(1);
  }
  if (!/^[0-9a-f]{6}$/.test(icao)) {
    console.error("icao must be 6 hex chars");
    process.exit(1);
  }
  if (parseYmdUtc(day) === null) {
    console.error("day must be YYYY-MM-DD");
    process.exit(1);
  }

  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  const points = normalizeRawTraceToPoints(raw);
  if (!points || points.length === 0) {
    console.error("Could not find trace array (expected top-level array or .trace)");
    process.exit(1);
  }

  const ym = day.replaceAll("-", "");
  const outfile = path.join(__dirname, "..", "data", "traces", `${ym}_${icao}.json`);

  await fs.mkdir(path.dirname(outfile), { recursive: true });
  await fs.writeFile(outfile, JSON.stringify({ points }, null, 2), "utf8");
  console.error(`Stored ${points.length} points → ${path.relative(process.cwd(), outfile)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
