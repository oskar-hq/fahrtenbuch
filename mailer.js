// Automatischer Versand der Monatsabrechnung per E-Mail.
// Einmal pro Stunde wird geprüft, ob die Abrechnung für den Vormonat schon raus ist.
// Ab dem 1. um 6 Uhr wird sie verschickt; war der Server aus, holt er das beim nächsten Start nach.
const nodemailer = require('nodemailer');
const { monthSummary, buildPdf, fmtKm, fmtEur } = require('./report');

const SEND_FROM_HOUR = 6;

// Bekannte Anbieter, damit Server und Port meist nicht von Hand eingetragen werden müssen
const PROVIDERS = {
  'gmail.com': ['smtp.gmail.com', 465], 'googlemail.com': ['smtp.gmail.com', 465],
  'gmx.de': ['mail.gmx.net', 465], 'gmx.net': ['mail.gmx.net', 465], 'gmx.at': ['mail.gmx.net', 465],
  'web.de': ['smtp.web.de', 465],
  'outlook.com': ['smtp-mail.outlook.com', 587], 'outlook.de': ['smtp-mail.outlook.com', 587],
  'hotmail.com': ['smtp-mail.outlook.com', 587], 'hotmail.de': ['smtp-mail.outlook.com', 587], 'live.de': ['smtp-mail.outlook.com', 587],
  'icloud.com': ['smtp.mail.me.com', 587], 'me.com': ['smtp.mail.me.com', 587],
  't-online.de': ['securesmtp.t-online.de', 465],
  'posteo.de': ['posteo.de', 465], 'mailbox.org': ['smtp.mailbox.org', 465],
  'yahoo.com': ['smtp.mail.yahoo.com', 465], 'yahoo.de': ['smtp.mail.yahoo.com', 465],
  'freenet.de': ['mx.freenet.de', 465],
};

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const pad2 = n => String(n).padStart(2, '0');

function previousMonth(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function createMailer(db) {
  const get = key => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '';
  const set = (key, value) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));

  function config() {
    return {
      user: get('mail_user'),
      pass: get('mail_pass'),
      host: get('mail_host'),
      port: Number(get('mail_port')) || 465,
      to: get('mail_to').split(',').filter(Boolean),
    };
  }
  const isActive = c => !!(c.user && c.pass && c.host && c.to.length);

  // Was die App zu sehen bekommt – das Passwort verlässt den Server nie
  function publicConfig() {
    const c = config();
    return {
      user: c.user, host: c.host, port: c.port, to: c.to,
      hasPassword: !!c.pass, active: isActive(c),
      lastSent: get('mail_last_sent'), lastError: get('mail_last_error'),
      nextReport: previousMonth(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)),
    };
  }

  function save(body) {
    if (typeof body.user === 'string') {
      const user = body.user.trim();
      if (user && !EMAIL.test(user)) throw new Error('Absender-Adresse ist ungültig');
      set('mail_user', user);
      // Server und Port automatisch vorschlagen, solange noch keiner eingetragen ist
      const known = PROVIDERS[user.split('@')[1]?.toLowerCase()];
      if (known && !get('mail_host')) { set('mail_host', known[0]); set('mail_port', known[1]); }
    }
    if (typeof body.pass === 'string' && body.pass) set('mail_pass', body.pass);
    if (typeof body.host === 'string') set('mail_host', body.host.trim());
    if (body.port !== undefined) {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port ist ungültig');
      set('mail_port', port);
    }
    if (typeof body.to === 'string' || Array.isArray(body.to)) {
      const list = (Array.isArray(body.to) ? body.to : body.to.split(/[\s,;]+/)).map(s => s.trim()).filter(Boolean);
      const bad = list.find(s => !EMAIL.test(s));
      if (bad) throw new Error(`Ungültige Adresse: ${bad}`);
      set('mail_to', [...new Set(list)].join(','));
    }
    // Beim ersten Einrichten nicht rückwirkend den letzten Monat verschicken
    if (!get('mail_last_sent')) set('mail_last_sent', previousMonth());
    return publicConfig();
  }

  async function send(ym) {
    const c = config();
    if (!isActive(c)) throw new Error('E-Mail-Versand ist nicht vollständig eingerichtet');
    const sum = monthSummary(db, ym);
    const transport = nodemailer.createTransport({
      host: c.host, port: c.port, secure: c.port === 465,
      auth: { user: c.user, pass: c.pass },
      connectionTimeout: 15000, greetingTimeout: 15000,
    });
    await transport.sendMail({
      from: `Fahrtenbuch <${c.user}>`,
      to: c.to.join(', '),
      subject: `Fahrtenbuch ${sum.label}: ${fmtKm(sum.total)} km · ${fmtEur(sum.cost)} €`,
      text: [
        'Hallo,', '',
        `anbei die Abrechnung für ${sum.label}.`, '',
        `Gefahren:       ${fmtKm(sum.total)} km (${sum.trips.length} ${sum.trips.length === 1 ? 'Fahrt' : 'Fahrten'})`,
        `Freikilometer:  ${fmtKm(sum.freeKm)} km`,
        `Mehrkilometer:  ${fmtKm(sum.extra)} km`,
        `Zu zahlen:      ${fmtEur(sum.cost)} €`, '',
        'Diese E-Mail wurde automatisch vom Fahrtenbuch verschickt.',
      ].join('\n'),
      attachments: [{ filename: `Fahrtenbuch_${ym}.pdf`, content: buildPdf(sum), contentType: 'application/pdf' }],
    });
    return sum;
  }

  let running = false;
  async function tick() {
    if (running || !isActive(config())) return;
    const now = new Date();
    if (now.getDate() === 1 && now.getHours() < SEND_FROM_HOUR) return;
    const ym = previousMonth(now);
    if (get('mail_last_sent') >= ym) return;
    running = true;
    try {
      await send(ym);
      set('mail_last_sent', ym);
      set('mail_last_error', '');
      console.log(`Abrechnung ${ym} per E-Mail verschickt`);
    } catch (e) {
      // Nächster Versuch automatisch in einer Stunde
      set('mail_last_error', `${now.toLocaleString('de-DE')}: ${e.message}`);
      console.error(`E-Mail-Versand ${ym} fehlgeschlagen:`, e.message);
    } finally {
      running = false;
    }
  }

  function start() {
    setTimeout(tick, 10 * 1000);
    setInterval(tick, 60 * 60 * 1000);
  }

  return { publicConfig, save, send, start, previousMonth };
}

module.exports = { createMailer, previousMonth };
