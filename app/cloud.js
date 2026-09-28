/**
 * Pont vers Supabase : authentification (mot de passe + code TOTP obligatoire), chargement de l'état
 * depuis la base et file d'envoi des opérations produites par core/sync.js.
 *
 * Modèle : cache local optimiste. Chaque action du dirigeant s'applique immédiatement au Workspace
 * (l'interface reste synchrone), puis son plan d'opérations rejoint une file persistée dans le
 * navigateur et envoyée dans l'ordre. En cas de refus serveur, la file s'arrête (jamais d'envoi
 * dans le désordre) et l'interface affiche le problème ; en cas de divergence (numéro de facture,
 * nombre d'écritures validées), l'état est rechargé depuis la base, qui fait foi.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { planSync, stateFromRows } from '../core/sync.js';
import { ACCOUNTS } from '../core/pcg.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const siteBase = () => window.location.origin + window.location.pathname.replace(/[^/]*$/, '');

// ------------------------------------------------------------------ messages d'erreur lisibles

const AUTH_MESSAGES = [
  [/Invalid login credentials/i, 'E-mail ou mot de passe incorrect.'],
  [/Email not confirmed/i, 'Votre adresse e-mail n’est pas encore confirmée : cliquez sur le lien reçu par e-mail.'],
  [/User already registered/i, 'Un compte existe déjà avec cette adresse : connectez-vous.'],
  [/Password should be at least/i, 'Le mot de passe doit contenir au moins 8 caractères.'],
  [/rate limit|too many/i, 'Trop de tentatives : patientez quelques minutes avant de réessayer.'],
  [/Invalid TOTP code|invalid.*code/i, 'Code incorrect : vérifiez l’heure de votre téléphone et saisissez le code affiché.'],
  [/Failed to fetch|NetworkError/i, 'Connexion impossible : vérifiez votre accès à internet.'],
];
export function friendly(error) {
  const msg = error?.message || String(error);
  return AUTH_MESSAGES.find(([re]) => re.test(msg))?.[1] || msg;
}
const check = ({ data, error }) => {
  if (error) throw error;
  return data;
};

// ------------------------------------------------------------------ authentification

export async function signUp(email, password) {
  return check(await supabase.auth.signUp({ email, password, options: { emailRedirectTo: siteBase() } }));
}
export async function signIn(email, password) {
  return check(await supabase.auth.signInWithPassword({ email, password }));
}
export async function signOut() {
  await supabase.auth.signOut();
}
export async function resendConfirmation(email) {
  return check(await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: siteBase() } }));
}
export async function resetPassword(email) {
  return check(await supabase.auth.resetPasswordForEmail(email, { redirectTo: siteBase() }));
}
export async function updatePassword(password) {
  return check(await supabase.auth.updateUser({ password }));
}
export async function currentSession() {
  return check(await supabase.auth.getSession()).session;
}
export function onAuthChange(cb) {
  return supabase.auth.onAuthStateChange((event, session) => cb(event, session));
}

/** État de la double authentification : 'enroll' (à configurer), 'challenge' (code à saisir) ou 'ok'. */
export async function mfaStatus() {
  const aal = check(await supabase.auth.mfa.getAuthenticatorAssuranceLevel());
  if (aal.currentLevel === 'aal2') return { step: 'ok' };
  const factors = check(await supabase.auth.mfa.listFactors());
  const verified = factors.totp.find((f) => f.status === 'verified');
  if (verified) return { step: 'challenge', factorId: verified.id };
  return { step: 'enroll' };
}

export async function mfaEnroll() {
  // Nettoie un éventuel enrôlement commencé puis abandonné (facteur non vérifié).
  const factors = check(await supabase.auth.mfa.listFactors());
  for (const f of factors.all || []) if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
  const data = check(await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Nexus Gestion ${new Date().toISOString().slice(0, 10)}` }));
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}

export async function mfaVerify(factorId, code) {
  return check(await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.replace(/\s/g, '') }));
}

// ------------------------------------------------------------------ structure et chargement

/** Structure(s) accessibles à l'utilisateur connecté (RLS : uniquement les siennes). */
export async function listStructures() {
  return check(await supabase.from('structures').select('id, name, siren').order('created_at'));
}

export async function createStructure(company) {
  const { name, siren, legalForm, taxRegime, vatRegime, fiscalYear, ...settings } = company;
  return check(
    await supabase.rpc('create_structure', {
      p_siren: siren, p_name: name, p_legal_form: legalForm, p_tax_regime: taxRegime, p_vat_regime: vatRegime,
      p_fy_start: fiscalYear.start, p_fy_end: fiscalYear.end, p_accounts: ACCOUNTS, p_settings: settings,
    }),
  );
}

async function all(query) {
  // PostgREST plafonne les réponses (1000 lignes par défaut) : lecture par pages.
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = check(await query().range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

export async function loadStructure(structureId) {
  const eq = (table, cols = '*') => () => supabase.from(table).select(cols).eq('structure_id', structureId);
  // Exercice ouvert d'abord : seules ses écritures sont chargées (les exercices clos restent en base).
  const fiscalYears = check(await supabase.from('fiscal_years').select('*').eq('structure_id', structureId).is('closed_at', null).order('start_date', { ascending: false }));
  const fiscalYear = fiscalYears[0];
  if (!fiscalYear) throw new Error('Aucun exercice ouvert pour cette entreprise.');
  const [structure, banks, entries, invoices, counters, settlements, clients, purchases, transactions, recurring, documents, events] = await Promise.all([
    supabase.from('structures').select('*').eq('id', structureId).single().then(check),
    supabase.from('bank_accounts').select('id').eq('structure_id', structureId).order('created_at').then(check),
    all(() => eq('entries', '*, entry_lines(*)')().eq('fiscal_year_id', fiscalYear.id).order('seq')),
    all(() => eq('invoices')().order('created_at')),
    supabase.from('invoice_counters').select('*').eq('structure_id', structureId).then(check),
    all(() => eq('settlements')().order('created_at')),
    all(() => eq('clients')().order('created_at')),
    all(() => eq('purchases')().order('created_at')),
    all(() => eq('bank_transactions')().order('imported_at')),
    all(() => eq('recurring_invoices')().order('created_at')),
    all(() => eq('documents')().order('uploaded_at')),
    all(() => eq('invoice_events')().order('position')),
  ]);
  const meta = { structureId, fiscalYearId: fiscalYear.id, bankAccountId: banks[0]?.id };
  const state = stateFromRows({ structure, fiscalYear, entries, invoices, counters, settlements, clients, purchases, transactions, recurring, events });
  return { meta, state, documents };
}

// ------------------------------------------------------------------ exercices clos

/** Exercices clos de la structure, du plus récent au plus ancien. */
export async function closedFiscalYears(structureId) {
  return check(await supabase.from('fiscal_years').select('*').eq('structure_id', structureId).not('closed_at', 'is', null).order('start_date', { ascending: false }));
}

/** Écritures d'un exercice (lecture seule, pagination PostgREST). */
export async function fiscalYearEntries(structureId, fiscalYearId) {
  return all(() => supabase.from('entries').select('*, entry_lines(*)').eq('structure_id', structureId).eq('fiscal_year_id', fiscalYearId).order('seq'));
}

// ------------------------------------------------------------------ clôture et membres

/** Clôture en base (contrôles serveur : tout validé, expert-comptable pour une société) ; renvoie l'id du nouvel exercice. */
export async function closeFiscalYear(fiscalYearId) {
  return check(await supabase.rpc('close_fiscal_year', { p_fiscal_year: fiscalYearId }));
}
export async function inviteMember(structureId, email, role) {
  return check(await supabase.rpc('invite_member', { p_structure: structureId, p_email: email, p_role: role }));
}
export async function listMembers(structureId) {
  return check(await supabase.rpc('list_members', { p_structure: structureId }));
}
export async function myRole(structureId) {
  return check(await supabase.rpc('member_role', { p_structure: structureId }));
}

// ------------------------------------------------------------------ pièces justificatives

async function sha256Hex(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Dépose une pièce au format d'origine, nommée par son empreinte SHA-256 (valeur probante : un
 * fichier altéré ne correspondrait plus à son nom ni à l'empreinte enregistrée), puis la référence
 * dans la table documents. Un même fichier déposé deux fois n'est stocké qu'une fois.
 */
export async function uploadReceipt(structureId, file, { entity, id }) {
  const sha = await sha256Hex(file);
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'bin';
  const path = `${structureId}/${sha}.${ext}`;
  const { error } = await supabase.storage.from('justificatifs').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (error && !/exists|duplicate/i.test(error.message)) throw error;
  return check(
    await supabase
      .from('documents')
      .insert({ structure_id: structureId, storage_path: path, sha256: sha, mime_type: file.type || 'application/octet-stream', original_name: file.name, linked_entity: entity, linked_id: id })
      .select()
      .single(),
  );
}

/** Lien temporaire (5 minutes) vers une pièce privée. */
export async function receiptUrl(path) {
  return check(await supabase.storage.from('justificatifs').createSignedUrl(path, 300)).signedUrl;
}

// ------------------------------------------------------------------ file d'envoi

async function run(op) {
  if (op.kind === 'upsert') {
    return check(await supabase.from(op.table).upsert(op.rows, { onConflict: op.onConflict, ignoreDuplicates: Boolean(op.ignoreDuplicates) }));
  }
  if (op.kind === 'update') return check(await supabase.from(op.table).update(op.values).match(op.match));
  if (op.kind === 'delete') return check(await supabase.from(op.table).delete().match(op.match));
  const result = check(await supabase.rpc(op.fn, op.args));
  if (op.expect?.type === 'invoiceNumber' && result !== op.expect.value) {
    throw Object.assign(new Error(`Numéro attribué par le serveur (${result}) différent de ${op.expect.value}`), { divergence: true });
  }
  if (op.expect?.type === 'count' && result !== op.expect.value) {
    throw Object.assign(new Error(`Le serveur a validé ${result} écriture(s) au lieu de ${op.expect.value}`), { divergence: true });
  }
  return result;
}

export class Outbox {
  /**
   * @param {object} opts
   * @param {string} opts.key clé de stockage local (par structure)
   * @param {(status: {pending: number, error: string|null, divergence?: boolean}) => void} opts.onStatus
   */
  constructor({ key, onStatus }) {
    this.key = key;
    this.onStatus = onStatus;
    this.running = false;
    this.error = null;
    try {
      this.queue = JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      this.queue = [];
    }
  }

  #persist() {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.queue));
    } catch {
      // Stockage plein : la file reste en mémoire, l'envoi continue.
    }
  }

  push(before, after, meta) {
    const ops = planSync(before, after, meta);
    if (!ops.length) return;
    this.queue.push(...ops);
    this.#persist();
    this.flush();
  }

  async flush() {
    if (this.running) return;
    this.running = true;
    this.error = null;
    this.onStatus({ pending: this.queue.length, error: null });
    try {
      while (this.queue.length) {
        await run(this.queue[0]);
        this.queue.shift();
        this.#persist();
      }
    } catch (e) {
      this.error = friendly(e);
      this.onStatus({ pending: this.queue.length, error: this.error, divergence: Boolean(e.divergence) });
      this.running = false;
      return;
    }
    this.running = false;
    this.onStatus({ pending: 0, error: null });
  }

  /** Attend que toutes les opérations soient envoyées ; échoue si le serveur en refuse une. */
  async waitIdle() {
    await this.flush();
    while (this.running) await new Promise((r) => setTimeout(r, 50));
    if (this.error) throw new Error(this.error);
    if (this.queue.length) await this.waitIdle();
  }

  /** Abandonne les opérations en attente (après rechargement depuis la base, qui fait foi). */
  clear() {
    this.queue = [];
    this.#persist();
  }
}
