/**
 * Workspace — import du fichier mensuel de Nexus RH (aperçu préparé par core/nexusrh-import.js) :
 * notes de frais en dépenses dues au salarié, tickets restaurant en dépense à la date de commande.
 * Méthode installée sur Workspace.prototype (voir core/workspace.js).
 */

import { noteRef, ticketsRef } from '../nexusrh-import.js?v=df4a177';

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
          documentName: n.label,
          lines: [{ categoryId: n.categoryId, ht: n.ht, vat: n.vat, vatRateBp: n.vatRateBp }],
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
    return { created, ignored };
  },
};
