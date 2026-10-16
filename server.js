// Zeitzone für den Monatsversand (Container laufen oft in UTC)
process.env.TZ = process.env.TZ || 'Europe/Berlin';

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { monthSummary, buildPdf } = require('./report');
const { createMailer } = require('./mailer');
const { createUpdater } = require('./updater');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

// Datenbank öffnen (wird automatisch erstellt falls nicht vorhanden)
// Schema ist identisch zur alten Version → bestehende fahrtenbuch.db funktioniert weiter.
const db = new Database(path.join(DATA_DIR, 'fahrtenbuch.db'));
// Normaler Journal-Modus: die Datenbank ist immer genau eine Datei,
// damit ein einfaches `cp fahrtenbuch.db …` eine vollständige Sicherung ist.
// (Stellt Datenbanken der Vorversion, die im WAL-Modus liefen, automatisch um.)
db.pragma('journal_mode = DELETE');
// Beim Beenden (Neustart, Update) sauber schließen
process.on('exit', () => db.close());
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));

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

  -- Laufende Fahrt: beim Losfahren angelegt, beim Ankommen in trips übernommen
  CREATE TABLE IF NOT EXISTS open_trip (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    date       TEXT NOT NULL,
    purpose    TEXT NOT NULL,
    km_start   TEXT NOT NULL,
    started_at TEXT DEFAULT (datetime('now'))
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

// ── API: Laufende Fahrt ──────────────────────────────────────────────────────

app.get('/api/open', (req, res) => {
  res.json(db.prepare('SELECT * FROM open_trip WHERE id = 1').get() || null);
});

app.put('/api/open', (req, res) => {
  const date = String(req.body.date || '').trim();
  const purpose = String(req.body.purpose || '').trim();
  const km_start = cleanOdo(req.body.km_start);
  if (!ISO_DATE.test(date)) return res.status(400).json({ error: 'Datum fehlt oder ist ungültig' });
  if (!purpose) return res.status(400).json({ error: 'Zweck fehlt' });
  if (!km_start) return res.status(400).json({ error: 'KM-Stand Beginn fehlt' });
  const existing = db.prepare('SELECT started_at FROM open_trip WHERE id = 1').get();
  db.prepare(
    `INSERT OR REPLACE INTO open_trip (id, date, purpose, km_start, started_at)
     VALUES (1, ?, ?, ?, COALESCE(?, datetime('now')))`
  ).run(date, purpose, km_start, existing ? existing.started_at : null);
  res.json(db.prepare('SELECT * FROM open_trip WHERE id = 1').get());
});

app.delete('/api/open', (req, res) => {
  db.prepare('DELETE FROM open_trip WHERE id = 1').run();
  res.json({ ok: true });
});

// Fahrt beenden: laufende Fahrt + Endstand → normaler Eintrag
app.post('/api/open/finish', (req, res) => {
  const open = db.prepare('SELECT * FROM open_trip WHERE id = 1').get();
  if (!open) return res.status(404).json({ error: 'Keine laufende Fahrt' });
  const km_end = cleanOdo(req.body.km_end);
  const { trip, error } = validateTrip({ date: open.date, purpose: open.purpose, km_start: open.km_start, km_end });
  if (error) return res.status(400).json({ error });
  if (!km_end || Number(km_end) <= Number(open.km_start)) {
    return res.status(400).json({ error: 'Endstand muss größer als der Beginn sein' });
  }
  const created = db.transaction(() => {
    const r = db.prepare(
      'INSERT INTO trips (date, purpose, km_start, km_end, km) VALUES (@date, @purpose, @km_start, @km_end, @km)'
    ).run(trip);
    db.prepare('DELETE FROM open_trip WHERE id = 1').run();
    return db.prepare('SELECT * FROM trips WHERE id = ?').get(r.lastInsertRowid);
  })();
  res.status(201).json(created);
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
  db.prepare("SELECT key, value FROM settings WHERE key IN ('freeKm', 'pricePerKm')").all().forEach(r => {
    s[r.key] = parseFloat(r.value);
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

// ── API: Monatsabrechnung als PDF ────────────────────────────────────────────

app.get('/api/report/:ym.pdf', (req, res) => {
  const { ym } = req.params;
  if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: 'Ungültiger Monat' });
  const pdf = buildPdf(monthSummary(db, ym));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Fahrtenbuch_${ym}.pdf"`);
  res.send(pdf);
});

// ── API: E-Mail-Versand ──────────────────────────────────────────────────────

const mailer = createMailer(db);
mailer.start();

app.get('/api/mail', (req, res) => res.json(mailer.publicConfig()));

app.post('/api/mail', (req, res) => {
  try { res.json(mailer.save(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Test: schickt die Abrechnung des Vormonats sofort an die eingetragenen Empfänger
let lastTest = 0;
app.post('/api/mail/test', async (req, res) => {
  if (Date.now() - lastTest < 30 * 1000) return res.status(429).json({ error: 'Bitte kurz warten' });
  lastTest = Date.now();
  try {
    const sum = await mailer.send(mailer.previousMonth());
    res.json({ ok: true, month: sum.label });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── API: App-Update von GitHub ───────────────────────────────────────────────

const updater = createUpdater(db, DATA_DIR);

app.get('/api/version', async (req, res) => {
  try { res.json(await updater.version()); }
  catch { res.json({ commit: null }); }   // z. B. nicht per git installiert
});

app.get('/api/update', async (req, res) => {
  try { res.json(await updater.check()); }
  catch (e) { res.status(400).json({ error: `Update-Prüfung fehlgeschlagen: ${e.message}` }); }
});

app.post('/api/update', async (req, res) => {
  try {
    const result = await updater.update();
    res.json(result);
    // Neue Version laden: beenden, systemd startet sofort neu
    if (result.updated && result.restarting) setTimeout(() => process.exit(0), 500);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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
