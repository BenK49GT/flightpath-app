import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lookupAircraft, normalizeReg } from "./lib/regLookup.js";
import { listGlobeDatesWithData } from "./lib/globeHistory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(__dirname, "..");

const jobs = new Map();
const pendingJobIds = [];
let activeJobId = null;

const MAX_DAYS_BACK = Number(process.env.INDY_GLOBE_DAYS_BACK || 120);
const GLOBE_DELAY_MS = Number(process.env.INDY_GLOBE_DELAY_MS || 110);
const MAX_PENDING_JOBS = Number(process.env.INDY_MAX_PENDING_JOBS || 25);
const FREE_MAX_RESOLUTION_HEIGHT = 720;
const RESOLUTIONS = {
  "480p": { width: 854, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
};

function jobVideoPath(jobId) {
  const base = `indy_web_${jobId}`;
  return path.join(SERVER_ROOT, "output", `${base}.mp4`);
}

function launchRenderJob(jobId) {
  const j = jobs.get(jobId);
  if (!j) return;

  activeJobId = jobId;
  j.status = "running";
  j.startedAt = Date.now();
  j.error = null;

  const scriptPath = path.join(SERVER_ROOT, "scripts", "render-indy-video.mjs");
  const child = spawn(
    process.execPath,
    [
      scriptPath,
      "--reg",
      j.registration,
      ...(Array.isArray(j.dates) && j.dates.length
        ? ["--dates", j.dates.join(",")]
        : ["--from", String(j.date), "--to", String(j.date)]),
      "--leg",
      j.leg,
      "--output-basename",
      j.outputBase,
      "--map-type",
      j.mapType,
      "--resolution",
      j.resolution,
      "--duration-sec",
      String(j.durationSec || 14),
      ...(j.multiFlight ? ["--cinematic-zoom-out"] : []),
    ],
    {
      cwd: SERVER_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    },
  );
  j.pid = child.pid ?? null;

  let errBuf = "";
  child.stderr?.on("data", (chunk) => {
    errBuf += chunk.toString();
    if (errBuf.length > 12000) errBuf = errBuf.slice(-12000);
  });

  child.on("error", (err) => {
    const cur = jobs.get(jobId);
    if (cur) {
      cur.status = "error";
      cur.finishedAt = Date.now();
      cur.error = err.message || String(err);
    }
    if (activeJobId === jobId) activeJobId = null;
    processQueue();
  });

  child.on("close", (code) => {
    const cur = jobs.get(jobId);
    if (cur) {
      cur.finishedAt = Date.now();
      if (code === 0 && fs.existsSync(jobVideoPath(jobId))) {
        cur.status = "done";
        cur.videoUrl = `/api/indy/video/${jobId}`;
      } else {
        cur.status = "error";
        cur.error = errBuf.trim().slice(-4000) || `Renderer exited with code ${code}`;
      }
    }
    if (activeJobId === jobId) activeJobId = null;
    processQueue();
  });
}

function processQueue() {
  if (activeJobId) return;
  while (pendingJobIds.length) {
    const nextJobId = pendingJobIds.shift();
    const nextJob = jobs.get(nextJobId);
    if (!nextJob || nextJob.status !== "queued") continue;
    launchRenderJob(nextJobId);
    return;
  }
}

export function getIndyVideoAbsolutePath(jobId) {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;
  const p = jobVideoPath(jobId);
  return fs.existsSync(p) ? p : null;
}

export async function handleIndyDates(reg, query) {
  try {
    if (!reg) {
      return {
        status: 400,
        body: { error: "BAD_REQUEST", message: "Query param `reg` (N-number) is required" },
      };
    }
    const registration = normalizeReg(String(reg));
    const ac = lookupAircraft(registration);
    const daysBack = Math.min(
      Math.max(Number(query.daysBack) || MAX_DAYS_BACK, 1),
      3650,
    );
    const delayMs = Math.min(Math.max(Number(query.delayMs) || GLOBE_DELAY_MS, 40), 800);

    const dates = await listGlobeDatesWithData(ac.icao24, daysBack, delayMs);
    return {
      status: 200,
      body: {
        registration: ac.registration,
        icao24: ac.icao24,
        daysScanned: daysBack,
        dates,
        source: "globe.adsbexchange.com",
      },
    };
  } catch (e) {
    if (e.code === "INVALID_REGISTRATION") {
      return { status: 400, body: { error: e.code, message: e.message } };
    }
    console.error(e);
    return { status: 500, body: { error: "INTERNAL", message: "Unexpected server error" } };
  }
}

export async function handleIndyRender(body) {
  try {
    const reg = body?.reg ?? body?.registration;
    const date = body?.date;
    const datesRaw = Array.isArray(body?.dates) ? body.dates : null;
    const leg = (body?.leg || "longest").toLowerCase();
    const mapType = String(body?.mapType || "osm").toLowerCase();
    const resolution = String(body?.resolution || "480p").toLowerCase();
    if (!["osm", "vfr", "ifr"].includes(mapType)) {
      return {
        status: 400,
        body: { error: "BAD_REQUEST", message: "`mapType` must be one of: osm, vfr, ifr" },
      };
    }
    const resDef = RESOLUTIONS[resolution];
    if (!resDef) {
      return {
        status: 400,
        body: { error: "BAD_REQUEST", message: "`resolution` must be one of: 480p, 720p, 1080p, 1440p" },
      };
    }
    if (resDef.height > FREE_MAX_RESOLUTION_HEIGHT) {
      return {
        status: 402,
        body: {
          error: "PLAN_LIMIT",
          message: "Higher-than-720p rendering is reserved for a future paid tier.",
          maxAllowedResolution: "720p",
        },
      };
    }

    if (!reg || (!date && !(datesRaw && datesRaw.length))) {
      return {
        status: 400,
        body: {
          error: "BAD_REQUEST",
          message: "JSON body must include `reg` and either `date` (YYYY-MM-DD) or `dates` (array)",
        },
      };
    }
    const dates =
      datesRaw && datesRaw.length
        ? datesRaw.map((d) => String(d)).filter(Boolean)
        : [String(date)];
    if (!dates.length || dates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
      return {
        status: 400,
        body: { error: "BAD_REQUEST", message: "`date`/`dates` values must be YYYY-MM-DD" },
      };
    }
    const uniqueDates = Array.from(new Set(dates)).sort((a, b) => a.localeCompare(b));
    const multiFlight = uniqueDates.length > 1;
    const durationSec = multiFlight ? 20 : 14;

    const registration = normalizeReg(String(reg));
    const ac = lookupAircraft(registration);

    if (pendingJobIds.length >= MAX_PENDING_JOBS) {
      return {
        status: 429,
        body: {
          error: "QUEUE_FULL",
          message: "Render queue is full. Try again shortly.",
          maxPendingJobs: MAX_PENDING_JOBS,
        },
      };
    }

    const jobId = crypto.randomUUID();
    const outputBase = `indy_web_${jobId}`;
    jobs.set(jobId, {
      status: "queued",
      registration: ac.registration,
      date: String(uniqueDates[0]),
      dates: uniqueDates,
      multiFlight,
      durationSec,
      leg,
      mapType,
      resolution,
      error: null,
      outputBase,
      createdAt: Date.now(),
    });
    pendingJobIds.push(jobId);
    processQueue();

    const created = jobs.get(jobId);
    const responseBody = {
      jobId,
      status: created?.status || "queued",
      resolution,
      dates: uniqueDates,
      durationSec,
      pollUrl: `/api/indy/jobs/${jobId}`,
      message: "Render accepted. Poll until status is done.",
    };
    if (responseBody.status === "queued") {
      responseBody.queuePosition = Math.max(0, pendingJobIds.indexOf(jobId)) + 1;
    }

    return {
      status: 202,
      body: responseBody,
    };
  } catch (e) {
    if (e.code === "INVALID_REGISTRATION") {
      return { status: 400, body: { error: e.code, message: e.message } };
    }
    console.error(e);
    return { status: 500, body: { error: "INTERNAL", message: "Unexpected server error" } };
  }
}

export async function handleIndyJob(jobId) {
  if (!jobId || !/^[0-9a-f-]{36}$/i.test(jobId)) {
    return { status: 400, body: { error: "BAD_REQUEST", message: "Invalid job id" } };
  }
  const j = jobs.get(jobId);
  if (!j) {
    return { status: 404, body: { error: "NOT_FOUND", message: "Unknown job" } };
  }
  const body = {
    jobId,
    status: j.status,
    registration: j.registration,
    date: j.date,
    dates: Array.isArray(j.dates) ? j.dates : [j.date],
    videoUrl: j.status === "done" ? `/api/indy/video/${jobId}` : null,
    mapType: j.mapType,
    resolution: j.resolution,
    activeJobId,
    pendingJobs: pendingJobIds.length,
  };
  if (j.status === "queued") body.queuePosition = Math.max(0, pendingJobIds.indexOf(jobId)) + 1;
  if (j.error) body.error = j.error;
  return { status: 200, body };
}
