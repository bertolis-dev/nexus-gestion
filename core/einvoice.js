/**
 * Facture électronique au format CII (UN/CEFACT Cross Industry Invoice D16B), profil EN 16931 —
 * l'un des trois formats acceptés par les plateformes agréées (§2 : « Factur-X profil EN 16931
 * minimum, UBL ou CII »). Le même XML constitue la partie structurée d'un Factur-X.
 *
 * Construit à partir d'une facture ÉMISE (InvoiceBook.issue) : numéro, émetteur figé, totaux par
 * taux et mentions sont ceux de l'instantané, jamais recalculés depuis des paramètres qui auraient
 * changé depuis. L'ordre des éléments suit le schéma XSD (il est imposé).
 *
 * `checkEn16931` rejoue les principales règles métier de la norme (BR-xx, BR-CO-xx) sur le modèle ;
 * la validation officielle (schéma + Schematron EN 16931 et CIUS FR) reste à faire en recette sur
 * le validateur de la PA retenue.
 */

import { lineHt } from './invoices.js';
import { sum, vatFromHt } from './money.js';

const NS = {
  rsm: 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100',
  ram: 'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100',
  qdt: 'urn:un:unece:uncefact:data:standard:QualifiedDataType:100',
  udt: 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100',
};

export const DOCUMENT_TYPES = { invoice: '380', credit: '381', deposit: '386' };

const xmlEscape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const amount = (cents) => `${cents < 0 ? '-' : ''}${Math.trunc(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
const rate = (bp) => (bp / 100).toFixed(2).replace(/\.?0+$/, '') || '0';
const date102 = (iso) => iso.replaceAll('-', '');
const quantity = (q) => String(Math.round(Number(q) * 10000) / 10000);

/** « 12 rue des Lilas, 69003 Lyon » → { line, postcode, city }. */
export function splitAddress(address = '') {
  const a = String(address).replace(/\s+/g, ' ').trim();
  const m = /^(.*?)[,\s]+(\d{5})\s+(.+)$/.exec(a);
  if (!m) return { line: a, postcode: '', city: '' };
  return { line: m[1].replace(/,\s*$/, '').trim(), postcode: m[2], city: m[3].trim() };
}

/**
 * Catégorie de TVA EN 16931 (UNCL5305) d'une facture :
 *  S  = taux normal / réduit ; E = exonéré (franchise en base 293 B) ;
 *  AE = autoliquidation (prestation de services intra-UE) ; K = livraison intracommunautaire.
 */
export function vatCategory(inv, issuer) {
  if (issuer.vatRegime === 'franchise') return { code: 'E', reason: 'TVA non applicable, art. 293 B du CGI', reasonCode: 'VATEX-FR-FRANCHISE' };
  const c = inv.client || {};
  if (c.type !== 'B2C' && (c.country || 'FR') !== 'FR') {
    return inv.operationNature === 'services'
      ? { code: 'AE', reason: 'Autoliquidation', reasonCode: 'VATEX-EU-AE' }
      : { code: 'K', reason: 'Livraison intracommunautaire exonérée, art. 262 ter I du CGI', reasonCode: 'VATEX-EU-IC' };
  }
  return { code: 'S' };
}

function party(tag, { name, siren, address, country = 'FR', vatNumber, email }) {
  const a = splitAddress(address);
  return `<ram:${tag}>
        <ram:Name>${xmlEscape(name)}</ram:Name>
        ${siren ? `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${xmlEscape(siren)}</ram:ID></ram:SpecifiedLegalOrganization>` : ''}
        <ram:PostalTradeAddress>
          ${a.postcode ? `<ram:PostcodeCode>${a.postcode}</ram:PostcodeCode>` : ''}
          ${a.line ? `<ram:LineOne>${xmlEscape(a.line)}</ram:LineOne>` : ''}
          ${a.city ? `<ram:CityName>${xmlEscape(a.city)}</ram:CityName>` : ''}
          <ram:CountryID>${xmlEscape(country)}</ram:CountryID>
        </ram:PostalTradeAddress>
        ${siren ? `<ram:URIUniversalCommunication><ram:URIID schemeID="0225">${xmlEscape(siren)}</ram:URIID></ram:URIUniversalCommunication>` : email ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${xmlEscape(email)}</ram:URIID></ram:URIUniversalCommunication>` : ''}
        ${vatNumber ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${xmlEscape(vatNumber)}</ram:ID></ram:SpecifiedTaxRegistration>` : ''}
      </ram:${tag}>`;
}

/** Montants signés : un avoir (381) porte des montants positifs, c'est le type de document qui l'inverse. */
export function buildCii(inv) {
  if (inv.status !== 'issued') throw new Error('Seule une facture émise peut être transmise.');
  if (inv.type === 'quote') throw new Error('Un devis ne se transmet pas en facture électronique.');
  const issuer = inv.issuer;
  const cat = vatCategory(inv, issuer);
  const vatOnReceipt = inv.operationNature === 'services' && !issuer.vatOnDebits && cat.code === 'S';
  const notes = [
    ...(inv.mentions || []).map((m) => ({ code: /retard|pénalités/i.test(m) ? 'PMD' : 'AAI', text: m })),
    { code: 'AAI', text: `Nature des opérations : ${inv.operationNature}` },
  ];
  if (issuer.capital) notes.push({ code: 'ABL', text: `${issuer.legalForm} au capital de ${issuer.capital}` });

  const lines = inv.lines.map((l, i) => {
    const net = lineHt(l);
    const lineRate = cat.code === 'S' ? l.vatRateBp : 0;
    return `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>${i + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>${xmlEscape(l.label)}</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice><ram:ChargeAmount>${amount(l.unitPrice)}</ram:ChargeAmount></ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="C62">${quantity(l.qty)}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>${cat.code}</ram:CategoryCode><ram:RateApplicablePercent>${rate(lineRate)}</ram:RateApplicablePercent></ram:ApplicableTradeTax>
        ${l.discountBp ? `<ram:SpecifiedTradeAllowanceCharge><ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator><ram:ActualAmount>${amount(Math.round(Number(l.qty) * l.unitPrice) - net)}</ram:ActualAmount><ram:Reason>Remise</ram:Reason></ram:SpecifiedTradeAllowanceCharge>` : ''}
        <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${amount(net)}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`;
  });

  const taxes = inv.totals.vatBreakdown.map(
    (v) => `
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${amount(v.vat)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        ${cat.reason ? `<ram:ExemptionReason>${xmlEscape(cat.reason)}</ram:ExemptionReason>` : ''}
        <ram:BasisAmount>${amount(v.base)}</ram:BasisAmount>
        <ram:CategoryCode>${cat.code}</ram:CategoryCode>
        ${cat.reasonCode ? `<ram:ExemptionReasonCode>${cat.reasonCode}</ram:ExemptionReasonCode>` : ''}
        ${cat.code === 'S' ? `<ram:DueDateTypeCode>${vatOnReceipt ? '72' : '5'}</ram:DueDateTypeCode>` : ''}
        <ram:RateApplicablePercent>${rate(cat.code === 'S' ? v.rateBp : 0)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`,
  );

  const t = inv.totals;
  const c = inv.client;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="${NS.rsm}" xmlns:ram="${NS.ram}" xmlns:qdt="${NS.qdt}" xmlns:udt="${NS.udt}">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${xmlEscape(inv.number)}</ram:ID>
    <ram:TypeCode>${DOCUMENT_TYPES[inv.type || 'invoice']}</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">${date102(inv.issueDate)}</udt:DateTimeString></ram:IssueDateTime>
    ${notes.map((n) => `<ram:IncludedNote><ram:Content>${xmlEscape(n.text)}</ram:Content><ram:SubjectCode>${n.code}</ram:SubjectCode></ram:IncludedNote>`).join('\n    ')}
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>${lines.join('')}
    <ram:ApplicableHeaderTradeAgreement>
      ${party('SellerTradeParty', { name: issuer.name, siren: issuer.siren, address: issuer.address, vatNumber: issuer.vatNumber })}
      ${party('BuyerTradeParty', { name: c.name, siren: c.type === 'B2C' ? '' : c.siren, address: c.address, country: c.country || 'FR', vatNumber: c.vatNumber, email: c.email })}
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      ${issuer.iban ? `<ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>58</ram:TypeCode><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>${xmlEscape(issuer.iban.replace(/\s/g, ''))}</ram:IBANID></ram:PayeePartyCreditorFinancialAccount></ram:SpecifiedTradeSettlementPaymentMeans>` : ''}${taxes.join('')}
      <ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime><udt:DateTimeString format="102">${date102(inv.dueDate)}</udt:DateTimeString></ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${amount(t.totalHt)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${amount(t.totalHt)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">${amount(t.totalVat)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${amount(t.totalTtc)}</ram:GrandTotalAmount>
        ${t.depositsDeducted ? `<ram:TotalPrepaidAmount>${amount(t.depositsDeducted)}</ram:TotalPrepaidAmount>` : ''}
        <ram:DuePayableAmount>${amount(t.netToPay)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
      ${inv.creditOf ? `<ram:InvoiceReferencedDocument><ram:IssuerAssignedID>${xmlEscape(inv.creditOf)}</ram:IssuerAssignedID></ram:InvoiceReferencedDocument>` : ''}
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;
  // Supprime les lignes vides laissées par les éléments facultatifs absents.
  return xml.replace(/\n\s*\n/g, '\n');
}

/**
 * Règles métier EN 16931 vérifiées sur la facture émise (sous-ensemble : cohérence des montants,
 * parties obligatoires, catégories). Renvoie la liste des règles violées.
 */
export function checkEn16931(inv) {
  const errors = [];
  const rule = (ok, code, msg) => ok || errors.push(`${code} : ${msg}`);
  const issuer = inv.issuer || {};
  const c = inv.client || {};
  const t = inv.totals;
  const cat = vatCategory(inv, issuer);
  rule(Boolean(inv.number), 'BR-02', 'numéro de facture obligatoire');
  rule(Boolean(inv.issueDate), 'BR-03', 'date d’émission obligatoire');
  rule(Boolean(issuer.name), 'BR-06', 'nom du vendeur obligatoire');
  rule(Boolean(c.name), 'BR-07', 'nom de l’acheteur obligatoire');
  rule(Boolean(splitAddress(issuer.address).postcode || issuer.address), 'BR-08', 'adresse du vendeur obligatoire');
  rule(inv.lines.length > 0, 'BR-16', 'au moins une ligne');
  if (cat.code === 'S') rule(/^FR/.test(issuer.vatNumber || ''), 'BR-S-02', 'n° de TVA du vendeur obligatoire en catégorie S');
  if (cat.code === 'AE' || cat.code === 'K') rule(Boolean(c.vatNumber), `BR-${cat.code}-02`, 'n° de TVA de l’acheteur obligatoire');
  if (cat.code === 'E') rule(t.totalVat === 0, 'BR-E-10', 'aucune TVA en catégorie exonérée');
  if (c.type !== 'B2C' && (c.country || 'FR') === 'FR') rule(/^\d{9}$/.test(c.siren || ''), 'BR-FR-10', 'SIREN de l’acheteur obligatoire (B2B France)');

  const lineSum = sum(inv.lines.map(lineHt));
  rule(lineSum === t.totalHt, 'BR-CO-10', `somme des lignes (${lineSum}) ≠ total HT (${t.totalHt})`);
  rule(t.totalHt + t.totalVat === t.totalTtc, 'BR-CO-15', 'TTC ≠ HT + TVA');
  rule(sum(t.vatBreakdown.map((v) => v.vat)) === t.totalVat, 'BR-CO-14', 'TVA totale ≠ somme des TVA par taux');
  for (const v of t.vatBreakdown) {
    const base = sum(inv.lines.filter((l) => (cat.code === 'S' ? l.vatRateBp : 0) === v.rateBp).map(lineHt));
    rule(base === v.base, 'BR-S-08', `base du taux ${v.rateBp / 100} % incohérente`);
    if (cat.code === 'S') rule(vatFromHt(v.base, v.rateBp) === v.vat, 'BR-S-09', `TVA du taux ${v.rateBp / 100} % mal arrondie`);
  }
  if (inv.type === 'credit') rule(Boolean(inv.creditOf), 'BR-FR-CO-04', 'un avoir référence la facture d’origine');
  return errors;
}

export function ciiFileName(inv) {
  return `${inv.issuer.siren}_${inv.number}.xml`;
}
