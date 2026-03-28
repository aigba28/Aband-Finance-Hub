const express = require("express");
const Database = require("better-sqlite3");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "finance.db");
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─── Schema ───
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT DEFAULT 'user' CHECK(role IN ('admin','user','viewer')),
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT
  );
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    updated_by TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    ip TEXT,
    timestamp TEXT DEFAULT (datetime('now'))
  );
`);

// Create default admin if no users exist
const userCount = db.prepare("SELECT COUNT(*) as c FROM users").get();
if (userCount.c === 0) {
  const hash = bcrypt.hashSync("admin123", 10);
  db.prepare("INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)").run("admin", hash, "Administrator", "admin");
  console.log("\n  ★ Default admin created: username=admin / password=admin123");
  console.log("  ★ CHANGE THIS PASSWORD immediately after first login!\n");
}

// Prepared statements
const SQL = {
  getUser: db.prepare("SELECT * FROM users WHERE username = ? AND active = 1"),
  getUserById: db.prepare("SELECT id, username, display_name, role, created_at, last_login FROM users WHERE id = ?"),
  allUsers: db.prepare("SELECT id, username, display_name, role, active, created_at, last_login FROM users ORDER BY created_at"),
  createUser: db.prepare("INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)"),
  updateUser: db.prepare("UPDATE users SET display_name = ?, role = ?, active = ? WHERE id = ?"),
  changePass: db.prepare("UPDATE users SET password = ? WHERE id = ?"),
  deleteUser: db.prepare("DELETE FROM users WHERE id = ? AND role != 'admin'"),
  touchLogin: db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?"),
  kvGet: db.prepare("SELECT key, value FROM kv_store WHERE key = ?"),
  kvSet: db.prepare("INSERT OR REPLACE INTO kv_store (key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)"),
  kvDel: db.prepare("DELETE FROM kv_store WHERE key = ?"),
  kvList: db.prepare("SELECT key FROM kv_store WHERE key LIKE ? ORDER BY key"),
  kvAll: db.prepare("SELECT key, value, updated_at, updated_by FROM kv_store ORDER BY key"),
  log: db.prepare("INSERT INTO audit_log (user, action, detail, ip) VALUES (?, ?, ?, ?)"),
  recentLogs: db.prepare("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 50"),
};

// ─── Middleware ───
app.use(express.json({ limit: "10mb" }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    sameSite: "lax",
  },
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not authenticated" });
  return res.redirect("/login.html");
}

function requireAdmin(req, res, next) {
  if (req.session?.user?.role === "admin") return next();
  return res.status(403).json({ error: "Admin access required" });
}

function audit(req, action, detail) {
  SQL.log.run(req.session?.user?.username || "anonymous", action, detail || "", req.ip);
}

// ─── Auth Routes (public) ───
app.get("/logo.jpg", (req, res) => res.sendFile(path.join(__dirname, "public", "logo.jpg")));
app.get("/logo-sm.jpg", (req, res) => res.sendFile(path.join(__dirname, "public", "logo-sm.jpg")));

app.get("/login.html", (req, res) => {
  if (req.session?.user) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  const user = SQL.getUser.get(username.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password)) {
    audit(req, "LOGIN_FAILED", username);
    return res.status(401).json({ error: "Invalid credentials" });
  }
  SQL.touchLogin.run(user.id);
  req.session.user = { id: user.id, username: user.username, displayName: user.display_name, role: user.role };
  audit(req, "LOGIN", user.username);
  res.json({ success: true, user: req.session.user });
});

app.post("/api/auth/logout", (req, res) => {
  audit(req, "LOGOUT");
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/api/auth/me", (req, res) => {
  if (req.session?.user) res.json({ user: req.session.user });
  else res.status(401).json({ error: "Not authenticated" });
});

app.post("/api/auth/change-password", requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: "Both passwords required" });
  if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const user = SQL.getUser.get(req.session.user.username);
  if (!bcrypt.compareSync(currentPassword, user.password)) return res.status(401).json({ error: "Current password is incorrect" });
  SQL.changePass.run(bcrypt.hashSync(newPassword, 10), user.id);
  audit(req, "PASSWORD_CHANGED");
  res.json({ success: true });
});

// ─── User Management (admin only) ───
app.get("/api/users", requireAuth, requireAdmin, (req, res) => {
  res.json({ users: SQL.allUsers.all() });
});

app.post("/api/users", requireAuth, requireAdmin, (req, res) => {
  const { username, password, displayName, role } = req.body;
  if (!username || !password || !displayName) return res.status(400).json({ error: "All fields required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  try {
    const hash = bcrypt.hashSync(password, 10);
    SQL.createUser.run(username.toLowerCase().trim(), hash, displayName, role || "user");
    audit(req, "USER_CREATED", username);
    res.json({ success: true });
  } catch (e) {
    if (e.message.includes("UNIQUE")) return res.status(409).json({ error: "Username already exists" });
    res.status(500).json({ error: "Failed to create user" });
  }
});

app.put("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const { displayName, role, active } = req.body;
  SQL.updateUser.run(displayName, role, active ? 1 : 0, req.params.id);
  audit(req, "USER_UPDATED", `User #${req.params.id}`);
  res.json({ success: true });
});

app.post("/api/users/:id/reset-password", requireAuth, requireAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  SQL.changePass.run(bcrypt.hashSync(newPassword, 10), req.params.id);
  audit(req, "PASSWORD_RESET", `User #${req.params.id}`);
  res.json({ success: true });
});

app.delete("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === req.session.user.id) return res.status(400).json({ error: "Cannot delete yourself" });
  const result = SQL.deleteUser.run(req.params.id);
  audit(req, "USER_DELETED", `User #${req.params.id}`);
  res.json({ success: true, deleted: result.changes > 0 });
});

app.get("/api/audit", requireAuth, requireAdmin, (req, res) => {
  res.json({ logs: SQL.recentLogs.all() });
});

// ─── Data Routes (authenticated) ───
app.get("/api/data/:key", requireAuth, (req, res) => {
  const row = SQL.kvGet.get(req.params.key);
  if (row) res.json({ key: row.key, value: row.value });
  else res.status(404).json({ error: "Not found" });
});

app.post("/api/data/:key", requireAuth, (req, res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: "Value required" });
  const val = typeof value === "string" ? value : JSON.stringify(value);
  SQL.kvSet.run(req.params.key, val, req.session.user.username);
  res.json({ key: req.params.key, success: true });
});

app.delete("/api/data/:key", requireAuth, (req, res) => {
  const result = SQL.kvDel.run(req.params.key);
  audit(req, "DATA_DELETE", req.params.key);
  res.json({ key: req.params.key, deleted: result.changes > 0 });
});

app.get("/api/keys", requireAuth, (req, res) => {
  const rows = SQL.kvList.all((req.query.prefix || "") + "%");
  res.json({ keys: rows.map(r => r.key) });
});

app.get("/api/backup", requireAuth, (req, res) => {
  audit(req, "BACKUP");
  const rows = SQL.kvAll.all();
  res.json({ exported_at: new Date().toISOString(), exported_by: req.session.user.username, records: rows });
});

app.post("/api/restore", requireAuth, requireAdmin, (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records)) return res.status(400).json({ error: "Records array required" });
  const insert = db.transaction((recs) => { for (const r of recs) SQL.kvSet.run(r.key, r.value, req.session.user.username); });
  insert(records);
  audit(req, "RESTORE", `${records.length} records`);
  res.json({ success: true, restored: records.length });
});

app.get("/api/health", (req, res) => {
  const count = db.prepare("SELECT COUNT(*) as c FROM kv_store").get();
  const users = db.prepare("SELECT COUNT(*) as c FROM users").get();
  res.json({ status: "ok", records: count.c, users: users.c, uptime: Math.round(process.uptime()) });
});

// ─── Static Files (protected) ───
app.get("/", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use("/assets", express.static(path.join(__dirname, "public", "assets")));

// Catch-all
app.get("*", (req, res) => {
  if (req.session?.user) res.sendFile(path.join(__dirname, "public", "index.html"));
  else res.redirect("/login.html");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║  A-Band Consulting — Finance Hub  v3.0        ║
║  http://localhost:${PORT}                         ║
║  Database: ${path.basename(DB_PATH).padEnd(34)}║
║  Auth: Session-based + bcrypt                 ║
╚═══════════════════════════════════════════════╝`);
});
