/**
 * Données publiques des entreprises (API Recherche d’entreprises, État, gratuite, sans clé) — §3.1
 * étape 1. L'interprétation du résultat (forme juridique, nom) est dans core/company.js.
 */

import { companyFromSearch } from '../core/company.js?v=e64ad2c';

export async function lookupSiren(siren) {
  const r = await fetch(`https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(siren)}&page=1&per_page=1`);
  if (!r.ok) throw new Error(`Service indisponible (${r.status})`);
  return companyFromSearch((await r.json()).results?.[0], siren);
}
