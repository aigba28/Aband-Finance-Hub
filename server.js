const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "finance.db");

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Initialize SQLite
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    key TEXT,
    timestamp TEXT DEFAULT (datetime('now'))
  );
`);

// Prepared statements
const stmts = {
  get: db.prepare("SELECT key, value FROM kv_store WHERE key = ?"),
  set: db.prepare("INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))"),
  del: db.prepare("DELETE FROM kv_store WHERE key = ?"),
  list: db.prepare("SELECT key FROM kv_store WHERE key LIKE ? ORDER BY key"),
  all: db.prepare("SELECT key, value, updated_at FROM kv_store ORDER BY key"),
  log: db.prepare("INSERT INTO audit_log (action, key) VALUES (?, ?)"),
};

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── API Routes ───

// Get a value
app.get("/api/data/:key", (req, res) => {
  const row = stmts.get.get(req.params.key);
  if (row) res.json({ key: row.key, value: row.value });
  else res.status(404).json({ error: "Not found" });
});

// Set a value
app.post("/api/data/:key", (req, res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: "Value required" });
  stmts.set.run(req.params.key, typeof value === "string" ? value : JSON.stringify(value));
  stmts.log.run("SET", req.params.key);
  res.json({ key: req.params.key, value, success: true });
});

// Delete a value
app.delete("/api/data/:key", (req, res) => {
  const result = stmts.del.run(req.params.key);
  stmts.log.run("DELETE", req.params.key);
  res.json({ key: req.params.key, deleted: result.changes > 0 });
});

// List keys with optional prefix
app.get("/api/keys", (req, res) => {
  const prefix = req.query.prefix || "";
  const rows = stmts.list.all(prefix + "%");
  res.json({ keys: rows.map(r => r.key) });
});

// List all data (for backup/export)
app.get("/api/backup", (req, res) => {
  const rows = stmts.all.all();
  res.json({
    exported_at: new Date().toISOString(),
    records: rows.map(r => ({ key: r.key, value: r.value, updated_at: r.updated_at })),
  });
});

// Restore from backup
app.post("/api/restore", (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records)) return res.status(400).json({ error: "Records array required" });
  const insert = db.transaction((recs) => {
    for (const r of recs) {
      stmts.set.run(r.key, r.value);
    }
  });
  insert(records);
  stmts.log.run("RESTORE", `${records.length} records`);
  res.json({ success: true, restored: records.length });
});

// Health check
app.get("/api/health", (req, res) => {
  const count = db.prepare("SELECT COUNT(*) as c FROM kv_store").get();
  res.json({ status: "ok", records: count.c, uptime: process.uptime() });
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   A-Band Consulting — Finance Hub            ║
║   Running on http://localhost:${PORT}            ║
║   Database: ${DB_PATH}  ║
╚══════════════════════════════════════════════╝
  `);
});
