import { Buffer } from 'node:buffer';
import type { BrowserStateSnapshot } from './browserState.js';
import type { BrowserCommitmentKind } from './commitmentDetector.js';
import type { DocumentContentSnapshot } from './documentContent.js';

export type BrowserCommitmentIdentifierType =
  | 'order'
  | 'booking'
  | 'reservation'
  | 'transfer'
  | 'payment'
  | 'transaction'
  | 'subscription'
  | 'publication'
  | 'post'
  | 'deletion'
  | 'security-change'
  | 'deployment'
  | 'workflow-run'
  | 'job'
  | 'process'
  | 'confirmation'
  | 'reference';

export interface BrowserCommitmentIdentifier {
  type: BrowserCommitmentIdentifierType;
  /** Bounded, explicitly labelled identifier. Never an account/card credential. */
  value: string;
}

export interface BrowserCommitmentIdentitySnapshot {
  /** Current page origin only; URLs, titles, and page excerpts are deliberately excluded. */
  origin?: string;
  identifiers: BrowserCommitmentIdentifier[];
  documentContext: 'available' | 'incomplete' | 'unavailable';
}

export type BrowserCommitmentIdentityRelation =
  | 'matched-expected'
  | 'fresh-result-identity'
  | 'conflict'
  | 'unbound';

export type BrowserCommitmentProviderRelation =
  | 'same-origin'
  | 'origin-changed'
  | 'unknown';

export interface BrowserCommitmentIdentityEvaluation {
  relation: BrowserCommitmentIdentityRelation;
  providerRelation: BrowserCommitmentProviderRelation;
  /** Identifier categories only are safe for ordinary traces. */
  matchedTypes: BrowserCommitmentIdentifierType[];
  freshTypes: BrowserCommitmentIdentifierType[];
  conflictingTypes: BrowserCommitmentIdentifierType[];
  /** Detailed bounded values are reserved for explicit verification callbacks. */
  baseline: BrowserCommitmentIdentitySnapshot;
  current: BrowserCommitmentIdentitySnapshot;
}

export interface BrowserCommitmentIdentityOptions {
  maxDocumentBlocks?: number;
  maxIdentifiers?: number;
  maxIdentifierBytes?: number;
}

interface IdentityLabel {
  label: string;
  type: BrowserCommitmentIdentifierType;
}

const COMMON_CONFIRMATION_LABELS: readonly IdentityLabel[] = [
  { label: 'confirmation number', type: 'confirmation' },
  { label: 'confirmation code', type: 'confirmation' },
  { label: 'confirmation id', type: 'confirmation' },
  { label: 'reference number', type: 'reference' },
  { label: 'reference id', type: 'reference' },
];

const LABELS: Readonly<Record<BrowserCommitmentKind, readonly IdentityLabel[]>> = {
  purchase: [
    { label: 'order number', type: 'order' },
    { label: 'order no', type: 'order' },
    { label: 'order id', type: 'order' },
    { label: 'order reference', type: 'order' },
    { label: 'purchase reference', type: 'reference' },
    { label: 'payment reference', type: 'payment' },
    { label: 'transaction id', type: 'transaction' },
    { label: 'transaction reference', type: 'transaction' },
    ...COMMON_CONFIRMATION_LABELS,
  ],
  booking: [
    { label: 'booking number', type: 'booking' },
    { label: 'booking id', type: 'booking' },
    { label: 'booking reference', type: 'booking' },
    { label: 'reservation number', type: 'reservation' },
    { label: 'reservation id', type: 'reservation' },
    { label: 'reservation reference', type: 'reservation' },
    ...COMMON_CONFIRMATION_LABELS,
  ],
  'financial-transfer': [
    { label: 'transfer id', type: 'transfer' },
    { label: 'transfer reference', type: 'transfer' },
    { label: 'payment reference', type: 'payment' },
    { label: 'transaction id', type: 'transaction' },
    { label: 'transaction reference', type: 'transaction' },
    ...COMMON_CONFIRMATION_LABELS,
  ],
  subscription: [
    { label: 'subscription id', type: 'subscription' },
    { label: 'subscription reference', type: 'subscription' },
    ...COMMON_CONFIRMATION_LABELS,
  ],
  publish: [
    { label: 'publication id', type: 'publication' },
    { label: 'publication reference', type: 'publication' },
    { label: 'post id', type: 'post' },
    { label: 'post reference', type: 'post' },
    ...COMMON_CONFIRMATION_LABELS,
  ],
  destructive: [
    { label: 'deletion reference', type: 'deletion' },
    { label: 'deletion id', type: 'deletion' },
    { label: 'request reference', type: 'reference' },
    { label: 'request id', type: 'reference' },
    ...COMMON_CONFIRMATION_LABELS,
  ],
  'identity-security': [
    { label: 'security change reference', type: 'security-change' },
    { label: 'security change id', type: 'security-change' },
    { label: 'request reference', type: 'reference' },
    { label: 'request id', type: 'reference' },
    ...COMMON_CONFIRMATION_LABELS,
  ],
  'process-trigger': [
    { label: 'deployment id', type: 'deployment' },
    { label: 'deployment reference', type: 'deployment' },
    { label: 'workflow run id', type: 'workflow-run' },
    { label: 'workflow run reference', type: 'workflow-run' },
    { label: 'run id', type: 'workflow-run' },
    { label: 'job id', type: 'job' },
    { label: 'job reference', type: 'job' },
    { label: 'process id', type: 'process' },
    { label: 'process reference', type: 'process' },
    ...COMMON_CONFIRMATION_LABELS,
  ],
};

const positiveInteger = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value));

function boundedUtf8(value: string, maxBytes: number): string | undefined {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let output = '';
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > maxBytes) break;
    output += character;
    used += size;
  }
  return output || undefined;
}

function canonicalIdentifier(value: string): string {
  return value.normalize('NFKC').trim().replace(/^#+/, '').toLocaleUpperCase('en-US');
}

function looksLikeCredential(value: string): boolean {
  return /^sk[-_][A-Za-z0-9_-]{16,}$/i.test(value) ||
    /^gh[pousr]_[A-Za-z0-9]{20,}$/i.test(value) ||
    /^github_pat_[A-Za-z0-9_]{20,}$/i.test(value) ||
    /^xox[baprs]-[A-Za-z0-9-]{20,}$/i.test(value) ||
    /^AIza[A-Za-z0-9_-]{20,}$/.test(value) ||
    /^(?:AKIA|ASIA)[A-Z0-9]{16}$/.test(value) ||
    /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value);
}

function safeIdentifier(value: string, maxBytes: number, explicitSeparator: boolean): string | undefined {
  const trimmed = value.trim().replace(/[),.;]+$/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,63}$/.test(trimmed)) return undefined;
  // Whitespace-only labels are common ("Order ID ABC-42"), but ordinary prose
  // such as "Order number will be assigned" must not turn the next word into an ID.
  if (!explicitSeparator && !/[0-9._:/-]/.test(trimmed)) return undefined;
  // Never retain values that are visibly URL- or credential-shaped even when a
  // page places them next to an unsafe generic reference label.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) || looksLikeCredential(trimmed)) return undefined;
  // Reject numeric account/card-like values and compact IBAN-shaped values. This
  // intentionally prefers a false negative over retaining financial credentials.
  if (/^\d{12,}$/.test(trimmed.replace(/-/g, ''))) return undefined;
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/i.test(trimmed)) return undefined;
  const bounded = boundedUtf8(trimmed, maxBytes);
  return bounded && bounded.length >= 2 ? bounded : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractFromText(
  text: string,
  labels: readonly IdentityLabel[],
  maxBytes: number,
): BrowserCommitmentIdentifier[] {
  const found: BrowserCommitmentIdentifier[] = [];
  for (const descriptor of labels) {
    const label = escapeRegExp(descriptor.label).replace(/ /g, '\\s+');
    const pattern = new RegExp(`(?:^|\\b)${label}\\s*([:#=]|[-–—])?\\s*#?([A-Za-z0-9][A-Za-z0-9._:/-]{1,63})`, 'ig');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const candidate = match[2]!;
      const following = text.slice(pattern.lastIndex);
      // Spaced numeric credentials would otherwise be truncated to their first
      // group (for example, 4111 from a longer card-like value). A two-letter
      // country prefix plus check digits can similarly be the first IBAN group.
      if (/^\d+$/.test(candidate) && /^\s+\d/.test(following)) continue;
      if (/^[A-Z]{2}\d{2}$/i.test(candidate) && /^\s+[A-Z0-9]{2,4}\b/i.test(following)) continue;
      const value = safeIdentifier(candidate, maxBytes, match[1] !== undefined);
      if (value) found.push({ type: descriptor.type, value });
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }
  return found;
}

function uniqueIdentifiers(
  identifiers: readonly BrowserCommitmentIdentifier[],
  maxIdentifiers: number,
): BrowserCommitmentIdentifier[] {
  const output: BrowserCommitmentIdentifier[] = [];
  const seen = new Set<string>();
  for (const identifier of identifiers) {
    const key = `${identifier.type}:${canonicalIdentifier(identifier.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(identifier);
    if (output.length >= maxIdentifiers) break;
  }
  return output;
}

function snapshotOrigin(browserState: BrowserStateSnapshot | undefined): string | undefined {
  const origin = browserState?.origin;
  return origin && origin !== 'null' ? origin : undefined;
}

/** Extract only explicitly-labelled, bounded, non-secret operation/result IDs. */
export function snapshotBrowserCommitmentIdentity(
  kind: BrowserCommitmentKind,
  document: DocumentContentSnapshot | undefined,
  browserState?: BrowserStateSnapshot,
  options: BrowserCommitmentIdentityOptions = {},
): BrowserCommitmentIdentitySnapshot {
  const maxDocumentBlocks = positiveInteger(options.maxDocumentBlocks, 128);
  const maxIdentifiers = positiveInteger(options.maxIdentifiers, 8);
  const maxIdentifierBytes = Math.min(96, positiveInteger(options.maxIdentifierBytes, 96));
  const origin = snapshotOrigin(browserState);
  if (!document) {
    return {
      ...(origin ? { origin } : {}),
      identifiers: [],
      documentContext: 'unavailable',
    };
  }

  const labels = LABELS[kind];
  const identifiers: BrowserCommitmentIdentifier[] = [];
  let examined = 0;
  for (const block of document.blocks) {
    if (examined >= maxDocumentBlocks || identifiers.length >= maxIdentifiers) break;
    if (!block.rendered) continue;
    examined += 1;
    for (const field of [block.text, block.name, block.alt]) {
      if (!field) continue;
      identifiers.push(...extractFromText(field.slice(0, 2048), labels, maxIdentifierBytes));
      if (identifiers.length >= maxIdentifiers) break;
    }
  }

  return {
    ...(origin ? { origin } : {}),
    identifiers: uniqueIdentifiers(identifiers, maxIdentifiers),
    documentContext: document.truncated || document.frameErrors.length > 0 ? 'incomplete' : 'available',
  };
}

function typesForValues(
  identifiers: readonly BrowserCommitmentIdentifier[],
  values: ReadonlySet<string>,
): BrowserCommitmentIdentifierType[] {
  return [...new Set(identifiers
    .filter((identifier) => values.has(canonicalIdentifier(identifier.value)))
    .map((identifier) => identifier.type))];
}

/** Compare a pre-dispatch identity snapshot with one observed from a result channel. */
export function evaluateBrowserCommitmentIdentity(
  baseline: BrowserCommitmentIdentitySnapshot,
  current: BrowserCommitmentIdentitySnapshot,
): BrowserCommitmentIdentityEvaluation {
  const baselineValues = new Set(baseline.identifiers.map((identifier) => canonicalIdentifier(identifier.value)));
  const currentValues = new Set(current.identifiers.map((identifier) => canonicalIdentifier(identifier.value)));
  const baselineHasOneUniqueValue = baselineValues.size === 1;
  const baselineIsEmpty = baselineValues.size === 0;
  const matchedValues = baselineHasOneUniqueValue
    ? new Set([...currentValues].filter((value) => baselineValues.has(value)))
    : new Set<string>();
  const freshValues = baselineIsEmpty ? new Set(currentValues) : new Set<string>();

  const baselineByType = new Map<BrowserCommitmentIdentifierType, Set<string>>();
  const currentByType = new Map<BrowserCommitmentIdentifierType, Set<string>>();
  for (const identifier of baseline.identifiers) {
    const set = baselineByType.get(identifier.type) ?? new Set<string>();
    set.add(canonicalIdentifier(identifier.value));
    baselineByType.set(identifier.type, set);
  }
  for (const identifier of current.identifiers) {
    const set = currentByType.get(identifier.type) ?? new Set<string>();
    set.add(canonicalIdentifier(identifier.value));
    currentByType.set(identifier.type, set);
  }

  const conflictingTypes: BrowserCommitmentIdentifierType[] = [];
  if (baselineHasOneUniqueValue) {
    for (const [type, expected] of baselineByType) {
      const observed = currentByType.get(type);
      if (!observed?.size) continue;
      const intersects = [...expected].some((value) => observed.has(value));
      if (!intersects) conflictingTypes.push(type);
    }
  }

  const relation: BrowserCommitmentIdentityRelation = conflictingTypes.length
    ? 'conflict'
    : matchedValues.size
      ? 'matched-expected'
      : freshValues.size
        ? 'fresh-result-identity'
        : 'unbound';

  const providerRelation: BrowserCommitmentProviderRelation = baseline.origin && current.origin
    ? (baseline.origin === current.origin ? 'same-origin' : 'origin-changed')
    : 'unknown';

  return {
    relation,
    providerRelation,
    matchedTypes: typesForValues(current.identifiers, matchedValues),
    freshTypes: typesForValues(current.identifiers, freshValues),
    conflictingTypes,
    baseline,
    current,
  };
}
