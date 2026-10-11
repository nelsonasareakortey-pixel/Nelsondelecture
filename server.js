require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { YoutubeTranscript } = require('youtube-transcript');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// ---------- Database ----------
const db = new Database(path.join(DATA_DIR, 'notewise.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, password TEXT,
  is_admin INTEGER DEFAULT 0, sub_until INTEGER DEFAULT 0, free_used INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, user_id INTEGER, reference TEXT, payer_number TEXT,
  amount REAL, status TEXT DEFAULT 'pending', created_at INTEGER);
CREATE TABLE IF NOT EXISTS generations(id INTEGER PRIMARY KEY, user_id INTEGER, url TEXT, title TEXT, data TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS materials(id INTEGER PRIMARY KEY, title TEXT, category TEXT, description TEXT,
  file TEXT, link TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
`);
const DEFAULTS = {
  site_name: 'NoteWise',
  tagline: 'Turn any YouTube lesson into notes, exam questions and flashcards.',
  price: '50',
  momo_number: '0598429685',
  momo_name: '',
  announcement: '',
  free_trials: '2',
};
for (const [k, v] of Object.entries(DEFAULTS))
  db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(k, v);
const getSettings = () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]));

if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const e = process.env.ADMIN_EMAIL.toLowerCase();
  const ex = db.prepare('SELECT id FROM users WHERE email=?').get(e);
  if (!ex) db.prepare('INSERT INTO users(name,email,password,is_admin,created_at) VALUES(?,?,?,1,?)')
    .run('Admin', e, bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10), Date.now());
  else db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(ex.id);
}

// ---------- Helpers ----------
const DAY = 86400000;
const isActive = u => u.is_admin || u.sub_until > Date.now();
const freeLeft = u => Math.max(0, parseInt(getSettings().free_trials) - u.free_used);
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, is_admin: !!u.is_admin,
  sub_until: u.sub_until, active: !!isActive(u), free_left: freeLeft(u) });
const sign = u => jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '30d' });

function auth(req, res, next) {
  try {
    const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.id);
    if (!u) throw new Error();
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Please log in' }); }
}
const adminOnly = (req, res, next) => req.user.is_admin ? next() : res.status(403).json({ error: 'Admins only' });

function videoId(url) {
  const m = String(url).match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Auth ----------
app.post('/api/signup', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password || password.length < 6) return res.status(400).json({ error: 'Fill all fields (password min 6 chars)' });
  try {
    const r = db.prepare('INSERT INTO users(name,email,password,created_at) VALUES(?,?,?,?)')
      .run(name.trim(), email.toLowerCase().trim(), bcrypt.hashSync(password, 10), Date.now());
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
    res.json({ token: sign(u), user: publicUser(u) });
  } catch { res.status(400).json({ error: 'Email already registered' }); }
});
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase().trim());
  if (!u || !bcrypt.compareSync(password || '', u.password)) return res.status(400).json({ error: 'Wrong email or password' });
  res.json({ token: sign(u), user: publicUser(u) });
});
app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));
app.get('/api/settings', (req, res) => res.json(getSettings()));

// ---------- Generate ----------
const SYSTEM = `You are an expert teacher and exam setter. From a video transcript you create thorough study material.
Return ONLY valid JSON (no markdown fences) with this exact shape:
{
 "title": string,
 "summary": string (3-5 sentences),
 "notes": string (detailed study notes in markdown using #, ##, ###, - bullets and **bold** key terms; cover every important idea, definition, example, formula and step in the video),
 "key_terms": [{"term": string, "definition": string}],
 "mcq": [{"question": string, "options": [4 strings], "answer": number (0-3 index), "explanation": string}],
 "short_answer": [{"question": string, "answer": string}],
 "essay": [{"question": string, "answer": string (model answer outline)}],
 "flashcards": [{"front": string, "back": string}]
}
Rules: Be comprehensive and cover the WHOLE transcript, not just the start. Produce at least 15 MCQs, 8 short-answer, 4 essay/application questions and 20 flashcards; produce more for longer videos (about 1 MCQ and 1 flashcard per 2 minutes of content). Include recall, understanding and application/analysis questions. Only use facts from the transcript, correct obvious transcription errors, and write in clear English.`;

app.post('/api/generate', auth, rateLimit({ windowMs: 60000, max: 8 }), async (req, res) => {
  const u = req.user;
  if (!isActive(u) && freeLeft(u) <= 0) return res.status(402).json({ error: 'Free trials finished. Please subscribe to continue.' });
  if (!anthropic) return res.status(500).json({ error: 'Server AI key not configured' });
  const { url } = req.body || {};
  const id = videoId(url);
  if (!id) return res.status(400).json({ error: 'Enter a valid YouTube link' });
  try {
    let parts;
    try { parts = await YoutubeTranscript.fetchTranscript(id); }
    catch { return res.status(400).json({ error: 'No captions available for this video. Try one with subtitles/CC.' }); }
    let text = parts.map(p => p.text).join(' ').replace(/&amp;#39;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    const minutes = Math.round((parts[parts.length - 1].offset + (parts[parts.length - 1].duration || 0)) / (parts[parts.length - 1].offset > 5000 ? 60000 : 60));
    if (text.length < 200) return res.status(400).json({ error: 'Transcript too short to study from' });
    if (text.length > 120000) text = text.slice(0, 120000);
    let ytTitle = '';
    try {
      const o = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id));
      ytTitle = (await o.json()).title || '';
    } catch {}
    const msg = await anthropic.messages.create({
      model: MODEL, max_tokens: 16000, system: SYSTEM,
      messages: [{ role: 'user', content: `Video title: ${ytTitle}\nApprox length: ${minutes} minutes\n\nTranscript:\n${text}` }],
    });
    const raw = msg.content.map(c => c.text || '').join('').replace(/^```json|```$/gm, '').trim();
    const data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const title = data.title || ytTitle || 'Untitled video';
    const r = db.prepare('INSERT INTO generations(user_id,url,title,data,created_at) VALUES(?,?,?,?,?)')
      .run(u.id, url, title, JSON.stringify(data), Date.now());
    if (!isActive(u)) db.prepare('UPDATE users SET free_used=free_used+1 WHERE id=?').run(u.id);
    res.json({ id: r.lastInsertRowid, title, data, user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not generate. Please try again.' });
  }
});
app.get('/api/generations', auth, (req, res) =>
  res.json(db.prepare('SELECT id,title,url,created_at FROM generations WHERE user_id=? ORDER BY id DESC').all(req.user.id)));
app.get('/api/generations/:id', auth, (req, res) => {
  const g = db.prepare('SELECT * FROM generations WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  res.json({ id: g.id, title: g.title, url: g.url, data: JSON.parse(g.data) });
});
app.delete('/api/generations/:id', auth, (req, res) => {
  db.prepare('DELETE FROM generations WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------- Payments (Mobile Money, manual approval) ----------
app.post('/api/payments', auth, (req, res) => {
  const { reference, payer_number } = req.body || {};
  if (!reference || !payer_number) return res.status(400).json({ error: 'Enter the MoMo number you paid from and the transaction ID' });
  db.prepare('INSERT INTO payments(user_id,reference,payer_number,amount,created_at) VALUES(?,?,?,?,?)')
    .run(req.user.id, reference.trim(), payer_number.trim(), parseFloat(getSettings().price), Date.now());
  res.json({ ok: true });
});
app.get('/api/payments/mine', auth, (req, res) =>
  res.json(db.prepare('SELECT * FROM payments WHERE user_id=? ORDER BY id DESC').all(req.user.id)));

// ---------- Library ----------
app.get('/api/materials', auth, (req, res) =>
  res.json(db.prepare('SELECT id,title,category,description,link,(file IS NOT NULL AND file!="") AS has_file,created_at FROM materials ORDER BY id DESC').all()));
app.get('/api/materials/:id/download', (req, res) => {
  try {
    const p = jwt.verify(req.query.t || '', JWT_SECRET);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.id);
    if (!u || !isActive(u)) return res.status(402).send('Subscription required');
    const m = db.prepare('SELECT * FROM materials WHERE id=?').get(req.params.id);
    if (!m || !m.file) return res.status(404).send('Not found');
    res.download(path.join(UPLOAD_DIR, m.file), m.title.replace(/[^\w.-]+/g, '_') + path.extname(m.file));
  } catch { res.status(401).send('Please log in'); }
});

// ---------- Admin ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, f, cb) => cb(null, Date.now() + '-' + f.originalname.replace(/[^\w.-]+/g, '_')),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});
const A = [auth, adminOnly];
app.get('/api/admin/stats', A, (req, res) => res.json({
  users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
  active: db.prepare('SELECT COUNT(*) c FROM users WHERE sub_until>?').get(Date.now()).c,
  pending: db.prepare("SELECT COUNT(*) c FROM payments WHERE status='pending'").get().c,
  generations: db.prepare('SELECT COUNT(*) c FROM generations').get().c,
}));
app.get('/api/admin/payments', A, (req, res) => res.json(db.prepare(
  'SELECT p.*,u.name,u.email FROM payments p JOIN users u ON u.id=p.user_id ORDER BY (p.status="pending") DESC, p.id DESC').all()));
app.post('/api/admin/payments/:id/:action', A, (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
  if (!p || p.status !== 'pending') return res.status(400).json({ error: 'Already handled' });
  if (req.params.action === 'approve') {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.user_id);
    const base = Math.max(Date.now(), u.sub_until);
    db.prepare('UPDATE users SET sub_until=? WHERE id=?').run(base + 30 * DAY, u.id);
    db.prepare("UPDATE payments SET status='approved' WHERE id=?").run(p.id);
  } else db.prepare("UPDATE payments SET status='rejected' WHERE id=?").run(p.id);
  res.json({ ok: true });
});
app.get('/api/admin/users', A, (req, res) => res.json(
  db.prepare('SELECT id,name,email,is_admin,sub_until,free_used,created_at FROM users ORDER BY id DESC').all()));
app.post('/api/admin/users/:id/grant', A, (req, res) => {
  const days = parseInt(req.body.days);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u || isNaN(days)) return res.status(400).json({ error: 'Bad request' });
  const next = days <= 0 ? 0 : Math.max(Date.now(), u.sub_until) + days * DAY;
  db.prepare('UPDATE users SET sub_until=? WHERE id=?').run(next, u.id);
  res.json({ ok: true });
});
app.post('/api/admin/materials', A, upload.single('file'), (req, res) => {
  const { title, category, description, link } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  if (!req.file && !link) return res.status(400).json({ error: 'Upload a file or add a link' });
  db.prepare('INSERT INTO materials(title,category,description,file,link,created_at) VALUES(?,?,?,?,?,?)')
    .run(title, category || 'Textbook', description || '', req.file ? req.file.filename : '', link || '', Date.now());
  res.json({ ok: true });
});
app.put('/api/admin/materials/:id', A, (req, res) => {
  const { title, category, description, link } = req.body;
  db.prepare('UPDATE materials SET title=?,category=?,description=?,link=? WHERE id=?')
    .run(title, category, description, link || '', req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/materials/:id', A, (req, res) => {
  const m = db.prepare('SELECT * FROM materials WHERE id=?').get(req.params.id);
  if (m && m.file) fs.rm(path.join(UPLOAD_DIR, m.file), () => {});
  db.prepare('DELETE FROM materials WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.put('/api/admin/settings', A, (req, res) => {
  for (const k of Object.keys(DEFAULTS))
    if (req.body[k] !== undefined) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(k, String(req.body[k]));
  res.json(getSettings());
});

app.listen(process.env.PORT || 3000, () => console.log('NoteWise running on port ' + (process.env.PORT || 3000)));
