/**
 * Statistiques de l'accueil, calculées sur les factures émises : chiffre d'affaires HT mois par mois
 * (12 derniers mois, comparés aux 12 précédents), meilleurs clients, délai moyen de paiement et part
 * des factures réglées après l'échéance. Les avoirs viennent en déduction du mois où ils sont émis.
 */

const monthOf = (iso) => iso.slice(0, 7);

/** Mois AAAA-MM décalé de `delta` mois. */
export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

const signedHt = (inv) => (inv.type === 'credit' ? -1 : 1) * (inv.totals?.totalHt || 0);
const counted = (inv) => inv.status === 'issued' && ['invoice', 'deposit', 'credit'].includes(inv.type) && inv.issueDate;

/**
 * @param {object[]} invoices factures du carnet (ws.book.invoices)
 * @param {object} payments règlements par facture (ws.book.payments)
 * @param {string} today date du jour (AAAA-MM-JJ)
 */
export function salesStats(invoices, payments, today) {
  const current = monthOf(today);
  const months = Array.from({ length: 12 }, (_, i) => shiftMonth(current, i - 11));
  const byMonth = new Map();
  const byClient = new Map();
  const firstMonth = months[0];
  const previousFirst = shiftMonth(firstMonth, -12);
  for (const inv of invoices.filter(counted)) {
    const m = monthOf(inv.issueDate);
    byMonth.set(m, (byMonth.get(m) || 0) + signedHt(inv));
    if (m >= firstMonth && m <= current) {
      const name = inv.client?.name || 'Sans nom';
      byClient.set(name, (byClient.get(name) || 0) + signedHt(inv));
    }
  }
  const series = months.map((month) => ({ month, revenue: byMonth.get(month) || 0, previous: byMonth.get(shiftMonth(month, -12)) || 0 }));
  const total = series.reduce((s, x) => s + x.revenue, 0);
  const previousTotal = [...byMonth].filter(([m]) => m >= previousFirst && m < firstMonth).reduce((s, [, v]) => s + v, 0);
  const topClients = [...byClient]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, revenue]) => ({ name, revenue, share: total > 0 ? revenue / total : 0 }));

  // Factures (hors avoirs) soldées sur les 12 derniers mois : date du dernier règlement.
  const settled = [];
  for (const inv of invoices.filter((i) => counted(i) && i.type !== 'credit')) {
    const list = payments?.[inv.id] || [];
    const paid = list.reduce((s, p) => s + p.amount, 0);
    const due = inv.totals?.netToPay ?? inv.totals?.totalTtc ?? 0;
    if (!list.length || due <= 0 || paid < due) continue;
    const last = list
      .map((p) => p.date)
      .sort()
      .at(-1);
    if (monthOf(last) < firstMonth) continue;
    const days = Math.round((Date.parse(last) - Date.parse(inv.issueDate)) / 86400000);
    settled.push({ days: Math.max(0, days), late: inv.dueDate ? last > inv.dueDate : false });
  }
  const avgPaymentDays = settled.length ? Math.round(settled.reduce((s, x) => s + x.days, 0) / settled.length) : null;
  const lateShare = settled.length ? settled.filter((x) => x.late).length / settled.length : null;
  return { series, total, previousTotal, topClients, avgPaymentDays, lateShare, settledCount: settled.length };
}
