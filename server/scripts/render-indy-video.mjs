#!/usr/bin/env node
/**
 * Flight-path video: sensible kinematics + OSM map underlay + animated route only.
 *
 * - Sanitizes points (sort, dedupe, drop implausible jumps vs. timestamp).
 * - Picks one leg via segmentFlights (or full cleaned path if needed).
 * - Builds Web Mercator basemap from OpenStreetMap raster tiles (see attribution on output).
 * - Renders: parchment/sepia OSM grade + Raiders-style red line + vintage border + plane + grain/vignette.
 *
 * Usage:
 *   node scripts/render-indy-video.mjs [--reg N49GT] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *        [--leg longest|first|0|1|…] [--open] [--audio path/to/track.m4a|mp3|wav] [--no-music]
 *        [--output-basename indy_flight] [--map-type osm|vfr|ifr]
 *
 * --open      Windows: Explorer with the MP4 selected (paths in chat are often not clickable).
 * --audio     Mux your own file instead of the default underscore (you must have rights to use it).
 * --no-music  Video only (skip default adventure underscore).
 *
 * Default music: Kevin MacLeod — "Five Armies" (incompetech.com), CC BY 3.0 — cached under
 * server/assets/indy-default-music/ on first run; on-screen attribution is burned in.
 * (Not the Indiana Jones theme — that score is separately copyrighted.)
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { eachUtcDayInclusive, ymdFromUtcMs } from "../src/lib/dates.js";
import { nToHex } from "../src/lib/nnumberLocal.js";
import { segmentFlights } from "../src/lib/segment.js";
import { normalizeRawTraceToPoints } from "./traceNormalize.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "output");

const W = 1920;
const H = 1080;
const FPS = 24;
const DURATION_SEC = 14;
const VIDEO_CRF = 18;
const OSM_UA =
  "FlightpathIndyVideo/1.2 (flightpath local render; +https://www.openstreetmap.org/copyright)";
const TILE_HOSTS = ["a", "b", "c"];

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function sanitizeOutputBase(name) {
  const s = String(name ?? "indy_flight").replace(/[^a-zA-Z0-9._-]/g, "_");
  const t = s.slice(0, 96);
  return t || "indy_flight";
}

const REG = (arg("--reg", "N49GT") || "N49GT").trim().toUpperCase();
const FROM = arg("--from", "2026-04-24");
const TO = arg("--to", FROM);
const LEG = (arg("--leg", "longest") || "longest").toLowerCase();
const OPEN_IN_OS = process.argv.includes("--open");
const AUDIO_ARG = arg("--audio", null);
const AUDIO_PATH = AUDIO_ARG ? String(AUDIO_ARG).trim() : null;
const MAP_TYPE = (arg("--map-type", "osm") || "osm").trim().toLowerCase();

const MAP_SOURCES = {
  osm: {
    key: "osm",
    label: "OpenStreetMap",
    copyright: "https://www.openstreetmap.org/copyright",
    minZoom: 5,
    maxZoom: 17,
    maxTiles: 24,
  },
  vfr: {
    key: "vfr",
    label: "FAA VFR Sectional",
    copyright: "Federal Aviation Administration, Aeronautical Information Services",
    minZoom: 8,
    maxZoom: 12,
    maxTiles: 72,
  },
  ifr: {
    key: "ifr",
    label: "FAA IFR AreaLow",
    copyright: "Federal Aviation Administration, Aeronautical Information Services",
    minZoom: 7,
    maxZoom: 12,
    maxTiles: 64,
  },
};

/** Cinematic adventure underscore; CC BY 3.0 — attribution required (drawtext + ATTRIBUTION.txt). */
const DEFAULT_ADVENTURE_MUSIC_URL =
  "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Five%20Armies.mp3";

async function ensureDefaultAdventureMusic() {
  const dir = path.join(ROOT, "assets", "indy-default-music");
  const dest = path.join(dir, "kevin-macleod-five-armies.mp3");
  fs.mkdirSync(dir, { recursive: true });
  const minBytes = 400_000;
  if (fs.existsSync(dest) && fs.statSync(dest).size >= minBytes) return dest;

  process.stderr.write(`Downloading adventure underscore (Kevin MacLeod — Five Armies, CC BY 3.0)… `);
  const res = await fetch(DEFAULT_ADVENTURE_MUSIC_URL, {
    headers: {
      "user-agent": "FlightpathIndyVideo/1.3 (local render; incompetech royalty-free)",
      accept: "audio/mpeg,*/*",
    },
  });
  if (!res.ok) throw new Error(`Default music download failed: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.error(`ok → ${dest}`);

  const attribution = `Five Armies
© Kevin MacLeod — https://incompetech.com

Licensed under Creative Commons: By Attribution 3.0
https://creativecommons.org/licenses/by/3.0/

Downloaded for local Flightpath renders from:
${DEFAULT_ADVENTURE_MUSIC_URL}
`;
  fs.writeFileSync(path.join(dir, "ATTRIBUTION.txt"), attribution, "utf8");
  return dest;
}

function writeVideoPreviewHtml(mp4Path) {
  const dir = path.dirname(mp4Path);
  const stem = path.basename(mp4Path, path.extname(mp4Path));
  const base = path.basename(mp4Path);
  const htmlPath = path.join(dir, `${stem}_preview.html`);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Flightpath — indy flight</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1a1510; color: #e8dcc8; margin: 0; padding: 1rem; }
  video { width: 100%; max-width: 100%; height: auto; display: block; border: 1px solid #5c4a3a; }
  .hint { opacity: 0.9; font-size: 0.9rem; margin-bottom: 0.75rem; max-width: 50rem; line-height: 1.4; }
  code { background: #2a2218; padding: 0.12rem 0.35rem; border-radius: 3px; }
</style>
</head>
<body>
<p class="hint">Local preview (loads <code>${base}</code> from this folder). If the video is blank, open the MP4 directly in Films &amp; TV or VLC.</p>
<video src="${base}" controls playsinline preload="metadata"></video>
</body>
</html>`;
  fs.writeFileSync(htmlPath, html, "utf8");
  return htmlPath;
}

function revealInFileManager(filePath) {
  const abs = path.resolve(filePath);
  if (process.platform === "win32") {
    spawnSync("explorer", ["/select,", abs], { shell: true, windowsHide: true });
  } else if (process.platform === "darwin") {
    spawnSync("open", ["-R", abs], { stdio: "ignore", windowsHide: true });
  } else {
    spawnSync("xdg-open", [path.dirname(abs)], { stdio: "ignore", windowsHide: true });
  }
}

function globeHistoryUrl(y, m, d, folder, icao, kind) {
  const ic = icao.toLowerCase();
  return `https://globe.adsbexchange.com/globe_history/${y}/${m}/${d}/traces/${folder}/${kind}_${ic}.json`;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json,*/*",
      "user-agent":
        "Mozilla/5.0 (compatible; FlightpathIndyRender/1.2) AppleWebKit/537.36",
      referer: "https://globe.adsbexchange.com/",
    },
  });
  if (!res.ok) return { ok: false, status: res.status };
  try {
    const data = await res.json();
    return { ok: true, data };
  } catch {
    return { ok: false, status: "parse-error" };
  }
}

async function tryScrapeTrace(icaoLower, from, to) {
  const folder = icaoLower.slice(-2);
  const dayStarts = eachUtcDayInclusive(from, to);
  for (const dayMs of dayStarts) {
    const ymd = ymdFromUtcMs(dayMs);
    const [y, m, d] = ymd.split("-");
    for (const kind of ["trace_full", "trace_recent"]) {
      const url = globeHistoryUrl(y, m, d, folder, icaoLower, kind);
      process.stderr.write(`Scrape: GET ${url} … `);
      const { ok, data, status } = await fetchJson(url);
      if (!ok) {
        console.error(status);
        continue;
      }
      const points = normalizeRawTraceToPoints(data);
      if (!points?.length) {
        console.error("no parseable points");
        continue;
      }
      console.error(`ok → ${points.length} raw points`);
      return { source: "globe.adsbexchange.com", url, ymd, points };
    }
  }
  return null;
}

function loadLocalTrace(icaoLower, ymdCompact) {
  const p = path.join(ROOT, "data", "traces", `${ymdCompact}_${icaoLower}.json`);
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const points = normalizeRawTraceToPoints(raw);
  if (!points?.length) return null;
  return {
    source: "local-fallback",
    path: p,
    ymd: `${ymdCompact.slice(0, 4)}-${ymdCompact.slice(4, 6)}-${ymdCompact.slice(6, 8)}`,
    points,
  };
}

/** Windows drawtext needs drive colon escaped, e.g. C\:/Windows/Fonts/... */
function toFfmpegFontPath(absPath) {
  const f = path.resolve(absPath).replace(/\\/g, "/");
  return f.replace(/^([A-Za-z]):/, "$1\\:");
}

function resolveTitleFont() {
  const windir = process.env.WINDIR || "C:\\Windows";
  for (const name of ["georgiab.ttf", "timesbd.ttf", "timesbi.ttf", "arial.ttf"]) {
    const p = path.join(windir, "Fonts", name);
    if (fs.existsSync(p)) return toFfmpegFontPath(p);
  }
  return "C\\:/Windows/Fonts/arial.ttf";
}

function findFfmpeg() {
  const tryRun = (bin) => {
    const r = spawnSync(bin, ["-version"], { encoding: "utf8" });
    if (r.status === 0) return bin;
    return null;
  };
  const direct = tryRun("ffmpeg");
  if (direct) return direct;
  const localLink = path.join(
    process.env.LOCALAPPDATA || "",
    "Microsoft",
    "WinGet",
    "Links",
    "ffmpeg.exe",
  );
  if (fs.existsSync(localLink)) return localLink;
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  for (const c of [
    path.join(pf, "ffmpeg", "bin", "ffmpeg.exe"),
    path.join(pf, "Gyan", "ffmpeg", "bin", "ffmpeg.exe"),
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** Initial true bearing 0–360° (north=0, east=90), for geographic fallback. */
function initialBearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return ((((θ * 180) / Math.PI) % 360) + 360) % 360;
}

/**
 * Heading 0–360° clockwise from north, matching the *drawn* polyline on screen (Mercator).
 * Uses atan2(dx, -dy): north is (0,-1) in screen space.
 */
function screenHeadingDegFromPath(x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (dx * dx + dy * dy < 2.25) return null;
  return ((((Math.atan2(dx, -dy) * 180) / Math.PI) % 360) + 360) % 360;
}

function timeLooksLikeUnixSec(points) {
  if (!points.length) return false;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  return t0 > 1_000_000_000 && t1 > 1_000_000_000 && t1 - t0 > 120;
}

/**
 * Keep only physically plausible steps vs. time (drops ADS-B glitches / stitched segments).
 */
function sanitizeKinematics(points, maxKts) {
  if (!points.length) return [];
  const unixy = timeLooksLikeUnixSec(points);
  /** Relative / non-epoch timestamps are common in globe traces — speed vs. `t` is meaningless. */
  if (!unixy) return points;

  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1];
    const p = points[i];
    const dt = Math.max(1, p.t - prev.t);
    const d = haversineNm(prev.lat, prev.lon, p.lat, p.lon);
    const maxNm = (maxKts / 3600) * dt * 1.35;
    if (d > maxNm) continue;
    out.push(p);
  }
  return out;
}

function dedupeSpatial(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || haversineNm(last.lat, last.lon, p.lat, p.lon) > 0.015) out.push(p);
  }
  return out;
}

function preprocessRawPoints(raw) {
  let pts = raw
    .map((p, i) => {
      const lat = Number(p.lat ?? p.latitude);
      const lon = Number(p.lon ?? p.longitude ?? p.lng);
      let t = Number(p.t ?? p.timestamp ?? p.time);
      if (!Number.isFinite(t)) t = i;
      return { ...p, lat, lon, t };
    })
    .filter(
      (p) =>
        p &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lon) &&
        Math.abs(p.lat) <= 90 &&
        Math.abs(p.lon) <= 180,
    );
  if (!pts.length) return [];
  pts.sort((a, b) => a.t - b.t);
  pts = dedupeSpatial(pts);
  pts = sanitizeKinematics(pts, 520);
  if (pts.length < 3) {
    console.error("After Unix-time speed filter < 3 points — using sorted/deduped coords only.");
    pts = dedupeSpatial(
      raw
        .map((p, i) => {
          const lat = Number(p.lat ?? p.latitude);
          const lon = Number(p.lon ?? p.longitude ?? p.lng);
          let t = Number(p.t ?? p.timestamp ?? p.time);
          if (!Number.isFinite(t)) t = i;
          return { ...p, lat, lon, t };
        })
        .filter(
          (p) =>
            p &&
            Number.isFinite(p.lat) &&
            Number.isFinite(p.lon) &&
            Math.abs(p.lat) <= 90 &&
            Math.abs(p.lon) <= 180,
        )
        .sort((a, b) => a.t - b.t),
    );
  }
  return pts;
}

function selectFlightLeg(points, legMode) {
  const unixy = timeLooksLikeUnixSec(points);
  const tryConfigs = unixy
    ? [{}, { minPoints: 8, minDurationSec: 90 }, { minPoints: 6, minDurationSec: 45 }]
    : [
        { maxGapSec: 86400, maxJumpNm: 35, minPoints: 15, minDurationSec: 0 },
        { maxGapSec: 86400, maxJumpNm: 55, minPoints: 10, minDurationSec: 0 },
        { maxGapSec: 86400, maxJumpNm: 85, minPoints: 6, minDurationSec: 0 },
      ];

  let flights = [];
  for (const cfg of tryConfigs) {
    flights = segmentFlights(points, cfg);
    if (flights.length) break;
  }

  if (!flights.length) {
    console.error("No segment passed filters — using cleaned full path.");
    const t0 = points[0]?.t ?? 0;
    const t1 = points[points.length - 1]?.t ?? 0;
    return {
      legIndex: 0,
      points,
      flightsFound: 1,
      legMeta: {
        points,
        startTimeUnix: t0,
        endTimeUnix: t1,
        durationSec: Math.max(1, t1 - t0),
        pointCount: points.length,
      },
    };
  }

  const ranked = [...flights].sort((a, b) => b.pointCount - a.pointCount || b.durationSec - a.durationSec);
  const best = ranked[0];
  if (best.pointCount < Math.min(30, Math.max(8, Math.floor(points.length * 0.2)))) {
    console.error(
      `Best leg only ${best.pointCount} pts (cleaned total ${points.length}) — using full cleaned path.`,
    );
    const t0 = points[0]?.t ?? 0;
    const t1 = points[points.length - 1]?.t ?? 0;
    return {
      legIndex: 0,
      points,
      flightsFound: flights.length,
      legMeta: {
        points,
        startTimeUnix: t0,
        endTimeUnix: t1,
        durationSec: Math.max(1, t1 - t0),
        pointCount: points.length,
      },
    };
  }

  const chron = [...flights].sort((a, b) => a.startTimeUnix - b.startTimeUnix);
  const byDur = [...flights].sort((a, b) => b.durationSec - a.durationSec);

  let leg;
  let legIdxChron = 0;

  if (legMode === "longest") {
    leg = byDur[0];
    legIdxChron = chron.indexOf(leg);
  } else if (legMode === "first") {
    leg = chron[0];
    legIdxChron = 0;
  } else if (/^\d+$/.test(legMode)) {
    legIdxChron = Math.min(Number(legMode), chron.length - 1);
    leg = chron[legIdxChron];
  } else {
    leg = byDur[0];
    legIdxChron = chron.indexOf(leg);
  }

  console.error(
    `Leg ${legIdxChron + 1}/${flights.length}: ${leg.pointCount} pts, ~${Math.round(leg.durationSec / 60)} min`,
  );
  return { legIndex: legIdxChron, points: leg.points, flightsFound: flights.length, legMeta: leg };
}

function worldSizePx(z) {
  return 256 * Math.pow(2, z);
}

function lonLatToWorldPx(lat, lon, z) {
  const s = worldSizePx(z);
  const x = ((lon + 180) / 360) * s;
  const latRad = (lat * Math.PI) / 180;
  const sin = Math.sin(latRad);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s;
  return { x, y };
}

function pickZoom(minLat, maxLat, minLon, maxLon) {
  for (let z = 17; z >= 5; z--) {
    const c = [
      lonLatToWorldPx(minLat, minLon, z),
      lonLatToWorldPx(minLat, maxLon, z),
      lonLatToWorldPx(maxLat, minLon, z),
      lonLatToWorldPx(maxLat, maxLon, z),
    ];
    const xs = c.map((p) => p.x);
    const ys = c.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    const span = Math.max(w, h);
    if (span >= Math.min(W, H) * 0.52 && span <= Math.max(W, H) * 2.8) return z;
  }
  return 10;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOsmTile(z, x, y, destPath) {
  const host = TILE_HOSTS[(x + y + z) % TILE_HOSTS.length];
  const url = `https://${host}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
  const res = await fetch(url, { headers: { "user-agent": OSM_UA, Accept: "image/png,*/*" } });
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: HTTP ${res.status}`);
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

async function fetchChartTile(mapType, z, x, y, destPath) {
  const service = mapType === "vfr" ? "VFR_Sectional" : "IFR_AreaLow";
  const url = `https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/${service}/MapServer/tile/${z}/${y}/${x}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": OSM_UA,
      accept: "image/png,image/jpeg,*/*",
      referer: "https://www.arcgis.com/",
    },
  });
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: HTTP ${res.status}`);
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

async function fetchMapTile(mapType, z, x, y, destPath) {
  if (mapType === "osm") return fetchOsmTile(z, x, y, destPath);
  if (mapType === "vfr" || mapType === "ifr") return fetchChartTile(mapType, z, x, y, destPath);
  throw new Error(`Unsupported --map-type: ${mapType}`);
}

async function buildBasemapPng(ffmpeg, bounds, zIn, outPngPath, tileDir, mapType, mapSource) {
  fs.mkdirSync(tileDir, { recursive: true });
  const { minLat, maxLat, minLon, maxLon } = bounds;

  /** Keep bounded so ffmpeg argv/filtergraph stays reliable while preserving chart detail. */
  const MAX_TILES = Math.max(8, Number(mapSource.maxTiles) || 24);
  let z = Math.max(mapSource.minZoom, Math.min(zIn, mapSource.maxZoom));
  let x0;
  let x1;
  let y0;
  let y1;
  let tx0;
  let tx1;
  let ty0;
  let ty1;
  let nCols;
  let nRows;

  for (;;) {
    const c = [
      lonLatToWorldPx(minLat, minLon, z),
      lonLatToWorldPx(minLat, maxLon, z),
      lonLatToWorldPx(maxLat, minLon, z),
      lonLatToWorldPx(maxLat, maxLon, z),
    ];
    const xs = c.map((p) => p.x);
    const ys = c.map((p) => p.y);
    x0 = Math.min(...xs);
    x1 = Math.max(...xs);
    y0 = Math.min(...ys);
    y1 = Math.max(...ys);
    const padFactor = mapType === "vfr" || mapType === "ifr" ? 0.08 : 0.12;
    const padPx = mapType === "vfr" || mapType === "ifr" ? 48 : 80;
    const pad = Math.max(x1 - x0, y1 - y0) * padFactor + padPx;
    x0 -= pad;
    x1 += pad;
    y0 -= pad;
    y1 += pad;

    tx0 = Math.floor(x0 / 256);
    tx1 = Math.floor(x1 / 256);
    ty0 = Math.floor(y0 / 256);
    ty1 = Math.floor(y1 / 256);
    nCols = tx1 - tx0 + 1;
    nRows = ty1 - ty0 + 1;
    if (!Number.isFinite(nCols) || !Number.isFinite(nRows) || nCols < 1 || nRows < 1) {
      throw new Error(`Invalid tile grid ${nCols}x${nRows} for zoom ${z}`);
    }
    if (nCols * nRows <= MAX_TILES || z <= mapSource.minZoom) break;
    z -= 1;
  }

  console.error(`${mapSource.label} tile grid ${nCols}x${nRows} at zoom ${z} (${nCols * nRows} tiles)`);

  const tilePaths = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const fp = path.join(tileDir, `t_${z}_${tx}_${ty}.png`);
      await fetchMapTile(mapType, z, tx, ty, fp);
      await sleep(85);
      tilePaths.push(fp);
    }
  }

  const ffInputs = [];
  for (const p of tilePaths) ffInputs.push("-i", p);

  const fc = [];
  for (let i = 0; i < tilePaths.length; i++) {
    fc.push(`[${i}:v]scale=256:256:flags=lanczos[t${i}]`);
  }
  for (let r = 0; r < nRows; r++) {
    const labs = [];
    for (let c = 0; c < nCols; c++) labs.push(`[t${r * nCols + c}]`);
    fc.push(`${labs.join("")}hstack=inputs=${nCols}[row${r}]`);
  }
  const rowLabs = [];
  for (let r = 0; r < nRows; r++) rowLabs.push(`[row${r}]`);
  fc.push(`${rowLabs.join("")}vstack=inputs=${nRows}[mos]`);

  const mosaicW = nCols * 256;
  const mosaicH = nRows * 256;
  let cropX = Math.floor(x0 - tx0 * 256);
  let cropY = Math.floor(y0 - ty0 * 256);
  let cropW = Math.ceil(x1 - x0);
  let cropH = Math.ceil(y1 - y0);
  cropX = Math.max(0, Math.min(cropX, mosaicW - 1));
  cropY = Math.max(0, Math.min(cropY, mosaicH - 1));
  cropW = Math.max(2, Math.min(cropW, mosaicW - cropX));
  cropH = Math.max(2, Math.min(cropH, mosaicH - cropY));

  fc.push(`[mos]crop=${cropW}:${cropH}:${cropX}:${cropY}[cropped]`);
  fc.push(`[cropped]scale=${W}:${H}:flags=lanczos[final]`);

  const args = [
    "-y",
    ...ffInputs,
    "-filter_complex",
    fc.join(";"),
    "-map",
    "[final]",
    "-frames:v",
    "1",
    "-update",
    "1",
    outPngPath,
  ];
  const r = spawnSync(ffmpeg, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error("ffmpeg tile mosaic failed");

  for (const f of fs.readdirSync(tileDir)) fs.unlinkSync(path.join(tileDir, f));
  fs.rmdirSync(tileDir);

  return { x0, x1, y0, y1, z };
}

function readPngRgbWithFfmpeg(ffmpeg, pngPath) {
  const r = spawnSync(
    ffmpeg,
    ["-i", pngPath, "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-"],
    { encoding: "buffer", maxBuffer: W * H * 3 + 10_000_000 },
  );
  if (r.status !== 0 || r.stdout.length < W * H * 3) {
    throw new Error(`decode basemap: ${r.stderr?.toString?.() || "unknown"}`);
  }
  return Buffer.from(r.stdout.subarray(0, W * H * 3));
}

function hashU8(x, y, salt) {
  let h = (x * 374761393 + y * 668265263 + salt * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h >>> 0) & 255;
}

function blendPx(buf, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (Math.floor(y) * W + Math.floor(x)) * 3;
  buf[i] = Math.round(buf[i] * (1 - a) + r * a);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + g * a);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + b * a);
}

function drawSoftSegment(buf, x0, y0, x1, y1, r, g, b, thickness, alpha) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const steps = Math.ceil(len * 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = x0 + dx * t;
    const y = y0 + dy * t;
    for (let ox = -thickness; ox <= thickness; ox++) {
      for (let oy = -thickness; oy <= thickness; oy++) {
        if (ox * ox + oy * oy <= thickness * thickness + 0.5) {
          blendPx(buf, x + ox, y + oy, r, g, b, alpha);
        }
      }
    }
  }
}

/** Classic travel-montage red: dark outline, saturated core, hot center. */
function drawRouteSegment(buf, x0, y0, x1, y1) {
  drawSoftSegment(buf, x0, y0, x1, y1, 55, 12, 14, 5.2, 0.62);
  drawSoftSegment(buf, x0, y0, x1, y1, 200, 28, 32, 3.4, 0.88);
  drawSoftSegment(buf, x0, y0, x1, y1, 255, 42, 38, 2.0, 0.98);
  drawSoftSegment(buf, x0, y0, x1, y1, 255, 235, 210, 0.75, 0.38);
}

/**
 * Map marker aligned with the route: nose at local -Y (north on screen before rotation).
 * Rotation `rad` = track clockwise from north; matches standard 2D rotation with +Y down.
 */
function drawPlaneIcon(buf, x, y, headingDeg) {
  let h = Number(headingDeg);
  if (!Number.isFinite(h)) h = 0;
  const rad = (h * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const R = (px, py) => [x + px * c - py * s, y + px * s + py * c];

  const outline = [
    [0, -20],
    [17, 7],
    [6, 7],
    [6, 13],
    [-6, 13],
    [-6, 7],
    [-17, 7],
  ];
  for (let i = 0; i < outline.length; i++) {
    const j = (i + 1) % outline.length;
    const [ax, ay] = R(outline[i][0], outline[i][1]);
    const [bx, by] = R(outline[j][0], outline[j][1]);
    drawSoftSegment(buf, ax, ay, bx, by, 45, 14, 12, 3.0, 0.82);
    drawSoftSegment(buf, ax, ay, bx, by, 210, 32, 30, 1.65, 0.96);
    drawSoftSegment(buf, ax, ay, bx, by, 255, 248, 235, 0.65, 0.35);
  }
}

function resolvePlaneHeadingDeg(points, upto, head, headXY, z, view) {
  const idx = upto - 1;
  if (idx >= 1) {
    const prevXY = worldToScreen(points[idx - 1].lat, points[idx - 1].lon, z, view);
    const fromPath = screenHeadingDegFromPath(prevXY.x, prevXY.y, headXY.x, headXY.y);
    if (fromPath != null) return fromPath;
  }
  if (idx >= 0 && idx < points.length - 1) {
    const nextXY = worldToScreen(points[idx + 1].lat, points[idx + 1].lon, z, view);
    const fromPath = screenHeadingDegFromPath(headXY.x, headXY.y, nextXY.x, nextXY.y);
    if (fromPath != null) return fromPath;
  }
  if (idx >= 1) {
    const br = initialBearingDeg(points[idx - 1].lat, points[idx - 1].lon, head.lat, head.lon);
    if (Number.isFinite(br)) return br;
  }
  if (Number.isFinite(head.trackDeg)) return head.trackDeg;
  return 0;
}

function worldToScreen(lat, lon, z, view) {
  const { x0, x1, y0, y1 } = view;
  const p = lonLatToWorldPx(lat, lon, z);
  const nx = (p.x - x0) / Math.max(x1 - x0, 1e-6);
  const ny = (p.y - y0) / Math.max(y1 - y0, 1e-6);
  return {
    // Basemap is already cropped/scaled to full frame; adding synthetic margins offsets the path.
    x: nx * W,
    y: ny * H,
  };
}

function clampU8(n) {
  return Math.max(0, Math.min(255, n));
}

/** Warm, heavy vignette — corners fall off to brown shadow like a desk lamp on a chart. */
function applyVignette(buf) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cx = x / W - 0.5;
      const cy = y / H - 0.5;
      const d = (cx * cx + cy * cy) * 4;
      const v = 1 - 0.38 * d;
      const warm = 1 + 0.06 * d;
      const i = (y * W + x) * 3;
      buf[i] = clampU8(buf[i] * v * warm + 4 * d);
      buf[i + 1] = clampU8(buf[i + 1] * v * (0.98 + 0.04 * d));
      buf[i + 2] = clampU8(buf[i + 2] * v * (1 - 0.22 * d));
    }
  }
}

/** Aged chart: desaturate blues, lift to warm ivory, keep roads readable. */
function applyParchmentGrade(buf) {
  for (let i = 0; i < buf.length; i += 3) {
    let r = buf[i];
    let g = buf[i + 1];
    let b = buf[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = 0.58;
    let sr = lum + (r - lum) * sat;
    let sg = lum + (g - lum) * sat;
    let sb = lum + (b - lum) * (sat * 0.82);
    let nr = sr * 1.05 + sg * 0.18 + sb * 0.04 + 10;
    let ng = sr * 0.2 + sg * 1.02 + sb * 0.06 + 8;
    let nb = sr * 0.06 + sg * 0.22 + sb * 0.78;
    const mix = 0.62;
    r = r * (1 - mix) + nr * mix;
    g = g * (1 - mix) + ng * mix;
    b = b * (1 - mix) + nb * mix;
    buf[i] = clampU8(r);
    buf[i + 1] = clampU8(g);
    buf[i + 2] = clampU8(b);
  }
}

/** Subtle paper flecks (static per frame salt so grain + speckle read as film + fiber). */
function applyPaperSpeckle(buf, frame) {
  const salt = (frame * 17) & 0xff;
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 3) {
      const h = hashU8(x, y, salt);
      if (h < 8) {
        const i = (y * W + x) * 3;
        const d = (h / 255) * 14 - 4;
        buf[i] = clampU8(buf[i] + d);
        buf[i + 1] = clampU8(buf[i + 1] + d * 0.9);
        buf[i + 2] = clampU8(buf[i + 2] + d * 0.75);
      }
    }
  }
}

/** Double-rule border like an old wall map. */
function drawVintageMapBorder(buf) {
  const insetOuter = 18;
  const gap = 5;
  const insetInner = insetOuter + gap;
  const br = 88;
  const bg = 58;
  const bb = 38;
  const a = 0.82;

  const hLine = (y) => {
    for (let x = insetOuter; x < W - insetOuter; x++) {
      blendPx(buf, x, y, br, bg, bb, a);
      blendPx(buf, x, y + gap, br, bg, bb, a * 0.75);
    }
  };
  const vLine = (x) => {
    for (let y = insetOuter; y < H - insetOuter; y++) {
      blendPx(buf, x, y, br, bg, bb, a);
      blendPx(buf, x + gap, y, br, bg, bb, a * 0.75);
    }
  };

  hLine(insetOuter);
  hLine(H - 1 - insetOuter - gap);
  vLine(insetOuter);
  vLine(W - 1 - insetOuter - gap);

  const io = insetInner;
  const br2 = 120;
  const bg2 = 85;
  const bb2 = 55;
  const a2 = 0.45;
  for (let x = io; x < W - io; x++) {
    blendPx(buf, x, io, br2, bg2, bb2, a2);
    blendPx(buf, x, H - 1 - io, br2, bg2, bb2, a2);
  }
  for (let y = io; y < H - io; y++) {
    blendPx(buf, io, y, br2, bg2, bb2, a2);
    blendPx(buf, W - 1 - io, y, br2, bg2, bb2, a2);
  }
}

function applyFilmGrain(buf, frame) {
  for (let i = 0; i < buf.length; i += 9) {
    if (hashU8(i, frame, 7) % 5 === 0) {
      const n = (hashU8(i >> 2, frame, 9) / 255 - 0.5) * 10;
      buf[i] = Math.max(0, Math.min(255, buf[i] + n));
      buf[i + 1] = Math.max(0, Math.min(255, buf[i + 1] + n * 0.95));
      buf[i + 2] = Math.max(0, Math.min(255, buf[i + 2] + n * 0.9));
    }
  }
}

function renderFrame(baseRgb, buf, points, progress, view, z, frame) {
  baseRgb.copy(buf, 0, 0, W * H * 3);
  applyParchmentGrade(buf);

  const n = points.length;
  const upto = Math.max(1, Math.min(n, Math.floor(progress * (n - 1)) + 1));
  const slice = points.slice(0, upto);
  const xy = slice.map((p) => worldToScreen(p.lat, p.lon, z, view));

  for (let i = 1; i < xy.length; i++) {
    drawRouteSegment(buf, xy[i - 1].x, xy[i - 1].y, xy[i].x, xy[i].y);
  }
  const head = slice[slice.length - 1];
  const headXY = worldToScreen(head.lat, head.lon, z, view);
  const planeH = resolvePlaneHeadingDeg(points, upto, head, headXY, z, view);
  drawPlaneIcon(buf, headXY.x, headXY.y, planeH);

  drawVintageMapBorder(buf);
  applyPaperSpeckle(buf, frame);
  applyVignette(buf);
  applyFilmGrain(buf, frame);
}

async function main() {
  const outputBase = sanitizeOutputBase(arg("--output-basename", "indy_flight"));
  const FRAMES_DIR = path.join(OUT_DIR, `${outputBase}_frames_tmp`);
  const TILE_DIR = path.join(OUT_DIR, `${outputBase}_tiles_tmp`);
  const mapSource = MAP_SOURCES[MAP_TYPE] || MAP_SOURCES.osm;

  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    console.error("ffmpeg not found.");
    process.exit(1);
  }

  const hexUpper = nToHex(REG);
  const icaoLower = hexUpper.toLowerCase();
  console.error(`N-number ${REG} → ICAO24 ${hexUpper}`);

  let pack = await tryScrapeTrace(icaoLower, FROM, TO);
  if (!pack) {
    const ymdCompact = FROM.replaceAll("-", "");
    pack = loadLocalTrace(icaoLower, ymdCompact);
  }
  if (!pack) {
    console.error("No trace data.");
    process.exit(1);
  }

  const rawPointCount = pack.points.length;
  const cleaned = preprocessRawPoints(pack.points);
  console.error(`Cleaned ${rawPointCount} → ${cleaned.length} points (kinematic + dedupe).`);

  const legPick = selectFlightLeg(cleaned, LEG);
  const points = legPick.points;
  const { legMeta, legIndex, flightsFound } = legPick;
  const usedFullTrace = points.length === cleaned.length;

  if (!points.length) {
    console.error("No points to plot after cleaning/leg selection.");
    process.exit(1);
  }

  let audioMuxPath = null;
  let showMacLeodCredit = false;
  if (AUDIO_PATH) {
    audioMuxPath = path.resolve(AUDIO_PATH.trim());
    if (!fs.existsSync(audioMuxPath)) {
      console.error(`--audio file not found: ${audioMuxPath}`);
      process.exit(1);
    }
  } else if (!process.argv.includes("--no-music")) {
    audioMuxPath = await ensureDefaultAdventureMusic();
    showMacLeodCredit = true;
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }
  const latPad = Math.max((maxLat - minLat) * 0.1, 0.02);
  const lonPad = Math.max((maxLon - minLon) * 0.1, 0.02);
  const bounds = {
    minLat: minLat - latPad,
    maxLat: maxLat + latPad,
    minLon: minLon - lonPad,
    maxLon: maxLon + lonPad,
  };

  const zGuess = Math.max(
    mapSource.minZoom,
    Math.min(pickZoom(bounds.minLat, bounds.maxLat, bounds.minLon, bounds.maxLon), mapSource.maxZoom),
  );
  console.error(`${mapSource.label} zoom (initial) ${zGuess}`);

  const basemapPath = path.join(OUT_DIR, `${outputBase}_basemap.png`);
  const view = await buildBasemapPng(ffmpeg, bounds, zGuess, basemapPath, TILE_DIR, mapSource.key, mapSource);
  const zUsed = view.z;
  const baseRgb = readPngRgbWithFfmpeg(ffmpeg, basemapPath);
  try {
    fs.unlinkSync(basemapPath);
  } catch {
    /* ignore */
  }

  const viewRect = { x0: view.x0, x1: view.x1, y0: view.y0, y1: view.y1 };

  const totalFrames = FPS * DURATION_SEC;
  const buf = Buffer.allocUnsafe(W * H * 3);
  const denom = Math.max(1, totalFrames - 1);

  for (let f = 0; f < totalFrames; f++) {
    const t = f / denom;
    const progress = 0.04 + t * 0.96;
    renderFrame(baseRgb, buf, points, progress, viewRect, zUsed, f);
    const ppmPath = path.join(FRAMES_DIR, `frame_${String(f + 1).padStart(4, "0")}.ppm`);
    const header = Buffer.from(`P6\n${W} ${H}\n255\n`);
    fs.writeFileSync(ppmPath, Buffer.concat([header, Buffer.from(buf)]));
  }

  const rawPath = path.join(OUT_DIR, `${outputBase}_raw.mp4`);
  const outPath = path.join(OUT_DIR, `${outputBase}.mp4`);

  const r1 = spawnSync(
    ffmpeg,
    [
      "-y",
      "-framerate",
      String(FPS),
      "-i",
      path.join(FRAMES_DIR, "frame_%04d.ppm"),
      "-c:v",
      "libx264",
      "-crf",
      String(VIDEO_CRF),
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      rawPath,
    ],
    { stdio: "inherit" },
  );
  if (r1.status !== 0) process.exit(r1.status ?? 1);

  const font = resolveTitleFont();
  const legNote = usedFullTrace
    ? `Full cleaned path · ${points.length} pts`
    : `Leg ${legIndex + 1}/${flightsFound} · ${points.length} pts`;
  const title = `${REG}  |  ${pack.ymd ?? FROM}  |  Mode S ${hexUpper}`;
  const sub = `Map: ${mapSource.label}  ·  Data: ADS-B Exchange globe_history`;
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  const box = "box=1:boxcolor=0x2a1f14@0.78:boxborderw=14";
  const vfParts = [
    `drawtext=fontfile='${font}':text='${esc(title)}':fontcolor=0xf5e6c8:fontsize=38:x=56:y=56:${box}`,
    `drawtext=fontfile='${font}':text='${esc(sub)}':fontcolor=0xe8d9b8:fontsize=21:x=56:y=112:${box}`,
    `drawtext=fontfile='${font}':text='${esc(legNote)}':fontcolor=0xe8d9b8:fontsize=21:x=56:y=152:${box}`,
  ];
  if (showMacLeodCredit) {
    vfParts.push(
      `drawtext=fontfile='${font}':text='${esc("Music: Five Armies — Kevin MacLeod — incompetech.com (CC BY 3.0)")}':fontcolor=0xc9b896:fontsize=12:x=56:y=h-100:${box}`,
    );
  }
  vfParts.push(
    `drawtext=fontfile='${font}':text='${esc(mapSource.copyright)}':fontcolor=0xc9b896:fontsize=15:x=56:y=h-56:${box}`,
    "eq=contrast=1.03:brightness=0.01:saturation=0.96",
  );
  const vf = vfParts.join(",");

  const r2 = spawnSync(
    ffmpeg,
    [
      "-y",
      "-i",
      rawPath,
      "-vf",
      vf,
      "-c:v",
      "libx264",
      "-crf",
      String(VIDEO_CRF),
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outPath,
    ],
    { stdio: "inherit", shell: false },
  );
  if (r2.status !== 0) fs.copyFileSync(rawPath, outPath);

  let audioSourceUsed = null;
  let musicAttribution = null;
  if (audioMuxPath) {
    const muxTmp = path.join(OUT_DIR, `${outputBase}_audio_mux_tmp.mp4`);
    const r3 = spawnSync(
      ffmpeg,
      [
        "-y",
        "-i",
        outPath,
        "-i",
        audioMuxPath,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-shortest",
        "-movflags",
        "+faststart",
        muxTmp,
      ],
      { stdio: "inherit", shell: false },
    );
    if (r3.status !== 0) {
      console.error("Audio mux failed; leaving video-only file.");
      try {
        fs.unlinkSync(muxTmp);
      } catch {
        /* ignore */
      }
    } else {
      fs.unlinkSync(outPath);
      fs.renameSync(muxTmp, outPath);
      audioSourceUsed = audioMuxPath;
      if (showMacLeodCredit) {
        musicAttribution = 'Kevin MacLeod — "Five Armies" — incompetech.com — CC BY 3.0';
      }
    }
  }

  for (const f of fs.readdirSync(FRAMES_DIR)) fs.unlinkSync(path.join(FRAMES_DIR, f));
  fs.rmdirSync(FRAMES_DIR);
  try {
    fs.unlinkSync(rawPath);
  } catch {
    /* ignore */
  }

  const previewHtmlPath = writeVideoPreviewHtml(outPath);
  const fileUrlMp4 = pathToFileURL(outPath).href;
  const fileUrlHtml = pathToFileURL(previewHtmlPath).href;

  const meta = {
    registration: REG,
    icao24: hexUpper,
    map: { provider: mapSource.label, key: mapSource.key, zoom: zUsed, copyright: mapSource.copyright },
    dataSource: pack.source,
    scrapeUrl: pack.url ?? null,
    day: pack.ymd ?? FROM,
    points: { raw: rawPointCount, cleaned: cleaned.length, plotted: points.length },
    leg: {
      index: legIndex,
      legsThatDay: flightsFound,
      startUnix: legMeta?.startTimeUnix ?? null,
      endUnix: legMeta?.endTimeUnix ?? null,
      durationSec: legMeta?.durationSec ?? null,
    },
    outputVideo: outPath,
    /** Paste into Chrome/Edge address bar if chat links are not clickable. */
    outputVideoFileUrl: fileUrlMp4,
    outputVideoPreviewHtml: previewHtmlPath,
    outputVideoPreviewFileUrl: fileUrlHtml,
    audioSource: audioSourceUsed,
    musicAttribution: musicAttribution,
    fps: FPS,
    durationSec: DURATION_SEC,
  };
  fs.writeFileSync(path.join(OUT_DIR, `${outputBase}_meta.json`), JSON.stringify(meta, null, 2));

  console.error(`\nDone → ${outPath}`);
  console.error(`Preview page (double-click or paste in browser):\n  ${fileUrlHtml}`);
  console.error(`Direct file URL (paste in browser address bar):\n  ${fileUrlMp4}`);
  if (OPEN_IN_OS) revealInFileManager(outPath);
  console.error(JSON.stringify(meta, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
