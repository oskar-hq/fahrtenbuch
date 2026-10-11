const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

// Datenbank öffnen (wird automatisch erstellt falls nicht vorhanden)
// Schema ist identisch zur alten Version → bestehende fahrtenbuch.db funktioniert weiter.
const db = new Database(path.join(DATA_DIR, 'fahrtenbuch.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS trips (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    date      TEXT    NOT NULL,
    purpose   TEXT    NOT NULL,
    km_start  TEXT,
    km_end    TEXT,
    km        REAL    NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  INSERT OR IGNORE INTO settings (key, value) VALUES ('freeKm', '300');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('pricePerKm', '0.22');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('name', 'Oskar Jacobsen');
`);

app.use(express.json());
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }));
// PDF-Bibliotheken lokal ausliefern (kein CDN nötig)
const mod = (...p) => path.join(__dirname, 'node_modules', ...p);
app.get('/vendor/jspdf.js', (req, res) => res.sendFile(mod('jspdf', 'dist', 'jspdf.umd.min.js')));
app.get('/vendor/jspdf-autotable.js', (req, res) => res.sendFile(mod('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js')));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) {
    // HTML immer frisch laden, damit Updates sofort in der Home-Screen-App ankommen
    if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// ── Validierung ──────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanOdo(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[^\d]/g, '');
  return s === '' ? null : s;
}

function validateTrip(body) {
  const date = String(body.date || '').trim();
  const purpose = String(body.purpose || '').trim();
  const km_start = cleanOdo(body.km_start);
  const km_end = cleanOdo(body.km_end);
  let km = parseFloat(body.km);
  if (isNaN(km) && km_start && km_end) km = Number(km_end) - Number(km_start);

  if (!ISO_DATE.test(date)) return { error: 'Datum fehlt oder ist ungültig' };
  if (!purpose) return { error: 'Zweck fehlt' };
  if (isNaN(km) || km <= 0) return { error: 'Kilometer fehlen oder sind ungültig' };
  return { trip: { date, purpose, km_start, km_end, km } };
}

// ── API: Fahrten ─────────────────────────────────────────────────────────────

app.get('/api/trips', (req, res) => {
  const trips = db.prepare('SELECT * FROM trips ORDER BY date ASC, id ASC').all();
  res.json(trips);
});

app.get('/api/trips/month/:month', (req, res) => {
  const trips = db.prepare('SELECT * FROM trips WHERE date LIKE ? ORDER BY date ASC, id ASC')
    .all(req.params.month + '%');
  res.json(trips);
});

app.post('/api/trips', (req, res) => {
  const { trip, error } = validateTrip(req.body);
  if (error) return res.status(400).json({ error });
  const result = db.prepare(
    'INSERT INTO trips (date, purpose, km_start, km_end, km) VALUES (@date, @purpose, @km_start, @km_end, @km)'
  ).run(trip);
  res.status(201).json(db.prepare('SELECT * FROM trips WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/trips/:id', (req, res) => {
  const { trip, error } = validateTrip(req.body);
  if (error) return res.status(400).json({ error });
  const result = db.prepare(
    'UPDATE trips SET date = @date, purpose = @purpose, km_start = @km_start, km_end = @km_end, km = @km WHERE id = @id'
  ).run({ ...trip, id: req.params.id });
  if (result.changes === 0) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json(db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id));
});

app.delete('/api/trips/:id', (req, res) => {
  const result = db.prepare('DELETE FROM trips WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json({ ok: true });
});

// ── API: CSV-Import ──────────────────────────────────────────────────────────
// Nimmt die CSV-Dateien an, die die App selbst exportiert
// ("Datum";"Zweck der Fahrt";"KM-Stand Beginn";"KM-Stand Ende";"Kilometer").
// Fahrten, die schon existieren (gleiches Datum, Zweck, KM-Stände und KM), werden übersprungen.

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const delim = (text.split('\n')[0].match(/;/g) || []).length >= (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function toIsoDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? s : null;
}

function tripsFromCsv(text) {
  const trips = [];
  for (const r of parseCsv(text)) {
    const date = toIsoDate(r[0]);
    if (!date) continue; // Kopfzeile, Leerzeilen, Summenzeilen
    const { trip } = validateTrip({
      date,
      purpose: r[1],
      km_start: r[2],
      km_end: r[3],
      km: String(r[4] || '').replace(',', '.'),
    });
    if (trip) trips.push(trip);
  }
  return trips;
}

app.post('/api/import', (req, res) => {
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text.trim()) return res.status(400).json({ error: 'Leere Datei' });
  const trips = tripsFromCsv(text);
  if (!trips.length) return res.status(400).json({ error: 'Keine Fahrten in der Datei gefunden' });

  const exists = db.prepare(
    `SELECT 1 FROM trips WHERE date = @date AND purpose = @purpose
       AND IFNULL(km_start, '') = IFNULL(@km_start, '') AND IFNULL(km_end, '') = IFNULL(@km_end, '')
       AND km = @km`
  );
  const insert = db.prepare(
    'INSERT INTO trips (date, purpose, km_start, km_end, km) VALUES (@date, @purpose, @km_start, @km_end, @km)'
  );
  let added = 0, skipped = 0;
  db.transaction(() => {
    for (const t of trips) {
      if (exists.get(t)) skipped++;
      else { insert.run(t); added++; }
    }
  })();
  res.json({ added, skipped });
});

// ── API: Einstellungen ───────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  const s = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(r => {
    s[r.key] = r.key === 'name' ? r.value : parseFloat(r.value);
  });
  res.json(s);
});

app.post('/api/settings', (req, res) => {
  const { freeKm, pricePerKm, name } = req.body;
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  if (freeKm !== undefined) stmt.run('freeKm', String(freeKm));
  if (pricePerKm !== undefined) stmt.run('pricePerKm', String(pricePerKm));
  if (typeof name === 'string' && name.trim()) stmt.run('name', name.trim().slice(0, 60));
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden' }));

// ── Alle anderen Routen → index.html ─────────────────────────────────────────
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Fahrtenbuch läuft auf http://0.0.0.0:${PORT}`);
});
