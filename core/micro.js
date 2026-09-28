/**
 * Micro-entrepreneur (§1, §3.7) : livre des recettes (encaissements), registre des achats,
 * montant à déclarer à l'URSSAF par période, suivi des seuils.
 * Les seuils sont des paramètres datés, à faire valider par l'expert-comptable référent (§2) avant
 * mise en service : la réforme de la franchise en base a été plusieurs fois modifiée en 2025.
 */

import { divRound, sum } from './money.js';

export const THRESHOLDS_2026 = {
  // Franchise en base de TVA (CGI art. 293 B) — seuil de base / seuil majoré
  vatFranchise: {
    biens: { base: 8500000, majore: 9350000 },
    services: { base: 3750000, majore: 4125000 },
  },
  // Plafonds de chiffre d'affaires du régime micro
  microRegime: { biens: 18870000, services: 7760000 },
};

/** Activité URSSAF : vente de marchandises (BIC), prestations BIC, prestations BNC. */
export const ACTIVITY_TYPES = {
  'bic-vente': { label: 'Ventes de marchandises (BIC)', family: 'biens' },
  'bic-services': { label: 'Prestations de services commerciales ou artisanales (BIC)', family: 'services' },
  bnc: { label: 'Prestations de services libérales (BNC)', family: 'services' },
};

/**
 * Livre des recettes : une ligne par encaissement (date, référence, client, montant, mode).
 * @param {{date, invoiceNumber, clientName, amount, method, activity}[]} receipts
 */
export function receiptsBook(receipts, { from, to } = {}) {
  const rows = receipts
    .filter((r) => (!from || r.date >= from) && (!to || r.date <= to))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { rows, total: sum(rows.map((r) => r.amount)) };
}

export function purchasesRegister(purchases, { from, to } = {}) {
  const rows = purchases
    .filter((p) => (!from || p.date >= from) && (!to || p.date <= to))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { rows, total: sum(rows.map((p) => p.amount)) };
}

/** Périodes de déclaration URSSAF : mensuelle ou trimestrielle. */
export function declarationPeriods(year, frequency = 'trimestrielle') {
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = (m) => new Date(Date.UTC(year, m, 0)).getUTCDate();
  if (frequency === 'mensuelle') {
    return Array.from({ length: 12 }, (_, i) => ({ label: `${pad(i + 1)}/${year}`, from: `${year}-${pad(i + 1)}-01`, to: `${year}-${pad(i + 1)}-${lastDay(i + 1)}` }));
  }
  return [1, 2, 3, 4].map((q) => ({ label: `T${q} ${year}`, from: `${year}-${pad(q * 3 - 2)}-01`, to: `${year}-${pad(q * 3)}-${lastDay(q * 3)}` }));
}

/**
 * Date limite de déclaration et de paiement URSSAF d'une période : dernier jour du mois qui suit
 * la fin du trimestre (30 avril, 31 juillet, 31 octobre, 31 janvier) ou du mois déclaré.
 */
export function urssafDeadline(period) {
  const [y, m] = period.to.split('-').map(Number);
  return new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
}

/** Montants à déclarer à l'URSSAF par type d'activité sur une période (chiffre d'affaires encaissé). */
export function urssafDeclaration(receipts, period) {
  const inPeriod = receipts.filter((r) => r.date >= period.from && r.date <= period.to);
  const byActivity = {};
  for (const type of Object.keys(ACTIVITY_TYPES)) {
    byActivity[type] = sum(inPeriod.filter((r) => r.activity === type).map((r) => r.amount));
  }
  return { period, byActivity, total: sum(Object.values(byActivity)) };
}

/**
 * Suivi des seuils sur l'année civile : alerte à 80 % du seuil de base, dépassement du seuil de
 * base (franchise maintenue l'année suivante perdue) et du seuil majoré (perte immédiate).
 */
export function thresholdStatus(receipts, year, thresholds = THRESHOLDS_2026) {
  const inYear = receipts.filter((r) => r.date.startsWith(String(year)));
  const ca = { biens: 0, services: 0 };
  for (const r of inYear) ca[ACTIVITY_TYPES[r.activity]?.family || 'services'] += r.amount;
  const status = (amount, t) => {
    if (amount > t.majore) return 'depasse-majore';
    if (amount > t.base) return 'depasse-base';
    if (amount >= divRound(t.base * 80, 100)) return 'alerte-80';
    return 'ok';
  };
  const mixed = ca.biens > 0 && ca.services > 0;
  const total = ca.biens + ca.services;
  return {
    ca,
    vat: {
      // Activité mixte : le total ne doit pas dépasser le seuil « biens » et la part services le seuil « services ».
      biens: status(mixed ? total : ca.biens, thresholds.vatFranchise.biens),
      services: status(ca.services, thresholds.vatFranchise.services),
    },
    microRegime: {
      biens: (mixed ? total : ca.biens) > thresholds.microRegime.biens ? 'depasse' : 'ok',
      services: ca.services > thresholds.microRegime.services ? 'depasse' : 'ok',
    },
  };
}
