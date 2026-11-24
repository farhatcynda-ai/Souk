// Souk — petites annonces. Lancer : npm i express && node server.js
const express = require("express"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const app = express();
app.set("trust proxy", 1);
const DB = "items.json", UP = "public/uploads", ADMIN = process.env.ADMIN_KEY || "change-moi";
fs.mkdirSync(UP, { recursive: true });
app.use(express.json({ limit: "8mb" }));
app.use(express.static("public"));

// Anti-spam : max N requêtes par heure et par personne
const hits = new Map();
const limit = max => (q, r, next) => {
  const k = q.ip + q.route.path, now = Date.now();
  const a = (hits.get(k) || []).filter(t => now - t < 3600e3);
  if (a.length >= max) return r.status(429).json({ error: "Trop de demandes, réessaie plus tard" });
  a.push(now); hits.set(k, a); next();
};
const visible = i => (i.reporters || []).length < 3;

const read = () => (fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, "utf8")) : []);
const save = d => fs.writeFileSync(DB, JSON.stringify(d, null, 2));
const clean = (s, n) => String(s || "").trim().slice(0, n);

// Liste des annonces (le code de suppression n'est jamais envoyé)
app.get("/api/items", (q, r) => r.json(read().filter(visible).reverse().map(({ code, reporters, ...i }) => i)));

// Publier une annonce avec photo
app.post("/api/items", limit(5), (q, r) => {
  const { title, price, seller, phone, code, photo, category } = q.body || {};
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(photo || "");
  if (!clean(title, 80) || !(price > 0) || !clean(seller, 40) || !clean(code, 20) || !m)
    return r.status(400).json({ error: "Champs manquants" });
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(UP, id + ".jpg"), Buffer.from(m[1], "base64"));
  const d = read();
  d.push({ id, title: clean(title, 80), category: clean(category, 30) || "Autre", price: +price, seller: clean(seller, 40), phone: clean(phone, 20),
           code: clean(code, 20), photo: "/uploads/" + id + ".jpg", comments: [], date: Date.now() });
  save(d);
  r.status(201).json({ id });
});

// Un acheteur laisse un commentaire
app.post("/api/items/:id/comments", limit(30), (q, r) => {
  const d = read(), it = d.find(x => x.id === q.params.id);
  const name = clean(q.body.name, 40), text = clean(q.body.text, 300);
  if (!it || !name || !text) return r.status(400).json({ error: "Invalide" });
  it.comments.push({ name, text, date: Date.now() });
  save(d);
  r.status(201).json({ ok: true });
});

// Supprimer : avec le code du vendeur ou la clé admin
app.delete("/api/items/:id", (q, r) => {
  const d = read(), it = d.find(x => x.id === q.params.id);
  if (!it) return r.sendStatus(404);
  if (q.query.code !== it.code && q.query.code !== ADMIN) return r.sendStatus(401);
  try { fs.unlinkSync(path.join("public", it.photo)); } catch (e) {}
  save(d.filter(x => x.id !== it.id));
  r.sendStatus(204);
});

// Le vendeur change le prix ou marque « vendu »
app.patch("/api/items/:id", (q, r) => {
  const d = read(), it = d.find(x => x.id === q.params.id);
  if (!it) return r.sendStatus(404);
  if (q.query.code !== it.code && q.query.code !== ADMIN) return r.sendStatus(401);
  if (q.body.price > 0) it.price = +q.body.price;
  if (typeof q.body.sold === "boolean") it.sold = q.body.sold;
  save(d);
  r.json({ ok: true });
});

// Signaler une annonce : cachée automatiquement après 3 personnes différentes
app.post("/api/items/:id/report", limit(10), (q, r) => {
  const d = read(), it = d.find(x => x.id === q.params.id);
  if (!it) return r.sendStatus(404);
  it.reporters = [...new Set([...(it.reporters || []), q.ip])];
  save(d);
  r.json({ ok: true });
});

// Toi : annonces signalées → /api/reported?key=TON_CODE (puis DELETE avec ?code=TON_CODE)
app.get("/api/reported", (q, r) => {
  if (q.query.key !== ADMIN) return r.sendStatus(401);
  r.json(read().filter(i => (i.reporters || []).length).map(({ code, ...i }) => i));
});

app.listen(process.env.PORT || 3000, () => console.log("http://localhost:3000"));
