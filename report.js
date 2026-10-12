// Monatsabrechnung als PDF – wird für den Download in der App und für den E-Mail-Versand genutzt.
const { jsPDF } = require('jspdf');
const autoTable = require('jspdf-autotable').default;

const nf = new Intl.NumberFormat('de-DE');
const fmtKm = n => nf.format(Math.round(n));
const fmtEur = n => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDateDE = iso => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
const monthName = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }); };

function monthSummary(db, ym) {
  const trips = db.prepare('SELECT * FROM trips WHERE date LIKE ? ORDER BY date ASC, id ASC').all(ym + '%');
  const s = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(r => { s[r.key] = r.value; });
  const freeKm = parseFloat(s.freeKm) || 0, pricePerKm = parseFloat(s.pricePerKm) || 0;
  const total = trips.reduce((sum, t) => sum + (Number(t.km) || 0), 0);
  const extra = Math.max(0, total - freeKm);
  return { ym, label: monthName(ym), trips, total, extra, cost: extra * pricePerKm, freeKm, pricePerKm };
}

function buildPdf(sum) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const gray = [150, 155, 160];

  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...gray);
  doc.text('Fahrtenbuch', 20, 22);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(24); doc.setTextColor(0);
  doc.text(sum.label, 20, 33);

  [
    ['Gefahren', `${fmtKm(sum.total)} km`],
    ['Freikilometer', `${fmtKm(sum.freeKm)} km`],
    ['Mehrkilometer', `${fmtKm(sum.extra)} km`],
    ['Zu zahlen', `${fmtEur(sum.cost)} EUR`],
  ].forEach(([k, v], i) => {
    const x = 20 + i * 43;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...gray);
    doc.text(k, x, 48);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(0);
    doc.text(v, x, 55);
  });

  autoTable(doc, {
    startY: 66,
    head: [['Datum', 'Zweck der Fahrt', 'KM Start', 'KM Ende', 'KM']],
    body: sum.trips.map(t => [fmtDateDE(t.date), t.purpose, t.km_start || '—', t.km_end || '—', fmtKm(t.km)]),
    foot: [['', '', '', 'Gesamt', `${fmtKm(sum.total)} km`]],
    theme: 'plain',
    styles: { font: 'helvetica', fontSize: 9.5, cellPadding: { top: 3.2, bottom: 3.2, left: 2, right: 2 }, textColor: 20 },
    headStyles: { fontStyle: 'bold', textColor: 150, fontSize: 8.5 },
    footStyles: { fontStyle: 'bold', textColor: 0 },
    columnStyles: { 0: { cellWidth: 26 }, 2: { cellWidth: 22, halign: 'right' }, 3: { cellWidth: 22, halign: 'right' }, 4: { cellWidth: 20, halign: 'right' } },
    didParseCell: d => { if (d.section !== 'body' && d.column.index >= 2) d.cell.styles.halign = 'right'; },
    didDrawCell: d => {
      if (d.section === 'body' || d.section === 'head') {
        doc.setDrawColor(235); doc.setLineWidth(0.2);
        doc.line(d.cell.x, d.cell.y + d.cell.height, d.cell.x + d.cell.width, d.cell.y + d.cell.height);
      }
    },
    margin: { left: 18, right: 18 },
  });

  const ph = doc.internal.pageSize.height;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...gray);
  doc.text(`Erstellt am ${new Date().toLocaleDateString('de-DE')} · Fahrtenbuch`, 20, ph - 12);

  return Buffer.from(doc.output('arraybuffer'));
}

module.exports = { monthSummary, buildPdf, fmtKm, fmtEur };
