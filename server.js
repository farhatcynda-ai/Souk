// Souk — petites annonces. Lancer : npm i express && node server.js
const express = require("express"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const app = express();
app.set("trust proxy", 1);

const DATA = process.env.DATA_DIR || ".";            // avec un disk Render : DATA_DIR=/data
const DB = path.join(DATA, "items.json"), BAN = path.join(DATA, "banned.json"), UP = path.join(DATA, "uploads");
const ADMIN = process.env.ADMIN_KEY || "";            // sans ADMIN_KEY, l'admin est désactivé
fs.mkdirSync(UP, { recursive: true });

app.use(express.json({ limit: "8mb" }));
app.use("/uploads", express.static(UP));
app.use(express.static("public", { extensions: ["html"] }));

const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const write = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));
const read = () => readJson(DB, []), save = d => write(DB, d);
const banned = () => readJson(BAN, []);
const clean = (s, n) => String(s || "").trim().slice(0, n);
const phoneOk = p => /^\d{8}$/.test(p);                // numéro : exactement 8 chiffres
const isAdmin = k => !!ADMIN && k === ADMIN;
const canEdit = (it, code) => code === it.code || isAdmin(code);
const visible = i => !i.hidden && (i.reporters || []).length < 3;
const rmPhoto = it => { try { fs.unlinkSync(path.join(UP, path.basename(it.photo))); } catch (e) {} };

// Anti-spam : max N requêtes par heure et par personne
const hits = new Map();
const limit = max => (q, r, next) => {
  const k = q.ip + q.route.path, now = Date.now();
  const a = (hits.get(k) || []).filter(t => now - t < 3600e3);
  if (a.length >= max) return r.status(429).json({ error: "Trop de demandes, réessaie plus tard" });
  a.push(now); hits.set(k, a); next();
};

/* ---------- Public ---------- */
app.get("/api/items", (q, r) => r.json(read().filter(visible).reverse().map(({ code, reporters, ...i }) => i)));

app.post("/api/items", limit(5), (q, r) => {
  const { title, price, seller, code, photo, category } = q.body || {};
  const phone = String(q.body.phone || "").replace(/\s/g, "");
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(photo || "");
  if (!clean(title, 80) || !(price > 0) || !clean(seller, 40) || !clean(code, 20) || !m)
    return r.status(400).json({ error: "Champs manquants" });
  if (!phoneOk(phone)) return r.status(400).json({ error: "Le numéro doit avoir 8 chiffres" });
  if (banned().includes(phone)) return r.status(403).json({ error: "Numéro bloqué" });
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(UP, id + ".jpg"), Buffer.from(m[1], "base64"));
  const d = read();
  d.push({ id, title: clean(title, 80), category: clean(category, 30) || "Autre", price: +price, seller: clean(seller, 40),
           phone, code: clean(code, 20), photo: "/uploads/" + id + ".jpg", comments: [], date: Date.now() });
  save(d);
  r.status(201).json({ id });
});

app.post("/api/items/:id/comments", limit(30), (q, r) => {
  const d = read(), it = d.find(x => x.id === q.params.id);
  const name = clean(q.body.name, 40), text = clean(q.body.text, 300);
  if (!it || !visible(it) || !name || !text) return r.status(400).json({ error: "Invalide" });
  it.comments.push({ name, text, date: Date.now() });
  save(d);
  r.status(201).json({ ok: true });
});

app.patch("/api/items/:id", (q, r) => {
  const d = read(), it = d.find(x => x.id === q.params.id);
  if (!it) return r.sendStatus(404);
  if (!canEdit(it, q.query.code)) return r.sendStatus(401);
  if (q.body.price > 0) it.price = +q.body.price;
  if (typeof q.body.sold === "boolean") it.sold = q.body.sold;
  save(d);
  r.json({ ok: true });
});

app.delete("/api/items/:id", (q, r) => {
  const d = read(), it = d.find(x => x.id === q.params.id);
  if (!it) return r.sendStatus(404);
  if (!canEdit(it, q.query.code)) return r.sendStatus(401);
  rmPhoto(it);
  save(d.filter(x => x.id !== it.id));
  r.sendStatus(204);
});

app.post("/api/items/:id/report", limit(10), (q, r) => {
  const d = read(), it = d.find(x => x.id === q.params.id);
  if (!it) return r.sendStatus(404);
  it.reporters = [...new Set([...(it.reporters || []), q.ip])];
  save(d);
  r.json({ ok: true });
});

/* ---------- Admin (en-tête x-admin-key) ---------- */
const admin = (q, r, next) => (isAdmin(q.get("x-admin-key")) ? next() : r.sendStatus(401));

app.get("/api/admin/items", admin, (q, r) =>
  r.json(read().reverse().map(({ code, reporters, ...i }) => ({ ...i, reports: (reporters || []).length }))));

app.patch("/api/admin/items/:id", admin, (q, r) => {
  const d = read(), it = d.find(x => x.id === q.params.id);
  if (!it) return r.sendStatus(404);
  if (typeof q.body.hidden === "boolean") it.hidden = q.body.hidden;
  if (q.body.clearReports) it.reporters = [];
  save(d);
  r.json({ ok: true });
});

app.delete("/api/admin/items/:id", admin, (q, r) => {
  const d = read(), it = d.find(x => x.id === q.params.id);
  if (!it) return r.sendStatus(404);
  rmPhoto(it);
  save(d.filter(x => x.id !== it.id));
  r.sendStatus(204);
});

app.delete("/api/admin/items/:id/comments/:n", admin, (q, r) => {
  const d = read(), it = d.find(x => x.id === q.params.id);
  if (!it || !it.comments[+q.params.n]) return r.sendStatus(404);
  it.comments.splice(+q.params.n, 1);
  save(d);
  r.sendStatus(204);
});

app.get("/api/admin/banned", admin, (q, r) => r.json(banned()));

app.post("/api/admin/ban", admin, (q, r) => {
  const p = String(q.body.phone || "").replace(/\s/g, "");
  if (!phoneOk(p)) return r.status(400).json({ error: "8 chiffres" });
  write(BAN, [...new Set([...banned(), p])]);
  r.json({ ok: true });
});

app.delete("/api/admin/ban/:phone", admin, (q, r) => {
  write(BAN, banned().filter(x => x !== q.params.phone));
  r.sendStatus(204);
});

app.listen(process.env.PORT || 3000, () => console.log("http://localhost:" + (process.env.PORT || 3000)));
