const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const STORAGE_MODE = process.env.STORAGE_MODE || "sqlite";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

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

// ─── Init ───
let store;
if (STORAGE_MODE==="github") {
  if (!GITHUB_TOKEN||!GITHUB_REPO){console.error("\n  ERROR: Set GITHUB_TOKEN and GITHUB_REPO env vars\n");process.exit(1)}
  store = new GitHubStore(GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH);
  console.log(`  Repo: ${GITHUB_REPO}`);
} else { store = new SQLiteStore(); }

async function getUsers(){const r=await store.get("_users");if(!r)return[];try{return JSON.parse(r)}catch(e){return[]}}
async function saveUsers(u){await store.set("_users",JSON.stringify(u),"system")}
async function initAdmin(){let u=await getUsers();if(!u.length){u=[{id:1,username:"admin",password:bcrypt.hashSync("admin123",10),displayName:"Administrator",role:"admin",active:true,createdAt:new Date().toISOString(),lastLogin:null}];await saveUsers(u);console.log("\n  ★ Default admin: admin / admin123\n  ★ CHANGE THIS PASSWORD!\n")}}

// ─── Middleware ───
app.use(express.json({limit:"10mb"}));
app.use(session({secret:SESSION_SECRET,resave:false,saveUninitialized:false,cookie:{maxAge:7*24*60*60*1000,httpOnly:true,sameSite:"lax"}}));
function auth(q,r,n){if(q.session?.user)return n();if(q.path.startsWith("/api/"))return r.status(401).json({error:"Not authenticated"});return r.redirect("/login.html")}
function admin(q,r,n){if(q.session?.user?.role==="admin")return n();return r.status(403).json({error:"Admin required"})}

// ─── Public Routes ───
app.get("/logo.jpg",(q,r)=>r.sendFile(path.join(__dirname,"public","logo.jpg")));
app.get("/logo-sm.jpg",(q,r)=>r.sendFile(path.join(__dirname,"public","logo-sm.jpg")));
app.get("/login.html",(q,r)=>{if(q.session?.user)return r.redirect("/");r.sendFile(path.join(__dirname,"public","login.html"))});

// ─── Auth ───
app.post("/api/auth/login",async(q,r)=>{const{username,password}=q.body;if(!username||!password)return r.status(400).json({error:"Required"});const users=await getUsers();const u=users.find(x=>x.username===username.toLowerCase().trim()&&x.active);if(!u||!bcrypt.compareSync(password,u.password))return r.status(401).json({error:"Invalid credentials"});u.lastLogin=new Date().toISOString();await saveUsers(users);q.session.user={id:u.id,username:u.username,displayName:u.displayName,role:u.role};r.json({success:true,user:q.session.user})});
app.post("/api/auth/logout",(q,r)=>{q.session.destroy(()=>r.json({success:true}))});
app.get("/api/auth/me",(q,r)=>{q.session?.user?r.json({user:q.session.user}):r.status(401).json({error:"Not authenticated"})});
app.post("/api/auth/change-password",auth,async(q,r)=>{const{currentPassword,newPassword}=q.body;if(!newPassword||newPassword.length<6)return r.status(400).json({error:"Min 6 chars"});const users=await getUsers();const u=users.find(x=>x.username===q.session.user.username);if(!u||!bcrypt.compareSync(currentPassword,u.password))return r.status(401).json({error:"Wrong password"});u.password=bcrypt.hashSync(newPassword,10);await saveUsers(users);r.json({success:true})});

// ─── User Mgmt ───
app.get("/api/users",auth,admin,async(q,r)=>{const u=await getUsers();r.json({users:u.map(x=>({id:x.id,username:x.username,display_name:x.displayName,role:x.role,active:x.active,created_at:x.createdAt,last_login:x.lastLogin}))})});
app.post("/api/users",auth,admin,async(q,r)=>{const{username,password,displayName,role}=q.body;if(!username||!password||!displayName)return r.status(400).json({error:"All fields required"});if(password.length<6)return r.status(400).json({error:"Min 6 chars"});const users=await getUsers();if(users.find(x=>x.username===username.toLowerCase().trim()))return r.status(409).json({error:"Exists"});users.push({id:users.length?Math.max(...users.map(x=>x.id))+1:1,username:username.toLowerCase().trim(),password:bcrypt.hashSync(password,10),displayName,role:role||"user",active:true,createdAt:new Date().toISOString(),lastLogin:null});await saveUsers(users);r.json({success:true})});
app.put("/api/users/:id",auth,admin,async(q,r)=>{const{displayName,role,active}=q.body;const users=await getUsers();const u=users.find(x=>x.id===+q.params.id);if(!u)return r.status(404).json({error:"Not found"});if(displayName)u.displayName=displayName;if(role)u.role=role;if(active!==undefined)u.active=active;await saveUsers(users);r.json({success:true})});
app.post("/api/users/:id/reset-password",auth,admin,async(q,r)=>{const{newPassword}=q.body;if(!newPassword||newPassword.length<6)return r.status(400).json({error:"Min 6 chars"});const users=await getUsers();const u=users.find(x=>x.id===+q.params.id);if(!u)return r.status(404).json({error:"Not found"});u.password=bcrypt.hashSync(newPassword,10);await saveUsers(users);r.json({success:true})});
app.delete("/api/users/:id",auth,admin,async(q,r)=>{if(+q.params.id===q.session.user.id)return r.status(400).json({error:"Cannot delete self"});let users=await getUsers();users=users.filter(x=>x.id!==+q.params.id||x.role==="admin");await saveUsers(users);r.json({success:true})});

// ─── Data ───
app.get("/api/data/:key",auth,async(q,r)=>{const v=await store.get(q.params.key);v!==null?r.json({key:q.params.key,value:v}):r.status(404).json({error:"Not found"})});
app.post("/api/data/:key",auth,async(q,r)=>{const{value}=q.body;if(value===undefined)return r.status(400).json({error:"Value required"});await store.set(q.params.key,typeof value==="string"?value:JSON.stringify(value),q.session.user.username);r.json({key:q.params.key,success:true})});
app.delete("/api/data/:key",auth,async(q,r)=>{await store.del(q.params.key);r.json({deleted:true})});
app.get("/api/backup",auth,async(q,r)=>{r.json({exported_at:new Date().toISOString(),exported_by:q.session?.user?.username,storage:STORAGE_MODE,records:await store.all()})});
app.post("/api/restore",auth,admin,async(q,r)=>{const{records}=q.body;if(!Array.isArray(records))return r.status(400).json({error:"Need records array"});for(const rec of records)await store.set(rec.key,rec.value,q.session.user.username);r.json({success:true,restored:records.length})});
app.get("/api/health",async(q,r)=>{const keys=await store.list();r.json({status:"ok",storage:STORAGE_MODE,records:keys.length,uptime:Math.round(process.uptime())})});
app.get("/api/audit",auth,admin,async(q,r)=>{store.getLogs?r.json({logs:store.getLogs()}):r.json({logs:[],note:"Audit logs in SQLite mode only"})});

// ─── Static ───
app.get("/",auth,(q,r)=>r.sendFile(path.join(__dirname,"public","index.html")));
app.get("*",(q,r)=>{q.session?.user?r.sendFile(path.join(__dirname,"public","index.html")):r.redirect("/login.html")});

(async()=>{await initAdmin();app.listen(PORT,"0.0.0.0",()=>{console.log(`
╔═══════════════════════════════════════════════╗
║  A-Band Consulting — Finance Hub  v3.1        ║
║  http://localhost:${String(PORT).padEnd(5)}                        ║
║  Storage: ${(STORAGE_MODE==="github"?"GitHub → "+GITHUB_REPO:"SQLite").padEnd(35)}║
╚═══════════════════════════════════════════════╝`)})})();
