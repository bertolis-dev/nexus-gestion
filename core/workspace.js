/**
 * Espace de travail d'une structure : orchestre les modules du moteur (ventes, achats, banque,
 * écritures) derrière les actions du dirigeant (§3 : « chaque action génère l'écriture en arrière-plan »).
 * Sans DOM ni stockage : l'interface (app/) le sérialise, les tests l'utilisent tel quel.
 */

import { buildChart, categoryById } from './pcg.js';
import { Ledger } from './ledger.js';
import { InvoiceBook, clientAux, lineHt } from './invoices.js';
import { purchaseEntry, findDuplicates } from './purchases.js';
import { mergeTransactions, suggestMatches, settlementEntry, directEntry, DEFAULT_BANK_ACCOUNT } from './bank.js';
export { DEFAULT_BANK_ACCOUNT };
import { isOnReceipt, creditsOf, originalOf, groupBalance, receiptTargets } from './receipts.js';
import { divRound, splitTtc, sum } from './money.js';
import { openingEntry } from './fecimport.js';
import { creditTargetsAsset } from './assets.js';
import { addDays, nextFiscalYear } from './dates.js';
import { prepareCa3, prepareCa12, ca12Advances, liquidationEntry } from './vatreturn.js';
import { LIFECYCLE } from './lifecycle.js';
import { declarationPeriods, urssafDeclaration, urssafDeadline, estimateContributions, thresholdStatus, vatFranchiseMessage, ACTIVITY_TYPES } from './micro.js';
import {
  inventoryEntry,
  depreciationEntry,
  incomeStatement,
  corporateTax,
  corporateTaxEntry,
  resultEntry,
  nextYearOpening,
  allocationEntry,
  balanceSheet,
  fiscalYearMonths,
} from './closing.js';
import { validateTemplate, dueOccurrences, periodLabel } from './recurring.js';

/** Entrées d'argent sans facture de vente, proposées en langage courant. */
export const INCOME_CATEGORIES = [
  { id: 'apport', label: 'Apport personnel', account: '108000' },
  { id: 'apport-associe', label: 'Apport en compte courant d’associé', account: '455000' },
  { id: 'emprunt', label: 'Emprunt reçu', account: '164000' },
  { id: 'virement-interne', label: 'Virement entre mes comptes', account: '580000' },
  { id: 'remboursement', label: 'Remboursement reçu', account: '758000' },
  { id: 'interets', label: 'Intérêts reçus', account: '768000' },
];

/** Sorties d'argent sans facture ni charge : dettes réglées, prélèvements du dirigeant. */
export const OUTFLOW_CATEGORIES = [
  { id: 'paiement-tva', label: 'Paiement de la TVA', account: '445510' },
  { id: 'acompte-tva', label: 'Acompte de TVA (régime simplifié, juillet ou décembre)', account: '445810' },
  { id: 'acompte-is', label: 'Acompte ou solde d’impôt sur les sociétés', account: '444000' },
  { id: 'cotisations-urssaf', label: 'Cotisations URSSAF', account: '646000' },
  { id: 'remboursement-emprunt', label: "Remboursement d'emprunt (capital)", account: '164000' },
  { id: 'prelevement-personnel', label: 'Prélèvement personnel du dirigeant', account: '108000' },
  { id: 'remboursement-associe', label: 'Remboursement du compte courant d’associé', account: '455000' },
  { id: 'virement-interne-sortant', label: 'Virement vers un autre de mes comptes', account: '580000' },
];

/** Somme de plusieurs estimations de cotisations (activité mixte). */
function combineEstimates(list) {
  const total = (k) => sum(list.map((e) => e[k]));
  return {
    turnover: total('turnover'),
    social: total('social'),
    acreReduction: total('acreReduction'),
    cfp: total('cfp'),
    liberatoire: total('liberatoire'),
    chamber: total('chamber'),
    total: total('total'),
    rates: list[0].rates,
    missing: [...new Set(list.flatMap((e) => e.missing))],
    byActivity: list,
  };
}

export const MAX_BANK_ACCOUNTS = 10;

export class Workspace {
  constructor({ company, state = {}, now, newId } = {}) {
    this.company = company;
    this.newId = newId;
    this.chart = buildChart(state.extraAccounts || []);
    this.ledger = new Ledger({ chart: this.chart, fiscalYear: company.fiscalYear, now, state: state.ledger, newId });
    this.book = new InvoiceBook({ company, state: state.book, newId });
    this.clients = state.clients || [];
    this.purchases = state.purchases || [];
    this.transactions = state.transactions || [];
    this.bankAccounts = state.bankAccounts || [{ ...DEFAULT_BANK_ACCOUNT }];
    this.recurring = state.recurring || [];
    this.archives = state.archives || [];
    this.seq = state.seq || 0;
  }

  toJSON() {
    return {
      company: this.company,
      ledger: this.ledger.toJSON(),
      book: this.book.toJSON(),
      clients: this.clients,
      purchases: this.purchases,
      transactions: this.transactions,
      bankAccounts: this.bankAccounts,
      recurring: this.recurring,
      archives: this.archives,
      seq: this.seq,
    };
  }

  #id(prefix) {
    const n = ++this.seq;
    return this.newId ? this.newId(n) : `${prefix}${n}`;
  }

  // ---------------------------------------------------------------- clients

  saveClient(data) {
    const code =
      data.code ||
      data.name
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 8) ||
      'CLIENT';
    if (data.id) {
      const idx = this.clients.findIndex((c) => c.id === data.id);
      this.clients[idx] = { ...this.clients[idx], ...data };
      return this.clients[idx];
    }
    const taken = new Set(this.clients.map((c) => c.code));
    let unique = code;
    for (let i = 2; taken.has(unique); i++) unique = `${code.slice(0, 6)}${i}`;
    const client = { type: 'B2B', country: 'FR', ...data, id: this.#id('C'), code: unique };
    this.clients.push(client);
    return client;
  }

  // ---------------------------------------------------------------- ventes

  issueInvoice(id) {
    const issued = this.book.issue(id, { ledger: this.ledger });
    // Un avoir modifie la TVA exigible et le restant dû de la facture qu'il corrige.
    const original = issued.type === 'credit' ? originalOf(this.book.invoices, issued) : null;
    if (original) {
      this.#syncReceiptVat(original, issued.issueDate);
      this.#letterGroupIfSettled(original, issued.issueDate);
    }
    return issued;
  }

  /**
   * TVA sur encaissements : passe l'écriture 445800 → 445710 (ou inverse) qui amène la TVA exigible
   * comptabilisée sur l'exercice au niveau attendu (receipts.js). Calcul par écart avec ce qui est
   * déjà comptabilisé : pas de dérive d'arrondi, et un encaissement de l'exercice précédent n'est pas
   * compté deux fois.
   */
  #syncReceiptVat(inv, date) {
    if (!isOnReceipt(inv) || !inv.totals.totalVat) return;
    const fy = this.ledger.fiscalYear;
    const before = new Date(Date.parse(`${fy.start}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const expected =
      receiptTargets(this.book.invoices, this.book.payments, inv, date).vat - receiptTargets(this.book.invoices, this.book.payments, inv, before).vat;
    const booked = sum(
      this.ledger.entries
        .filter((e) => e.source?.kind === 'vat-receipt' && e.source.id === inv.id)
        .flatMap((e) => e.lines)
        .filter((l) => l.account === '445710')
        .map((l) => l.credit - l.debit),
    );
    const delta = expected - booked;
    if (!delta) return;
    const amount = Math.abs(delta);
    this.ledger.addDraft({
      journal: 'OD',
      date,
      label: `TVA exigible sur encaissement ${inv.number}`,
      pieceRef: inv.number,
      pieceDate: date,
      source: { kind: 'vat-receipt', id: inv.id },
      lines:
        delta > 0
          ? [
              { account: '445800', debit: amount, credit: 0 },
              { account: '445710', debit: 0, credit: amount },
            ]
          : [
              { account: '445710', debit: amount, credit: 0 },
              { account: '445800', debit: 0, credit: amount },
            ],
    });
  }

  /** Groupe soldé (facture + avoirs + règlements) : lettrage de toutes ses lignes client. */
  #letterGroupIfSettled(inv, date) {
    if (groupBalance(this.book.invoices, this.book.payments, inv) !== 0) return;
    const docs = [inv, ...creditsOf(this.book.invoices, inv)];
    const refs = [
      ...docs.filter((d) => this.ledger.entries.some((e) => e.id === d.entryId)).map((d) => ({ entryId: d.entryId, lineIndex: 0 })),
      ...docs.flatMap((d) => (this.book.payments[d.id] || []).map((p) => ({ entryId: p.entryId, lineIndex: p.lineIndex }))),
    ].filter((r) => this.ledger.entries.some((e) => e.id === r.entryId));
    if (refs.length < 2) return;
    try {
      this.ledger.letter(refs, date);
    } catch {
      // Solde non nul dans l'exercice (pièce d'un exercice précédent, écart absorbé) : lettrage manuel.
    }
  }

  invoiceAux(inv) {
    // Facture d'un exercice précédent : son écriture n'est plus dans le grand livre de l'année.
    return this.ledger.entries.find((e) => e.id === inv.entryId)?.lines[0].aux || clientAux(inv.client);
  }

  /** Factures clients avec restant dû et ancienneté (§3.5). */
  receivables(today) {
    return this.book.invoices
      .filter((i) => i.status === 'issued' && i.type !== 'credit' && i.type !== 'quote')
      .map((i) => {
        const outstanding = this.book.outstanding(i);
        const lateDays = Math.floor((Date.parse(today) - Date.parse(i.dueDate)) / 86400000);
        let bucket = 'a-echoir';
        if (outstanding <= 0) bucket = 'payee';
        else if (lateDays > 60) bucket = '+60';
        else if (lateDays > 30) bucket = '31-60';
        else if (lateDays > 0) bucket = '0-30';
        return { invoice: i, outstanding, lateDays, bucket };
      });
  }

  // ---------------------------------------------------------------- factures récurrentes

  saveRecurring(data) {
    const problems = validateTemplate(data);
    if (problems.length) throw new Error(problems[0]);
    if (data.id) {
      const idx = this.recurring.findIndex((r) => r.id === data.id);
      this.recurring[idx] = { ...this.recurring[idx], ...structuredClone(data) };
      return this.recurring[idx];
    }
    const t = { active: true, autoIssue: false, paymentDays: 30, nextIndex: 0, ...structuredClone(data), id: this.#id('R') };
    this.recurring.push(t);
    return t;
  }

  deleteRecurring(id) {
    this.recurring = this.recurring.filter((r) => r.id !== id);
  }

  /**
   * Prépare (ou émet, si le modèle le demande) les factures des échéances arrivées à la date `today`.
   * Idempotent : chaque échéance n'est facturée qu'une fois (nextIndex avance).
   */
  generateRecurring(today) {
    const result = { drafts: [], issued: [] };
    for (const t of this.recurring) {
      for (const occ of dueOccurrences(t, today)) {
        const due = addDays(today, t.paymentDays ?? 30);
        const period = periodLabel(occ.date, t.frequency);
        const draft = this.book.createDraft({
          type: 'invoice',
          client: structuredClone(t.client),
          issueDate: today,
          dueDate: due,
          lines: t.lines.map((l) => ({ ...l, label: `${l.label} — ${period}` })),
          recurringId: t.id,
          period,
        });
        t.nextIndex = occ.index + 1;
        t.lastRun = today;
        if (t.autoIssue) {
          try {
            result.issued.push(this.issueInvoice(draft.id));
            continue;
          } catch {
            // Non conforme (SIREN manquant…) : la facture reste en brouillon, visible dans « À faire ».
          }
        }
        result.drafts.push(draft);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------- déclarations de TVA

  /** Déclarations déjà validées (conservées dans les paramètres de la structure). */
  get vatReturns() {
    return this.company.vatReturns || [];
  }

  /** Crédit de TVA reporté de la dernière déclaration validée avant la période. */
  previousVatCredit(from) {
    const last = this.vatReturns
      .filter((r) => r.to < from)
      .sort((a, b) => a.to.localeCompare(b.to))
      .at(-1);
    return last && last.balance < 0 ? -last.balance : 0;
  }

  prepareVatReturn(period) {
    const prepare = this.company.vatRegime === 'reel-simplifie' ? prepareCa12 : prepareCa3;
    return prepare(this, period, { previousCredit: this.previousVatCredit(period.from) });
  }

  /** Acomptes de TVA de l'exercice (régime simplifié), d'après la dernière CA12 déclarée. */
  vatAdvancesDue() {
    const last = this.vatReturns
      .filter((r) => r.kind === 'CA12')
      .sort((a, b) => a.to.localeCompare(b.to))
      .at(-1);
    return last ? ca12Advances(last.summary) : null;
  }

  /** Valide la CA3 : écriture de liquidation et déclaration conservée (une seule par période). */
  declareVat(period, today) {
    if (period.to >= today) throw new Error('La période n’est pas terminée : la déclaration se prépare après sa dernière journée.');
    if (this.vatReturns.some((r) => r.from === period.from)) throw new Error('Cette période a déjà été déclarée.');
    const ca3 = this.prepareVatReturn(period);
    const liquidation = liquidationEntry(ca3);
    // Mois sans aucune TVA : la déclaration « néant » est enregistrée, sans écriture (rien à solder).
    const entry = liquidation.lines.length >= 2 ? this.ledger.addDraft(liquidation) : null;
    const record = {
      kind: ca3.kind || 'CA3',
      from: period.from,
      to: period.to,
      boxes: ca3.boxes,
      balance: ca3.balance,
      entryId: entry?.id || null,
      declaredAt: today,
      summary: { grossVat: ca3.grossVat, deductibleOther: ca3.deductibleOther },
    };
    this.company.vatReturns = [...this.vatReturns, record];
    return { ca3, entry, record };
  }

  // ---------------------------------------------------------------- clôture de l'exercice

  addInventory(item) {
    // Client douteux : toute sa créance encore ouverte est transférée en 416.
    const receivableTtc =
      item.type === 'doubtful' && item.aux
        ? sum(
            this.ledger
              .lines()
              .filter((l) => l.account === '411000' && l.aux === item.aux)
              .map((l) => l.debit - l.credit),
          )
        : 0;
    return this.ledger.addDraft(inventoryEntry(item, this.company.fiscalYear, { receivableTtc }));
  }

  bookDepreciation() {
    if (this.ledger.entries.some((e) => e.source?.kind === 'inventory' && e.source.type === 'depreciation'))
      throw new Error('Les dotations de l’exercice sont déjà passées.');
    const entry = depreciationEntry(this);
    if (!entry) throw new Error('Aucune immobilisation à amortir cette année.');
    return this.ledger.addDraft(entry);
  }

  /** Calcul de l'IS sur le résultat comptable avant impôt (EURL et sociétés à l'IS uniquement). */
  computeCorporateTax(opts = {}) {
    const fy = this.company.fiscalYear;
    const days = Math.round((Date.parse(fy.end) - Date.parse(fy.start)) / 86400000) + 1;
    return corporateTax({ resultBeforeTax: incomeStatement(this.ledger).resultBeforeTax, days, months: fiscalYearMonths(fy), ...opts });
  }

  /** Passe (ou remplace, tant qu'elle est en brouillon) l'écriture d'IS de l'exercice. */
  bookCorporateTax(tax) {
    const previous = this.ledger.entries.find((e) => e.source?.kind === 'inventory' && e.source.type === 'corporate-tax');
    if (previous?.status === 'validated') throw new Error('L’impôt de l’exercice est déjà comptabilisé et validé.');
    if (previous) this.ledger.deleteDraft(previous.id);
    const entry = corporateTaxEntry(tax, this.company.fiscalYear);
    return entry ? this.ledger.addDraft(entry) : null;
  }

  /**
   * Clôture : détermination du résultat, validation de toutes les écritures de l'exercice, puis
   * état du nouvel exercice (bilan d'ouverture et extournes). Renvoie l'état à charger dans un nouveau
   * Workspace — le grand livre de l'exercice clos reste consultable dans son FEC.
   */
  /** Affecte le résultat de l'exercice précédent (décision d'assemblée ou du dirigeant). */
  allocateResult(parts, date) {
    if (this.ledger.entries.some((e) => e.source?.kind === 'allocation')) throw new Error('Le résultat a déjà été affecté.');
    return this.ledger.addDraft(allocationEntry(this.ledger, this.company, parts, date));
  }

  closeYear(today) {
    const fy = this.company.fiscalYear;
    if (today <= fy.end) throw new Error('L’exercice n’est pas terminé.');
    // Contrôle bloquant : on ne clôture jamais un exercice dont le bilan ne s'équilibre pas.
    const bs = balanceSheet(this.ledger);
    if (!bs.balanced)
      throw new Error(
        `Le bilan n’est pas équilibré (écart de ${(bs.totalAssets - bs.totalLiabilities) / 100} €) : la clôture est bloquée. Contactez le support.`,
      );
    const result = resultEntry(this.ledger, fy);
    if (result && this.ledger.lockedThrough >= fy.end)
      throw new Error('Le dernier jour de l’exercice est déjà verrouillé : l’écriture de résultat ne peut plus être passée.');
    if (result) this.ledger.addDraft(result);
    this.ledger.validateThrough(fy.end);
    const late = this.ledger.entries.filter((e) => e.status === 'draft');
    if (late.length) throw new Error(`${late.length} écriture(s) sont datées après la fin de l’exercice.`);
    const { start: nextStart, end: nextEnd } = nextFiscalYear(fy);
    const { opening, reversals } = nextYearOpening(this.ledger, nextStart);
    const nextCompany = { ...structuredClone(this.company), fiscalYear: { start: nextStart, end: nextEnd } };
    const next = new Workspace({
      company: nextCompany,
      newId: this.newId,
      state: {
        ...structuredClone(this.toJSON()),
        company: nextCompany,
        // Nouveau grand livre : numérotation repartant de 1, ordre de saisie poursuivi (clé unique en base).
        ledger: { entries: [], seq: this.ledger.seq, lastNumber: 0, lastLetter: this.ledger.lastLetter, auditLog: [] },
      },
    });
    // Exercice clos conservé en lecture seule (en base, il reste dans ses tables ; ici pour le mode local).
    next.archives = [...(this.archives || []), { fiscalYear: structuredClone(fy), ledger: structuredClone(this.ledger.toJSON()) }];
    if (opening.lines.length) next.ledger.addDraft(opening);
    for (const r of reversals) next.ledger.addDraft(r);
    return next;
  }

  // ---------------------------------------------------------------- reprise d'historique

  /** Importe un bilan d'ouverture (fecimport.js) : écriture d'à-nouveaux et clients repris. */
  importOpening(opening) {
    if (this.ledger.entries.some((e) => e.source?.kind === 'fec-import')) throw new Error('Un bilan d’ouverture a déjà été repris pour cet exercice.');
    const entry = this.ledger.addDraft(openingEntry(opening, this.company.fiscalYear.start));
    let clientsCreated = 0;
    for (const c of opening.clients) {
      if (this.clients.some((x) => x.code === c.code || x.aux === c.aux)) continue;
      this.saveClient({ code: c.code, aux: c.aux, name: c.name || c.code, type: 'B2B', country: 'FR' });
      clientsCreated++;
    }
    return { entry, clientsCreated };
  }

  // ---------------------------------------------------------------- achats

  /**
   * Enregistre une dépense saisie en TTC (le cas courant d'une facture papier ou photo).
   * @param {{supplier, date, number, categoryId, ttc, vatRateBp}} data
   * @param {{force?: boolean}} opts enregistrer malgré un doublon probable
   */
  addPurchase(
    { supplier, date, number = '', categoryId, ttc, vatRateBp = 2000, documentName = '', type = 'invoice', reverseCharge = false },
    { force = false } = {},
  ) {
    // Fournisseur étranger (autoliquidation) : sa facture ne porte pas de TVA française, le montant
    // saisi est donc déjà le HT — la TVA due est calculée à part par purchaseEntry.
    const foreign = reverseCharge || (supplier.country || 'FR') !== 'FR';
    const { ht } = foreign ? { ht: ttc } : splitTtc(ttc, vatRateBp);
    return this.addPurchaseLines({ supplier, date, number, documentName, type, reverseCharge, lines: [{ categoryId, ht, vatRateBp }] }, { force });
  }

  /**
   * Enregistre une dépense à plusieurs lignes (HT par taux), cas d'une facture électronique reçue.
   * @param {{supplier, date, number, lines: {categoryId, ht, vatRateBp}[], documentName?, einvoice?}} data
   * @param {{force?: boolean}} opts enregistrer malgré un doublon probable
   */
  addPurchaseLines(
    { supplier, date, number = '', lines, documentName = '', einvoice = null, type = 'invoice', reverseCharge = false },
    { force = false } = {},
  ) {
    const p = { id: this.#id('P'), supplier: { country: 'FR', ...supplier }, date, number, documentName, lines: structuredClone(lines) };
    if (reverseCharge) p.reverseCharge = true;
    if (type === 'credit') {
      p.type = 'credit';
      // Avoir sur un équipement du registre : il diminue le compte du bien d'origine.
      for (const l of p.lines) {
        if (
          categoryById(l.categoryId).fixedAsset &&
          creditTargetsAsset(this.purchases, this.company, { supplierName: p.supplier.name, categoryId: l.categoryId, date })
        )
          l.assetCredit = true;
      }
    }
    if (einvoice) p.einvoice = einvoice;
    const duplicates = findDuplicates(p, this.purchases);
    // Doublon probable : rien n'est enregistré tant que l'utilisateur n'a pas confirmé (force).
    if (duplicates.length && !force) return { purchase: null, duplicates };
    const entry = purchaseEntry(p, this.company);
    const created = this.ledger.addDraft(entry);
    p.entryId = created.id;
    p.totalTtc = entry.meta.totalTtc;
    p.paid = 0;
    p.aux = entry.lines.at(-1).aux;
    p.thirdPartyAccount = entry.lines.at(-1).account;
    this.purchases.push(p);
    return { purchase: p, duplicates };
  }

  // ---------------------------------------------------------------- banque

  importTransactions(list) {
    return mergeTransactions(this.transactions, list);
  }

  /** Compte bancaire supplémentaire : sous-compte 512100, 512200… (10 comptes au plus). */
  addBankAccount({ label, iban = '', provider = 'manual' }) {
    const name = String(label ?? '').trim();
    if (!name) throw new Error('Donnez un nom à ce compte (par exemple « Qonto » ou « Livret »).');
    if (this.bankAccounts.length >= MAX_BANK_ACCOUNTS) throw new Error(`${MAX_BANK_ACCOUNTS} comptes bancaires au plus.`);
    const used = new Set(this.bankAccounts.map((a) => a.glAccount));
    const glAccount = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `512${n}00`).find((a) => !used.has(a));
    const digits = String(iban).replace(/\s/g, '');
    const account = { id: this.#id('bank'), label: name, glAccount, provider, ibanLast4: digits.length >= 4 ? digits.slice(-4) : null };
    this.bankAccounts.push(account);
    return account;
  }

  /** Sous-compte 512 du compte d'une transaction (compte principal par défaut). */
  bankGlOf(tx) {
    return this.bankAccounts.find((a) => a.id === (tx.accountId || 'default'))?.glAccount || '512000';
  }

  /** Solde comptable d'un compte bancaire. */
  bankBalance(accountId, opts) {
    const account = this.bankAccounts.find((a) => a.id === accountId);
    if (!account) throw new Error('Compte bancaire inconnu');
    return this.ledger.balanceOf(account.glAccount, opts);
  }

  openDocs() {
    const sales = this.book.invoices
      .filter((i) => i.status === 'issued' && i.type !== 'credit' && i.type !== 'quote' && this.book.outstanding(i) > 0)
      .map((i) => ({
        id: i.id,
        kind: 'invoice',
        number: i.number,
        partyName: i.client.name,
        date: i.issueDate,
        dueDate: i.dueDate,
        outstanding: this.book.outstanding(i),
        thirdPartyAccount: '411000',
        aux: this.invoiceAux(i),
      }));
    const buys = this.purchases
      .filter((p) => p.totalTtc - p.paid > 0)
      .map((p) => ({
        id: p.id,
        kind: p.type === 'credit' ? 'purchase-credit' : 'purchase',
        number: p.number || p.id,
        partyName: p.supplier.name,
        date: p.date,
        dueDate: p.date,
        outstanding: p.totalTtc - p.paid,
        thirdPartyAccount: p.thirdPartyAccount,
        aux: p.aux,
      }));
    const refunds = this.book.invoices
      .filter((c) => c.type === 'credit' && c.status === 'issued' && this.book.outstanding(c) < 0)
      .map((c) => ({
        id: c.id,
        kind: 'credit',
        number: c.number,
        partyName: c.client.name,
        date: c.issueDate,
        dueDate: c.issueDate,
        outstanding: -this.book.outstanding(c),
        thirdPartyAccount: '411000',
        aux: this.invoiceAux(originalOf(this.book.invoices, c) || c),
      }));
    return [...sales, ...buys, ...refunds];
  }

  suggestionsFor(txId) {
    const tx = this.transactions.find((t) => t.id === txId);
    return suggestMatches(tx, this.openDocs());
  }

  /**
   * Rapproche une transaction de pièces : écriture de règlement, TVA sur encaissements, lettrage
   * automatique des pièces soldées (§3.4 « lettrage automatique à chaque rapprochement »).
   */
  matchTransaction(txId, allocations) {
    const tx = this.transactions.find((t) => t.id === txId);
    if (!tx || tx.status !== 'open') throw new Error('Transaction déjà traitée');
    const entry = this.ledger.addDraft(settlementEntry(tx, allocations, { bankAccount: this.bankGlOf(tx) }));
    allocations.forEach(({ doc, amount }, i) => {
      const lineIndex = i + 1; // ligne 0 = banque, puis une ligne par pièce dans l'ordre des allocations
      if (doc.kind === 'credit') {
        // Remboursement d'un avoir au client : règlement négatif sur l'avoir.
        const cn = this.book.get(doc.id);
        this.book.recordPayment(cn.id, { amount: -amount, date: tx.date, ref: tx.id, entryId: entry.id, lineIndex });
        const original = originalOf(this.book.invoices, cn);
        if (original) {
          this.#syncReceiptVat(original, tx.date);
          this.#letterGroupIfSettled(original, tx.date);
        }
      } else if (doc.kind === 'invoice') {
        const inv = this.book.get(doc.id);
        const left = this.book.recordPayment(inv.id, { amount, date: tx.date, ref: tx.id, entryId: entry.id, lineIndex });
        this.#syncReceiptVat(inv, tx.date);
        if (left === 0) {
          if (creditsOf(this.book.invoices, inv).length) this.#letterGroupIfSettled(inv, tx.date);
          else if (this.ledger.entries.some((e) => e.id === inv.entryId))
            this.#letterSettled({ entryId: inv.entryId, lineIndex: 0 }, this.book.payments[inv.id], tx.date);
          else {
            // Facture d'un exercice précédent : on lettre sa ligne d'à-nouveau avec les règlements de l'exercice.
            const ref = this.#openingRef(inv);
            const inLedger = (this.book.payments[inv.id] || []).filter((p) => this.ledger.entries.some((e) => e.id === p.entryId));
            if (ref) this.#letterSettled(ref, inLedger, tx.date);
          }
          const events = this.book.lifecycle[inv.id] || [];
          const last = events.at(-1);
          // Pas de statut automatique après un statut final (facture refusée puis payée : à traiter à la main).
          if (!last || !LIFECYCLE[last.status].final)
            this.book.recordStatus(inv.id, { status: 'encaissee', date: tx.date, source: 'banque', detail: tx.label });
        }
      } else {
        const p = this.purchases.find((x) => x.id === doc.id);
        p.paid += amount;
        (p.payments ||= []).push({ amount, date: tx.date, ref: tx.id, entryId: entry.id, lineIndex });
        const purchaseEntryRow = this.ledger.entries.find((e) => e.id === p.entryId);
        if (p.paid === p.totalTtc && purchaseEntryRow) {
          this.#letterSettled({ entryId: p.entryId, lineIndex: purchaseEntryRow.lines.length - 1 }, p.payments, tx.date);
        }
      }
    });
    tx.status = 'matched';
    tx.entryId = entry.id;
    return entry;
  }

  /** Ligne d'à-nouveau d'une facture d'un exercice précédent (même tiers, référence dans le libellé). */
  #openingRef(inv) {
    const aux = this.invoiceAux(inv);
    for (const e of this.ledger.entries.filter((x) => x.source?.kind === 'opening')) {
      const lineIndex = e.lines.findIndex((l) => l.account === '411000' && l.aux === aux && !l.letter && l.label.includes(inv.number));
      if (lineIndex >= 0) return { entryId: e.id, lineIndex };
    }
    return null;
  }

  #letterSettled(docRef, payments, date) {
    const refs = [docRef, ...payments.map((p) => ({ entryId: p.entryId, lineIndex: p.lineIndex }))];
    try {
      this.ledger.letter(refs, date);
    } catch {
      // Solde non nul (écart absorbé ailleurs, trop-perçu) : la pièce reste à lettrer manuellement.
    }
  }

  /** Transaction sans facture : dépense ou recette catégorisée directement, signalée sans justificatif. */
  categorizeTransaction(txId, { categoryId, vatRateBp = 0, hasReceipt = false }) {
    const tx = this.transactions.find((t) => t.id === txId);
    if (!tx || tx.status !== 'open') throw new Error('Transaction déjà traitée');
    const income = INCOME_CATEGORIES.find((c) => c.id === categoryId) || OUTFLOW_CATEGORIES.find((c) => c.id === categoryId);
    if (income) {
      const e = this.ledger.addDraft(directEntry(tx, { account: income.account, missingReceipt: false, bankAccount: this.bankGlOf(tx) }));
      tx.status = 'matched';
      tx.entryId = e.id;
      if (categoryId === 'cotisations-urssaf') this.#markUrssafPaid(tx);
      return e;
    }
    const cat = categoryById(categoryId);
    if (cat.fixedAsset) {
      // Équipement payé par carte ou virement : même circuit qu'une facture d'achat (seuil
      // d'immobilisation, registre, compte 404), puis rapprochement du paiement. Sans facture, la TVA
      // n'est pas récupérable : elle fait partie du coût.
      const amount = Math.abs(tx.amount);
      const rate = hasReceipt ? vatRateBp : 0;
      const { purchase } = this.addPurchaseLines(
        { supplier: { name: tx.label }, date: tx.date, lines: [{ categoryId, ht: splitTtc(amount, rate).ht, vatRateBp: rate }] },
        { force: true },
      );
      const doc = this.openDocs().find((d) => d.kind === 'purchase' && d.id === purchase.id);
      const entry = this.matchTransaction(txId, [{ doc, amount }]);
      tx.missingReceipt = !hasReceipt;
      purchase.missingReceipt = !hasReceipt;
      return entry;
    }
    const franchise = this.company.vatRegime === 'franchise';
    const { tva } = splitTtc(Math.abs(tx.amount), vatRateBp);
    // Sans facture, la TVA n'est pas déductible : seule une pièce justificative ouvre droit à déduction.
    const deductible = franchise || !hasReceipt ? 0 : divRound(tva * cat.vatDeductiblePct, 100);
    const entry = this.ledger.addDraft(
      directEntry(tx, {
        account: cat.account,
        vatAccount: cat.fixedAsset ? '445620' : '445660',
        vatAmount: deductible,
        missingReceipt: !hasReceipt,
        bankAccount: this.bankGlOf(tx),
      }),
    );
    tx.status = 'matched';
    tx.entryId = entry.id;
    tx.missingReceipt = !hasReceipt;
    return entry;
  }

  ignoreTransaction(txId) {
    const tx = this.transactions.find((t) => t.id === txId);
    tx.status = 'ignored';
  }

  // ---------------------------------------------------------------- indicateurs

  /** TVA nette due sur une période (collectée − déductible), à partir des écritures. */
  vatDue({ from, to }) {
    const lines = this.ledger.lines({ from, to });
    const credit = (acc) => sum(lines.filter((l) => l.account === acc).map((l) => l.credit - l.debit));
    const debit = (acc) => sum(lines.filter((l) => l.account === acc).map((l) => l.debit - l.credit));
    const collected = credit('445710') + credit('445200');
    const deductible = debit('445660') + debit('445620');
    return { collected, deductible, net: collected - deductible };
  }

  dashboard(today) {
    const year = this.company.fiscalYear;
    const revenue = -this.ledger.balanceOf('70', { from: year.start, to: today });
    const expenses = this.ledger.balanceOf('6', { from: year.start, to: today });
    return {
      cash: this.ledger.balanceOf('512'),
      receivable: this.ledger.balanceOf('411'),
      payable: -this.ledger.balanceOf('40'),
      revenue,
      expenses,
      result: revenue - expenses,
    };
  }

  /** Liste « À faire » classée par urgence (§5). */
  // ---------------------------------------------------------------- URSSAF (micro-entrepreneur)

  /** Encaissements de l'année (base du chiffre d'affaires à déclarer en micro-entreprise). */
  microReceipts() {
    // Chiffre d'affaires encaissé : hors taxes si l'entreprise facture la TVA ; réparti entre ventes
    // (lignes « biens ») et prestations (lignes « services ») pour une activité mixte ; les
    // remboursements d'avoirs (règlements négatifs) le diminuent.
    const franchise = this.company.vatRegime === 'franchise';
    const servicesActivity = this.company.microActivity === 'bnc' ? 'bnc' : 'bic-services';
    const out = [];
    for (const inv of this.book.invoices) {
      const payments = this.book.payments[inv.id] || [];
      if (!payments.length) continue;
      const goodsHt = sum(inv.lines.filter((l) => l.nature !== 'services').map(lineHt));
      const totalHt = sum(inv.lines.map(lineHt));
      for (const p of payments) {
        const amount = franchise || !inv.totals.totalTtc ? p.amount : divRound(p.amount * inv.totals.totalHt, inv.totals.totalTtc);
        const goods = totalHt ? divRound(amount * goodsHt, totalHt) : 0;
        const base = { date: p.date, invoiceNumber: inv.number, clientName: inv.client.name, method: 'Virement' };
        if (goods) out.push({ ...base, amount: goods, activity: 'bic-vente' });
        if (amount - goods) out.push({ ...base, amount: amount - goods, activity: servicesActivity });
      }
    }
    return out;
  }

  /**
   * SIREN, forme juridique et régime fiscal figés dès la première facture émise ou écriture validée
   * (même règle que la base de données, migration 0009) : ils figurent sur des pièces définitives.
   */
  identityLocked() {
    return this.ledger.entries.some((e) => e.status === 'validated') || this.book.invoices.some((i) => i.status === 'issued');
  }

  /** Situation du micro-entrepreneur utilisée pour estimer ses cotisations (Paramètres > Ma micro-entreprise). */
  microOptions() {
    const c = this.company;
    return {
      acreStart: c.acreStart || null,
      acreEnd: c.acreEnd || null,
      versementLiberatoire: Boolean(c.versementLiberatoire),
      retraite: c.retraite === 'cipav' ? 'cipav' : 'general',
      artisan: Boolean(c.artisan),
    };
  }

  /**
   * Situation vis-à-vis de la franchise de TVA, avec le message à afficher. L'année précédente n'est
   * connue que si Nexus tenait déjà la comptabilité au 1er janvier de cette année-là.
   */
  vatFranchiseStatus(today) {
    if (this.company.vatRegime !== 'franchise') return null;
    const year = Number(today.slice(0, 4));
    const receipts = this.microReceipts();
    const family = ACTIVITY_TYPES[this.company.microActivity]?.family || (this.company.defaultNature === 'biens' ? 'biens' : 'services');
    const current = thresholdStatus(receipts, year);
    const since = this.archives?.[0]?.fiscalYear.start || this.company.fiscalYear.start;
    const previousKnown = since <= `${year - 1}-01-01`;
    const previous = thresholdStatus(receipts, year - 1).vat[family];
    const previousYearOverBase = previousKnown ? previous === 'depasse-base' || previous === 'depasse-majore' : null;
    const status = current.vat[family];
    return { status, family, turnover: current.ca[family], message: vatFranchiseMessage(status, family, { year, previousYearOverBase }) };
  }

  get urssafDeclarations() {
    return this.company.urssafDeclarations || [];
  }

  /** Périodes de l'année avec leur montant, leur échéance et leur état (à déclarer, déclarée, payée). */
  urssafPeriods(year, today) {
    const receipts = this.microReceipts();
    // Rien avant le premier exercice tenu dans Nexus (les périodes antérieures ont été déclarées ailleurs).
    const since = this.archives?.[0]?.fiscalYear.start || this.company.fiscalYear.start;
    return declarationPeriods(year, this.company.urssafFrequency || 'trimestrielle')
      .filter((p) => p.to >= since)
      .map((p) => {
        const record = this.urssafDeclarations.find((r) => r.from === p.from);
        const deadline = urssafDeadline(p);
        const status =
          record && !record.contributions
            ? 'rien-a-payer'
            : record?.paidAt
              ? 'payee'
              : record
                ? 'declaree'
                : p.from > today
                  ? 'a-venir'
                  : p.to >= today
                    ? 'en-cours'
                    : deadline < today
                      ? 'en-retard'
                      : 'a-declarer';
        const declaration = urssafDeclaration(receipts, p);
        const turnover = declaration.total;
        // Activité mixte : chaque activité à son propre taux ; un remboursement supérieur aux
        // encaissements du trimestre ne donne rien à payer (à valider).
        const parts = Object.entries(declaration.byActivity).filter(([, amount]) => amount > 0);
        const estimates = (parts.length ? parts : [[this.company.microActivity || 'bnc', 0]]).map(([activity, amount]) =>
          estimateContributions(amount, activity, this.microOptions(), p.to),
        );
        const estimate = estimates.length === 1 ? estimates[0] : combineEstimates(estimates);
        return { ...p, turnover, estimate, deadline, record, status };
      });
  }

  /** Enregistre la déclaration faite sur autoentrepreneur.urssaf.fr (chiffre d'affaires et cotisations calculées par l'URSSAF). */
  recordUrssafDeclaration({ from, to, turnover, contributions, date }) {
    if (this.urssafDeclarations.some((r) => r.from === from)) throw new Error('Cette période a déjà été déclarée.');
    if (!Number.isSafeInteger(contributions) || contributions < 0) throw new Error('Le montant des cotisations est invalide.');
    const record = { from, to, turnover, contributions, declaredAt: date, paidAt: null, txId: null };
    this.company.urssafDeclarations = [...this.urssafDeclarations, record];
    return record;
  }

  /** Un prélèvement « Cotisations URSSAF » solde la plus ancienne déclaration non payée du même montant. */
  #markUrssafPaid(tx) {
    const record = [...this.urssafDeclarations].sort((a, b) => a.from.localeCompare(b.from)).find((r) => !r.paidAt && r.contributions === Math.abs(tx.amount));
    if (!record) return;
    this.company.urssafDeclarations = this.urssafDeclarations.map((r) => (r === record ? { ...r, paidAt: tx.date, txId: tx.id } : r));
  }

  #urssafTodo(today) {
    if (!this.company.taxRegime?.startsWith('micro')) return [];
    const year = Number(today.slice(0, 4));
    const periods = [...this.urssafPeriods(year - 1, today), ...this.urssafPeriods(year, today)];
    const pending = periods.find((p) => p.status === 'en-retard' || p.status === 'a-declarer');
    if (!pending) return [];
    const fr = (d) => d.split('-').reverse().join('/');
    return [
      {
        urgency: pending.status === 'en-retard' ? 3 : 2,
        kind: 'urssaf',
        view: 'urssaf',
        text:
          pending.status === 'en-retard'
            ? `Déclaration URSSAF ${pending.label} en retard (échéance du ${fr(pending.deadline)})`
            : `Déclarer votre chiffre d'affaires ${pending.label} à l'URSSAF avant le ${fr(pending.deadline)}`,
      },
    ];
  }

  todo(today) {
    const items = [];
    const open = this.transactions.filter((t) => t.status === 'open');
    if (open.length) items.push({ urgency: 2, kind: 'bank', view: 'banque', text: `${open.length} transaction${open.length > 1 ? 's' : ''} à justifier` });
    const late = this.receivables(today).filter((r) => r.outstanding > 0 && r.lateDays > 0);
    for (const r of late) {
      items.push({
        urgency: r.lateDays > 30 ? 3 : 2,
        kind: 'late',
        view: 'ventes',
        id: r.invoice.id,
        text: `Relancer ${r.invoice.client.name} — facture ${r.invoice.number} en retard de ${r.lateDays} j`,
      });
    }
    const drafts = this.book.invoices.filter((i) => i.status === 'draft' && i.type !== 'quote');
    if (drafts.length)
      items.push({ urgency: 1, kind: 'draft', view: 'ventes', text: `${drafts.length} facture${drafts.length > 1 ? 's' : ''} en brouillon à émettre` });
    const noReceipt = this.transactions.filter((t) => t.missingReceipt);
    if (noReceipt.length)
      items.push({ urgency: 1, kind: 'receipt', view: 'banque', text: `${noReceipt.length} dépense${noReceipt.length > 1 ? 's' : ''} sans justificatif` });
    items.push(...this.#vatTodo(today));
    items.push(...this.#urssafTodo(today));
    return items.sort((a, b) => b.urgency - a.urgency);
  }

  /**
   * Prochaine échéance de TVA. Réel normal : CA3 du mois M déposée le mois M+1 avant le jour limite
   * (entre le 15 et le 24 selon le SIREN et la forme, paramétrable ; 19 par défaut) — une fois ce
   * jour passé, on annonce la déclaration du mois en cours. Réel simplifié : acomptes de juillet et
   * décembre, CA12 annuelle début mai.
   */
  /**
   * Périodes de déclaration de TVA (CA3) couvrant l'exercice : mois civils, ou trimestres civils si
   * l'entreprise déclare chaque trimestre (company.vatPeriodicity = 'trimestrielle').
   */
  vatPeriods() {
    const fy = this.company.fiscalYear;
    const quarterly = this.company.vatPeriodicity === 'trimestrielle';
    const span = quarterly ? 3 : 1;
    let [y, m] = fy.start.split('-').map(Number);
    if (quarterly) m = Math.floor((m - 1) / 3) * 3 + 1;
    const out = [];
    for (let guard = 0; guard < 40; guard++) {
      const from = `${y}-${String(m).padStart(2, '0')}-01`;
      if (from > fy.end) break;
      const to = new Date(Date.UTC(y, m - 1 + span, 0)).toISOString().slice(0, 10);
      const label = quarterly
        ? `${(m - 1) / 3 + 1 === 1 ? '1er' : `${(m - 1) / 3 + 1}e`} trimestre ${y}`
        : new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString('fr-FR', { month: 'long', timeZone: 'UTC' });
      out.push({ from, to, label });
      m += span;
      if (m > 12) {
        m -= 12;
        y += 1;
      }
    }
    return out;
  }

  /** Date limite de dépôt d'une CA3 : le jour limite du mois qui suit la période. */
  vatDeadline(period) {
    const [y, m] = period.to.split('-').map(Number);
    return new Date(Date.UTC(y, m, this.company.vatDeadlineDay || 19)).toISOString().slice(0, 10);
  }

  #vatTodo(today) {
    if (this.company.vatRegime === 'franchise') return [];
    const d = new Date(`${today}T00:00:00Z`);
    const y = d.getUTCFullYear();
    const month = d.getUTCMonth(); // 0-11
    const monthName = (m) => new Date(Date.UTC(2000, m, 1)).toLocaleDateString('fr-FR', { month: 'long', timeZone: 'UTC' });
    const of = (name) => (/^[aeiouyh]/i.test(name) ? `d’${name}` : `de ${name}`);
    if (this.company.vatRegime === 'reel-simplifie') {
      if (month === 6 || month === 11) return [{ urgency: 2, kind: 'vat', view: 'tva', text: `Acompte de TVA de ${monthName(month)} à payer (CA12)` }];
      if (month >= 2 && month <= 4)
        return [{ urgency: 2, kind: 'vat', view: 'tva', text: `Déclaration annuelle de TVA (CA12) de ${y - 1} à déposer début mai` }];
      return [];
    }
    const quarterly = this.company.vatPeriodicity === 'trimestrielle';
    const periods = this.vatPeriods();
    const isDeclared = (p) => this.vatReturns.some((r) => r.from === p.from);
    const name = (p) => (quarterly ? `du ${p.label}` : of(p.label));
    const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
    const items = [];
    // Dernière période terminée, non déclarée alors que son échéance est passée : retard, en tête de
    // liste. Les périodes plus anciennes ne sont pas signalées : elles ont pu être déclarées avant
    // l'arrivée dans Nexus (la check-list de clôture les recense).
    const lastEnded = periods.filter((p) => p.to < today).at(-1);
    const late = lastEnded && !isDeclared(lastEnded) && this.vatDeadline(lastEnded) < today ? lastEnded : null;
    if (late) {
      items.push({
        urgency: 3,
        kind: 'vat',
        view: 'tva',
        period: late.from,
        text: `TVA ${name(late)} non déclarée : l'échéance du ${ddmm(this.vatDeadline(late))} est dépassée`,
      });
    }
    // Période à déclarer : la première dont l'échéance n'est pas passée (la période échue tant que
    // son échéance court, sinon la période en cours).
    const next = periods.find((p) => this.vatDeadline(p) >= today && p.from <= today);
    if (!next || isDeclared(next)) return items;
    const net = this.prepareVatReturn(next).balance;
    return [
      ...items,
      {
        urgency: next.to < today ? 3 : 1,
        kind: 'vat',
        view: 'tva',
        period: next.from,
        amount: net,
        text: `TVA ${name(next)} à déclarer avant le ${ddmm(this.vatDeadline(next))}`,
      },
    ];
  }
}
