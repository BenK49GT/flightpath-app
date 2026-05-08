#!/usr/bin/env node
/**
 * Build server/data/airports_us_basic.json from OurAirports CSV (public domain).
 * Run from repo root: node server/scripts/build-airports-us-basic.mjs
 *
 * Source: https://github.com/davidmegginson/ourairports-data (airports.csv)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CSV_PATH = path.join(ROOT, "data", "_airports_raw.csv");
const OUT_PATH = path.join(ROOT, "data", "airports_us_basic.json");

const CSV_URL =
  "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv";

function parseCSVLine(line) {
  const result = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      result.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

function normalizeCode(gps, ident, icao) {
  const pick = (s) => (typeof s === "string" ? s.trim().toUpperCase() : "");
  return pick(gps) || pick(icao) || pick(ident) || "";
}

const INCLUDED_TYPES = new Set([
  "large_airport",
  "medium_airport",
  "small_airport",
  "seaplane_base",
]);

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`Missing ${CSV_PATH}`);
    console.error(`Download with:\n  curl -sL -o ${CSV_PATH} ${CSV_URL}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const header = parseCSVLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h.replace(/^\uFEFF/, ""), i]));

  const byCode = new Map();

  for (let li = 1; li < lines.length; li++) {
    const cols = parseCSVLine(lines[li]);
    if (cols.length < 15) continue;

    const type = cols[idx.type]?.trim().toLowerCase() || "";
    if (!INCLUDED_TYPES.has(type)) continue;

    const iso = cols[idx.iso_country]?.trim().toUpperCase();
    if (iso !== "US") continue;

    const lat = Number(cols[idx.latitude_deg]);
    const lon = Number(cols[idx.longitude_deg]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const code = normalizeCode(cols[idx.gps_code], cols[idx.ident], cols[idx.icao_code]);
    if (!code || code.length < 3) continue;

    const name = cols[idx.name]?.trim() || code;
    const localRaw =
      typeof cols[idx.local_code] === "string" ? cols[idx.local_code].trim().toUpperCase() : "";
    const faaIdent = localRaw && localRaw !== code ? localRaw : null;
    const scheduledRaw = cols[idx.scheduled_service]?.trim().toLowerCase() || "";
    const scheduledService = scheduledRaw === "yes";
    const prev = byCode.get(code);
    const pri = (t) =>
      ({ large_airport: 4, medium_airport: 3, small_airport: 2, seaplane_base: 1, heliport: 0, balloonport: 0 }[
        t
      ] ?? 0);

    if (!prev || pri(type) > pri(prev.type)) {
      byCode.set(code, { code, name, lat, lon, type, scheduledService, faaIdent });
    } else if (prev) {
      prev.scheduledService = prev.scheduledService || scheduledService;
      prev.faaIdent = prev.faaIdent || faaIdent;
    }
  }

  const out = Array.from(byCode.values())
    .map(({ code, name, lat, lon, type, scheduledService, faaIdent }) => ({
      code,
      name,
      lat,
      lon,
      type,
      scheduledService: !!scheduledService,
      ...(faaIdent ? { faaIdent } : {}),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.error(`Wrote ${out.length} US airports → ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
