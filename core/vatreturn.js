/**
 * Déclaration de TVA CA3 (formulaire n° 3310-CA3, régime réel normal) — §3.6 « brouillon de
 * déclaration ligne à ligne avec justification par facture ; écriture de liquidation générée à la
 * validation ».
 *
 * Exigibilité (CGI art. 269) :
 *  - livraisons de biens, et prestations avec option pour les débits : TVA exigible à la facturation ;
 *  - prestations de services sans option : TVA exigible à l'encaissement, au prorata de chaque
 *    règlement reçu (même calcul que l'écriture de bascule 445800 → 445710, bank.js).
 * Les bases par taux sont calculées depuis les factures (justification pièce par pièce) ; les montants
 * de taxe sont rapprochés des comptes 4457 du grand livre et tout écart est signalé.
 *
 * Numéros de lignes du formulaire 3310-CA3 (millésime en vigueur à vérifier chaque année avec
 * l'expert-comptable, notamment après la réforme de la facturation électronique) :
 *   01 ventes et prestations imposables (HT) · 3B achats de services auprès d'un assujetti non établi
 *   en France (autoliquidation) · F2 livraisons intracommunautaires · E2 autres opérations non
 *   imposables · 08 / 9B / 09 / 10 base et taxe aux taux de 20 %, 10 %, 5,5 %, 2,1 % · 17 TVA due
 *   sur achats autoliquidés · 16 total TVA brute · 19 TVA déductible sur immobilisations · 20 sur
 *   autres biens et services · 22 report du crédit précédent · 23 total déductible · 25 crédit ·
 *   28 TVA nette due · 32 total à payer.
 */

import { divRound, sum } from './money.js';

export const RATE_LINES = { 2000: '08', 1000: '9B', 550: '09', 210: '10' };

const inPeriod = (d, { from, to }) => d >= from && d <= to;

/** Part d'une facture exigible dans la période : { share (0..1 en fraction), date, reason }. */
function exigibleParts(inv, payments, period) {
  const onReceipt = inv.operationNature === 'services' && !inv.issuer.vatOnDebits;
  if (!onReceipt) return inPeriod(inv.issueDate, period) ? [{ num: 1, den: 1, date: inv.issueDate, reason: 'facturation' }] : [];
  // Les règlements portent sur le net à payer (acomptes déduits), base de la répartition.
  const due = inv.totals.netToPay;
  return payments.filter((p) => inPeriod(p.date, period)).map((p) => ({ num: p.amount, den: due, date: p.date, reason: 'encaissement' }));
}

/**
 * Prépare la CA3 d'une période à partir du Workspace (factures, paiements, dépenses, grand livre).
 * @param {import('./workspace.js').Workspace} ws
 * @param {{ from: string, to: string }} period
 * @param {{ previousCredit?: number }} opts crédit de TVA reporté de la déclaration précédente
 */
export function prepareCa3(ws, period, { previousCredit = 0 } = {}) {
  const byRate = new Map();
  const justification = [];
  let exemptIntraGoods = 0;
  let otherExempt = 0;

  for (const inv of ws.book.invoices) {
    if (inv.status !== 'issued' || inv.type === 'quote') continue;
    const sign = inv.type === 'credit' ? -1 : 1;
    const parts = exigibleParts(inv, ws.book.payments[inv.id] || [], period);
    for (const part of parts) {
      if (inv.totals.totalVat === 0) {
        // Opération non soumise à la TVA française : livraison intracommunautaire ou autre (autoliquidation, franchise).
        const ht = sign * divRound(inv.totals.totalHt * part.num, part.den);
        const foreignGoods = (inv.client.country || 'FR') !== 'FR' && inv.operationNature !== 'services';
        if (foreignGoods) exemptIntraGoods += ht;
        else otherExempt += ht;
        justification.push({
          line: foreignGoods ? 'F2' : 'E2',
          number: inv.number,
          client: inv.client.name,
          date: part.date,
          reason: part.reason,
          base: ht,
          vat: 0,
        });
        continue;
      }
      // Déduction des acomptes déjà déclarés : la facture finale ne porte que le solde.
      const depositVat = sum((inv.deposits || []).map((d) => d.amountVat));
      const depositHt = sum((inv.deposits || []).map((d) => d.amountHt));
      for (const v of inv.totals.vatBreakdown) {
        if (!v.vat) continue;
        const weight = inv.totals.totalVat ? v.vat / inv.totals.totalVat : 0;
        const base = sign * divRound((v.base - Math.round(depositHt * weight)) * part.num, part.den);
        const vat = sign * divRound((v.vat - Math.round(depositVat * weight)) * part.num, part.den);
        const row = byRate.get(v.rateBp) || { rateBp: v.rateBp, base: 0, vat: 0 };
        row.base += base;
        row.vat += vat;
        byRate.set(v.rateBp, row);
        justification.push({
          line: RATE_LINES[v.rateBp] || '08',
          number: inv.number,
          client: inv.client.name,
          date: part.date,
          reason: part.reason,
          base,
          vat,
        });
      }
    }
  }

  // Grand livre de la période : taxe réellement comptabilisée, déductible, autoliquidation.
  // Hors écritures de liquidation elles-mêmes (sinon une déclaration déjà validée s'annulerait).
  const lines = ws.ledger.lines(period).filter((l) => l.entry.source?.kind !== 'vat-return');
  const net = (acc) => sum(lines.filter((l) => l.account === acc).map((l) => l.credit - l.debit));
  const debitNet = (acc) => -net(acc);
  const collectedLedger = net('445710');
  const reverseCharge = net('445200');
  const deductibleAssets = debitNet('445620');
  const deductibleOther = debitNet('445660');
  const reverseChargeBase = sum(
    ws.purchases.filter((p) => (p.supplier.country || 'FR') !== 'FR' && inPeriod(p.date, period)).map((p) => sum(p.lines.map((l) => l.ht))),
  );

  const rates = [...byRate.values()].sort((a, b) => b.rateBp - a.rateBp);
  const collected = sum(rates.map((r) => r.vat));
  const grossVat = collected + reverseCharge;
  const totalDeductible = deductibleAssets + deductibleOther + previousCredit;
  const balance = grossVat - totalDeductible;

  const warnings = [];
  // La TVA comptabilisée hors factures (écritures manuelles) ou un écart d'arrondi est signalé, jamais masqué.
  if (collectedLedger !== collected) {
    warnings.push(
      `La TVA collectée d'après les factures (${collected / 100} €) diffère de celle comptabilisée en 44571 (${collectedLedger / 100} €) : vérifiez les écritures manuelles de la période.`,
    );
  }
  const drafts = ws.book.invoices.filter((i) => i.status === 'draft' && i.type !== 'quote' && inPeriod(i.issueDate || '', period));
  if (drafts.length) warnings.push(`${drafts.length} facture(s) en brouillon datée(s) de la période ne sont pas prises en compte.`);
  const openTx = ws.transactions.filter((t) => t.status === 'open' && inPeriod(t.date, period));
  if (openTx.length)
    warnings.push(`${openTx.length} mouvement(s) bancaire(s) de la période restent à justifier : des encaissements ou des dépenses peuvent manquer.`);

  const boxes = {
    '01': sum(rates.map((r) => r.base)),
    '3B': reverseChargeBase,
    F2: exemptIntraGoods,
    E2: otherExempt,
    ...Object.fromEntries(
      rates.flatMap((r) => [
        [`${RATE_LINES[r.rateBp] || '08'}-base`, r.base],
        [`${RATE_LINES[r.rateBp] || '08'}-taxe`, r.vat],
      ]),
    ),
    17: reverseCharge,
    16: grossVat,
    19: deductibleAssets,
    20: deductibleOther,
    22: previousCredit,
    23: totalDeductible,
    25: balance < 0 ? -balance : 0,
    28: balance > 0 ? balance : 0,
    32: balance > 0 ? balance : 0,
  };
  return { period, rates, boxes, collected, grossVat, reverseCharge, deductibleAssets, deductibleOther, previousCredit, balance, justification, warnings };
}

/**
 * Écriture de liquidation de la TVA (journal OD, au dernier jour de la période) : soldes les comptes
 * de TVA collectée, due et déductible sur 44551 « TVA à décaisser » ou 44567 « crédit à reporter ».
 */
export function liquidationEntry(ca3) {
  const label = ca3.kind === 'CA12' ? `Liquidation TVA annuelle (CA12) ${ca3.period.from.slice(0, 4)}` : `Liquidation TVA ${ca3.period.from.slice(0, 7)}`;
  const lines = [];
  // Montant signé : positif au débit, négatif au crédit (un collecté négatif — avoirs supérieurs aux
  // ventes du mois — passe ainsi naturellement au crédit).
  const add = (account, amount) => amount && lines.push({ account, label, debit: amount > 0 ? amount : 0, credit: amount < 0 ? -amount : 0 });
  add('445710', ca3.collected);
  add('445200', ca3.reverseCharge);
  add('445620', -ca3.deductibleAssets);
  add('445660', -ca3.deductibleOther);
  add('445670', -ca3.previousCredit);
  add('445810', -(ca3.advances || 0)); // CA12 : acomptes versés imputés
  add(ca3.balance > 0 ? '445510' : '445670', -ca3.balance);
  return {
    journal: 'OD',
    date: ca3.period.to,
    label,
    pieceRef: `${ca3.kind || 'CA3'}-${ca3.period.from.slice(0, 7)}`,
    pieceDate: ca3.period.to,
    source: { kind: 'vat-return', period: ca3.period.from.slice(0, 7) },
    lines,
  };
}

/** Justification exportable (CSV Excel) : une ligne par facture prise en compte. */
export function justificationRows(ca3) {
  return ca3.justification.map((j) => [j.line, j.number, j.client, j.date, j.reason, j.base, j.vat]);
}

// ------------------------------------------------------------------ CA12 (régime réel simplifié)

/**
 * Déclaration annuelle CA12 (formulaire n° 3517-S) : même calcul que la CA3 sur tout l'exercice,
 * diminué des acomptes versés en juillet et décembre (compte 44581). Les montants sont à reporter
 * sur le formulaire officiel ; numéros de cases à confirmer chaque année avec l'expert-comptable.
 */
export function prepareCa12(ws, period, { previousCredit = 0 } = {}) {
  const base = prepareCa3(ws, period, { previousCredit });
  const lines = ws.ledger.lines(period).filter((l) => l.entry.source?.kind !== 'vat-return');
  const advances = sum(lines.filter((l) => l.account === '445810').map((l) => l.debit - l.credit));
  const balance = base.balance - advances;
  return {
    ...base,
    kind: 'CA12',
    advances,
    balance,
    boxes: { ...base.boxes, acomptes: advances, 25: balance < 0 ? -balance : 0, 28: balance > 0 ? balance : 0, 32: balance > 0 ? balance : 0 },
  };
}

/**
 * Acomptes de l'exercice suivant (CGI art. 287-3) : 55 % en juillet et 40 % en décembre de la TVA
 * due au titre de l'exercice précédent, hors TVA déductible sur immobilisations ; aucun acompte si
 * cette base est inférieure à 1 000 €.
 */
export function ca12Advances(previousCa12) {
  const basis = previousCa12.grossVat - previousCa12.deductibleOther;
  if (basis < 100000) return { basis, july: 0, december: 0 };
  return { basis, july: divRound(basis * 55, 100), december: divRound(basis * 40, 100) };
}
