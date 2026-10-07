/**
 * Écran « sales ».
 */

import { buildCii, checkEn16931, ciiFileName } from '../../core/einvoice.js?v=d485078';
import { InvoiceError, defaultDueDate, isValidSiren } from '../../core/invoices.js?v=d485078';
import { LIFECYCLE } from '../../core/lifecycle.js?v=d485078';
import { lookupSiren } from '../company-lookup.js?v=d485078';
import { render } from '../render.js?v=d485078';
import { eur, frDate, today, ui, ws } from '../state.js?v=d485078';
import { download, save, toast } from '../store.js?v=d485078';
import { isUnconfirmed } from '../sync-ui.js?v=d485078';
import { emptyLine, persistDraft } from '../views/invoice-form.js?v=d485078';
import { invoicePdf, pdfFileName } from '../facturx-ui.js?v=d485078';
import { depositCandidates } from '../../core/deposit.js?v=d485078';
import { createZip } from '../../core/zip.js?v=d485078';

/** Actions « sales » : data-action → fonction. */
export const actionsTable = {
  'line-add': async () => {
    ui.draft.lines.push(emptyLine());
    return render();
  },
  'line-remove': async ({ index }) => {
    ui.draft.lines.splice(Number(index), 1);
    return render();
  },
  'client-lookup': async () => {
    const nc = ui.draft.newClient;
    const siren = (nc.siren || '').replace(/\s/g, '');
    if (!isValidSiren(siren)) return toast('Ce SIREN ne semble pas valide.', true);
    try {
      const { warning: _warning, ...found } = await lookupSiren(siren);
      Object.assign(nc, found, { siren });
      render();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  },
  'invoice-cancel': async () => {
    ui.draft = null;
    location.hash = '#/ventes';
    return;
  },
  'invoice-save': async () => {
    const inv = persistDraft();
    if (!inv) return render();
    ui.draft = null;
    location.hash = `#/ventes/${inv.id}`;
    return toast('Brouillon enregistré.');
  },
  'invoice-issue': async ({ action, id }) => {
    const inv = action === 'invoice-issue' ? persistDraft() : ws.book.get(id);
    if (!inv) return render();
    try {
      const issued = ws.issueInvoice(inv.id);
      ui.draft = null;
      save();
      location.hash = `#/ventes/${issued.id}`;
      render();
      if (isUnconfirmed(issued)) return toast('Émission envoyée : le numéro s’affiche dès sa confirmation par le serveur.');
      toast(
        `${issued.type === 'quote' ? 'Devis' : issued.type === 'deposit' ? "Facture d'acompte" : issued.type === 'credit' ? 'Avoir' : 'Facture'} ${issued.number} émis${issued.type === 'quote' || issued.type === 'credit' ? '' : 'e'}.`,
      );
    } catch (err) {
      if (err instanceof InvoiceError && err.issues.length) {
        if (ui.draft) {
          Object.assign(ui.draft, { issues: err.issues, focusIssues: true, key: `modifier-${inv.id}`, savedId: inv.id });
          location.hash = `#/ventes/modifier-${inv.id}`;
        }
        render();
      } else toast(err.message, true);
    }
    return;
  },
  'invoice-issue-existing': (ctx) => actionsTable['invoice-issue'](ctx),
  'invoice-delete': async ({ id }) => {
    if (!confirm('Supprimer ce brouillon ?')) return;
    ws.book.deleteDraft(id);
    save();
    location.hash = '#/ventes';
    return;
  },
  'credit-note': async ({ id }) => {
    const draft = ws.book.createCreditNote(id, { issueDate: today() });
    save();
    location.hash = `#/ventes/modifier-${draft.id}`;
    return;
  },
  'deposit-prepare': async () => {
    const todo = depositCandidates(ws.book);
    if (!todo.length) return;
    const platform = ws.company.paPlatform || 'autre';
    try {
      toast(`Préparation de ${todo.length} facture(s)…`);
      const files = [];
      for (const inv of todo) files.push({ name: pdfFileName(inv), data: await invoicePdf(inv, ws.company) });
      const fileName = `depot-factures-${today()}.zip`;
      download(fileName, createZip(files), 'application/zip');
      ui.pendingDeposit = { ids: todo.map((i) => i.id), platform, fileName };
      render();
    } catch (err) {
      toast(`Préparation impossible : ${err.message}`, true);
    }
  },
  'deposit-confirm': async () => {
    const { ids, platform } = ui.pendingDeposit;
    ws.markDeposited(ids, { date: today(), platform });
    ui.pendingDeposit = null;
    save();
    render();
    toast(`${ids.length} facture(s) marquée(s) « Déposée ».`);
  },
  'deposit-cancel': async () => {
    ui.pendingDeposit = null;
    return render();
  },
  // Le lien mailto s'ouvre normalement ; la relance est ajoutée à l'historique de la facture.
  'reminder-send': async ({ id, index }) => {
    ws.recordReminder(id, { level: Number(index), date: today() });
    save();
    setTimeout(render, 0);
  },
  'invoice-pdf': async ({ id }) => {
    const inv = ws.book.get(id);
    try {
      const pdf = await invoicePdf(inv, ws.company);
      download(pdfFileName(inv), pdf, 'application/pdf');
      toast('Facture PDF téléchargée (Factur-X : la facture électronique est jointe au PDF).');
    } catch (err) {
      toast(`PDF impossible : ${err.message}`, true);
    }
  },
  'invoice-send': async ({ id }) => {
    const inv = ws.book.get(id);
    let pdf;
    try {
      pdf = await invoicePdf(inv, ws.company);
    } catch (err) {
      return toast(`PDF impossible : ${err.message}`, true);
    }
    const name = pdfFileName(inv);
    const subject = `${inv.type === 'credit' ? 'Avoir' : 'Facture'} ${inv.number} — ${ws.company.name}`;
    const body = `Bonjour,\n\nVeuillez trouver ci-joint ${inv.type === 'credit' ? "l'avoir" : 'la facture'} ${inv.number} d'un montant de ${eur(inv.totals.netToPay ?? inv.totals.totalTtc)}${inv.type === 'credit' ? '' : `, à régler avant le ${frDate(inv.dueDate)}`}.\n\nCordialement,\n${ws.company.name}`;
    const file = new File([pdf], name, { type: 'application/pdf' });
    // Téléphone et certains ordinateurs : partage natif avec le PDF joint.
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: subject, text: body });
        return toast('Facture partagée.');
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    // Sinon : PDF téléchargé, puis message préparé dans la messagerie (la pièce jointe s'ajoute à la main).
    download(name, pdf, 'application/pdf');
    const to = inv.client?.email ? encodeURIComponent(inv.client.email) : '';
    location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    toast(`${name} est téléchargé : joignez-le au message qui s’ouvre.`);
  },
  einvoice: async ({ id }) => {
    const inv = ws.book.get(id);
    if (isUnconfirmed(inv)) return toast('Numéro en attente de confirmation par le serveur : réessayez dans un instant.', true);
    const problems = checkEn16931(inv);
    if (problems.length) return toast(`Facture électronique non conforme : ${problems[0]}`, true);
    download(ciiFileName(inv), buildCii(inv), 'application/xml;charset=utf-8');
    return toast('Facture électronique CII (EN 16931) téléchargée.');
  },
  'status-add': async ({ id }) => {
    const status = document.querySelector('[data-status-select]').value;
    const detail = document.querySelector('[data-status-detail]').value.trim();
    try {
      ws.book.recordStatus(id, { status, date: today(), detail });
      save();
      render();
      toast(`Statut « ${LIFECYCLE[status].label} » ajouté.`);
    } catch (err) {
      toast(err.message, true);
    }
    return;
  },
  'recurring-toggle': async ({ id }) => {
    const t = ws.recurring.find((x) => x.id === id);
    ws.saveRecurring({ ...t, active: !t.active });
    save();
    return render();
  },
  'recurring-delete': async ({ id }) => {
    if (!confirm('Supprimer cette facture récurrente ? Les factures déjà créées sont conservées.')) return;
    ws.deleteRecurring(id);
    save();
    return render();
  },
  'sales-tab': async ({ el }) => {
    ui.salesTab = el.dataset.tab;
    return render();
  },
  'quote-convert': async ({ id }) => {
    const q = ws.book.get(id);
    const due = defaultDueDate({ type: 'invoice', issueDate: today(), paymentTermsDays: ws.company.paymentTermsDays });
    const draft = ws.book.convertQuote(id, { issueDate: today(), dueDate: due });
    save();
    ui.draft = null;
    location.hash = `#/ventes/modifier-${draft.id}`;
    return toast(`Brouillon de facture créé depuis le devis ${q.number}.`);
  },
};
