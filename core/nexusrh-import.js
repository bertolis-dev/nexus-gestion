/**
 * Pont Nexus RH → Nexus Gestion : lecture et contrôle du fichier d'export mensuel de Nexus RH
 * (format « nexus-rh-export », version 1, contrat partagé — ne pas le modifier ici). Produit un aperçu
 * ligne par ligne ; rien n'est enregistré ici (voir Workspace.importNexusRh, core/workspace/nexusrh.js).
 *
 * Hypothèses sur le contrat, à confirmer avec Nexus RH (docs/regles-a-valider.md) : montants en euros
 * (nombres décimaux), taux de TVA en pourcentage (20 pour 20 %), catégories en clair.
 */

import { formatEuros } from './money.js?v=eb01de0';
import { parsePayroll } from './payroll.js?v=eb01de0';

export const NEXUS_RH_FORMAT = 'nexus-rh-export';
export const NEXUS_RH_VERSION = 1;

/**
 * Catégorie de note de frais Nexus RH (en minuscules, sans accents) → catégorie de dépense Nexus
 * Gestion (core/pcg.js, dont les règles de TVA récupérable s'appliquent). Une catégorie absente de
 * cette table bloque l'import : la dépense ne doit pas être rangée au hasard.
 */
export const NEXUS_RH_CATEGORIES = {
  repas: 'repas',
  restaurant: 'repas',
  restauration: 'repas',
  hotel: 'hotel',
  hebergement: 'hotel',
  transport: 'deplacements',
  train: 'deplacements',
  avion: 'deplacements',
  taxi: 'deplacements',
  deplacement: 'deplacements',
  deplacements: 'deplacements',
  carburant: 'carburant-vp',
  // Indemnités kilométriques : remboursement forfaitaire du véhicule personnel, sans TVA.
  kilometrique: 'deplacements',
  'indemnites kilometriques': 'deplacements',
  'frais kilometriques': 'deplacements',
  fournitures: 'fournitures',
  'fournitures de bureau': 'fournitures',
  telephone: 'telecom',
  telecom: 'telecom',
  internet: 'telecom',
  logiciel: 'logiciel',
  abonnement: 'logiciel',
  formation: 'formation',
  documentation: 'formation',
  cadeau: 'cadeaux',
  cadeaux: 'cadeaux',
  materiel: 'petit-materiel',
  'petit materiel': 'petit-materiel',
};

const RATES_PCT = [20, 10, 5.5, 2.1, 0];
const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const eur = (cents) => formatEuros(cents).replace(/\s/g, ' ');

/** Montant en euros du fichier → centimes (null si illisible ou négatif). */
function cents(v) {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export const noteRef = (id) => `nexus-rh:${id}`;
export const ticketsRef = (siren, period) => `nexus-rh:tickets:${siren}:${period}`;
export const payrollRef = (siren, period) => `nexus-rh:paie:${siren}:${period}`;

/**
 * @param {import('./workspace.js?v=eb01de0').Workspace} ws
 * @param {string} text contenu du fichier choisi par l'utilisateur
 * @returns {{ errors: string[], period?, notes: object[], tickets: object|null, toCreate: number }}
 */
export function previewNexusRhImport(ws, text) {
  const errors = [];
  const out = { errors, notes: [], tickets: null, payroll: null, toCreate: 0 };
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    d = null;
  }
  if (!d || typeof d !== 'object' || d.format !== NEXUS_RH_FORMAT) {
    errors.push('Ce fichier n’est pas un fichier d’export Nexus RH : dans Nexus RH, utilisez « Exporter vers Nexus Gestion » et choisissez le fichier obtenu.');
    return out;
  }
  if (d.version !== NEXUS_RH_VERSION) {
    errors.push(
      `Ce fichier est au format version ${d.version}, que cette version de Nexus Gestion ne lit pas encore : mettez à jour Nexus Gestion (bouton recharger).`,
    );
    return out;
  }
  if (String(d.siren) !== String(ws.company.siren)) {
    errors.push(
      `Ce fichier concerne l’entreprise de SIREN ${d.siren}, et non la vôtre (${ws.company.siren}) : vérifiez l’entreprise ouverte dans Nexus RH et dans Nexus Gestion.`,
    );
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(d.periode || ''))
    errors.push('La période du fichier est illisible (attendu : AAAA-MM) : exportez de nouveau depuis Nexus RH.');
  out.period = d.periode;
  // Salaires du mois (journal de paie de Nexus RH) : contrôlés ici, repris selon le réglage
  // « Qui saisit les salaires ? » (core/payroll.js).
  if (d.paie !== null && d.paie !== undefined) {
    const { errors: payErrors, payroll } = parsePayroll(d.paie, /^\d{4}-\d{2}$/.test(d.periode || '') ? d.periode : '1970-01');
    errors.push(...payErrors);
    if (payroll) {
      const already = (ws.payrolls || []).some((x) => x.ref === payrollRef(d.siren, d.periode));
      out.payroll = { ...payroll, status: already ? 'already' : 'new', message: already ? 'Salaires de ce mois déjà importés.' : '' };
    }
  }

  const known = new Map(ws.purchases.filter((p) => p.externalRef).map((p) => [p.externalRef, p]));
  for (const [i, n] of (Array.isArray(d.notes_de_frais) ? d.notes_de_frais : []).entries()) {
    const id = String(n?.id ?? '').trim();
    const where = `Note ${id || `n° ${i + 1}`}`;
    const ht = cents(n?.montant_ht);
    const vat = cents(n?.tva);
    const ttc = cents(n?.montant_ttc);
    const categoryId = NEXUS_RH_CATEGORIES[norm(n?.categorie)];
    const rate = typeof n?.taux_tva === 'string' ? Number(n.taux_tva.replace(',', '.')) : n?.taux_tva;
    const line = {
      id,
      date: n?.date,
      employee: String(n?.salarie ?? '').trim(),
      category: n?.categorie,
      categoryId,
      label: String(n?.libelle ?? '').trim(),
      ht,
      vat,
      ttc,
      vatRateBp: RATES_PCT.includes(rate) ? Math.round(rate * 100) : null,
      // Lien web (https) consultable depuis Nexus Gestion, ou chemin du justificatif dans le stockage de
      // Nexus RH (format réel v1) gardé comme référence de la pièce.
      receiptUrl: typeof n?.justificatif_url === 'string' && /^https:\/\//.test(n.justificatif_url) ? n.justificatif_url : null,
      receiptRef: typeof n?.justificatif_url === 'string' ? n.justificatif_url.trim().slice(0, 300) : '',
      refundDate: isDate(n?.date_remboursement) ? n.date_remboursement : null,
      status: 'new',
      message: '',
    };
    const problems = [];
    if (!id) problems.push('identifiant manquant');
    if (!isDate(line.date)) problems.push('date illisible');
    if (!line.employee) problems.push('salarié non indiqué');
    if (ht === null || vat === null || ttc === null) problems.push('montant illisible');
    else if (Math.abs(ht + vat - ttc) > 1) problems.push(`${eur(ht)} + ${eur(vat)} ≠ ${eur(ttc)} (HT + TVA doit égaler le TTC)`);
    if (!categoryId) problems.push(`catégorie « ${n?.categorie ?? ''} » inconnue de Nexus Gestion : choisissez une autre catégorie dans Nexus RH`);
    if (line.vatRateBp === null) problems.push(`taux de TVA « ${n?.taux_tva} » non reconnu (attendu : 20, 10, 5,5, 2,1 ou 0)`);
    if (problems.length) {
      line.status = 'error';
      line.message = problems.join(' ; ');
      errors.push(`${where} : ${line.message}.`);
    } else if (known.has(noteRef(id))) {
      line.status = 'already';
      const prev = known.get(noteRef(id));
      line.message =
        prev.totalTtc !== ttc
          ? `Déjà importée, avec un montant différent de l’import précédent (${eur(prev.totalTtc)}) : corrigez-la à la main si besoin.`
          : 'Déjà importée.';
    }
    out.notes.push(line);
  }

  const t = d.tickets_restaurant;
  if (t) {
    const total = cents(t.montant_total);
    const employer = cents(t.part_employeur);
    const tickets = { count: Number(t.nombre) || 0, total, employer, date: t.date_commande, status: 'new', message: '' };
    const problems = [];
    if (total === null || employer === null) problems.push('montant illisible');
    else if (employer > total) problems.push(`la part employeur (${eur(employer)}) dépasse le montant total (${eur(total)})`);
    if (!isDate(t.date_commande)) problems.push('date de commande illisible');
    if (problems.length) {
      tickets.status = 'error';
      tickets.message = problems.join(' ; ');
      errors.push(`Tickets restaurant : ${tickets.message}.`);
    } else if (known.has(ticketsRef(d.siren, d.periode))) {
      tickets.status = 'already';
      tickets.message = 'Déjà importés pour cette période.';
    }
    if (total) out.tickets = tickets;
  }
  out.siren = String(d.siren);
  out.toCreate = out.notes.filter((n) => n.status === 'new').length + (out.tickets?.status === 'new' ? 1 : 0) + (out.payroll?.status === 'new' ? 1 : 0);
  return out;
}
