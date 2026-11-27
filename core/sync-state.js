/**
 * Synchronisation — lignes de la base → état de l'application (chargement d'une entreprise, exercices
 * clos). Séparé de core/sync.js (état → opérations) ; réexporté par lui.
 */

import { DEFAULT_BANK_ACCOUNT } from './bank.js?v=e8e3fd1';
import { parisDateOf } from './dates.js?v=e8e3fd1';

// ------------------------------------------------------------------ lignes → état

function letterValue(code) {
  let n = 0;
  for (const ch of code) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/**
 * @param {object} r lignes lues en base : { structure, fiscalYear, bankAccountId, entries (avec
 *   entry_lines), invoices, counters, settlements, clients, purchases, transactions }
 */
function draftFromRow(i) {
  const x = i.extra || {};
  const draft = {
    id: i.id,
    type: i.type,
    series: i.series,
    status: 'draft',
    number: null,
    deposits: x.deposits || [],
    client: i.client,
    issueDate: i.issue_date,
    dueDate: i.due_date,
    lines: i.lines,
  };
  if (i.credit_of) draft.creditOf = i.credit_of;
  for (const k of ['quoteRef', 'recurringId', 'period', 'deliveryDate', 'deliveryAddress', 'deliveryCountry', 'reason', 'rebillOf', 'attachReceipt'])
    if (x[k]) draft[k] = x[k];
  return draft;
}

/** Grand livre d'un exercice (clos ou non) à partir de ses écritures en base, pour consultation. */
export function ledgerStateFromRows(entries, fiscalYear) {
  const list = [...entries]
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({
      seq: Number(e.seq),
      id: e.id,
      journal: e.journal,
      date: e.entry_date,
      label: e.label,
      pieceRef: e.piece_ref,
      pieceDate: e.piece_date,
      source: e.source,
      status: e.status,
      number: e.number,
      validatedAt: e.validated_at,
      reversalOf: e.reversal_of,
      lines: [...e.entry_lines]
        .sort((a, b) => a.line_no - b.line_no)
        .map((l) => ({
          account: l.account,
          aux: l.aux,
          auxLabel: l.aux_label,
          label: l.label,
          debit: Number(l.debit),
          credit: Number(l.credit),
          letter: l.letter,
          letterDate: l.letter_date || '',
        })),
    }));
  return {
    entries: list,
    lockedThrough: fiscalYear.locked_through,
    lastNumber: fiscalYear.last_entry_number,
    lastLetter: 0,
    auditLog: [],
    seq: list.length ? list.at(-1).seq : 0,
    fiscalYear: { start: fiscalYear.start_date, end: fiscalYear.end_date },
  };
}

/** Regroupement par clé (Object.groupBy n'existe qu'à partir de Node 21 et des navigateurs de 2024). */
function groupBy(list, key) {
  const out = {};
  for (const x of list) (out[key(x)] ||= []).push(x);
  return out;
}

export function stateFromRows(r) {
  const s = r.structure;
  const company = {
    ...(s.settings || {}),
    name: s.name,
    siren: s.siren,
    legalForm: s.legal_form,
    taxRegime: s.tax_regime,
    vatRegime: s.vat_regime,
    vatOnDebits: s.vat_on_debits,
    fiscalYear: { start: r.fiscalYear.start_date, end: r.fiscalYear.end_date },
  };
  // Relances envoyées par e-mail depuis la base (journal email_log) : ajoutées à l'historique de la
  // facture si ce niveau n'y figure pas déjà.
  for (const e of r.emails || []) {
    if (!e.invoice_id || !e.level) continue;
    const history = company.reminders?.[e.invoice_id] || [];
    if (history.some((h) => h.level === e.level)) continue;
    company.reminders = { ...(company.reminders || {}), [e.invoice_id]: [...history, { level: e.level, date: parisDateOf(e.sent_at) }] };
  }

  // Comptes bancaires : le compte en 512000 est le compte principal (« default » dans l'état local).
  const bankRows = r.bankAccounts || [];
  const primaryBankId = (bankRows.find((x) => x.gl_account === '512000') || bankRows[0])?.id || r.bankAccountId || null;
  const bankAccounts = [
    ...bankRows
      .filter((x) => x.id === primaryBankId)
      .map((x) => ({ ...DEFAULT_BANK_ACCOUNT, label: x.label || DEFAULT_BANK_ACCOUNT.label, ibanLast4: x.iban_last4 || null })),
    ...bankRows
      .filter((x) => x.id !== primaryBankId)
      .map((x) => ({ id: x.id, label: x.label, glAccount: x.gl_account, provider: x.provider || 'manual', ibanLast4: x.iban_last4 || null })),
  ];
  if (!bankAccounts.length) bankAccounts.push({ ...DEFAULT_BANK_ACCOUNT });

  const entries = [...r.entries]
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({
      seq: Number(e.seq),
      id: e.id,
      journal: e.journal,
      date: e.entry_date,
      label: e.label,
      pieceRef: e.piece_ref,
      pieceDate: e.piece_date,
      source: e.source,
      status: e.status,
      number: e.number,
      validatedAt: e.validated_at,
      reversalOf: e.reversal_of,
      lines: [...e.entry_lines]
        .sort((a, b) => a.line_no - b.line_no)
        .map((l) => ({
          account: l.account,
          aux: l.aux,
          auxLabel: l.aux_label,
          label: l.label,
          debit: Number(l.debit),
          credit: Number(l.credit),
          letter: l.letter,
          letterDate: l.letter_date || '',
        })),
    }));
  const letters = entries.flatMap((e) => e.lines.map((l) => l.letter)).filter(Boolean);

  const payments = {};
  const purchasePayments = {};
  for (const st of [...r.settlements].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
    const p = {
      amount: Number(st.amount),
      date: st.pay_date,
      ref: st.ref,
      entryId: st.entry_id,
      lineIndex: st.line_index,
      ...(st.vat_date ? { vatDate: st.vat_date } : {}),
    };
    const target = st.doc_kind === 'invoice' ? payments : purchasePayments;
    (target[st.doc_id] ||= []).push(p);
  }

  const invoices = [...r.invoices]
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map((i) => (i.status === 'issued' ? { ...i.issued, id: i.id, status: 'issued', number: i.number } : draftFromRow(i)));

  return {
    company,
    ledger: {
      entries,
      lockedThrough: r.fiscalYear.locked_through,
      lastNumber: r.fiscalYear.last_entry_number,
      // Code n° n = valeur − 702 (codes à 3 lettres, voir Ledger) ; un ancien code plus court compte pour 0.
      lastLetter: letters.length ? Math.max(0, ...letters.map((c) => letterValue(c) - 702)) : 0,
      auditLog: [],
      seq: entries.length ? Math.max(...entries.map((e) => e.seq)) : 0,
    },
    book: {
      invoices,
      counters: Object.fromEntries(r.counters.map((c) => [c.series_key, c.last_number])),
      seq: invoices.length,
      payments,
      lifecycle: Object.fromEntries(
        Object.entries(groupBy(r.events || [], (e) => e.invoice_id)).map(([id, list]) => [
          id,
          list.sort((a, b) => a.position - b.position).map((e) => ({ status: e.status, date: e.event_date, source: e.source, detail: e.detail })),
        ]),
      ),
    },
    clients: r.clients.map((c) => ({ ...c.data, id: c.id, code: c.code, name: c.name })),
    purchases: [...r.purchases]
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((p) => {
        const pays = purchasePayments[p.id] || [];
        return {
          id: p.id,
          supplier: p.supplier,
          date: p.purchase_date,
          number: p.number,
          documentName: p.document_name,
          lines: p.lines,
          entryId: p.entry_id,
          ...(p.kind === 'credit' ? { type: 'credit' } : {}),
          ...(p.reverse_charge ? { reverseCharge: true } : {}),
          ...(p.external_ref ? { externalRef: p.external_ref } : {}),
          ...(p.due_date ? { dueDate: p.due_date } : {}),
          ...(p.receipt_url ? { receiptUrl: p.receipt_url } : {}),
          totalTtc: Number(p.total_ttc),
          paid: pays.reduce((sum, x) => sum + x.amount, 0),
          payments: pays,
          aux: p.aux,
          thirdPartyAccount: p.third_party_account,
        };
      }),
    bankAccounts,
    transactions: [...r.transactions]
      .sort((a, b) => String(a.imported_at).localeCompare(String(b.imported_at)) || a.id.localeCompare(b.id))
      .map((t) => ({
        id: t.id,
        accountId: t.bank_account_id && t.bank_account_id !== primaryBankId ? t.bank_account_id : 'default',
        date: t.tx_date,
        label: t.label,
        amount: Number(t.amount),
        status: t.status,
        entryId: t.entry_id || undefined,
        missingReceipt: t.missing_receipt || undefined,
      })),
    recurring: (r.recurring || []).map((x) => ({ ...x.data, id: x.id })),
    payrolls: (r.payrolls || []).map((x) => ({ ...x.data, id: x.id, ref: x.ref, period: x.period, ...(x.entry_id ? { entryId: x.entry_id } : {}) })),
    seq: 0,
  };
}

/**
 * Applique à l'appareil la réponse du serveur à une opération : le numéro d'ordre d'une écriture est
 * attribué par le serveur (migration 0014) et doit être repris localement.
 * @returns {boolean} vrai si l'état local a changé
 */
