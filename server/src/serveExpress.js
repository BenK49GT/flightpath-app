import cors from "cors";
import express from "express";
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
import { getAirportCatalogStats } from "./lib/nearestAirport.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "../public");

const PORT = Number(process.env.PORT || 8787);

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: true }));
app.use(express.json({ limit: "400kb" }));

app.get("/", (_req, res) => {
  res.redirect(302, "/indy");
});

app.get("/health", async (_req, res) => {
  const { status, body } = await handleHealth();
  res.status(status).json(body);
});

app.get("/api/aircraft/:reg/summary", async (req, res) => {
  const { status, body } = await handleSummary(req.params.reg, req.query.from, req.query.to);
  res.status(status).json(body);
});

app.get("/api/aircraft/:reg/flights", async (req, res) => {
  const { status, body } = await handleFlights(req.params.reg, req.query.from, req.query.to);
  res.status(status).json(body);
});

app.get("/api/aircraft/:reg/flights/:flightId/track", async (req, res) => {
  const { status, body } = await handleTrack(
    req.params.reg,
    req.params.flightId,
    req.query.from,
    req.query.to,
    req.query.maxPoints,
    req.query.epsilonDeg,
  );
  res.status(status).json(body);
});

app.get("/indy", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "indy.html"));
});

app.get("/api/indy/dates", async (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  const { status, body } = await handleIndyDates(req.query.reg, req.query);
  res.status(status).json(body);
});

app.post("/api/indy/render", async (req, res) => {
  const { status, body } = await handleIndyRender(req.body || {});
  res.status(status).json(body);
});

app.get("/api/indy/jobs/:jobId", async (req, res) => {
  const { status, body } = await handleIndyJob(req.params.jobId);
  res.status(status).json(body);
});

app.get("/api/indy/video/:jobId", (req, res) => {
  const filePath = getIndyVideoAbsolutePath(req.params.jobId);
  if (!filePath) {
    res.status(404).json({ error: "NOT_FOUND", message: "Video not ready or unknown job" });
    return;
  }
  res.type("mp4");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.sendFile(filePath);
});

app.listen(PORT, "0.0.0.0", () => {
  const cat = getAirportCatalogStats();
  console.error(`flightpath-api (express) listening on http://0.0.0.0:${PORT}`);
  console.error(`Indy web UI: http://0.0.0.0:${PORT}/indy`);
  console.error(
    `[flightpath] US airport catalog: ${cat.count} rows (scheduledService field: ${cat.hasScheduledServiceField})`,
  );
  if (cat.count < 3000) {
    console.error("[flightpath] WARN: airport catalog looks tiny — Indy airport detection may be wrong.");
  }
});
