/**
 * Workspace — caisse : sessions (ouverture, clôture), ventes, retours, factures demandées sur un
 * ticket et versements du prestataire de paiement par carte. Les ventes en mode test sont gardées à
 * part : ni écriture, ni stock, ni recette.
 * Méthodes installées sur Workspace.prototype (voir core/workspace.js).
 */

import { divRound, sum, vatFromHt } from '../money.js?v=151777b';
import { addDays } from '../dates.js?v=151777b';
import { stockLevels } from '../stock.js?v=151777b';
import { buildReturn, buildSale, closeSession, returnedByLine, sessionSummary, ticketNumber } from '../pos/sale.js?v=151777b';
import { computeTotals } from '../invoices.js?v=151777b';
import { CARD_ACCOUNT, closingGapEntry, payoutEntry, posReturnEntry, posSaleEntry } from '../pos/entries.js?v=151777b';

export const emptyPos = () => ({ sessions: [], sales: [], returns: [], payouts: [], counters: {} });

/** HT d'un TTC tel que HT + TVA(HT) redonne exactement le TTC quand c'est possible. */
export function htForTtc(ttc, rateBp) {
  const h = divRound(ttc * 10000, 10000 + rateBp);
  return [h, h - 1, h + 1].find((x) => x + vatFromHt(x, rateBp) === ttc) ?? h;
}

/** Commissions tolérées sur un versement rapproché sans les données du prestataire : 5 % au plus. */
const MAX_FEES_PCT = 5;

export const posMethods = {
  _pos() {
    return (this.pos ||= emptyPos());
  },

  /** Numéro suivant (local : démonstration ; en ligne, la base attribue le numéro et l'appelant le fournit). */
  _posNumber(prefix, date, mode) {
    const year = date.slice(0, 4);
    const key = `${mode === 'test' ? 'TEST-' : ''}${prefix}${year}`;
    const n = (this._pos().counters[key] || 0) + 1;
    this._pos().counters[key] = n;
    return ticketNumber(prefix, year, n, mode);
  },

  openSession({ registerId, user, at, openingFloat = 0 }) {
    if (this.currentSession(registerId)) throw new Error('Cette caisse est déjà ouverte.');
    if (!Number.isSafeInteger(openingFloat) || openingFloat < 0) throw new Error('Fonds de caisse illisible.');
    const session = { id: this._id('Z'), registerId, openedAt: at, openedBy: user, openingFloat, closedAt: null };
    this._pos().sessions.push(session);
    return session;
  },

  currentSession(registerId) {
    return this._pos().sessions.find((s) => s.registerId === registerId && !s.closedAt) || null;
  },

  sessionSummary(sessionId) {
    const s = this._pos().sessions.find((x) => x.id === sessionId);
    return sessionSummary(s, this._pos().sales, this._pos().returns);
  },

  /** Clôture de caisse (responsable) : écart entre espèces comptées et attendues passé en 658 / 758. */
  closeRegister(sessionId, { countedCash, at, user, mode = 'live' }) {
    const idx = this._pos().sessions.findIndex((x) => x.id === sessionId);
    const closed = closeSession(this._pos().sessions[idx], this.sessionSummary(sessionId), { countedCash, at, user });
    this._pos().sessions[idx] = closed;
    const entry = mode === 'live' ? closingGapEntry(closed) : null;
    if (entry) closed.entryId = this.ledger.addDraft(entry).id;
    return closed;
  },

  /** Clôture faite par la base (mode connecté) : session remplacée, écart passé en écriture. */
  applySessionClose(closed) {
    const idx = this._pos().sessions.findIndex((x) => x.id === closed.id);
    if (idx < 0) this._pos().sessions.push(closed);
    else this._pos().sessions[idx] = { ...this._pos().sessions[idx], ...closed };
    const s = this._pos().sessions.find((x) => x.id === closed.id);
    const entry = s.mode !== 'test' && !s.entryId ? closingGapEntry(s) : null;
    if (entry) s.entryId = this.ledger.addDraft(entry).id;
    return s;
  },

  /**
   * Vente encaissée : ticket figé, écriture de recette (mode réel seulement). `id` et `number` sont
   * fournis par la base en mode connecté ; sinon attribués ici.
   */
  recordSale({ id, number, registerId, sessionId, cashier, at, mode = 'live', lines, payments }) {
    return this._atomic(() => {
      const sale = buildSale({
        id: id || this._id('V'),
        number: number || this._posNumber('T', at, mode),
        registerId,
        sessionId,
        cashier,
        at,
        mode,
        lines,
        payments,
      });
      if (this._pos().sales.some((s) => s.id === sale.id)) return this._pos().sales.find((s) => s.id === sale.id);
      for (const p of sale.payments.filter((x) => x.attemptId))
        if (this._pos().sales.some((s) => s.payments.some((q) => q.attemptId === p.attemptId)))
          throw new Error('Ce paiement par carte est déjà rattaché à une autre vente.');
      if (mode === 'live') sale.entryId = this.ledger.addDraft(posSaleEntry(sale)).id;
      this._pos().sales.push(sale);
      return sale;
    });
  },

  posSale(id) {
    return this._pos().sales.find((s) => s.id === id) || null;
  },

  /** Retour sur un ticket : espèces rendues aussitôt ; carte en attente de la confirmation du prestataire. */
  recordReturn(saleId, { id, number, at, user, reason, wanted, refundMethod }) {
    return this._atomic(() => {
      const sale = this.posSale(saleId);
      if (!sale) throw new Error('Ticket introuvable.');
      const ret = buildReturn(sale, this._pos().returns, {
        id: id || this._id('R'),
        number: number || this._posNumber('R', at, sale.mode),
        at,
        user,
        reason,
        wanted,
        refundMethod,
      });
      ret.sessionId = this.currentSession(sale.registerId)?.id || null;
      this._pos().returns.push(ret);
      if (ret.refund.status === 'done' && ret.mode === 'live' && ret.totals.totalTtc) ret.entryId = this.ledger.addDraft(posReturnEntry(ret)).id;
      return ret;
    });
  },

  /** Remboursement carte confirmé (ou refusé) par le prestataire. */
  completeRefund(returnId, { status, refundId }) {
    const ret = this._pos().returns.find((r) => r.id === returnId);
    if (!ret || ret.refund.status === 'done') return ret;
    ret.refund = { ...ret.refund, status, refundId: refundId || ret.refund.refundId || null };
    if (status === 'done' && ret.mode === 'live' && ret.totals.totalTtc && !ret.entryId) ret.entryId = this.ledger.addDraft(posReturnEntry(ret)).id;
    return ret;
  },

  /**
   * Facture demandée par le client sur un ticket déjà encaissé : brouillon rattaché à la vente, sans
   * nouvelle recette ni sortie de stock (la vente les a déjà comptées), réglé d'office.
   */
  invoiceFromSale(saleId, clientId, today) {
    const sale = this.posSale(saleId);
    if (!sale || sale.mode !== 'live') throw new Error('Ticket introuvable.');
    if (sale.invoiceId && this.book.invoices.some((i) => i.id === sale.invoiceId)) throw new Error('Une facture existe déjà pour ce ticket.');
    const client = this.clients.find((c) => c.id === clientId);
    if (!client) throw new Error('Choisissez le client.');
    const lines = this._saleInvoiceLines(sale);
    if (!lines.length) throw new Error('Tous les articles de ce ticket ont été rendus : rien à facturer.');
    const draft = this.book.createDraft({
      client: structuredClone(client),
      issueDate: today,
      dueDate: addDays(today, 0),
      lines,
      saleId: sale.id,
      saleRef: sale.number,
    });
    sale.invoiceId = draft.id;
    return draft;
  },

  /**
   * Lignes de facture d'un ticket, retours déduits : HT par taux tel que HT + TVA = TTC encaissé,
   * réparti entre les articles au prorata (reste sur le dernier).
   */
  _saleInvoiceLines(sale) {
    const done = returnedByLine(sale, this._pos().returns);
    const net = sale.lines
      .map((l, i) => ({ ...l, qty: Math.round((l.qty - (done[i]?.qty || 0)) * 1000) / 1000, ttc: l.ttc - (done[i]?.ttc || 0) }))
      .filter((l) => l.ttc > 0);
    const lines = [];
    for (const rate of [...new Set(net.map((l) => l.vatRateBp))].sort((a, b) => b - a)) {
      const ofRate = net.filter((l) => l.vatRateBp === rate);
      const ttc = sum(ofRate.map((l) => l.ttc));
      const ht = htForTtc(ttc, rate);
      let left = ht;
      ofRate.forEach((l, i) => {
        const part = i === ofRate.length - 1 ? left : divRound(ht * l.ttc, ttc);
        left -= part;
        lines.push({
          label: `${l.label}${l.qty !== 1 ? ` (× ${String(l.qty).replace('.', ',')})` : ''}`,
          qty: 1,
          unitPrice: part,
          vatRateBp: rate,
          nature: l.nature,
        });
      });
    }
    return lines;
  },

  /** Facture d'un ticket : son montant ne peut pas s'écarter de ce que le client a payé (retours déduits). */
  _checkSaleInvoice(draft) {
    const sale = this.posSale(draft.saleId);
    if (!sale) throw new Error('Ticket de caisse introuvable pour cette facture.');
    const done = returnedByLine(sale, this._pos().returns);
    const expected = sale.totals.totalTtc - sum(Object.values(done).map((d) => d.ttc));
    const actual = computeTotals(draft, { franchise: this.company.vatRegime === 'franchise' }).totalTtc;
    if (actual !== expected)
      throw new Error(
        `La facture du ticket ${sale.number} doit faire ${(expected / 100).toFixed(2).replace('.', ',')} € TTC, comme le ticket (retours déduits).`,
      );
  },

  /** Stock avec les ventes et retours de caisse. */
  stockLevels() {
    return stockLevels(this.company.catalog, this.stockMoves, this.book.invoices, this._pos());
  },

  /** Ventes et retours réels de l'exercice sans écriture (enregistrement interrompu) : écritures passées. */
  ensurePosEntries() {
    const fy = this.ledger.fiscalYear;
    const has = new Set(this.ledger.entries.map((e) => e.source?.kind?.startsWith('pos-') && e.source.id).filter(Boolean));
    let n = 0;
    for (const s of this._pos().sales)
      if (s.mode === 'live' && s.date >= fy.start && s.date <= fy.end && !has.has(s.id)) {
        s.entryId = this.ledger.addDraft(posSaleEntry(s)).id;
        n++;
      }
    for (const r of this._pos().returns)
      if (r.mode === 'live' && r.refund.status === 'done' && r.totals.totalTtc && r.date >= fy.start && r.date <= fy.end && !has.has(r.id)) {
        r.entryId = this.ledger.addDraft(posReturnEntry(r)).id;
        n++;
      }
    return n;
  },

  /** Paiements par carte pas encore versés par le prestataire (solde du compte 5115). */
  cardBalance() {
    return this.ledger.balanceOf(CARD_ACCOUNT);
  },

  /**
   * Versement du prestataire reçu en banque. Avec ses données (brut, commissions), l'écriture est
   * exacte ; sans elles, commissions = solde à verser − montant reçu, dans la limite de 5 %.
   */
  payoutSuggestion(txId) {
    const tx = this.transactions.find((t) => t.id === txId);
    if (!tx || tx.amount <= 0) return null;
    const gross = this.cardBalance();
    const fees = gross - tx.amount;
    if (gross <= 0 || fees < 0 || fees > divRound(gross * MAX_FEES_PCT, 100)) return null;
    return { gross, net: tx.amount, fees };
  },

  recordPayout(txId, { gross, fees, payoutId = '' }) {
    const tx = this.transactions.find((t) => t.id === txId);
    if (!tx || tx.status !== 'open') throw new Error('Transaction déjà traitée.');
    if (!Number.isSafeInteger(gross) || !Number.isSafeInteger(fees) || gross - fees !== tx.amount)
      throw new Error('Versement : le brut moins les commissions doit égaler le montant reçu en banque.');
    return this._atomic(() => {
      const entry = this.ledger.addDraft(
        payoutEntry({
          id: payoutId || tx.id,
          date: tx.date,
          bankAccount: this.bankGlOf(tx),
          net: tx.amount,
          fees,
          gross,
          label: `Versement cartes ${payoutId || tx.label}`,
        }),
      );
      tx.status = 'matched';
      tx.entryId = entry.id;
      this._pos().payouts.push({ id: payoutId || tx.id, txId, date: tx.date, gross, fees, net: tx.amount, entryId: entry.id });
      return entry;
    });
  },

  /** Total des ventes réelles d'un jour (récapitulatif de l'écran Caisse). */
  posDayTotal(date) {
    return sum(
      this._pos()
        .sales.filter((s) => s.mode === 'live' && s.date === date)
        .map((s) => s.totals.totalTtc),
    );
  },
};
