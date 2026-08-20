import { Buffer } from 'node:buffer';
import type {
  BrowserCommitmentAmount,
  BrowserCommitmentConfidence,
  BrowserCommitmentKind,
  BrowserCommitmentSummary,
} from './commitmentDetector.js';
import type { DocumentContentSnapshot } from './documentContent.js';

export type BrowserCommitmentVerificationStatus =
  | 'confirmed'
  | 'pending'
  | 'declined'
  | 'canceled'
  | 'mismatch'
  | 'unknown';

export type BrowserCommitmentMaterialField =
  | 'amount'
  | 'currency'
  | 'counterparty'
  | 'schedule'
  | 'recurrence';

export type BrowserCommitmentVerificationEvidenceCode =
  | 'confirmed-outcome'
  | 'pending-outcome'
  | 'declined-outcome'
  | 'canceled-outcome'
  | 'amount-visible'
  | 'counterparty-visible'
  | 'schedule-visible'
  | 'recurrence-visible'
  | 'material-mismatch'
  | 'document-context-incomplete'
  | 'document-context-unavailable';

export interface BrowserCommitmentVerificationEvidence {
  code: BrowserCommitmentVerificationEvidenceCode;
  source: 'document' | 'policy';
}

export interface BrowserCommitmentObservedTerms {
  amount?: BrowserCommitmentAmount;
  counterparty?: string;
  schedule?: string;
  recurrence?: 'recurring' | 'one-time' | 'unknown';
}

export interface BrowserCommitmentVerificationSummary {
  status: BrowserCommitmentVerificationStatus;
  confidence: BrowserCommitmentConfidence;
  commitmentKind: BrowserCommitmentKind;
  /** Material field names only are safe for ordinary traces. Values remain here for explicit callers. */
  mismatchedFields: BrowserCommitmentMaterialField[];
  observed: BrowserCommitmentObservedTerms;
  documentContext: 'available' | 'incomplete' | 'unavailable';
  evidence: BrowserCommitmentVerificationEvidence[];
}

export interface BrowserCommitmentVerificationOptions {
  maxDocumentBlocks?: number;
  maxEvidence?: number;
  maxScalarBytes?: number;
}

type OutcomeStatus = Exclude<BrowserCommitmentVerificationStatus, 'mismatch' | 'unknown'>;

interface OutcomeRule {
  status: OutcomeStatus;
  phrases: readonly string[];
}

const OUTCOME_RULES: Readonly<Record<BrowserCommitmentKind, readonly OutcomeRule[]>> = {
  purchase: [
    { status: 'canceled', phrases: ['order canceled', 'order cancelled', 'payment canceled', 'payment cancelled'] },
    { status: 'declined', phrases: ['payment declined', 'card declined', 'payment failed', 'order failed', 'could not process payment'] },
    { status: 'pending', phrases: ['order pending', 'order processing', 'processing your order', 'payment pending', 'payment processing'] },
    { status: 'confirmed', phrases: ['order confirmed', 'order placed', 'purchase complete', 'purchase completed', 'payment successful', 'payment received', 'thank you for your order', 'thanks for your order'] },
  ],
  booking: [
    { status: 'canceled', phrases: ['booking canceled', 'booking cancelled', 'reservation canceled', 'reservation cancelled'] },
    { status: 'declined', phrases: ['booking failed', 'reservation failed', 'booking declined', 'reservation declined'] },
    { status: 'pending', phrases: ['booking pending', 'reservation pending', 'booking processing', 'reservation processing'] },
    { status: 'confirmed', phrases: ['booking confirmed', 'reservation confirmed', 'booking complete', 'reservation complete'] },
  ],
  'financial-transfer': [
    { status: 'canceled', phrases: ['transfer canceled', 'transfer cancelled', 'payment canceled', 'payment cancelled'] },
    { status: 'declined', phrases: ['transfer declined', 'transfer failed', 'payment declined', 'payment failed'] },
    { status: 'pending', phrases: ['transfer pending', 'transfer processing', 'payment pending', 'payment processing'] },
    { status: 'confirmed', phrases: ['transfer complete', 'transfer completed', 'transfer successful', 'money sent', 'payment sent'] },
  ],
  subscription: [
    { status: 'canceled', phrases: ['subscription canceled', 'subscription cancelled', 'trial canceled', 'trial cancelled'] },
    { status: 'declined', phrases: ['subscription failed', 'subscription declined', 'trial failed'] },
    { status: 'pending', phrases: ['subscription pending', 'subscription processing', 'trial pending'] },
    { status: 'confirmed', phrases: ['subscription active', 'subscription started', 'subscription confirmed', 'trial started', 'free trial started'] },
  ],
  publish: [
    { status: 'canceled', phrases: ['publication canceled', 'publication cancelled', 'publishing canceled', 'publishing cancelled'] },
    { status: 'declined', phrases: ['publication failed', 'publishing failed', 'publish failed'] },
    { status: 'pending', phrases: ['publication pending', 'publishing in progress', 'publish pending'] },
    { status: 'confirmed', phrases: ['published successfully', 'post published', 'page published', 'campaign sent', 'publication complete'] },
  ],
  destructive: [
    { status: 'canceled', phrases: ['deletion canceled', 'deletion cancelled'] },
    { status: 'declined', phrases: ['deletion failed', 'could not delete'] },
    { status: 'pending', phrases: ['deletion pending', 'deletion scheduled', 'scheduled for deletion'] },
    { status: 'confirmed', phrases: ['account deleted', 'workspace deleted', 'project deleted', 'deletion complete', 'permanently deleted'] },
  ],
  'identity-security': [
    { status: 'canceled', phrases: ['security change canceled', 'security change cancelled'] },
    { status: 'declined', phrases: ['password change failed', 'security change failed', 'could not update security'] },
    { status: 'pending', phrases: ['security change pending', 'password change pending'] },
    { status: 'confirmed', phrases: ['password changed', 'password updated', 'two factor disabled', '2fa disabled', 'passkey removed', 'sessions revoked', 'other sessions signed out'] },
  ],
  'process-trigger': [
    { status: 'canceled', phrases: ['deployment canceled', 'deployment cancelled', 'workflow canceled', 'workflow cancelled', 'job canceled', 'job cancelled'] },
    { status: 'declined', phrases: ['deployment failed', 'workflow failed', 'job failed', 'trigger failed'] },
    { status: 'pending', phrases: ['deployment started', 'deployment queued', 'workflow started', 'workflow queued', 'job started', 'job queued'] },
    { status: 'confirmed', phrases: ['deployment complete', 'deployment completed', 'workflow complete', 'workflow completed', 'job complete', 'job completed'] },
  ],
};

const positiveInteger = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value));

function normalize(value: string | undefined): string {
  return (value ?? '').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

function containsPhrase(text: string, phrase: string): boolean {
  if (!text) return false;
  const haystack = ` ${text.replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const needle = ` ${phrase.replace(/[^a-z0-9]+/g, ' ').trim()} `;
  return haystack.includes(needle);
}

function boundedUtf8(value: string | undefined, maxBytes: number): string | undefined {
  if (!value) return undefined;
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let output = '';
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output || undefined;
}

function documentTexts(document: DocumentContentSnapshot, maxBlocks: number): string[] {
  const texts: string[] = [];
  for (const block of document.blocks) {
    if (texts.length >= maxBlocks) break;
    if (!block.rendered) continue;
    const text = normalize([block.text, block.name, block.alt].filter(Boolean).join(' '));
    if (text) texts.push(text.slice(0, 2048));
  }
  return texts;
}

function addEvidence(
  evidence: BrowserCommitmentVerificationEvidence[],
  maxEvidence: number,
  code: BrowserCommitmentVerificationEvidenceCode,
  source: 'document' | 'policy' = 'document',
): void {
  if (evidence.length >= maxEvidence || evidence.some((item) => item.code === code)) return;
  evidence.push({ code, source });
}

function outcomeStatus(kind: BrowserCommitmentKind, texts: readonly string[]): OutcomeStatus | undefined {
  for (const rule of OUTCOME_RULES[kind]) {
    if (rule.phrases.some((phrase) => texts.some((text) => containsPhrase(text, phrase)))) {
      return rule.status;
    }
  }
  return undefined;
}

function extractAmount(texts: readonly string[], maxBytes: number): BrowserCommitmentAmount | undefined {
  const label = '(?:amount|order total|booking total|reservation total|transfer amount|payment amount|charged|paid|total)';
  const codePattern = new RegExp(`\\b${label}\\s*[:\\-–—]?\\s*(AUD|USD|EUR|GBP|CAD|NZD|JPY)\\s*(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)`, 'i');
  const symbolPattern = new RegExp(`\\b${label}\\s*[:\\-–—]?\\s*([$€£])\\s*(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)`, 'i');
  for (const text of texts) {
    const coded = codePattern.exec(text);
    if (coded) {
      const raw = boundedUtf8(coded[0], maxBytes);
      if (raw) return { text: raw, currency: coded[1]!.toUpperCase(), value: coded[2]! };
    }
    const symbol = symbolPattern.exec(text);
    if (symbol) {
      const raw = boundedUtf8(symbol[0], maxBytes);
      if (raw) return { text: raw, currency: symbol[1]!, value: symbol[2]! };
    }
  }
  return undefined;
}

function extractLabeledValue(
  texts: readonly string[],
  labels: readonly string[],
  maxBytes: number,
): string | undefined {
  for (const text of texts) {
    for (const label of labels) {
      const index = text.indexOf(label);
      if (index < 0) continue;
      const tail = text.slice(index + label.length).replace(/^\s*[:\-–—]\s*/, '').trim();
      const value = tail.split(/[|•\n]/, 1)[0]?.trim();
      if (value && value.length <= 160) return boundedUtf8(value, maxBytes);
    }
  }
  return undefined;
}

function extractRecurrence(texts: readonly string[]): 'recurring' | 'one-time' | 'unknown' {
  if (texts.some((text) => ['one time', 'one-time', 'single payment', 'does not renew'].some((phrase) => containsPhrase(text, phrase)))) {
    return 'one-time';
  }
  if (texts.some((text) => ['renews', 'recurring', 'per month', 'monthly', 'per year', 'annually'].some((phrase) => containsPhrase(text, phrase)))) {
    return 'recurring';
  }
  return 'unknown';
}

function canonicalAmount(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/,/g, '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return undefined;
  const [wholeRaw, fractionRaw = ''] = normalized.split('.');
  const whole = wholeRaw!.replace(/^0+(?=\d)/, '') || '0';
  const fraction = fractionRaw.replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function comparableCurrency(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.toUpperCase();
  if (/^[A-Z]{3}$/.test(normalized)) return normalized;
  if (value === '$' || value === '€' || value === '£') return value;
  return undefined;
}

function normalizedComparable(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return normalize(value).replace(/[^a-z0-9]+/g, ' ').trim();
}

function materialMismatches(
  approved: BrowserCommitmentSummary,
  observed: BrowserCommitmentObservedTerms,
): BrowserCommitmentMaterialField[] {
  const mismatches: BrowserCommitmentMaterialField[] = [];
  const expectedAmount = canonicalAmount(approved.amount?.value);
  const observedAmount = canonicalAmount(observed.amount?.value);
  if (expectedAmount && observedAmount && expectedAmount !== observedAmount) mismatches.push('amount');

  const expectedCurrency = comparableCurrency(approved.amount?.currency);
  const observedCurrency = comparableCurrency(observed.amount?.currency);
  if (expectedCurrency && observedCurrency) {
    const sameShape = (/^[A-Z]{3}$/.test(expectedCurrency) && /^[A-Z]{3}$/.test(observedCurrency)) ||
      (!/^[A-Z]{3}$/.test(expectedCurrency) && !/^[A-Z]{3}$/.test(observedCurrency));
    if (sameShape && expectedCurrency !== observedCurrency) mismatches.push('currency');
  }

  const expectedCounterparty = normalizedComparable(approved.counterparty);
  const observedCounterparty = normalizedComparable(observed.counterparty);
  if (expectedCounterparty && observedCounterparty && expectedCounterparty !== observedCounterparty) mismatches.push('counterparty');

  const expectedSchedule = normalizedComparable(approved.schedule);
  const observedSchedule = normalizedComparable(observed.schedule);
  if (expectedSchedule && observedSchedule && expectedSchedule !== observedSchedule) mismatches.push('schedule');

  if (approved.recurrence === 'recurring' && observed.recurrence === 'one-time') mismatches.push('recurrence');
  return mismatches;
}

/**
 * Verify an already-approved browser commitment from bounded structured document
 * state. Generic navigation or DOM mutation is deliberately insufficient:
 * confirmation requires explicit outcome text for the approved commitment kind.
 */
export function verifyBrowserCommitment(
  approved: BrowserCommitmentSummary,
  document: DocumentContentSnapshot | undefined,
  options: BrowserCommitmentVerificationOptions = {},
): BrowserCommitmentVerificationSummary {
  if (!approved.kind) throw new Error('approved commitment kind is required for verification');
  const maxDocumentBlocks = positiveInteger(options.maxDocumentBlocks, 128);
  const maxEvidence = positiveInteger(options.maxEvidence, 8);
  const maxScalarBytes = positiveInteger(options.maxScalarBytes, 256);
  const evidence: BrowserCommitmentVerificationEvidence[] = [];

  if (!document) {
    addEvidence(evidence, maxEvidence, 'document-context-unavailable', 'policy');
    return {
      status: 'unknown', confidence: 'low', commitmentKind: approved.kind,
      mismatchedFields: [], observed: {}, documentContext: 'unavailable', evidence,
    };
  }

  const incomplete = document.truncated || document.frameErrors.length > 0;
  if (incomplete) addEvidence(evidence, maxEvidence, 'document-context-incomplete');
  const texts = documentTexts(document, maxDocumentBlocks);
  const amount = approved.commitmentClass === 'financial' ? extractAmount(texts, Math.min(maxScalarBytes, 96)) : undefined;
  const counterparty = extractLabeledValue(texts, ['merchant', 'seller', 'provider', 'payee', 'recipient'], Math.min(maxScalarBytes, 128));
  const schedule = extractLabeledValue(texts, ['scheduled for', 'booking date', 'reservation date', 'payment date'], Math.min(maxScalarBytes, 128));
  const recurrence = extractRecurrence(texts);
  const observed: BrowserCommitmentObservedTerms = {
    ...(amount ? { amount } : {}),
    ...(counterparty ? { counterparty } : {}),
    ...(schedule ? { schedule } : {}),
    recurrence,
  };

  if (amount) addEvidence(evidence, maxEvidence, 'amount-visible');
  if (counterparty) addEvidence(evidence, maxEvidence, 'counterparty-visible');
  if (schedule) addEvidence(evidence, maxEvidence, 'schedule-visible');
  if (recurrence !== 'unknown') addEvidence(evidence, maxEvidence, 'recurrence-visible');

  const mismatchedFields = materialMismatches(approved, observed);
  if (mismatchedFields.length) {
    addEvidence(evidence, maxEvidence, 'material-mismatch', 'policy');
    return {
      status: 'mismatch', confidence: incomplete ? 'medium' : 'high',
      commitmentKind: approved.kind, mismatchedFields, observed,
      documentContext: incomplete ? 'incomplete' : 'available', evidence,
    };
  }

  const status = outcomeStatus(approved.kind, texts);
  if (!status) {
    return {
      status: 'unknown', confidence: incomplete ? 'low' : 'none',
      commitmentKind: approved.kind, mismatchedFields, observed,
      documentContext: incomplete ? 'incomplete' : 'available', evidence,
    };
  }

  addEvidence(evidence, maxEvidence, `${status}-outcome` as BrowserCommitmentVerificationEvidenceCode);
  return {
    status,
    confidence: incomplete ? 'medium' : 'high',
    commitmentKind: approved.kind,
    mismatchedFields,
    observed,
    documentContext: incomplete ? 'incomplete' : 'available',
    evidence,
  };
}
