/**
 * Pages « Fonctionnalités » du site public (une page par carte de la page d'accueil).
 * Les captures (app/features/*.webp) sont prises sur la démonstration par scripts/screenshots.mjs :
 * relancer ce script après toute évolution visible d'un écran.
 * Règle de rédaction : ne décrire que ce que l'application fait réellement aujourd'hui ; ce qui
 * dépend d'un partenaire pas encore branché est annoncé comme tel.
 */
import factures from './site/pages/factures.js?v=c2b4932';
import devis from './site/pages/devis.js?v=c2b4932';
import banque from './site/pages/banque.js?v=c2b4932';
import depenses from './site/pages/depenses.js?v=c2b4932';
import tva from './site/pages/tva.js?v=c2b4932';
import micro from './site/pages/micro.js?v=c2b4932';
import relances from './site/pages/relances.js?v=c2b4932';
import compta from './site/pages/compta.js?v=c2b4932';
import cloture from './site/pages/cloture.js?v=c2b4932';
import securite from './site/pages/securite.js?v=c2b4932';

/** Ordre d'affichage sur la page d'accueil. */
export const FEATURE_PAGES = [factures, devis, banque, depenses, tva, micro, relances, compta, cloture, securite];

export const featureBySlug = (slug) => FEATURE_PAGES.find((f) => f.slug === slug);
