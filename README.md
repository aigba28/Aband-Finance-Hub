# A-Band Consulting — Finance Hub v3 (with Authentication)

Cloud-ready finance management with login system, role-based access, and audit logging.

## Default Login

```
Username: admin
Password: admin123
```

**Change this password immediately after first login.**

## Features

- **Authentication** — bcrypt-hashed passwords, session-based login, role-based access
- **3 Roles** — Admin (full + user management), User (full access), Viewer (read-only)
- **Audit Log** — Every login, data change, and user action is logged
- **Multi-Year Database** — Independent data per fiscal year
- **Unlimited Clients & Invoices** — Rate/hr × Hours/Day × Days
- **Auto Revenue** — Paid invoices flow to P&L automatically
- **P&L + Expense Analysis** — Monthly, weekly, yearly views
- **Excel Export** — Every tab exportable, plus full backup
- **Invoice PDF** — Print-ready invoices via browser

## Quick Start

```bash
cd aband-cloud
npm install
npm start
# Open http://localhost:3000
```

## Deploy

**Railway:** Push to GitHub → railway.app → New Project → Deploy from repo → Add volume at `/app/data`

**Render:** Push to GitHub → render.com → New Web Service → auto-configures from render.yaml

**Docker:**
```bash
docker compose up -d
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DB_PATH` | `./data/finance.db` | SQLite database path |
| `SESSION_SECRET` | Auto-generated | Session encryption key |

## API

All data routes require authentication. User management requires admin role.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/login` | Public | Login |
| POST | `/api/auth/logout` | User | Logout |
| GET | `/api/auth/me` | User | Current user info |
| POST | `/api/auth/change-password` | User | Change own password |
| GET | `/api/users` | Admin | List users |
| POST | `/api/users` | Admin | Create user |
| PUT | `/api/users/:id` | Admin | Update user |
| DELETE | `/api/users/:id` | Admin | Delete user |
| GET | `/api/data/:key` | User | Get record |
| POST | `/api/data/:key` | User | Save record |
| GET | `/api/backup` | User | Download backup |
| POST | `/api/restore` | Admin | Restore backup |
| GET | `/api/audit` | Admin | View audit log |
