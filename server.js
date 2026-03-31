const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

// Determine storage mode: explicit env var wins; otherwise auto-detect from DATABASE_URL
const _defaultMode = process.env.DATABASE_URL ? "postgres" : "sqlite";
const STORAGE_MODE = process.env.STORAGE_MODE || _defaultMode;

console.log(`\n  Storage: ${STORAGE_MODE.toUpperCase()}`);

// ─── GitHub Storage Engine ───
class GitHubStore {
  constructor(token, repo, branch) {
    this.token = token; this.repo = repo; this.branch = branch;
    this.api = `https://api.github.com/repos/${repo}/contents`;
    this.cache = new Map(); this.shas = new Map();
  }
  h() { return { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" }; }
  fp(key) { return `data/${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`; }

  async get(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    try {
      const res = await fetch(`${this.api}/${this.fp(key)}?ref=${this.branch}`, { headers: this.h() });
      if (!res.ok) return null;
      const d = await res.json(); this.shas.set(key, d.sha);
      const val = JSON.parse(Buffer.from(d.content, "base64").toString("utf-8")).value;
      this.cache.set(key, val); return val;
    } catch (e) { return null; }
  }
  async set(key, value, user) {
    const body = { message: `${key} by ${user||"system"}`, content: Buffer.from(JSON.stringify({key,value,updated_at:new Date().toISOString(),updated_by:user||"system"},null,2)).toString("base64"), branch: this.branch };
    if (!this.shas.has(key)) { try { const c = await fetch(`${this.api}/${this.fp(key)}?ref=${this.branch}`, {headers:this.h()}); if(c.ok){const d=await c.json();this.shas.set(key,d.sha)} } catch(e){} }
    if (this.shas.has(key)) body.sha = this.shas.get(key);
    try { const res = await fetch(`${this.api}/${this.fp(key)}`, {method:"PUT",headers:this.h(),body:JSON.stringify(body)}); if(res.ok){const d=await res.json();this.shas.set(key,d.content.sha);this.cache.set(key,value);return true} return false; } catch(e){return false}
  }
  async del(key) {
    if(!this.shas.has(key)){try{const c=await fetch(`${this.api}/${this.fp(key)}?ref=${this.branch}`,{headers:this.h()});if(c.ok){const d=await c.json();this.shas.set(key,d.sha)}else return false}catch(e){return false}}
    try{const res=await fetch(`${this.api}/${this.fp(key)}`,{method:"DELETE",headers:this.h(),body:JSON.stringify({message:`Delete ${key}`,sha:this.shas.get(key),branch:this.branch})});if(res.ok){this.cache.delete(key);this.shas.delete(key);return true}return false}catch(e){return false}
  }
  async list(prefix) {
    try{const res=await fetch(`${this.api}/data?ref=${this.branch}`,{headers:this.h()});if(!res.ok)return[];const files=await res.json();if(!Array.isArray(files))return[];const keys=files.filter(f=>f.name.endsWith(".json")).map(f=>f.name.replace(".json","").replace(/_/g,"-"));return prefix?keys.filter(k=>k.startsWith(prefix)):keys}catch(e){return[]}
  }
  async all() { const keys=await this.list();const r=[];for(const k of keys){const v=await this.get(k);if(v!==null)r.push({key:k,value:typeof v==="string"?v:JSON.stringify(v)})}return r }
}

// ─── SQLite Storage Engine ───
class SQLiteStore {
  constructor() {
    const Database = require("better-sqlite3");
    const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "finance.db");
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    this.db = new Database(DB_PATH); this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')), updated_by TEXT);
      CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, action TEXT, detail TEXT, ip TEXT, timestamp TEXT DEFAULT (datetime('now')));`);
    this.s = { get: this.db.prepare("SELECT value FROM kv_store WHERE key = ?"), set: this.db.prepare("INSERT OR REPLACE INTO kv_store (key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)"),
      del: this.db.prepare("DELETE FROM kv_store WHERE key = ?"), list: this.db.prepare("SELECT key FROM kv_store WHERE key LIKE ? ORDER BY key"),
      all: this.db.prepare("SELECT key, value, updated_at, updated_by FROM kv_store ORDER BY key"), log: this.db.prepare("INSERT INTO audit_log (user, action, detail, ip) VALUES (?, ?, ?, ?)"),
      logs: this.db.prepare("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 50") };
    console.log(`  DB: ${DB_PATH}`);
  }
  async get(k){const r=this.s.get.get(k);return r?r.value:null}
  async set(k,v,u){this.s.set.run(k,v,u||"system");return true}
  async del(k){this.s.del.run(k);return true}
  async list(p){return this.s.list.all((p||"")+"%").map(r=>r.key)}
  async all(){return this.s.all.all()}
  audit(u,a,d,ip){this.s.log.run(u,a,d||"",ip||"")}
  getLogs(){return this.s.logs.all()}
}

// ─── PostgreSQL Storage Engine ───
class PostgreSQLStore {
  constructor() {
    const { Pool } = require("pg");
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false }
    });
    this._ready = this._init();
  }

  async _init() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS kv_store (
          key         TEXT PRIMARY KEY,
          value       TEXT NOT NULL,
          updated_at  TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
          updated_by  TEXT
        );
        CREATE TABLE IF NOT EXISTS audit_log (
          id          SERIAL PRIMARY KEY,
          "user"      TEXT,
          action      TEXT,
          detail      TEXT,
          ip          TEXT,
          timestamp   TEXT DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        );
      `);
      console.log("  DB: PostgreSQL connected");
    } finally {
      client.release();
    }
  }

  async get(k) {
    await this._ready;
    const res = await this.pool.query("SELECT value FROM kv_store WHERE key = $1", [k]);
    return res.rows.length ? res.rows[0].value : null;
  }

  async set(k, v, u) {
    await this._ready;
    await this.pool.query(
      `INSERT INTO kv_store (key, value, updated_at, updated_by)
       VALUES ($1, $2, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_at = EXCLUDED.updated_at,
             updated_by = EXCLUDED.updated_by`,
      [k, v, u || "system"]
    );
    return true;
  }

  async del(k) {
    await this._ready;
    await this.pool.query("DELETE FROM kv_store WHERE key = $1", [k]);
    return true;
  }

  async list(prefix) {
    await this._ready;
    const res = await this.pool.query(
      "SELECT key FROM kv_store WHERE key LIKE $1 ORDER BY key",
      [(prefix || "") + "%"]
    );
    return res.rows.map(r => r.key);
  }

  async all() {
    await this._ready;
    const res = await this.pool.query("SELECT key, value, updated_at, updated_by FROM kv_store ORDER BY key");
    return res.rows;
  }

  async audit(u, a, d, ip) {
    await this._ready;
    await this.pool.query(
      `INSERT INTO audit_log ("user", action, detail, ip) VALUES ($1, $2, $3, $4)`,
      [u, a, d || "", ip || ""]
    );
  }

  async getLogs() {
    await this._ready;
    const res = await this.pool.query(`SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 50`);
    return res.rows;
  }
}

// ─── GitHub Data Loader ───
// Files to fetch from aigba28/aband-data/data/ on startup
const ABAND_DATA_FILES = [
  "aband-idx",
  "aband-2025",
  "aband-2026",
  "aband-2027",
  "_users",
  "_email_config"
];
const ABAND_DATA_API = "https://api.github.com/repos/aigba28/aband-data/contents/data";

async function loadDataFromGitHub() {
  if (!GITHUB_TOKEN) {
    console.warn("\n  [seed] WARNING: GITHUB_TOKEN is not set — skipping data load (private repo requires authentication)\n");
    return;
  }

  console.log("\n  Loading seed data from aigba28/aband-data …");
  let loaded = 0, skipped = 0, failed = 0;

  for (const name of ABAND_DATA_FILES) {
    const url = `${ABAND_DATA_API}/${name}.json?ref=main`;
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json"
        }
      });
      if (!res.ok) {
        console.log(`  [seed] SKIP  ${name}.json — HTTP ${res.status}`);
        skipped++;
        continue;
      }
      const apiJson = await res.json();
      // GitHub API returns { content: "<base64>", ... } — decode it
      const raw  = Buffer.from(apiJson.content, "base64").toString("utf-8");
      const json = JSON.parse(raw);
      // Each file has { key, value, updated_at, updated_by }
      const key   = json.key   || name;
      const value = typeof json.value === "string" ? json.value : JSON.stringify(json.value);
      const by    = json.updated_by || "seed";
      await store.set(key, value, by);
      console.log(`  [seed] OK    ${name}.json → key="${key}"`);
      loaded++;
    } catch (e) {
      console.error(`  [seed] ERROR ${name}.json — ${e.message}`);
      failed++;
    }
  }

  console.log(`  Seed complete: ${loaded} loaded, ${skipped} skipped, ${failed} failed\n`);
}

// ─── Init ───
let store;
if (STORAGE_MODE === "github") {
  if (!GITHUB_TOKEN || !GITHUB_REPO) { console.error("\n  ERROR: Set GITHUB_TOKEN and GITHUB_REPO env vars\n"); process.exit(1); }
  store = new GitHubStore(GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH);
  console.log(`  Repo: ${GITHUB_REPO}`);
} else if (STORAGE_MODE === "postgres" || process.env.DATABASE_URL) {
  if (!process.env.DATABASE_URL) { console.error("\n  ERROR: Set DATABASE_URL env var for PostgreSQL\n"); process.exit(1); }
  store = new PostgreSQLStore();
} else {
  store = new SQLiteStore();
}

async function getUsers(){const r=await store.get("_users");if(!r)return[];try{return JSON.parse(r)}catch(e){return[]}}
async function saveUsers(u){await store.set("_users",JSON.stringify(u),"system")}
async function initAdmin(){let u=await getUsers();if(!u.length){u=[{id:1,username:"admin",password:bcrypt.hashSync("admin123",10),displayName:"Administrator",role:"admin",active:true,createdAt:new Date().toISOString(),lastLogin:null}];await saveUsers(u);console.log("\n  ★ Default admin: admin / admin123\n  ★ CHANGE THIS PASSWORD!\n")}}

// ─── Middleware ───
app.use(express.json({limit:"10mb"}));
app.use(session({secret:SESSION_SECRET,resave:false,saveUninitialized:false,cookie:{maxAge:7*24*60*60*1000,httpOnly:true,sameSite:"lax"}}));
function auth(q,r,n){if(q.session?.user)return n();if(q.path.startsWith("/api/"))return r.status(401).json({error:"Not authenticated"});return r.redirect("/login.html")}
function admin(q,r,n){if(q.session?.user?.role==="admin")return n();return r.status(403).json({error:"Admin required"})}
function writer(q,r,n){if(q.session?.user?.role==="viewer")return r.status(403).json({error:"Read-only access"});return n()}

// ─── Public Routes ───
app.get("/logo.jpg",(q,r)=>r.sendFile(path.join(__dirname,"public","logo.jpg")));
app.get("/logo-sm.jpg",(q,r)=>r.sendFile(path.join(__dirname,"public","logo-sm.jpg")));
app.get("/login.html",(q,r)=>{if(q.session?.user)return r.redirect("/");r.sendFile(path.join(__dirname,"public","login.html"))});

// ─── Auth ───
app.post("/api/auth/login",async(q,r)=>{const{username,password}=q.body;if(!username||!password)return r.status(400).json({error:"Required"});const users=await getUsers();const u=users.find(x=>x.username===username.toLowerCase().trim()&&x.active);if(!u||!bcrypt.compareSync(password,u.password))return r.status(401).json({error:"Invalid credentials"});u.lastLogin=new Date().toISOString();await saveUsers(users);q.session.user={id:u.id,username:u.username,displayName:u.displayName,role:u.role};r.json({success:true,user:q.session.user})});
app.post("/api/auth/logout",(q,r)=>{q.session.destroy(()=>r.json({success:true}))});
app.get("/api/auth/me",(q,r)=>{q.session?.user?r.json({user:q.session.user}):r.status(401).json({error:"Not authenticated"})});
app.post("/api/auth/change-password",auth,async(q,r)=>{const{currentPassword,newPassword}=q.body;if(!newPassword||newPassword.length<6)return r.status(400).json({error:"Min 6 chars"});const users=await getUsers();const u=users.find(x=>x.username===q.session.user.username);if(!u||!bcrypt.compareSync(currentPassword,u.password))return r.status(401).json({error:"Wrong password"});u.password=bcrypt.hashSync(newPassword,10);await saveUsers(users);r.json({success:true})});
app.post("/api/auth/verify-password",auth,async(q,r)=>{const{password}=q.body;if(!password)return r.status(400).json({error:"Password required"});const users=await getUsers();const u=users.find(x=>x.username===q.session.user.username);if(!u||!bcrypt.compareSync(password,u.password))return r.status(401).json({error:"Incorrect password"});r.json({success:true})});

// ─── User Mgmt ───
app.get("/api/users",auth,admin,async(q,r)=>{const u=await getUsers();r.json({users:u.map(x=>({id:x.id,username:x.username,display_name:x.displayName,role:x.role,active:x.active,created_at:x.createdAt,last_login:x.lastLogin}))})});
app.post("/api/users",auth,admin,async(q,r)=>{const{username,password,displayName,role}=q.body;if(!username||!password||!displayName)return r.status(400).json({error:"All fields required"});if(password.length<6)return r.status(400).json({error:"Min 6 chars"});const users=await getUsers();if(users.find(x=>x.username===username.toLowerCase().trim()))return r.status(409).json({error:"Exists"});users.push({id:users.length?Math.max(...users.map(x=>x.id))+1:1,username:username.toLowerCase().trim(),password:bcrypt.hashSync(password,10),displayName,role:role||"user",active:true,createdAt:new Date().toISOString(),lastLogin:null});await saveUsers(users);r.json({success:true})});
app.put("/api/users/:id",auth,admin,async(q,r)=>{const{displayName,role,active}=q.body;const users=await getUsers();const u=users.find(x=>x.id===+q.params.id);if(!u)return r.status(404).json({error:"Not found"});if(displayName)u.displayName=displayName;if(role)u.role=role;if(active!==undefined)u.active=active;await saveUsers(users);r.json({success:true})});
app.post("/api/users/:id/reset-password",auth,admin,async(q,r)=>{const{newPassword}=q.body;if(!newPassword||newPassword.length<6)return r.status(400).json({error:"Min 6 chars"});const users=await getUsers();const u=users.find(x=>x.id===+q.params.id);if(!u)return r.status(404).json({error:"Not found"});u.password=bcrypt.hashSync(newPassword,10);await saveUsers(users);r.json({success:true})});
app.delete("/api/users/:id",auth,admin,async(q,r)=>{if(+q.params.id===q.session.user.id)return r.status(400).json({error:"Cannot delete self"});let users=await getUsers();users=users.filter(x=>x.id!==+q.params.id||x.role==="admin");await saveUsers(users);r.json({success:true})});

// ─── Data ───
app.get("/api/data/:key",auth,async(q,r)=>{const v=await store.get(q.params.key);v!==null?r.json({key:q.params.key,value:v}):r.status(404).json({error:"Not found"})});
app.post("/api/data/:key",auth,writer,async(q,r)=>{const{value}=q.body;if(value===undefined)return r.status(400).json({error:"Value required"});await store.set(q.params.key,typeof value==="string"?value:JSON.stringify(value),q.session.user.username);r.json({key:q.params.key,success:true})});
app.delete("/api/data/:key",auth,writer,async(q,r)=>{await store.del(q.params.key);r.json({deleted:true})});
app.get("/api/backup",auth,async(q,r)=>{r.json({exported_at:new Date().toISOString(),exported_by:q.session?.user?.username,storage:STORAGE_MODE,records:await store.all()})});
app.post("/api/restore",auth,admin,async(q,r)=>{const{records}=q.body;if(!Array.isArray(records))return r.status(400).json({error:"Need records array"});for(const rec of records)await store.set(rec.key,rec.value,q.session.user.username);r.json({success:true,restored:records.length})});
app.get("/api/health",async(q,r)=>{const keys=await store.list();r.json({status:"ok",storage:STORAGE_MODE,records:keys.length,uptime:Math.round(process.uptime())})});
app.get("/api/audit",auth,admin,async(q,r)=>{if(store.getLogs){try{r.json({logs:await store.getLogs()})}catch(e){r.status(500).json({error:e.message})}}else{r.json({logs:[],note:"Audit logs not available in this storage mode"})}});

// ─── Email ───
app.get("/api/email/config",auth,async(q,r)=>{
try{let cfg=null;try{const v=await store.get("_email_config");if(v)cfg=JSON.parse(v)}catch(e){}
if(cfg&&cfg.host&&cfg.user){return r.json({configured:true,sender:cfg.fromEmail||cfg.user})}
const envOk=!!(process.env.GMAIL_USER&&process.env.GMAIL_APP_PASSWORD);
r.json({configured:envOk,sender:process.env.GMAIL_USER||""})}
catch(e){r.json({configured:false,sender:"",error:e.message})}});

app.get("/api/settings/email",auth,admin,async(q,r)=>{
try{let cfg={host:"",port:587,secure:false,user:"",pass:"",fromName:"",fromEmail:"",configured:false};
try{const v=await store.get("_email_config");if(v){const c=JSON.parse(v);cfg={...cfg,...c,configured:!!(c.host&&c.user)}}}catch(e){}
if(!cfg.host&&process.env.GMAIL_USER){cfg.host="smtp.gmail.com";cfg.port=587;cfg.user=process.env.GMAIL_USER;cfg.pass=process.env.GMAIL_APP_PASSWORD?"(env)":"";cfg.configured=true}
r.json({config:{...cfg,pass:cfg.pass?"••••••••":""}})}
catch(e){r.status(500).json({error:e.message})}});

app.post("/api/settings/email",auth,admin,async(q,r)=>{
try{const{host,port,secure,user,pass,fromName,fromEmail}=q.body;
if(!host||!user)return r.status(400).json({error:"Host and username required"});
let existing={};try{const v=await store.get("_email_config");if(v)existing=JSON.parse(v)}catch(e){}
const cfg={host,port:port||587,secure:!!secure,user,pass:pass||existing.pass||"",fromName:fromName||"",fromEmail:fromEmail||""};
await store.set("_email_config",JSON.stringify(cfg),"system");
r.json({success:true})}
catch(e){console.error("Save email config error:",e.message);r.status(500).json({error:"Failed to save: "+e.message})}});

app.delete("/api/settings/email",auth,admin,async(q,r)=>{
try{await store.del("_email_config")}catch(e){}
r.json({success:true})});

app.post("/api/settings/email/test",auth,admin,async(q,r)=>{
try{const transport=await getTransporter();
if(!transport)return r.status(400).json({error:"Email not configured. Save your settings first."});
await Promise.race([transport.t.verify(),new Promise((_,rej)=>setTimeout(()=>rej(new Error("Connection timed out (15s). Your hosting provider may block SMTP ports 587/465. Try: 1) Use port 2525, 2) Set GMAIL_USER + GMAIL_APP_PASSWORD as Render environment variables instead.")),15000))]);
const info=await Promise.race([transport.t.sendMail({from:transport.from,to:transport.cfg.user,subject:"A-Band Finance Hub — Test Email",html:`<div style="font-family:Arial,sans-serif;padding:30px;max-width:500px;margin:0 auto;text-align:center"><div style="background:#0F1D3D;color:#fff;padding:20px;border-radius:10px;font-size:20px;font-weight:700;letter-spacing:.08em;margin-bottom:20px">A-BAND CONSULTING INC</div><h2 style="color:#10B981;margin-bottom:10px">Email is working!</h2><p style="color:#64748b;font-size:14px">Your outgoing mail server is properly configured.</p></div>`}),new Promise((_,rej)=>setTimeout(()=>rej(new Error("Send timed out (30s)")),30000))]);
r.json({success:true,messageId:info.messageId})}
catch(e){console.error("Test email error:",e.message);r.status(500).json({error:e.message})}});

async function getTransporter(){
let cfg=null;try{const v=await store.get("_email_config");if(v)cfg=JSON.parse(v)}catch(e){}
if(cfg&&cfg.host&&cfg.user&&cfg.pass){
const t=nodemailer.createTransport({host:cfg.host,port:cfg.port||587,secure:!!cfg.secure,auth:{user:cfg.user,pass:cfg.pass},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000});
const from=`"${cfg.fromName||"A-Band Consulting"}" <${cfg.fromEmail||cfg.user}>`;
return{t,from,cfg}}
if(process.env.GMAIL_USER&&process.env.GMAIL_APP_PASSWORD){
const t=nodemailer.createTransport({service:"gmail",auth:{user:process.env.GMAIL_USER,pass:process.env.GMAIL_APP_PASSWORD},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000});
const from=`"A-Band Consulting" <${process.env.GMAIL_USER}>`;
return{t,from,cfg:{user:process.env.GMAIL_USER}}}
return null}

app.post("/api/send-email",auth,writer,async(q,r)=>{
try{const{to,cc,subject,htmlBody,textBody,attachments}=q.body;
if(!to||!subject)return r.status(400).json({error:"To and subject required"});
const transport=await getTransporter();
if(!transport)return r.status(400).json({error:"Email not configured. Go to Settings → Outgoing Email Server to set it up.",needsConfig:true});
const mailOpts={from:transport.from,to,subject,html:htmlBody||undefined,text:textBody||undefined};
if(cc)mailOpts.cc=cc;
if(attachments&&Array.isArray(attachments)){mailOpts.attachments=attachments.map(a=>({filename:a.filename,content:Buffer.from(a.content,"base64"),contentType:a.contentType||"application/octet-stream"}))}
const info=await Promise.race([transport.t.sendMail(mailOpts),new Promise((_,rej)=>setTimeout(()=>rej(new Error("SMTP send timed out (30s). Your hosting provider may block outbound SMTP.")),30000))]);
r.json({success:true,messageId:info.messageId})}
catch(e){console.error("Email error:",e.message);r.status(500).json({error:e.message})}});

// ─── Global API error handler (prevents HTML error pages) ───
app.use("/api",(err,q,r,n)=>{console.error("API error:",err.message);r.status(500).json({error:err.message||"Internal server error"})});

// ─── Static ───
app.get("/",auth,(q,r)=>r.sendFile(path.join(__dirname,"public","index.html")));
app.get("*",(q,r)=>{q.session?.user?r.sendFile(path.join(__dirname,"public","index.html")):r.redirect("/login.html")});

(async () => {
  // For PostgreSQL: wait for schema init, load seed data, then create default admin
  if (STORAGE_MODE === "postgres" || (STORAGE_MODE !== "github" && STORAGE_MODE !== "sqlite" && process.env.DATABASE_URL)) {
    await store._ready;
    await loadDataFromGitHub();
  }
  await initAdmin();

  const storageLabel = STORAGE_MODE === "github"
    ? "GitHub → " + GITHUB_REPO
    : STORAGE_MODE === "postgres"
      ? "PostgreSQL"
      : "SQLite";

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`
╔═══════════════════════════════════════════════╗
║  A-Band Consulting — Finance Hub  v3.1        ║
║  http://localhost:${String(PORT).padEnd(5)}                        ║
║  Storage: ${storageLabel.padEnd(35)}║
╚═══════════════════════════════════════════════╝`);
  });
})();
