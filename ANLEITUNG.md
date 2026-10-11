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
App öffnen → rundes **J** oben rechts → **CSV importieren** → eine oder mehrere
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

## D — Neuinstallation von Null (falls der Container mal neu muss)

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
Zusätzlich in der App: Profil → **Alle Fahrten sichern** lädt eine CSV mit allen Fahrten
herunter, die sich jederzeit wieder importieren lässt.

```bash
# Tägliches Backup (crontab -e)
0 3 * * * cp /opt/fahrtenbuch/data/fahrtenbuch.db /mnt/nextcloud-backup/fahrtenbuch_$(date +\%Y-\%m-\%d).db
```
