/**
 * Zero-dependency HTTP server (Node built-ins only).
 * Use when `npm install` has not been run (no express/cors).
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  handleFlights,
  handleHealth,
  handleSummary,
  handleTrack,
} from "./apiHandlers.js";
import {
  getIndyVideoAbsolutePath,
  handleIndyDates,
  handleIndyJob,
  handleIndyRender,
} from "./indyApi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "../public");

const PORT = Number(process.env.PORT || 8787);

const JSON_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

function parseQuery(search) {
  const q = new URLSearchParams(search || "");
  const out = {};
  for (const [k, v] of q) out[k] = v;
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** @param {http.IncomingMessage} req */
function route(req) {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `http://${host}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const query = parseQuery(url.search);

  if (req.method === "OPTIONS") {
    return { kind: "options" };
  }

  if (req.method === "GET" && pathname === "/") {
    return { kind: "redirect", location: "/indy" };
  }

  if (req.method === "GET" && pathname === "/health") {
    return { kind: "handler", fn: () => handleHealth() };
  }

  if (req.method === "GET" && pathname === "/indy") {
    return { kind: "static", filePath: path.join(PUBLIC_DIR, "indy.html"), contentType: "text/html; charset=utf-8" };
  }

  if (req.method === "GET" && pathname === "/api/indy/dates") {
    return {
      kind: "handler",
      fn: () => handleIndyDates(query.reg, query),
    };
  }

  if (req.method === "POST" && pathname === "/api/indy/render") {
    return { kind: "indy_render" };
  }

  const mJob = /^\/api\/indy\/jobs\/([^/]+)$/.exec(pathname);
  if (req.method === "GET" && mJob) {
    return { kind: "handler", fn: () => handleIndyJob(mJob[1]) };
  }

  const mVid = /^\/api\/indy\/video\/([^/]+)$/.exec(pathname);
  if (req.method === "GET" && mVid) {
    return { kind: "indy_video", jobId: mVid[1] };
  }

  const mSummary = /^\/api\/aircraft\/([^/]+)\/summary$/.exec(pathname);
  if (req.method === "GET" && mSummary) {
    return {
      kind: "handler",
      fn: () => handleSummary(mSummary[1], query.from, query.to),
    };
  }

  const mFlights = /^\/api\/aircraft\/([^/]+)\/flights$/.exec(pathname);
  if (req.method === "GET" && mFlights) {
    return {
      kind: "handler",
      fn: () => handleFlights(mFlights[1], query.from, query.to),
    };
  }

  const mTrack = /^\/api\/aircraft\/([^/]+)\/flights\/([^/]+)\/track$/.exec(pathname);
  if (req.method === "GET" && mTrack) {
    return {
      kind: "handler",
      fn: () =>
        handleTrack(mTrack[1], mTrack[2], query.from, query.to, query.maxPoints, query.epsilonDeg),
    };
  }

  return { kind: "notfound" };
}

export function start() {
  const server = http.createServer(async (req, res) => {
    const match = route(req);

    if (match.kind === "options") {
      res.writeHead(204, JSON_CORS);
      res.end();
      return;
    }

    if (match.kind === "notfound") {
      res.writeHead(404, JSON_CORS);
      res.end(JSON.stringify({ error: "NOT_FOUND", message: "No route" }));
      return;
    }

    if (match.kind === "redirect") {
      res.writeHead(302, {
        Location: match.location,
        "Access-Control-Allow-Origin": "*",
      });
      res.end();
      return;
    }

    if (match.kind === "static") {
      try {
        const buf = fs.readFileSync(match.filePath);
        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": match.contentType,
          "Cache-Control": "no-cache",
        });
        res.end(buf);
      } catch {
        res.writeHead(404, JSON_CORS);
        res.end(JSON.stringify({ error: "NOT_FOUND" }));
      }
      return;
    }

    if (match.kind === "indy_video") {
      const filePath = getIndyVideoAbsolutePath(match.jobId);
      if (!filePath) {
        res.writeHead(404, JSON_CORS);
        res.end(JSON.stringify({ error: "NOT_FOUND", message: "Video not ready" }));
        return;
      }
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "video/mp4",
        "Cache-Control": "no-store, no-cache, must-revalidate, private",
        Pragma: "no-cache",
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (match.kind === "indy_render") {
      try {
        const raw = await readBody(req);
        let body = {};
        try {
          body = JSON.parse(raw.length ? raw.toString("utf8") : "{}");
        } catch {
          res.writeHead(400, JSON_CORS);
          res.end(JSON.stringify({ error: "BAD_REQUEST", message: "Invalid JSON" }));
          return;
        }
        const { status, body: out } = await handleIndyRender(body);
        res.writeHead(status, JSON_CORS);
        res.end(JSON.stringify(out));
      } catch (e) {
        console.error(e);
        res.writeHead(500, JSON_CORS);
        res.end(JSON.stringify({ error: "INTERNAL", message: "Unexpected server error" }));
      }
      return;
    }

    try {
      const { status, body } = await match.fn();
      const pathnameOnly = new URL(req.url || "/", "http://localhost").pathname;
      const headers =
        pathnameOnly === "/api/indy/dates"
          ? {
              ...JSON_CORS,
              "Cache-Control": "no-store, no-cache, must-revalidate, private",
              Pragma: "no-cache",
            }
          : JSON_CORS;
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    } catch (e) {
      console.error(e);
      res.writeHead(500, JSON_CORS);
      res.end(JSON.stringify({ error: "INTERNAL", message: "Unexpected server error" }));
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.error(
      `flightpath-api (builtin http) listening on http://0.0.0.0:${PORT} — install deps for Express if you prefer`,
    );
    console.error(`Indy web UI: http://0.0.0.0:${PORT}/indy`);
  });

  return server;
}
