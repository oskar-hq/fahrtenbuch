// Update aus der App: neueste Version von GitHub holen und neu starten.
// Neustart übernimmt systemd (Restart=always): der Prozess beendet sich nach dem Update selbst.
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const KEEP_BACKUPS = 5;

function run(cmd, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd: ROOT, timeout, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },   // nie auf eine Passwort-Eingabe warten
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.trim());
      const msg = (stderr || stdout || err.message).trim().split('\n').filter(Boolean).slice(-3).join(' ');
      reject(new Error(err.killed ? `${cmd} hat zu lange gebraucht` : msg));
    });
  });
}

function createUpdater(db, dataDir) {
  let busy = false;
  // Unter systemd gesetzt – nur dann startet die App nach dem Beenden von selbst wieder
  const supervised = !!process.env.INVOCATION_ID;

  async function version() {
    const [commit, date, ...subject] = (await run('git', ['log', '-1', '--format=%h|%cI|%s'])).split('|');
    return { commit, date, subject: subject.join('|'), supervised };
  }

  async function branch() {
    return run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  async function check() {
    const b = await branch();
    await run('git', ['fetch', '--quiet', 'origin', b], 60000);
    const log = await run('git', ['log', '--format=%h|%s', `HEAD..origin/${b}`]);
    const commits = log ? log.split('\n').map(l => { const [commit, ...s] = l.split('|'); return { commit, subject: s.join('|') }; }) : [];
    return { ...(await version()), branch: b, commits };
  }

  async function backup() {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    await db.backup(path.join(dataDir, `fahrtenbuch.backup-${stamp}.db`));
    const old = fs.readdirSync(dataDir).filter(f => /^fahrtenbuch\.backup-\d+\.db$/.test(f)).sort().slice(0, -KEEP_BACKUPS);
    old.forEach(f => fs.unlinkSync(path.join(dataDir, f)));
  }

  async function update() {
    if (busy) throw new Error('Update läuft bereits');
    busy = true;
    try {
      const b = await branch();
      const before = await run('git', ['rev-parse', 'HEAD']);
      await backup();
      await run('git', ['pull', '--ff-only', 'origin', b], 120000);
      const after = await run('git', ['rev-parse', 'HEAD']);
      if (before === after) return { updated: false };

      // Abhängigkeiten nur neu installieren, wenn sie sich geändert haben
      const changed = await run('git', ['diff', '--name-only', before, after]);
      if (/^package(-lock)?\.json$/m.test(changed)) {
        try {
          await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], 10 * 60 * 1000);
        } catch (e) {
          await run('git', ['reset', '--hard', before]);   // lieber alte Version behalten als kaputte starten
          throw new Error(`npm install fehlgeschlagen, Update zurückgenommen: ${e.message}`);
        }
      }
      return { updated: true, from: before.slice(0, 7), to: after.slice(0, 7), restarting: supervised };
    } finally {
      busy = false;
    }
  }

  return { version, check, update, supervised };
}

module.exports = { createUpdater };
