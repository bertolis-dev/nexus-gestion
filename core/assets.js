/**
 * Registre des immobilisations (§3.3) : les achats d'équipement au-delà du seuil (500 € HT par
 * défaut) sont inscrits en compte de classe 2 à l'enregistrement de la dépense (purchases.js) ;
 * ce module en dresse la liste et le plan d'amortissement linéaire.
 * Les dotations annuelles sont passées à la clôture (lot 3, écritures d'inventaire) ; la durée
 * retenue par bien est modifiable (paramètre de la structure `assetYears`).
 */

import { divRound, sum } from './money.js';
import { categoryById } from './pcg.js';
import { straightLineSchedule } from './purchases.js';

/** Durées d'usage courantes, à confirmer par l'expert-comptable. */
export const DEFAULT_YEARS = { '205000': 1, '215400': 5, '218200': 5, '218300': 3, '218400': 10 };

export const DEPRECIATION_ACCOUNT = { '205000': '280500', '215400': '281540', '218200': '281820', '218300': '281830', '218400': '281840' };

/**
 * @param {object[]} purchases dépenses du Workspace
 * @param {{ assetYears?: Record<string, number>, fixedAssetThreshold?: number }} company
 * @param {{ start: string, end: string }} fiscalYear exercice pour la dotation affichée
 */
export function fixedAssets(purchases, company, fiscalYear) {
  const threshold = company.fixedAssetThreshold ?? 50000;
  const out = [];
  for (const p of purchases) {
    p.lines.forEach((l, i) => {
      const cat = categoryById(l.categoryId);
      if (!cat.fixedAsset || l.ht < threshold) return;
      const id = `${p.id}#${i}`;
      const years = company.assetYears?.[id] || DEFAULT_YEARS[cat.account] || 5;
      // La TVA non récupérable fait partie du coût d'acquisition (PCG art. 213-8).
      const nonDeductibleVat = divRound(divRound(l.ht * (l.vatRateBp || 0), 10000) * (100 - cat.vatDeductiblePct), 100);
      const cost = l.ht + nonDeductibleVat;
      const schedule = straightLineSchedule({ cost, startDate: p.date, years });
      const fyYear = Number(fiscalYear.end.slice(0, 4));
      const current = schedule.find((s) => s.year === fyYear);
      const before = sum(schedule.filter((s) => s.year < fyYear).map((s) => s.dotation));
      out.push({
        id,
        purchaseId: p.id,
        label: `${cat.label} — ${p.supplier.name}${p.number ? ` ${p.number}` : ''}`,
        date: p.date,
        account: cat.account,
        depreciationAccount: DEPRECIATION_ACCOUNT[cat.account],
        cost,
        years,
        schedule,
        dotationThisYear: current?.dotation || 0,
        netBookValue: cost - before - (current?.dotation || 0),
      });
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
