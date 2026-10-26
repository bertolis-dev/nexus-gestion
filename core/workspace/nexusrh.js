/**
 * Workspace — import du fichier mensuel de Nexus RH (aperçu préparé par core/nexusrh-import.js) :
 * notes de frais en dépenses dues au salarié, tickets restaurant en dépense à la date de commande.
 * Méthode installée sur Workspace.prototype (voir core/workspace.js).
 */

import { noteRef, payrollRef, ticketsRef } from '../nexusrh-import.js?v=eb01de0';
import { payrollEntry } from '../payroll.js?v=eb01de0';

export const nexusRhMethods = {
  /**
   * Enregistre les lignes « à créer » d'un aperçu sans erreur ; les lignes déjà importées sont ignorées.
   * @returns {{ created: number, ignored: number }}
   */
  importNexusRh(preview) {
    if (preview.errors.length) throw new Error('Le fichier contient des erreurs : corrigez-les dans Nexus RH avant l’import.');
    let created = 0;
    let ignored = 0;
    for (const n of preview.notes) {
      // Contrôle refait au moment d'enregistrer : un import lancé deux fois ne crée rien en double.
      if (n.status !== 'new' || this.purchases.some((p) => p.externalRef === noteRef(n.id))) {
        ignored++;
        continue;
      }
      const { purchase } = this.addPurchaseLines(
        {
          // Dépense avancée par le salarié : c'est à lui que l'entreprise la doit (compte 421).
          supplier: { name: n.employee, kind: 'salarie' },
          date: n.date,
          number: n.id,
          documentName: n.receiptRef,
          lines: [{ categoryId: n.categoryId, ht: n.ht, vat: n.vat, vatRateBp: n.vatRateBp, label: n.label }],
        },
        { force: true },
      );
      Object.assign(purchase, { externalRef: noteRef(n.id), dueDate: n.refundDate || n.date });
      if (n.receiptUrl) purchase.receiptUrl = n.receiptUrl;
      created++;
    }
    const t = preview.tickets;
    if (t) {
      const ref = ticketsRef(preview.siren, preview.period);
      if (t.status !== 'new' || this.purchases.some((p) => p.externalRef === ref)) ignored++;
      else {
        const lines = [{ categoryId: 'titres-restaurant', ht: t.employer, vat: 0, vatRateBp: 0 }];
        if (t.total > t.employer) lines.push({ categoryId: 'titres-restaurant-salarie', ht: t.total - t.employer, vat: 0, vatRateBp: 0 });
        const { purchase } = this.addPurchaseLines(
          {
            supplier: { name: 'Titres-restaurant', kind: 'titres-restaurant' },
            date: t.date,
            number: `TR-${preview.period}`,
            documentName: `${t.count} titres-restaurant`,
            lines,
          },
          { force: true },
        );
        Object.assign(purchase, { externalRef: ref, dueDate: t.date });
        created++;
      }
    }
    const pay = preview.payroll;
    if (pay) {
      const ref = payrollRef(preview.siren, preview.period);
      if (pay.status !== 'new' || this.payrolls.some((x) => x.ref === ref)) ignored++;
      else {
        const { status, message, ...data } = pay;
        const record = { id: this._id('PAY'), ref, ...data };
        // Salaires saisis dans Nexus (réglage) : écriture de paie ; sinon l'expert-comptable les passe et
        // Nexus ne les reprend que dans la trésorerie prévisionnelle.
        if (this.company.payrollBy === 'nexus') record.entryId = this.ledger.addDraft(payrollEntry(record)).id;
        this.payrolls.push(record);
        created++;
      }
    }
    return { created, ignored };
  },
};
