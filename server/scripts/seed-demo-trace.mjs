#!/usr/bin/env node
/**
 * Writes a deterministic demo trace loosely matching public FlightAware breadcrumbs for N49GT.
 * Runtime ICAO comes from local N-number mapping; this file only seeds position history for demos.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lerpGreatCircle } from "./interp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ICAO = "a60e67"; // N49GT via local FAA Mode S mapping

/** Outbound Sky Acres → Oxford (approx public schedule, 2026-04-24 EDT) */

const LAT1 = 41.5653;
const LON1 = -73.8214;
const LAT2 = 41.4786;
const LON2 = -73.1352;

// 01:37 PM EDT ⇒ 17:37 local ⇒ 21:37Z on that date (EDT = UTC-4)
const DEPART_UNIX = Math.floor(Date.parse("2026-04-24T21:37:00.000Z") / 1000);
const SEGMENT_SEC = 18 * 60;
const TICK_SEC = Math.max(30, Math.floor(SEGMENT_SEC / 48));

async function writeTrace({ ymdSuffix, departUnix }) {
  const pts = [];
  for (let t = 0, i = 0; t <= SEGMENT_SEC; t += TICK_SEC, i++) {
    const frac = t / SEGMENT_SEC;
    const { lat, lon } = lerpGreatCircle(LAT1, LON1, LAT2, LON2, frac);
    const alt = 3500 + 1200 * Math.sin(Math.PI * frac);
    pts.push({
      t: departUnix + t,
      lat,
      lon,
      altFt: Math.round(alt),
      gsKt: 95 + frac * 20,
      trackDeg: 95 + frac * 5,
    });
  }

  const outDir = path.join(__dirname, "..", "data", "traces");
  await fs.mkdir(outDir, { recursive: true });
  const fname = `${ymdSuffix}_${ICAO}.json`;
  await fs.writeFile(path.join(outDir, fname), JSON.stringify({ points: pts }, null, 2), "utf8");
  console.error(`Wrote ${fname} (${pts.length} points)`);
}

await writeTrace({ ymdSuffix: "20260424", departUnix: DEPART_UNIX });
