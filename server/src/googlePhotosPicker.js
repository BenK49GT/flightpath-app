/**
 * Google Photos Picker API (photospicker.googleapis.com).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getGoogleAccessToken, isGoogleOAuthConfigured } from "./googleAuth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(__dirname, "..");
const PICKER_BASE = "https://photospicker.googleapis.com/v1";

function sessionResourcePath(sessionId) {
  const id = String(sessionId).replace(/^\/+/, "");
  if (id.startsWith("sessions/")) return `${PICKER_BASE}/${id}`;
  return `${PICKER_BASE}/sessions/${encodeURIComponent(id)}`;
}

function mediaRoot() {
  return path.join(SERVER_ROOT, "data", "media");
}

function sessionDir(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return path.join(mediaRoot(), safe);
}

async function pickerFetch(url, opts = {}) {
  const token = await getGoogleAccessToken();
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 400) };
    }
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || `Picker HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export function isSafeSessionId(id) {
  return typeof id === "string" && /^[A-Za-z0-9._:/-]{4,200}$/.test(id);
}

export async function handleCreatePickerSession() {
  if (!isGoogleOAuthConfigured()) {
    return {
      status: 503,
      body: { error: "NOT_CONFIGURED", message: "Google OAuth is not configured." },
    };
  }
  try {
    const session = await pickerFetch(`${PICKER_BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const sessionId = session.id || session.name;
    let pickerUri = session.pickerUri || session.pickingUri || "";
    if (pickerUri && !pickerUri.endsWith("/autoclose")) {
      pickerUri = `${pickerUri.replace(/\/$/, "")}/autoclose`;
    }
    return {
      status: 200,
      body: {
        sessionId,
        pickerUri,
        expireTime: session.expireTime || null,
      },
    };
  } catch (e) {
    if (e.code === "NOT_CONNECTED" || e.code === "NOT_CONFIGURED") {
      return { status: 401, body: { error: e.code, message: e.message } };
    }
    return { status: e.status === 401 ? 401 : 502, body: { error: "PICKER_ERROR", message: e.message } };
  }
}

export async function handleGetPickerSession(sessionId) {
  if (!isSafeSessionId(sessionId)) {
    return { status: 400, body: { error: "BAD_REQUEST", message: "Invalid session id" } };
  }
  try {
    const session = await pickerFetch(sessionResourcePath(sessionId));
    const mediaItemsSet = Boolean(session.mediaItemsSet);
    return {
      status: 200,
      body: {
        sessionId: session.id || sessionId,
        mediaItemsSet,
        ready: mediaItemsSet,
        expireTime: session.expireTime || null,
      },
    };
  } catch (e) {
    if (e.code === "NOT_CONNECTED" || e.code === "NOT_CONFIGURED") {
      return { status: 401, body: { error: e.code, message: e.message } };
    }
    return { status: e.status === 401 ? 401 : 502, body: { error: "PICKER_ERROR", message: e.message } };
  }
}

export async function listPickedMediaItems(sessionId) {
  const items = [];
  let pageToken = "";
  for (let i = 0; i < 40; i++) {
    const u = new URL(`${PICKER_BASE}/mediaItems`);
    u.searchParams.set("sessionId", sessionId);
    u.searchParams.set("pageSize", "100");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const data = await pickerFetch(u.toString());
    const page = Array.isArray(data.mediaItems) ? data.mediaItems : [];
    items.push(...page);
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  return items;
}

export async function handleListPickerItems(sessionId) {
  if (!isSafeSessionId(sessionId)) {
    return { status: 400, body: { error: "BAD_REQUEST", message: "Invalid session id" } };
  }
  try {
    const items = await listPickedMediaItems(sessionId);
    return {
      status: 200,
      body: {
        sessionId,
        count: items.length,
        items: items.map(summarizePickedItem),
      },
    };
  } catch (e) {
    if (e.code === "NOT_CONNECTED" || e.code === "NOT_CONFIGURED") {
      return { status: 401, body: { error: e.code, message: e.message } };
    }
    return { status: e.status === 401 ? 401 : 502, body: { error: "PICKER_ERROR", message: e.message } };
  }
}

export function summarizePickedItem(item) {
  const file = item.mediaFile || {};
  const type = String(item.type || file.mimeType || "PHOTO").toUpperCase();
  const isVideo = type.includes("VIDEO") || String(file.mimeType || "").startsWith("video/");
  const createTime = item.createTime || item.mediaMetadata?.creationTime || null;
  return {
    id: item.id,
    type: isVideo ? "video" : "photo",
    createTime,
    createTimeUnix: createTimeUnix(createTime),
    filename: file.filename || item.id,
    mimeType: file.mimeType || null,
    width: file.mediaFileMetadata?.width ?? null,
    height: file.mediaFileMetadata?.height ?? null,
  };
}

export function createTimeUnix(createTime) {
  if (!createTime) return null;
  const ms = Date.parse(createTime);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function extForItem(item, isVideo) {
  const name = item.mediaFile?.filename || "";
  const m = /\.([A-Za-z0-9]{2,5})$/.exec(name);
  if (m) return `.${m[1].toLowerCase()}`;
  return isVideo ? ".mp4" : ".jpg";
}

export async function downloadPickedMedia(sessionId, destDir) {
  const items = await listPickedMediaItems(sessionId);
  fs.mkdirSync(destDir, { recursive: true });
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const sum = summarizePickedItem(item);
    const baseUrl = item.mediaFile?.baseUrl;
    if (!baseUrl) continue;
    const url = sum.type === "video" ? `${baseUrl}=dv` : `${baseUrl}=w1600-h1600`;
    const token = await getGoogleAccessToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.error(`Media download failed ${sum.id}: HTTP ${res.status}`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = extForItem(item, sum.type === "video");
    const dest = path.join(destDir, `${String(i + 1).padStart(3, "0")}_${(sum.filename || "item").replace(/[^\w.-]+/g, "_").slice(0, 80)}${ext}`);
    fs.writeFileSync(dest, buf);
    out.push({
      ...sum,
      path: dest,
    });
  }
  return out;
}

export function getSessionMediaDir(sessionId) {
  return sessionDir(sessionId);
}
