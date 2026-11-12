# Google Photos slideshow (local trial)

Indy can overlay photos/videos you pick from Google Photos onto the map video, timed to the flight using each item’s **capture time** (`createTime`). Google’s APIs do **not** expose GPS for picked media.

This is **local-only** (`http://127.0.0.1:8787/indy`). Hosted Render is not wired for OAuth.

## 1. Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create (or pick) a project.
2. **APIs & Services → Library**: enable **Google Photos Picker API** (`photospicker.googleapis.com`).
3. **APIs & Services → OAuth consent screen**
   - User type: **External**
   - Publishing status: **Testing**
   - Add your Google account under **Test users**
   - App name can be `Flightpath Indy (local)`
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URI: `http://127.0.0.1:8787/api/auth/google/callback`
5. Copy the **Client ID** and **Client secret**.

## 2. Local env

```powershell
cd C:\Users\benku\projects\flightpath-app\server
copy .env.example .env
```

Edit `server/.env`:

```
GOOGLE_CLIENT_ID=...your client id...
GOOGLE_CLIENT_SECRET=...your client secret...
GOOGLE_OAUTH_REDIRECT_URI=http://127.0.0.1:8787/api/auth/google/callback
OAUTH_TOKEN_PATH=./data/oauth-tokens.json
```

Install deps and start:

```powershell
cd C:\Users\benku\projects\flightpath-app\server
npm.cmd install
npm.cmd start
```

Open [http://127.0.0.1:8787/indy](http://127.0.0.1:8787/indy).

## 3. In the UI

1. Enter an N-number and **Find flight dates**.
2. Select one or more days.
3. **Connect Google Photos** (approve the Picker scope). You must be a **test user** on the consent screen.
4. **Add photos from Google Photos** — Google’s picker opens; select items, then Done.
5. Leave **Only include media during selected flight time** checked (recommended).
6. **Generate video**. Overlays appear as a slideshow card when the animated path reaches that capture time.

## Scopes requested

- `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`
- `openid` + `email` (shown as “connected as …” only)

Tokens are stored in `server/data/oauth-tokens.json` (gitignored). Use **Disconnect** to delete them.

## Limits

- You must pick items in Google’s UI; the API cannot bulk-list your whole library by date.
- Correlation is **time**, not GPS.
- Video clips use a still (first frame) for this trial.
