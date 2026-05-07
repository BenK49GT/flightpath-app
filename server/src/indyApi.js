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
let runningJobId = null;

const MAX_DAYS_BACK = Number(process.env.INDY_GLOBE_DAYS_BACK || 120);
const GLOBE_DELAY_MS = Number(process.env.INDY_GLOBE_DELAY_MS || 110);

function jobVideoPath(jobId) {
  const base = `indy_web_${jobId}`;
  return path.join(SERVER_ROOT, "output", `${base}.mp4`);
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
      366,
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
    const leg = (body?.leg || "longest").toLowerCase();

    if (!reg || !date) {
      return {
        status: 400,
        body: { error: "BAD_REQUEST", message: "JSON body must include `reg` and `date` (YYYY-MM-DD)" },
      };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return {
        status: 400,
        body: { error: "BAD_REQUEST", message: "`date` must be YYYY-MM-DD" },
      };
    }

    const registration = normalizeReg(String(reg));
    const ac = lookupAircraft(registration);

    if (runningJobId) {
      return {
        status: 429,
        body: {
          error: "RENDER_BUSY",
          message: "Another video is rendering; try again shortly.",
          activeJobId: runningJobId,
        },
      };
    }

    const jobId = crypto.randomUUID();
    const outputBase = `indy_web_${jobId}`;
    jobs.set(jobId, {
      status: "running",
      registration: ac.registration,
      date: String(date),
      leg,
      error: null,
      outputBase,
      createdAt: Date.now(),
    });
    runningJobId = jobId;

    const scriptPath = path.join(SERVER_ROOT, "scripts", "render-indy-video.mjs");
    const child = spawn(
      process.execPath,
      [
        scriptPath,
        "--reg",
        ac.registration,
        "--from",
        String(date),
        "--to",
        String(date),
        "--leg",
        leg,
        "--output-basename",
        outputBase,
      ],
      {
        cwd: SERVER_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      },
    );

    let errBuf = "";
    child.stderr?.on("data", (chunk) => {
      errBuf += chunk.toString();
      if (errBuf.length > 12000) errBuf = errBuf.slice(-12000);
    });

    child.on("error", (err) => {
      runningJobId = null;
      const j = jobs.get(jobId);
      if (j) {
        j.status = "error";
        j.error = err.message || String(err);
      }
    });

    child.on("close", (code) => {
      runningJobId = null;
      const j = jobs.get(jobId);
      if (!j) return;
      if (code === 0 && fs.existsSync(jobVideoPath(jobId))) {
        j.status = "done";
        j.videoUrl = `/api/indy/video/${jobId}`;
      } else {
        j.status = "error";
        j.error = errBuf.trim().slice(-4000) || `Renderer exited with code ${code}`;
      }
    });

    return {
      status: 202,
      body: {
        jobId,
        status: "running",
        pollUrl: `/api/indy/jobs/${jobId}`,
        message: "Rendering video (typically 30–90s). Poll until status is done.",
      },
    };
  } catch (e) {
    runningJobId = null;
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
    videoUrl: j.status === "done" ? `/api/indy/video/${jobId}` : null,
  };
  if (j.error) body.error = j.error;
  return { status: 200, body };
}
