/**
 * Google OAuth for Photos Picker (local single-user trial).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OAuth2Client } from "google-auth-library";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(__dirname, "..");

const PICKER_SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
const SCOPES = [PICKER_SCOPE, "openid", "https://www.googleapis.com/auth/userinfo.email"];

const pendingStates = new Map();

function tokenPath() {
  const rel = process.env.OAUTH_TOKEN_PATH || "./data/oauth-tokens.json";
  return path.isAbsolute(rel) ? rel : path.join(SERVER_ROOT, rel);
}

export function isGoogleOAuthConfigured() {
  return Boolean(String(process.env.GOOGLE_CLIENT_ID || "").trim() && String(process.env.GOOGLE_CLIENT_SECRET || "").trim());
}

export function googleRedirectUri() {
  return (
    process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1:8787/api/auth/google/callback"
  );
}

function createOAuthClient() {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri(),
  );
}

function readTokenFile() {
  const p = tokenPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeTokenFile(data) {
  const p = tokenPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

export function handleGoogleAuthStatus() {
  if (!isGoogleOAuthConfigured()) {
    return {
      status: 200,
      body: {
        connected: false,
        configured: false,
        message: "Google OAuth is not configured. See server/GOOGLE_PHOTOS.md",
      },
    };
  }
  const stored = readTokenFile();
  const connected = Boolean(stored?.refresh_token || stored?.access_token);
  return {
    status: 200,
    body: {
      connected,
      configured: true,
      email: stored?.email || null,
    },
  };
}

export function handleGoogleAuthStart() {
  if (!isGoogleOAuthConfigured()) {
    return {
      status: 503,
      body: {
        error: "NOT_CONFIGURED",
        message: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env (see GOOGLE_PHOTOS.md).",
      },
    };
  }
  const state = crypto.randomUUID();
  pendingStates.set(state, Date.now());
  for (const [k, t0] of pendingStates) {
    if (Date.now() - t0 > 15 * 60 * 1000) pendingStates.delete(k);
  }
  const client = createOAuthClient();
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
  return { status: 302, redirect: url };
}

export async function handleGoogleAuthCallback(query) {
  const err = query?.error;
  if (err) {
    return { status: 302, redirect: `/indy?connected=0&error=${encodeURIComponent(String(err))}` };
  }
  const code = query?.code;
  const state = query?.state;
  if (!code || !state || !pendingStates.has(String(state))) {
    return { status: 302, redirect: "/indy?connected=0&error=invalid_oauth_state" };
  }
  pendingStates.delete(String(state));
  try {
    const client = createOAuthClient();
    const { tokens } = await client.getToken(String(code));
    client.setCredentials(tokens);
    let email = null;
    try {
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      email = ticket.getPayload()?.email || null;
    } catch {
      /* email optional */
    }
    const prev = readTokenFile() || {};
    writeTokenFile({
      ...prev,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || prev.refresh_token || null,
      expiry_date: tokens.expiry_date || null,
      id_token: tokens.id_token || null,
      email,
      scope: tokens.scope || SCOPES.join(" "),
      updatedAt: Date.now(),
    });
    return { status: 302, redirect: "/indy?connected=1" };
  } catch (e) {
    console.error(e);
    return {
      status: 302,
      redirect: `/indy?connected=0&error=${encodeURIComponent(e.message || "oauth_failed")}`,
    };
  }
}

export function handleGoogleAuthDisconnect() {
  const p = tokenPath();
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
  return { status: 200, body: { connected: false, configured: isGoogleOAuthConfigured() } };
}

export async function getGoogleAccessToken() {
  if (!isGoogleOAuthConfigured()) {
    const err = new Error("Google OAuth is not configured");
    err.code = "NOT_CONFIGURED";
    throw err;
  }
  const stored = readTokenFile();
  if (!stored?.access_token && !stored?.refresh_token) {
    const err = new Error("Google Photos is not connected");
    err.code = "NOT_CONNECTED";
    throw err;
  }
  const client = createOAuthClient();
  client.setCredentials({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token,
    expiry_date: stored.expiry_date,
  });
  const { token } = await client.getAccessToken();
  if (!token) {
    const err = new Error("Could not refresh Google access token. Reconnect Google Photos.");
    err.code = "NOT_CONNECTED";
    throw err;
  }
  const creds = client.credentials;
  writeTokenFile({
    ...stored,
    access_token: creds.access_token || token,
    refresh_token: creds.refresh_token || stored.refresh_token,
    expiry_date: creds.expiry_date || stored.expiry_date,
    updatedAt: Date.now(),
  });
  return token;
}
