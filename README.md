# A-Band Consulting — Finance Hub ☁️

A full-stack cloud finance management application for consulting businesses. Multi-year invoicing, P&L statements, expense tracking, and PDF invoice generation — all backed by a SQLite database.

## Features

- **Multi-Year Database** — Create, switch, duplicate fiscal years. Each year's data stored independently
- **Unlimited Clients** — Add as many clients as needed with default rates
- **Invoice Ledger** — Rate/hr × Hours/Day × Days. Unlimited invoices per month per client
- **Auto Revenue Flow** — Mark invoice "Paid" → automatically appears in P&L Actual Revenue
- **P&L Statement** — Combined revenue + expenses + net profit. Export to Excel
- **Expense Analysis** — Monthly, weekly average, and annual views with charts
- **Invoice PDF** — Professional invoice preview with browser print/save-as-PDF
- **Cloud Backup** — Download full database as JSON backup. Export all years to Excel
- **SQLite Database** — Persistent, reliable storage that survives restarts

---

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. Open browser
open http://localhost:3000
```

---

## Deploy to Cloud

### Option 1: Railway (Recommended — Easiest)

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app)
3. Click **"New Project"** → **"Deploy from GitHub repo"**
4. Select your repo
5. Railway auto-detects the Dockerfile and deploys
6. Add a **Volume** mounted at `/app/data` for persistent storage
7. Your app is live at `https://your-app.up.railway.app`

> **Important:** Add a volume in Railway dashboard → your service → Settings → Volumes → Mount at `/app/data`

### Option 2: Render

1. Push to GitHub
2. Go to [render.com](https://render.com)
3. Click **"New"** → **"Web Service"**
4. Connect your repo
5. Render will use the included `render.yaml` automatically
6. The disk is pre-configured for persistent SQLite storage
7. Free tier available

### Option 3: Docker (Any VPS — DigitalOcean, AWS, etc.)

```bash
# Build and run with Docker Compose
docker compose up -d

# Or build manually
docker build -t aband-finance .
docker run -d -p 3000:3000 -v finance-data:/app/data aband-finance
```

### Option 4: Fly.io

```bash
# Install flyctl, then:
fly launch
fly volumes create finance_data --size 1
# Add to fly.toml:
# [mounts]
#   source = "finance_data"
#   destination = "/app/data"
fly deploy
```

### Option 5: Any Node.js Host (Heroku, etc.)

```bash
npm install
PORT=3000 DB_PATH=./data/finance.db node server.js
```

> **Note:** For Heroku, the filesystem is ephemeral. Use the JSON backup feature regularly, or switch to a Postgres-based version.

---

## Environment Variables

| Variable  | Default                | Description                     |
|-----------|------------------------|---------------------------------|
| `PORT`    | `3000`                 | Server port                     |
| `DB_PATH` | `./data/finance.db`    | Path to SQLite database file    |

---

## API Endpoints

| Method   | Endpoint             | Description                      |
|----------|----------------------|----------------------------------|
| `GET`    | `/api/data/:key`     | Get a stored record              |
| `POST`   | `/api/data/:key`     | Save a record (body: `{value}`)  |
| `DELETE` | `/api/data/:key`     | Delete a record                  |
| `GET`    | `/api/keys`          | List all keys                    |
| `GET`    | `/api/backup`        | Download full database as JSON   |
| `POST`   | `/api/restore`       | Restore from JSON backup         |
| `GET`    | `/api/health`        | Health check                     |

---

## Backup & Restore

### Download backup
Click **💾 Backup** in the header, or:
```bash
curl http://localhost:3000/api/backup > backup.json
```

### Restore from backup
```bash
curl -X POST http://localhost:3000/api/restore \
  -H "Content-Type: application/json" \
  -d @backup.json
```

---

## Project Structure

```
aband-cloud/
├── server.js            # Express + SQLite backend
├── package.json         # Dependencies
├── Dockerfile           # Container build
├── docker-compose.yml   # Local Docker setup
├── railway.json         # Railway config
├── render.yaml          # Render config
├── public/
│   └── index.html       # Full frontend application
└── data/
    └── finance.db       # SQLite database (created at runtime)
```

---

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** SQLite via better-sqlite3
- **Frontend:** Vanilla HTML/CSS/JS
- **Charts:** Chart.js
- **Excel Export:** SheetJS
- **Deployment:** Docker / Railway / Render / Any Node.js host
