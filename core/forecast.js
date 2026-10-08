/**
 * Trésorerie prévisionnelle à 30, 60 et 90 jours : trésorerie du jour, puis mouvements attendus —
 * factures à encaisser (à leur échéance ; en retard : comptées aujourd'hui), factures récurrentes à
 * venir, dépenses à payer (échéance, sinon 30 jours après la facture), TVA à payer (CA3 à son
 * échéance, acomptes de CA12), cotisations URSSAF estimées (micro). L'impôt sur les sociétés n'est pas
 * inclus (acomptes non gérés).
 */

import { addDays } from './dates.js?v=bd59798';
import { dueOccurrences } from './recurring.js?v=bd59798';
import { computeTotals, isVatExempt } from './invoices.js?v=bd59798';

/** Délai de paiement d'une dépense sans échéance connue (usage, à valider par l'expert-comptable). */
export const DEFAULT_SUPPLIER_TERMS_DAYS = 30;

export function cashForecast(ws, today, { horizons = [30, 60, 90] } = {}) {
  const end = addDays(today, Math.max(...horizons));
  const events = [];
  const add = (date, kind, label, amount) => {
    if (!amount || date > end) return;
    events.push({ date: date < today ? today : date, kind, label, amount });
  };

  for (const r of ws.receivables(today)) {
    if (r.outstanding > 0)
      add(r.invoice.dueDate, 'facture', `${r.invoice.number} — ${r.invoice.client?.name || ''}${r.lateDays > 0 ? ' (en retard)' : ''}`, r.outstanding);
  }
  for (const t of ws.recurring || []) {
    const exempt = isVatExempt({ client: t.client, lines: t.lines }, ws.company);
    const ttc = computeTotals({ lines: t.lines }, { franchise: exempt }).totalTtc;
    for (const occ of dueOccurrences({ ...t, nextIndex: t.nextIndex || 0 }, end)) {
      if (occ.date <= today) continue; // déjà facturée (ou à facturer aujourd'hui : comptée avec les factures)
      add(addDays(occ.date, t.paymentDays ?? 30), 'recurrente', `Facture récurrente — ${t.client?.name || ''}`, ttc);
    }
  }
  for (const p of ws.purchases) {
    const left = (p.totalTtc || 0) - (p.paid || 0);
    // Un avoir fournisseur non encore remboursé est une rentrée d'argent.
    if (left > 0)
      add(
        p.dueDate || addDays(p.date, DEFAULT_SUPPLIER_TERMS_DAYS),
        'depense',
        `${p.type === 'credit' ? 'Avoir ' : ''}${p.supplier?.name || 'Dépense'}${p.number ? ` ${p.number}` : ''}`,
        p.type === 'credit' ? left : -left,
      );
  }

  if (ws.company.vatRegime === 'reel-normal') {
    const declared = new Set(ws.vatReturns.map((r) => r.from));
    for (const period of ws.vatPeriods()) {
      if (declared.has(period.from) || period.from > today) continue;
      const deadline = ws.vatDeadline(period);
      if (deadline < today) continue;
      const balance = ws.prepareVatReturn({ from: period.from, to: period.to < today ? period.to : today }).balance;
      if (balance > 0) add(deadline, 'tva', `TVA ${period.label}`, -balance);
    }
  } else if (ws.company.vatRegime === 'reel-simplifie') {
    const adv = ws.vatAdvancesDue();
    const year = today.slice(0, 4);
    if (adv) {
      if (`${year}-07-31` >= today) add(`${year}-07-31`, 'tva', 'Acompte de TVA de juillet', -adv.july);
      if (`${year}-12-31` >= today) add(`${year}-12-31`, 'tva', 'Acompte de TVA de décembre', -adv.december);
    }
  }

  if (ws.company.taxRegime?.startsWith('micro')) {
    const year = Number(today.slice(0, 4));
    for (const p of [...ws.urssafPeriods(year, today), ...ws.urssafPeriods(year + 1, today)]) {
      if (p.record || p.deadline < today) continue;
      add(p.deadline, 'urssaf', `Cotisations URSSAF ${p.label} (estimation)`, -(p.estimate?.total || 0));
    }
  }

  events.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  const start = ws.dashboard(today).cash;
  let running = start;
  let firstNegative = start < 0 ? today : null;
  for (const e of events) {
    running += e.amount;
    e.balance = running;
    if (running < 0 && !firstNegative) firstNegative = e.date;
  }
  return {
    start,
    events,
    firstNegative,
    horizons: horizons.map((days) => {
      const date = addDays(today, days);
      const upTo = events.filter((e) => e.date <= date);
      const inflow = upTo.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
      const outflow = upTo.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);
      return { days, date, inflow, outflow, balance: start + inflow + outflow };
    }),
  };
}
