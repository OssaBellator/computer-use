import { Buffer } from 'node:buffer';
import type { InteractionNode } from '../types.js';
import type { BrowserStateSnapshot } from './browserState.js';
import type { DocumentContentSnapshot } from './documentContent.js';

export type BrowserCommitmentKind =
  | 'purchase'
  | 'booking'
  | 'financial-transfer'
  | 'subscription'
  | 'publish'
  | 'destructive'
  | 'identity-security'
  | 'process-trigger';

export type BrowserCommitmentClass =
  | 'financial'
  | 'remote-publish'
  | 'remote-reversible'
  | 'identity-security'
  | 'process-trigger';

export type BrowserCommitmentStatus = 'none' | 'uncertain' | 'detected';
export type BrowserCommitmentConfidence = 'none' | 'low' | 'medium' | 'high';
export type BrowserCommitmentDocumentContext =
  | 'not-provided'
  | 'available'
  | 'incomplete'
  | 'unavailable';

export type BrowserCommitmentEvidenceCode =
  | 'strong-target-label'
  | 'ambiguous-target-label'
  | 'purchase-context'
  | 'booking-context'
  | 'financial-transfer-context'
  | 'subscription-context'
  | 'publication-context'
  | 'destructive-context'
  | 'identity-security-context'
  | 'process-trigger-context'
  | 'amount-visible'
  | 'counterparty-visible'
  | 'schedule-visible'
  | 'recurrence-visible'
  | 'irreversibility-visible'
  | 'document-context-incomplete';

export interface BrowserCommitmentEvidence {
  code: BrowserCommitmentEvidenceCode;
  source: 'target' | 'document';
  kind?: BrowserCommitmentKind;
}

export interface BrowserCommitmentAmount {
  text: string;
  currency?: string;
  value?: string;
}

export interface BrowserCommitmentTargetSummary {
  id: string;
  role?: string;
  label?: string;
}

export interface BrowserCommitmentSummary {
  status: BrowserCommitmentStatus;
  confidence: BrowserCommitmentConfidence;
  requiresApproval: boolean;
  needsDocumentContext: boolean;
  documentContext: BrowserCommitmentDocumentContext;
  kind?: BrowserCommitmentKind;
  commitmentClass?: BrowserCommitmentClass;
  target?: BrowserCommitmentTargetSummary;
  amount?: BrowserCommitmentAmount;
  counterparty?: string;
  schedule?: string;
  recurrence?: 'recurring' | 'unknown';
  irreversible: boolean;
  securitySensitive: boolean;
  evidence: BrowserCommitmentEvidence[];
}

export interface BrowserCommitmentDetectionInput {
  action: 'activate' | 'press-key';
  target?: InteractionNode;
  key?: string;
  browser?: BrowserStateSnapshot;
  document?: DocumentContentSnapshot;
}

export interface BrowserCommitmentDetectionOptions {
  maxDocumentBlocks?: number;
  maxEvidence?: number;
  maxScalarBytes?: number;
}

interface CommitmentRule {
  kind: BrowserCommitmentKind;
  commitmentClass: BrowserCommitmentClass;
  phrases: readonly string[];
}

interface ContextRule extends CommitmentRule {
  evidenceCode: BrowserCommitmentEvidenceCode;
  weightedPhrases: readonly (readonly [string, number])[];
}

const TARGET_RULES: readonly CommitmentRule[] = [
  { kind: 'purchase', commitmentClass: 'financial', phrases: ['place order', 'buy now', 'confirm order', 'complete order', 'submit order', 'complete purchase', 'confirm purchase', 'purchase now', 'pay now', 'submit payment'] },
  { kind: 'booking', commitmentClass: 'financial', phrases: ['confirm booking', 'book now', 'confirm reservation', 'reserve now', 'complete booking'] },
  { kind: 'financial-transfer', commitmentClass: 'financial', phrases: ['confirm transfer', 'transfer now', 'send money', 'pay bill', 'make payment', 'confirm payment', 'send payment'] },
  { kind: 'subscription', commitmentClass: 'financial', phrases: ['subscribe', 'start subscription', 'confirm subscription', 'start free trial', 'begin free trial'] },
  { kind: 'publish', commitmentClass: 'remote-publish', phrases: ['publish', 'publish now', 'post now', 'make public', 'send campaign'] },
  { kind: 'identity-security', commitmentClass: 'identity-security', phrases: ['change password', 'reset password', 'disable two-factor', 'disable 2fa', 'remove passkey', 'revoke sessions', 'sign out all sessions'] },
  { kind: 'process-trigger', commitmentClass: 'process-trigger', phrases: ['deploy', 'deploy now', 'run workflow', 'trigger workflow', 'execute job', 'start deployment', 'run job'] },
  { kind: 'destructive', commitmentClass: 'remote-reversible', phrases: ['delete account', 'delete workspace', 'delete project', 'permanently delete', 'remove account'] },
];

const AMBIGUOUS_TARGET_PREFIXES = [
  'confirm', 'complete', 'finish', 'submit', 'continue', 'next', 'save', 'accept', 'delete',
] as const;

const CONTEXT_RULES: readonly ContextRule[] = [
  {
    kind: 'purchase', commitmentClass: 'financial', evidenceCode: 'purchase-context', phrases: [],
    weightedPhrases: [['you will be charged', 3], ['order total', 2], ['review your order', 2], ['total due', 2], ['payment method', 1], ['billing address', 1]],
  },
  {
    kind: 'booking', commitmentClass: 'financial', evidenceCode: 'booking-context', phrases: [],
    weightedPhrases: [['booking summary', 2], ['reservation summary', 2], ['confirm your booking', 3], ['confirm your reservation', 3], ['booking total', 2], ['reservation total', 2]],
  },
  {
    kind: 'financial-transfer', commitmentClass: 'financial', evidenceCode: 'financial-transfer-context', phrases: [],
    weightedPhrases: [['transfer amount', 2], ['recipient', 1], ['payee', 1], ['from account', 1], ['to account', 1], ['wire transfer', 2]],
  },
  {
    kind: 'subscription', commitmentClass: 'financial', evidenceCode: 'subscription-context', phrases: [],
    weightedPhrases: [['subscription', 1], ['renews', 2], ['recurring', 2], ['per month', 1], ['monthly', 1], ['per year', 1], ['annually', 1], ['trial ends', 2]],
  },
  {
    kind: 'publish', commitmentClass: 'remote-publish', evidenceCode: 'publication-context', phrases: [],
    weightedPhrases: [['will be published', 3], ['visible to everyone', 2], ['make this public', 2], ['publish to', 2], ['send to subscribers', 2]],
  },
  {
    kind: 'destructive', commitmentClass: 'remote-reversible', evidenceCode: 'destructive-context', phrases: [],
    weightedPhrases: [['cannot be undone', 3], ['permanently delete', 3], ['delete your account', 3], ['remove this account', 2], ['all data will be deleted', 3]],
  },
  {
    kind: 'identity-security', commitmentClass: 'identity-security', evidenceCode: 'identity-security-context', phrases: [],
    weightedPhrases: [['change your password', 2], ['new password', 1], ['two-factor authentication', 2], ['security key', 1], ['passkey', 1], ['sign out other sessions', 2]],
  },
  {
    kind: 'process-trigger', commitmentClass: 'process-trigger', evidenceCode: 'process-trigger-context', phrases: [],
    weightedPhrases: [['start deployment', 2], ['production deployment', 2], ['workflow run', 2], ['trigger this workflow', 3], ['job will start', 2], ['run in production', 2]],
  },
];

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

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

function targetText(target: InteractionNode | undefined): string {
  return normalize([target?.name, target?.value].filter(Boolean).join(' '));
}

function strongTargetRule(text: string): CommitmentRule | undefined {
  return TARGET_RULES.find((rule) => rule.phrases.some((phrase) => containsPhrase(text, phrase)));
}

function ambiguousTarget(text: string): boolean {
  if (!text) return false;
  return AMBIGUOUS_TARGET_PREFIXES.some((prefix) => text === prefix || text.startsWith(`${prefix} `));
}

function contextText(document: DocumentContentSnapshot, maxBlocks: number): string[] {
  const output: string[] = [];
  for (const block of document.blocks) {
    if (output.length >= maxBlocks) break;
    if (!block.rendered) continue;
    const value = normalize([block.text, block.name, block.alt].filter(Boolean).join(' '));
    if (value) output.push(value.slice(0, 2048));
  }
  return output;
}

function addEvidence(
  evidence: BrowserCommitmentEvidence[],
  maxEvidence: number,
  item: BrowserCommitmentEvidence,
): void {
  if (evidence.length >= maxEvidence) return;
  if (evidence.some((existing) => existing.code === item.code && existing.kind === item.kind)) return;
  evidence.push(item);
}

function extractAmount(texts: readonly string[], maxBytes: number): BrowserCommitmentAmount | undefined {
  const patterns: readonly RegExp[] = [
    /\b(AUD|USD|EUR|GBP|CAD|NZD|JPY)\s*([$€£])?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/i,
    /([$€£])\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/,
  ];
  for (const text of texts) {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (!match) continue;
      if (match.length >= 4) {
        const currency = match[1]?.toUpperCase();
        const value = match[3];
        const raw = boundedUtf8(match[0], maxBytes);
        if (raw) return { text: raw, ...(currency ? { currency } : {}), ...(value ? { value } : {}) };
      }
      const symbol = match[1];
      const value = match[2];
      const raw = boundedUtf8(match[0], maxBytes);
      if (raw) return { text: raw, ...(symbol ? { currency: symbol } : {}), ...(value ? { value } : {}) };
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

function confidenceFor(score: number): BrowserCommitmentConfidence {
  if (score >= 6) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'none';
}

function emptySummary(
  target: InteractionNode | undefined,
  documentContext: BrowserCommitmentDocumentContext,
  maxScalarBytes: number,
): BrowserCommitmentSummary {
  const label = boundedUtf8(target?.name ?? target?.value, maxScalarBytes);
  return {
    status: 'none',
    confidence: 'none',
    requiresApproval: false,
    needsDocumentContext: false,
    documentContext,
    ...(target ? { target: { id: target.id, ...(target.role ? { role: target.role } : {}), ...(label ? { label } : {}) } } : {}),
    irreversible: false,
    securitySensitive: false,
    evidence: [],
  };
}

export function markBrowserCommitmentContextUnavailable(
  summary: BrowserCommitmentSummary,
): BrowserCommitmentSummary {
  if (summary.status === 'none') return { ...summary, documentContext: 'unavailable' };
  return {
    ...summary,
    requiresApproval: true,
    needsDocumentContext: false,
    documentContext: 'unavailable',
  };
}

/**
 * Heuristic commitment detector over already-bounded semantic/document state.
 * It never reads arbitrary DOM on its own. Strong target labels are sufficient
 * to gate; generic labels require contextual corroboration before detection.
 */
export function detectBrowserCommitment(
  input: BrowserCommitmentDetectionInput,
  options: BrowserCommitmentDetectionOptions = {},
): BrowserCommitmentSummary {
  const maxDocumentBlocks = positiveInteger(options.maxDocumentBlocks, 128);
  const maxEvidence = positiveInteger(options.maxEvidence, 8);
  const maxScalarBytes = positiveInteger(options.maxScalarBytes, 256);
  const target = input.target;
  const documentContext: BrowserCommitmentDocumentContext = input.document
    ? (input.document.truncated || input.document.frameErrors.some((error) => error.frameId === target?.frameId) ? 'incomplete' : 'available')
    : 'not-provided';
  const summary = emptySummary(target, documentContext, maxScalarBytes);

  if (input.action === 'press-key') {
    const key = normalize(input.key);
    if (key !== 'enter' && key !== ' ' && key !== 'space' && key !== 'spacebar') return summary;
  }
  if (!target || target.disabled || (!target.clickable && !target.capabilities.includes('activate'))) return summary;

  const label = targetText(target);
  const targetRule = strongTargetRule(label);
  const isAmbiguous = ambiguousTarget(label);
  const evidence: BrowserCommitmentEvidence[] = [];
  const scores = new Map<BrowserCommitmentKind, number>();
  const classes = new Map<BrowserCommitmentKind, BrowserCommitmentClass>();

  if (targetRule) {
    scores.set(targetRule.kind, 6);
    classes.set(targetRule.kind, targetRule.commitmentClass);
    addEvidence(evidence, maxEvidence, { code: 'strong-target-label', source: 'target', kind: targetRule.kind });
  } else if (isAmbiguous) {
    addEvidence(evidence, maxEvidence, { code: 'ambiguous-target-label', source: 'target' });
  } else {
    return summary;
  }

  const texts = input.document ? contextText(input.document, maxDocumentBlocks) : [];
  for (const rule of CONTEXT_RULES) {
    let added = 0;
    for (const [phrase, weight] of rule.weightedPhrases) {
      if (texts.some((text) => containsPhrase(text, phrase))) added += weight;
    }
    if (added <= 0) continue;
    scores.set(rule.kind, (scores.get(rule.kind) ?? (isAmbiguous ? 1 : 0)) + Math.min(added, 5));
    classes.set(rule.kind, rule.commitmentClass);
    addEvidence(evidence, maxEvidence, { code: rule.evidenceCode, source: 'document', kind: rule.kind });
  }

  let selectedKind: BrowserCommitmentKind | undefined;
  let selectedScore = 0;
  for (const [kind, score] of scores) {
    if (score > selectedScore) {
      selectedKind = kind;
      selectedScore = score;
    }
  }

  const contextIncomplete = documentContext === 'incomplete';
  if (!selectedKind || selectedScore < 4) {
    if (isAmbiguous && !input.document) {
      return {
        ...summary,
        status: 'uncertain',
        confidence: 'low',
        needsDocumentContext: true,
        evidence,
      };
    }
    if (isAmbiguous && contextIncomplete) {
      addEvidence(evidence, maxEvidence, { code: 'document-context-incomplete', source: 'document' });
      return {
        ...summary,
        status: 'uncertain',
        confidence: 'low',
        requiresApproval: true,
        documentContext,
        evidence,
      };
    }
    return { ...summary, confidence: confidenceFor(selectedScore), evidence };
  }

  const commitmentClass = classes.get(selectedKind)!;
  const amount = commitmentClass === 'financial' ? extractAmount(texts, Math.min(maxScalarBytes, 96)) : undefined;
  const counterparty = extractLabeledValue(texts, ['merchant', 'seller', 'provider', 'payee', 'recipient'], Math.min(maxScalarBytes, 128));
  const schedule = extractLabeledValue(texts, ['scheduled for', 'booking date', 'reservation date', 'payment date'], Math.min(maxScalarBytes, 128));
  const recurrence = texts.some((text) => ['renews', 'recurring', 'per month', 'monthly', 'per year', 'annually'].some((phrase) => containsPhrase(text, phrase)))
    ? 'recurring' as const
    : 'unknown' as const;
  const irreversible = selectedKind === 'destructive' && texts.some((text) => containsPhrase(text, 'cannot be undone') || containsPhrase(text, 'permanently delete'));
  const securitySensitive = selectedKind === 'identity-security';

  if (amount) addEvidence(evidence, maxEvidence, { code: 'amount-visible', source: 'document', kind: selectedKind });
  if (counterparty) addEvidence(evidence, maxEvidence, { code: 'counterparty-visible', source: 'document', kind: selectedKind });
  if (schedule) addEvidence(evidence, maxEvidence, { code: 'schedule-visible', source: 'document', kind: selectedKind });
  if (recurrence === 'recurring') addEvidence(evidence, maxEvidence, { code: 'recurrence-visible', source: 'document', kind: selectedKind });
  if (irreversible) addEvidence(evidence, maxEvidence, { code: 'irreversibility-visible', source: 'document', kind: selectedKind });
  if (contextIncomplete) addEvidence(evidence, maxEvidence, { code: 'document-context-incomplete', source: 'document', kind: selectedKind });

  return {
    ...summary,
    status: 'detected',
    confidence: confidenceFor(selectedScore),
    requiresApproval: true,
    needsDocumentContext: false,
    documentContext,
    kind: selectedKind,
    commitmentClass,
    ...(amount ? { amount } : {}),
    ...(counterparty ? { counterparty } : {}),
    ...(schedule ? { schedule } : {}),
    recurrence,
    irreversible,
    securitySensitive,
    evidence,
  };
}
