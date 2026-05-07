# Flightpath (concept)

Mobile-first concept: enter a U.S. **N-number** and **date range**, load flights from your backend, tap a leg to draw the **track on a map**.

## Repo layout

| Path | Purpose |
|------|---------|
| `server/` | Express API: local N→ICAO mapping, trace files, segmentation, track simplification |
| `mobile/` | Expo Router app: date pickers, flight list, map screen, offline cache |
| `packages/shared/schemas/` | JSON Schemas documenting API shapes |

## Prerequisites

- **Node.js** (v18+ recommended)
- **npm** (for installing Express + Expo; optional for a quick API-only demo — see below)
- For the phone: **Expo Go** app, or an emulator

## One-shot setup (recommended)

From the repo root, with `node` and `npm` on your PATH:

```powershell
cd C:\Users\benku\projects\flightpath-app
.\setup.ps1
```

## 1. Backend

```powershell
cd C:\Users\benku\projects\flightpath-app\server
npm install
npm run seed-demo
npm start
```

If you **have not** run `npm install`, `npm start` still works: it serves the same API using **Node’s built-in `http` module** (no Express). After `npm install`, it prefers **Express** automatically.

The API listens on **`0.0.0.0:8787`** so other devices on your LAN can reach it.

Demo trace: **`N49GT`**, dates **`2026-04-24`** (one synthetic leg Sky Acres → Oxford area). After `seed-demo`, data lives at `server/data/traces/20260424_a60e67.json` (you can keep that file in git if you want clone-and-run without re-seeding).

Smoke test in a browser:

- `http://127.0.0.1:8787/health`
- `http://127.0.0.1:8787/api/aircraft/N49GT/flights?from=2026-04-24&to=2026-04-24`

## 2. Mobile (Expo)

```powershell
cd C:\Users\benku\projects\flightpath-app\mobile
npm install
npx expo install
npx expo start
```

### API URL

- **Same machine / iOS Simulator:** default `http://127.0.0.1:8787` is fine.
- **Android emulator:** defaults to `http://10.0.2.2:8787` when `EXPO_PUBLIC_API_BASE` is unset (see `mobile/lib/apiBase.js`).
- **Physical phone:** set your PC’s LAN IP, e.g.

```powershell
$env:EXPO_PUBLIC_API_BASE = "http://192.168.1.50:8787"
npx expo start
```

Ensure Windows Firewall allows inbound **8787** on private networks.

### Flow

1. Confirm **API base** in the first field (adjust for phone/emulator).
2. Set **From / To** with the calendar controls (or use **Cached** to load the last saved list for that range).
3. **Load flights** for `N49GT` / `2026-04-24` after seeding.
4. Tap a flight card → full-screen **Track** with a red polyline (track is **cached** for offline replay when the API is unreachable).

### Automated trace fetch (server)

Tries the public `globe_history/.../trace_full|trace_recent` URL pattern per day (subject to provider availability and your compliance with their terms):

```powershell
cd C:\Users\benku\projects\flightpath-app\server
npm run fetch-traces -- --reg N49GT --from 2026-04-20 --to 2026-04-26 --delay-ms 750
```

Or `--icao a60e67` instead of `--reg`. Outputs normalized files under `data/traces/`.

## Real data (later)

Replace demo traces with your own normalized JSON under `server/data/traces/` (`YYYYMMDD_<icao24>.json`), or use:

```powershell
node scripts/ingest-trace.mjs --icao a60e67 --day 2026-04-24 --file path\to\trace.json
```

## License / data

You are responsible for **terms and attribution** of any ADS-B archives you ingest. The N-number→ICAO mapping in `server/src/lib/nnumberLocal.js` is a local deterministic FAA allocation model for U.S. registrations.
