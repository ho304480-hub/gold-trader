# حەمزە گۆڵد — Hamza Gold Terminal

Live gold (XAU/USD) trading terminal: Express + Socket.IO backend, a
LightweightCharts v5 dashboard, and a Python collector layer feeding
TimescaleDB.

## Entry point

The dashboard is **`public/hamza.html`**.

`public/index.html` is a thin redirect shim so that `/` (and any static host
that looks for `index.html`) lands on `hamza.html`. `server.js` serves the
whole `public/` directory via `express.static`, so both of these work:

- `http://localhost:3000/` → redirects to `hamza.html`
- `http://localhost:3000/hamza.html` → the dashboard

Both files carry the Google Search Console verification meta tag
(`google-site-verification`) in their `<head>`, so site verification succeeds
whether the crawler lands on `/` or on `/hamza.html`.

## Run locally

```bash
npm install
cp .env.example .env      # then fill in real values
npm start                 # http://localhost:3000
```

The database is optional for a UI-only run — `server.js` falls back to
simulated candles when no Postgres connection is available.

To bring up the full stack:

```bash
docker compose up -d      # TimescaleDB on :5432
npm run migrate           # create schema
npm start
```

## Deploy

### Render (full app — recommended)

`render.yaml` is a Render Blueprint. Push to GitHub, then in Render:
**New + → Blueprint → select this repo**. Render provisions the web service
from the blueprint. Set secrets (`JWT_SECRET`, `DB_*`, `FRED_API_KEY`) in the
Render dashboard — never in the repo.

### GitHub Pages (static UI only)

GitHub Pages serves static files only. It cannot run `server.js`, so the
Socket.IO stream and `/api/*` routes will not work there. To publish just the
dashboard:

1. Repo → **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: `main`, folder: `/public`
4. Save — the site appears at `https://<user>.github.io/<repo>/`

Because `index.html` redirects to `hamza.html`, the Pages root lands on the
dashboard. The chart will render, but live data requires the Render deployment.

## Layout

| Path | Purpose |
|---|---|
| `server.js` | Express + Socket.IO server, API routes, static hosting |
| `public/hamza.html` | Main dashboard (RTL Kurdish UI) |
| `public/index.html` | Redirect shim → `hamza.html` |
| `public/signals.js` | Multi-timeframe BUY/SELL/HOLD signal engine |
| `collectors/` | Python data collectors (Yahoo, FRED, gold-api) |
| `sql/`, `migrate.js` | Schema and migration runner |
| `docker-compose.yml` | TimescaleDB service |
| `render.yaml` | Render Blueprint |
