# Fahrtenbuch 2.0 — Anleitung

Läuft weiter im selben Proxmox-LXC-Container, erreichbar unter `fahrtenbuch.oskarjacobsen.de`.
Datenbank-Schema, Port (3000), systemd-Dienst und Cloudflare Tunnel bleiben **unverändert**.

---

## A — Umstieg von der alten Version (einmalig)

Im Container (`pct enter <CONTAINER-ID>` oder per SSH):

```bash
# 1. Dienst stoppen und Datenbank sichern
systemctl stop fahrtenbuch
cp /opt/fahrtenbuch/data/fahrtenbuch.db /root/fahrtenbuch-v1.db

# 2. Alte Version beiseitelegen
mv /opt/fahrtenbuch /opt/fahrtenbuch-v1

# 3. Neue Version von GitHub holen
apt install -y git
git clone https://github.com/oskar-hq/fahrtenbuch.git /opt/fahrtenbuch
#   → Das Repo ist privat: als Benutzername deinen GitHub-Namen, als Passwort
#     einen Personal Access Token (github.com → Settings → Developer settings →
#     Fine-grained tokens, Recht „Contents: Read“ für dieses Repo) eingeben.
#     Damit du ihn nicht jedes Mal brauchst:  git config --global credential.helper store

# 4. Bestehende Datenbank übernehmen
mkdir -p /opt/fahrtenbuch/data
cp /opt/fahrtenbuch-v1/data/fahrtenbuch.db /opt/fahrtenbuch/data/

# 5. Abhängigkeiten installieren und starten
cd /opt/fahrtenbuch
npm install --omit=dev
systemctl start fahrtenbuch
systemctl status fahrtenbuch
```

Alle bisherigen Fahrten sind danach sofort da – die Datenbank ist dieselbe.
Läuft alles, kann `/opt/fahrtenbuch-v1` gelöscht werden.

### Daten aus CSV-Dateien einspielen (optional)

Nur nötig, wenn Fahrten in der Datenbank fehlen (z. B. neue, leere Installation):
App öffnen → Regler-Symbol oben rechts → **CSV importieren** → eine oder mehrere
`Fahrtenbuch_JJJJ-MM.csv` auswählen.

Fahrten, die schon existieren (gleiches Datum, Zweck, KM-Stände), werden übersprungen –
du kannst also gefahrlos alle Dateien auf einmal importieren.

Alternativ vom PC aus:
```bash
curl -X POST -H 'Content-Type: text/csv' --data-binary @Fahrtenbuch_2026-09.csv \
  https://fahrtenbuch.oskarjacobsen.de/api/import
```

---

## B — Als App auf dem iPhone

1. `https://fahrtenbuch.oskarjacobsen.de` in **Safari** öffnen
2. Teilen-Symbol → **Zum Home-Bildschirm**
3. Fertig – startet im Vollbild ohne Safari-Leiste.

Hattest du die alte Version schon auf dem Home-Bildschirm: einmal löschen und neu
hinzufügen, damit das neue Icon übernommen wird.

---

## C — Updates einspielen

```bash
/opt/fahrtenbuch/update.sh
```

Das Skript legt vorher eine Kopie der Datenbank in `data/` ab, holt den neuesten Stand
von GitHub, installiert Abhängigkeiten und startet den Dienst neu.

---

## D — Monatsabrechnung automatisch per E-Mail

In der App: Regler-Symbol oben rechts → **E-Mail-Versand**.

| Feld | Was eintragen |
| --- | --- |
| Empfänger | Eine oder mehrere Adressen, mit Komma getrennt. Leer = Versand aus. |
| Absender | Das Postfach, mit dem verschickt wird. Bei Gmail, GMX, web.de, Outlook, iCloud, T-Online, Posteo u. a. werden Server und Port automatisch eingetragen. |
| Passwort | Passwort dieses Postfachs. **Gmail, iCloud, Outlook:** ein *App-Passwort* aus den Sicherheitseinstellungen des Kontos, nicht das normale Passwort. **GMX/web.de:** vorher im Webmail unter Einstellungen → POP3/IMAP den Versand per SMTP erlauben. |
| Server / Port | Nur bei eigenen Domains nötig, steht beim Anbieter unter „SMTP-Server“ (meist Port 465). |

Mit **Test-E-Mail senden** prüfst du sofort, ob alles stimmt – Fehler (z. B. falsches Passwort) erscheinen direkt als Meldung.

Danach verschickt der Server die PDF-Abrechnung des Vormonats **am 1. jeden Monats ab 6 Uhr** an alle Empfänger. War der Server zu der Zeit aus, wird das beim nächsten Start nachgeholt; schlägt der Versand fehl, versucht er es stündlich erneut und zeigt den Fehler in den Einstellungen an. Beim ersten Einrichten wird nichts rückwirkend verschickt.

Das Passwort liegt nur auf dem Server (in `data/fahrtenbuch.db`) und wird nie an die App zurückgegeben.

### Wichtig: App mit Login absichern

Die App hat selbst keinen Login – wer die Adresse kennt, kann Fahrten sehen und ändern und jetzt auch die E-Mail-Empfänger umstellen. Da sie über den Cloudflare Tunnel öffentlich erreichbar ist, solltest du **Cloudflare Access** davorschalten (kostenlos bis 50 Nutzer):

1. dash.cloudflare.com → **Zero Trust** → Access → **Applications** → *Add an application* → **Self-hosted**
2. Domain: `fahrtenbuch.oskarjacobsen.de`
3. Policy: *Allow* → Include → **Emails** → deine E-Mail-Adresse
4. Speichern. Beim ersten Öffnen bekommst du einen Code per E-Mail, danach bleibt das iPhone angemeldet (Session-Dauer z. B. auf 1 Monat stellen).

Der automatische Versand läuft davon unabhängig direkt auf dem Server.

---

## E — Neuinstallation von Null (falls der Container mal neu muss)

1. **LXC erstellen** (Proxmox → Create CT): Debian 12, 4 GB Disk, 1 Core, 256 MB RAM, unprivileged.
2. **Node.js 20 installieren:**
   ```bash
   apt update && apt upgrade -y && apt install -y curl git
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   apt install -y nodejs
   ```
3. **App holen:** wie in Abschnitt A, Schritt 3 + 5.
4. **systemd-Dienst** `/etc/systemd/system/fahrtenbuch.service`:
   ```ini
   [Unit]
   Description=Fahrtenbuch
   After=network.target

   [Service]
   Type=simple
   User=root
   WorkingDirectory=/opt/fahrtenbuch
   ExecStart=/usr/bin/node server.js
   Restart=always
   RestartSec=5
   Environment=NODE_ENV=production
   Environment=PORT=3000

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   systemctl daemon-reload && systemctl enable --now fahrtenbuch
   ```
5. **Cloudflare Tunnel:**
   ```bash
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
   dpkg -i cloudflared.deb
   cloudflared tunnel login
   cloudflared tunnel create fahrtenbuch
   ```
   `/etc/cloudflared/config.yml`:
   ```yaml
   tunnel: DEINE-TUNNEL-ID
   credentials-file: /root/.cloudflared/DEINE-TUNNEL-ID.json
   ingress:
     - hostname: fahrtenbuch.oskarjacobsen.de
       service: http://localhost:3000
     - service: http_status:404
   ```
   ```bash
   cloudflared tunnel route dns fahrtenbuch fahrtenbuch.oskarjacobsen.de
   cloudflared service install && systemctl enable --now cloudflared
   ```
6. Daten per CSV-Import einspielen (siehe oben) oder eine gesicherte `fahrtenbuch.db` nach `/opt/fahrtenbuch/data/` kopieren.

---

## Nützliches

```bash
journalctl -u fahrtenbuch -f          # App-Logs
systemctl restart fahrtenbuch         # Neustart
sqlite3 /opt/fahrtenbuch/data/fahrtenbuch.db "SELECT * FROM trips;"
```

### Datensicherung

Die komplette Datenbank ist eine Datei: `/opt/fahrtenbuch/data/fahrtenbuch.db`.
Zusätzlich in der App: Regler-Symbol oben rechts → **Alle Fahrten sichern** lädt eine CSV mit allen Fahrten
herunter, die sich jederzeit wieder importieren lässt.

```bash
# Tägliches Backup (crontab -e)
0 3 * * * cp /opt/fahrtenbuch/data/fahrtenbuch.db /mnt/nextcloud-backup/fahrtenbuch_$(date +\%Y-\%m-\%d).db
```
