# Fahrtenbuch

Minimalistisches Fahrtenbuch als iPhone-Web-App (Safari → „Zum Home-Bildschirm“).
Node.js + Express + SQLite, läuft im Proxmox-LXC hinter einem Cloudflare Tunnel.

- **Neue Fahrt** in vier Schritten, immer nur eine Sache auf dem Bildschirm:
  KM-Stand Beginn (vorbelegt) → KM-Stand Ende (letzte Ziffern reichen) → Zweck (häufige Ziele mit einem Tipp) → Übersicht
- Tagesbudget und Verlauf gegen die Freikilometer
- Monatsabrechnung mit Mehrkilometern und Kosten, Export als PDF oder CSV
- CSV-Import (auch die Dateien der alten Version), Duplikate werden übersprungen

```bash
npm install
npm start          # http://localhost:3000
```

Deployment, Umstieg von der alten Version und Updates: siehe [ANLEITUNG.md](ANLEITUNG.md).
