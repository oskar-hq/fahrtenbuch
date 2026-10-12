# Fahrtenbuch

Minimalistisches Fahrtenbuch als iPhone-Web-App (Safari → „Zum Home-Bildschirm“).
Node.js + Express + SQLite, läuft im Proxmox-LXC hinter einem Cloudflare Tunnel.

- **Fahrt starten** im Auto: KM-Stand Beginn ist vorbelegt, Ziel mit einem Tipp – fertig
- **Fahrt beenden** am Ziel: alles bis auf die letzten zwei Ziffern steht schon da (Fahrten unter 100 km),
  für längere Fahrten einfach mit ← weiter zurück löschen
- **Nachtragen** und **Bearbeiten** für alles andere, immer nur eine Sache auf dem Bildschirm
- Ein Bildschirm: Kilometer im Monat, Verlauf gegen die Freikilometer, die letzten drei Fahrten; Monate mit ‹ › wechseln
- Monatsabrechnung als PDF oder CSV, auf Wunsch am 1. jeden Monats automatisch per E-Mail
- CSV-Import (auch die Dateien der alten Version), Duplikate werden übersprungen

```bash
npm install
npm start          # http://localhost:3000
```

Deployment, Umstieg von der alten Version und Updates: siehe [ANLEITUNG.md](ANLEITUNG.md).
