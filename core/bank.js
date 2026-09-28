/**
 * Banque (§3.4) : import des relevés (CSV, OFX — secours de la synchronisation Qonto / agrégateur),
 * propositions de rapprochement classées par confiance, et écritures de règlement + lettrage.
 * L'import est idempotent : chaque transaction porte un identifiant stable (FITID OFX, identifiant
 * Qonto, ou empreinte date|montant|libellé|rang pour le CSV), et un ré-import ne crée aucun doublon.
 */

import { divRound, parseEuros, sum } from './money.js';

// ------------------------------------------------------------------ import

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function toIsoDate(s) {
  const t = s.trim();
  let m = /^(\d{2})[/.-](\d{2})[/.-](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  throw new Error(`Date non reconnue : « ${s} »`);
}

function splitCsvLine(line, sep) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === sep && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * CSV bancaire français : séparateur « ; » ou « , », colonnes reconnues par leur en-tête
 * (date, libellé, montant — ou débit/crédit séparés).
 */
export function parseBankCsv(text, { accountId = 'default' } = {}) {
  const rows = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (rows.length < 2) return [];
  const sep = (rows[0].match(/;/g) || []).length >= (rows[0].match(/,/g) || []).length ? ';' : ',';
  const header = splitCsvLine(rows[0], sep).map(norm);
  const col = (...names) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const iDate = col('date operation', 'date');
  const iLabel = col('libelle', 'description', 'intitule', 'label');
  const iAmount = col('montant', 'amount');
  const iDebit = col('debit');
  const iCredit = col('credit');
  if (iDate < 0 || iLabel < 0 || (iAmount < 0 && iDebit < 0)) {
    throw new Error('Colonnes attendues introuvables : date, libellé et montant (ou débit/crédit)');
  }
  const seen = new Map();
  return rows.slice(1).map((line) => {
    const c = splitCsvLine(line, sep);
    const date = toIsoDate(c[iDate]);
    const label = c[iLabel];
    let amount;
    if (iAmount >= 0 && c[iAmount]) amount = parseEuros(c[iAmount]);
    else amount = (c[iCredit] ? parseEuros(c[iCredit]) : 0) - Math.abs(c[iDebit] ? parseEuros(c[iDebit]) : 0);
    const base = `${accountId}|${date}|${amount}|${label}`;
    const rank = (seen.get(base) || 0) + 1;
    seen.set(base, rank);
    return { id: `csv-${fnv1a(`${base}|${rank}`)}`, accountId, date, label, amount, status: 'open' };
  });
}

/** OFX (SGML ou XML) : blocs <STMTTRN>, identifiant stable FITID. */
export function parseOfx(text, { accountId = 'default' } = {}) {
  const tag = (block, name) => {
    const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block);
    return m ? m[1].trim() : '';
  };
  return [...text.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|(?=<\/BANKTRANLIST>))/gi)].map(([, b]) => ({
    id: `ofx-${tag(b, 'FITID')}`,
    accountId,
    date: toIsoDate(tag(b, 'DTPOSTED')),
    label: [tag(b, 'NAME'), tag(b, 'MEMO')].filter(Boolean).join(' '),
    amount: parseEuros(tag(b, 'TRNAMT')),
    status: 'open',
  }));
}

/** Fusionne un import dans la liste existante sans doublon ; renvoie les transactions ajoutées. */
export function mergeTransactions(existing, incoming) {
  const ids = new Set(existing.map((t) => t.id));
  const added = incoming.filter((t) => !ids.has(t.id) && ids.add(t.id));
  existing.push(...added);
  return added;
}

// ------------------------------------------------------------------ propositions

const tokens = (s) =>
  norm(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);

function daysBetween(a, b) {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
}

/**
 * Propositions de rapprochement pour une transaction, triées par confiance (0–100).
 * @param {object} tx transaction bancaire (amount > 0 = encaissement)
 * @param {object[]} openDocs pièces ouvertes { id, kind: 'invoice'|'purchase', number, partyName, date, dueDate, outstanding }
 */
export function suggestMatches(tx, openDocs, { maxGroup = 3 } = {}) {
  const wanted = Math.abs(tx.amount);
  // Encaissement : factures clients et avoirs fournisseurs remboursés ; décaissement : dépenses.
  const kinds = tx.amount > 0 ? ['invoice', 'purchase-credit'] : ['purchase'];
  const docs = openDocs.filter((d) => kinds.includes(d.kind) && d.outstanding > 0);
  const label = norm(tx.label);
  const labelTokens = new Set(tokens(tx.label));
  const nameScore = (d) => {
    const t = tokens(d.partyName);
    return t.length && t.some((x) => labelTokens.has(x)) ? 20 : 0;
  };
  const numberInLabel = (d) => d.number && label.replace(/[^a-z0-9]/g, '').includes(norm(d.number).replace(/[^a-z0-9]/g, ''));
  const dateScore = (d) => Math.max(0, 10 - Math.floor(daysBetween(tx.date, d.dueDate || d.date) / 6));

  const out = [];
  for (const d of docs) {
    let score = 0;
    const reasons = [];
    if (d.outstanding === wanted) {
      score += 50;
      reasons.push('montant identique');
    } else if (d.outstanding > wanted) {
      score += 15;
      reasons.push('paiement partiel possible');
    }
    if (numberInLabel(d)) {
      score += 40;
      reasons.push('numéro de facture dans le libellé');
    }
    const ns = nameScore(d);
    if (ns) reasons.push('nom du tiers dans le libellé');
    score += ns + dateScore(d);
    if (score >= 30) out.push({ docs: [d], amounts: [Math.min(wanted, d.outstanding)], score: Math.min(100, score), reasons });
  }

  // Paiement groupé : combinaisons de 2 à maxGroup factures d'un même tiers dont la somme est exacte.
  const byParty = new Map();
  for (const d of docs) byParty.set(d.partyName, [...(byParty.get(d.partyName) || []), d]);
  for (const list of byParty.values()) {
    const combos = [];
    const walk = (start, picked, total) => {
      if (picked.length >= 2 && total === wanted) combos.push([...picked]);
      if (picked.length === maxGroup || total >= wanted) return;
      for (let i = start; i < list.length && combos.length < 5; i++) walk(i + 1, [...picked, list[i]], total + list[i].outstanding);
    };
    walk(0, [], 0);
    for (const combo of combos) {
      const score = Math.min(100, 45 + nameScore(combo[0]) + (combo.every(numberInLabel) ? 30 : 0));
      out.push({ docs: combo, amounts: combo.map((d) => d.outstanding), score, reasons: [`paiement groupé de ${combo.length} factures`] });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

// ------------------------------------------------------------------ écritures de règlement

/**
 * Écriture de banque pour un règlement de pièces (clients ou fournisseurs).
 * @param {object} tx transaction
 * @param {{doc: object, amount: number}[]} allocations montants imputés par pièce
 * @param {{ writeOffThreshold?: number }} opts écart de centimes absorbé en 658/758 (défaut 1 €)
 */
export function settlementEntry(tx, allocations, { writeOffThreshold = 100 } = {}) {
  const incoming = tx.amount > 0;
  const bank = Math.abs(tx.amount);
  const allocated = sum(allocations.map((a) => a.amount));
  const gap = bank - allocated;
  if (Math.abs(gap) > writeOffThreshold && gap < 0) {
    throw new Error(`Le montant imputé (${allocated}) dépasse la transaction (${bank})`);
  }
  const lines = [];
  lines.push({ account: '512000', label: tx.label, debit: incoming ? bank : 0, credit: incoming ? 0 : bank });
  for (const { doc, amount } of allocations) {
    lines.push({
      account: doc.thirdPartyAccount,
      aux: doc.aux,
      auxLabel: doc.partyName,
      label: `Règlement ${doc.number}`,
      debit: incoming ? 0 : amount,
      credit: incoming ? amount : 0,
    });
  }
  if (gap !== 0) {
    if (Math.abs(gap) <= writeOffThreshold) {
      // Écart de centimes : produit (758) si on a reçu plus, charge (658) si on a reçu moins.
      const toRevenue = incoming ? gap > 0 : gap < 0;
      lines.push({
        account: toRevenue ? '758000' : '658000',
        label: 'Écart de règlement',
        debit: toRevenue ? 0 : Math.abs(gap),
        credit: toRevenue ? Math.abs(gap) : 0,
      });
    } else {
      // Trop-perçu significatif : reste sur le compte du tiers (avance), à traiter par l'utilisateur.
      const d = allocations[0].doc;
      lines.push({
        account: d.thirdPartyAccount,
        aux: d.aux,
        auxLabel: d.partyName,
        label: 'Trop-perçu',
        debit: incoming ? 0 : gap,
        credit: incoming ? gap : 0,
      });
    }
  }
  return { journal: 'BQ', date: tx.date, label: tx.label, pieceRef: tx.id, pieceDate: tx.date, source: { kind: 'bank', id: tx.id }, lines };
}

/**
 * Bascule de la TVA sur encaissements : à chaque paiement d'une facture de services, la part de TVA
 * correspondante passe de 445800 (en attente) à 445710 (collectée, exigible).
 */
export function vatOnReceiptEntry(invoice, paidAmount, date) {
  // Facture finale avec acomptes : seule la TVA restant en attente (hors acomptes) est répartie, au
  // prorata du net à payer — c'est lui que les règlements soldent.
  const pendingVat = invoice.totals.totalVat - (invoice.deposits || []).reduce((s, d) => s + d.amountVat, 0);
  const vat = divRound(pendingVat * paidAmount, invoice.totals.netToPay);
  if (!vat) return null;
  return {
    journal: 'OD',
    date,
    label: `TVA exigible sur encaissement ${invoice.number}`,
    pieceRef: invoice.number,
    pieceDate: date,
    source: { kind: 'vat-receipt', id: invoice.id },
    lines: [
      { account: '445800', debit: vat, credit: 0 },
      { account: '445710', debit: 0, credit: vat },
    ],
  };
}

/** Dépense ou recette sans pièce (frais bancaires, abonnement prélevé…), signalée si sans justificatif. */
export function directEntry(tx, { account, vatAccount, vatAmount = 0, missingReceipt = true }) {
  const abs = Math.abs(tx.amount);
  const out = tx.amount < 0;
  const lines = [{ account: '512000', label: tx.label, debit: out ? 0 : abs, credit: out ? abs : 0 }];
  lines.push({ account, label: tx.label, debit: out ? abs - vatAmount : 0, credit: out ? 0 : abs - vatAmount });
  if (vatAmount) lines.push({ account: vatAccount, label: tx.label, debit: out ? vatAmount : 0, credit: out ? 0 : vatAmount });
  return { journal: 'BQ', date: tx.date, label: tx.label, pieceRef: tx.id, pieceDate: tx.date, source: { kind: 'bank', id: tx.id, missingReceipt }, lines };
}

/** État de rapprochement : solde relevé vs solde du 512, avec les suspens. */
export function reconciliationStatement(ledger, transactions, { date, statementBalance }) {
  const bookBalance = ledger.balanceOf('512', { to: date });
  const pending = transactions.filter((t) => t.date <= date && t.status === 'open');
  return {
    date,
    statementBalance,
    bookBalance,
    pendingCount: pending.length,
    pendingTotal: sum(pending.map((t) => t.amount)),
    difference: statementBalance - bookBalance - sum(pending.map((t) => t.amount)),
  };
}
