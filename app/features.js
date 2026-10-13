/**
 * Pages « Fonctionnalités » du site public (une page par carte de la page d'accueil).
 * Les captures (app/features/*.webp) sont prises sur la démonstration par scripts/screenshots.mjs :
 * relancer ce script après toute évolution visible d'un écran.
 * Règle de rédaction : ne décrire que ce que l'application fait réellement aujourd'hui ; ce qui
 * dépend d'un partenaire pas encore branché est annoncé comme tel.
 */
import factures from './site/pages/factures.js?v=214818f';
import devis from './site/pages/devis.js?v=214818f';
import banque from './site/pages/banque.js?v=214818f';
import depenses from './site/pages/depenses.js?v=214818f';
import tva from './site/pages/tva.js?v=214818f';
import micro from './site/pages/micro.js?v=214818f';
import relances from './site/pages/relances.js?v=214818f';
import compta from './site/pages/compta.js?v=214818f';
import cloture from './site/pages/cloture.js?v=214818f';
import securite from './site/pages/securite.js?v=214818f';

/** Ordre d'affichage sur la page d'accueil. */
export const FEATURE_PAGES = [factures, devis, banque, depenses, tva, micro, relances, compta, cloture, securite];

export const featureBySlug = (slug) => FEATURE_PAGES.find((f) => f.slug === slug);
