import { Buffer } from 'node:buffer';
import type { DocumentEditingHost } from './documentSelection.js';
import type { SnapshotFrameLike, SnapshotPageLike } from './domSnapshot.js';

export type FormattingValue = 'on' | 'off' | 'mixed' | 'unknown';
export type DocumentListKind = 'ordered' | 'unordered';

export interface DocumentBlockContext {
  kind: 'paragraph' | 'heading' | 'other';
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  list?: { kind: DocumentListKind; depth: number };
}

export interface DocumentFormattingLink { url: string; urlTruncated: boolean; }
export interface DocumentFormattingRun {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  link?: DocumentFormattingLink;
  block: DocumentBlockContext;
  textNodes: number;
}

export interface DocumentFormattingSummary {
  bold: FormattingValue;
  italic: FormattingValue;
  underline: FormattingValue;
  strike: FormattingValue;
  code: FormattingValue;
  link: FormattingValue;
}

export interface DocumentFormattingState {
  frameId: string;
  collapsed: boolean;
  editingHost: DocumentEditingHost;
  summary: DocumentFormattingSummary;
  runs: DocumentFormattingRun[];
  runsTruncated: boolean;
  blocks: DocumentBlockContext[];
  blocksTruncated: boolean;
  complete: boolean;
}

export interface DocumentFormattingFrameError { frameId: string; message: string; }
export interface DocumentFormattingSnapshot {
  states: DocumentFormattingState[];
  frameErrors: DocumentFormattingFrameError[];
  truncated: boolean;
}

export interface DocumentFormattingOptions {
  maxRuns?: number;
  maxBlocks?: number;
  maxLinkUrlBytes?: number;
}

interface RawFormattingState extends Omit<DocumentFormattingState, 'frameId'> {}
interface RawFormattingError { error: string; }
type RawFormattingResult = RawFormattingState | RawFormattingError | undefined;

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value, truncated: false };
  let output = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return { value: output, truncated: true };
}

function cloneBlock(block: DocumentBlockContext): DocumentBlockContext {
  return { ...block, ...(block.list ? { list: { ...block.list } } : {}) };
}

function boundRunLink(run: DocumentFormattingRun, maxLinkUrlBytes: number): {
  run: DocumentFormattingRun;
  truncated: boolean;
} {
  if (!run.link) return { run: { ...run, block: cloneBlock(run.block) }, truncated: false };
  const bounded = truncateUtf8(run.link.url, maxLinkUrlBytes);
  const urlTruncated = run.link.urlTruncated || bounded.truncated;
  return {
    run: {
      ...run,
      block: cloneBlock(run.block),
      link: { url: bounded.value, urlTruncated },
    },
    truncated: urlTruncated,
  };
}

export async function snapshotDocumentFormatting(
  page: SnapshotPageLike,
  options: DocumentFormattingOptions = {},
): Promise<DocumentFormattingSnapshot> {
  const maxRuns = positiveInteger('maxRuns', options.maxRuns ?? 64);
  const maxBlocks = positiveInteger('maxBlocks', options.maxBlocks ?? 16);
  const maxLinkUrlBytes = positiveInteger('maxLinkUrlBytes', options.maxLinkUrlBytes ?? 2_048);
  const states: DocumentFormattingState[] = [];
  const frameErrors: DocumentFormattingFrameError[] = [];
  let truncated = false;

  const frames = page.frames();
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frameId = frameIndex === 0 ? 'main' : `frame-${frameIndex}`;
    let raw: RawFormattingResult;
    try {
      raw = await extractFormattingFrame(frames[frameIndex]);
    } catch (error) {
      frameErrors.push({ frameId, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!raw) continue;
    if ('error' in raw) {
      frameErrors.push({ frameId, message: raw.error });
      continue;
    }

    const boundedRuns = raw.runs.slice(0, maxRuns).map((run) => boundRunLink(run, maxLinkUrlBytes));
    const runsTruncated = raw.runsTruncated || raw.runs.length > maxRuns;
    const blocksTruncated = raw.blocksTruncated || raw.blocks.length > maxBlocks;
    const linkTruncated = boundedRuns.some(({ truncated: wasTruncated }) => wasTruncated);
    truncated ||= runsTruncated || blocksTruncated || linkTruncated;

    states.push({
      ...raw,
      frameId,
      editingHost: { ...raw.editingHost },
      summary: { ...raw.summary },
      runs: boundedRuns.map(({ run }) => run),
      runsTruncated,
      blocks: raw.blocks.slice(0, maxBlocks).map(cloneBlock),
      blocksTruncated,
    });
  }
  return { states, frameErrors, truncated };
}

async function extractFormattingFrame(frame: SnapshotFrameLike): Promise<RawFormattingResult> {
  return frame.evaluate((): RawFormattingResult => {
    const MAX_VISITED_TEXT_NODES = 2_048;
    const MAX_SELECTED_TEXT_NODES = 512;
    const MAX_RUNS = 128;
    const MAX_BLOCKS = 32;
    const MAX_LINK_URL_CHARS = 4_096;
    const MAX_LIST_DEPTH = 16;

    interface Sample {
      bold: boolean;
      italic: boolean;
      underline: boolean;
      strike: boolean;
      code: boolean;
      link?: DocumentFormattingLink;
      block: DocumentBlockContext;
    }

    function elementSegment(element: Element): string {
      let index = 1;
      for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === element.tagName) index += 1;
      }
      return `${element.tagName.toLowerCase()}:nth-of-type(${index})`;
    }

    function elementPath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.documentElement && parts.length < 260) {
        parts.push(elementSegment(current));
        const root = current.getRootNode();
        if (root instanceof ShadowRoot) {
          parts.push('::shadow');
          current = root.host;
        } else {
          current = current.parentElement;
        }
      }
      return parts.reverse().join(' > ') || element.tagName.toLowerCase();
    }

    function composedParent(element: Element): Element | null {
      if (element.parentElement) return element.parentElement;
      const root = element.getRootNode();
      return root instanceof ShadowRoot ? root.host : null;
    }

    function nearestEditingHost(node: Node | null): Element | undefined {
      let element = node instanceof Element ? node : node?.parentElement ?? undefined;
      let host: Element | undefined;
      while (element) {
        if ((element as HTMLElement).isContentEditable) host = element;
        else if (host) break;
        element = composedParent(element) ?? undefined;
      }
      if (!host && document.designMode?.toLowerCase() === 'on') host = document.body ?? undefined;
      return host;
    }

    function hostDetails(host: Element): DocumentEditingHost {
      const role = host.getAttribute('role')?.trim() || undefined;
      const contentEditable = host.getAttribute('contenteditable') ?? undefined;
      return {
        path: elementPath(host),
        tagName: host.tagName.toLowerCase(),
        ...(role ? { role } : {}),
        ...(contentEditable !== undefined ? { contentEditable } : {}),
      };
    }

    function deepActiveElement(): Element | null {
      let active: Element | null = document.activeElement;
      for (let depth = 0; depth < 64; depth += 1) {
        const shadow = (active as HTMLElement | null)?.shadowRoot;
        const next = shadow?.activeElement ?? null;
        if (!next) return active;
        active = next;
      }
      return active;
    }

    function isWithinHost(element: Element | null, host: Element): boolean {
      let current = element;
      for (let depth = 0; current && depth < 260; depth += 1) {
        if (current === host) return true;
        current = composedParent(current);
      }
      return false;
    }

    function blockContext(element: Element, host: Element): DocumentBlockContext {
      let kind: DocumentBlockContext['kind'] = 'other';
      let headingLevel: DocumentBlockContext['headingLevel'];
      let listKind: DocumentListKind | undefined;
      let listDepth = 0;
      let current: Element | null = element;
      for (let depth = 0; current && depth < 260; depth += 1) {
        const tag = current.tagName.toLowerCase();
        if (kind === 'other' && tag === 'p') kind = 'paragraph';
        if (kind === 'other' && /^h[1-6]$/.test(tag)) {
          kind = 'heading';
          headingLevel = Number(tag.slice(1)) as DocumentBlockContext['headingLevel'];
        }
        if ((tag === 'ol' || tag === 'ul') && listDepth < MAX_LIST_DEPTH) {
          listDepth += 1;
          if (!listKind) listKind = tag === 'ol' ? 'ordered' : 'unordered';
        }
        if (current === host) break;
        current = composedParent(current);
      }
      return {
        kind,
        ...(headingLevel ? { headingLevel } : {}),
        ...(listKind ? { list: { kind: listKind, depth: listDepth } } : {}),
      };
    }

    function boundedLink(anchor: HTMLAnchorElement): DocumentFormattingLink {
      const url = anchor.href;
      return url.length <= MAX_LINK_URL_CHARS
        ? { url, urlTruncated: false }
        : { url: url.slice(0, MAX_LINK_URL_CHARS), urlTruncated: true };
    }

    function sampleForElement(element: Element, host: Element): Sample {
      const style = getComputedStyle(element);
      const numericWeight = Number.parseInt(style.fontWeight, 10);
      let bold = style.fontWeight === 'bold' || (Number.isFinite(numericWeight) && numericWeight >= 600);
      let italic = style.fontStyle === 'italic' || style.fontStyle === 'oblique' || style.fontStyle.startsWith('oblique ');
      let underline = false;
      let strike = false;
      let code = style.fontFamily.split(',').some((part) =>
        part.trim().replace(/^['"]|['"]$/g, '').toLowerCase() === 'monospace');
      let link: DocumentFormattingLink | undefined;
      let current: Element | null = element;
      for (let depth = 0; current && depth < 260; depth += 1) {
        const tag = current.tagName.toLowerCase();
        if (tag === 'b' || tag === 'strong') bold = true;
        if (tag === 'i' || tag === 'em') italic = true;
        if (tag === 'u') underline = true;
        if (tag === 's' || tag === 'strike' || tag === 'del') strike = true;
        if (tag === 'code' || tag === 'pre' || tag === 'kbd' || tag === 'samp') code = true;
        if (!link && current instanceof HTMLAnchorElement && current.hasAttribute('href')) link = boundedLink(current);
        const decoration = getComputedStyle(current).textDecorationLine.split(/\s+/);
        if (decoration.includes('underline')) underline = true;
        if (decoration.includes('line-through')) strike = true;
        if (current === host) break;
        current = composedParent(current);
      }
      return { bold, italic, underline, strike, code, ...(link ? { link } : {}), block: blockContext(element, host) };
    }

    function sameBlock(left: DocumentBlockContext, right: DocumentBlockContext): boolean {
      return left.kind === right.kind && left.headingLevel === right.headingLevel &&
        left.list?.kind === right.list?.kind && left.list?.depth === right.list?.depth;
    }
    function sameSample(left: Sample, right: Sample): boolean {
      return left.bold === right.bold && left.italic === right.italic &&
        left.underline === right.underline && left.strike === right.strike &&
        left.code === right.code && left.link?.url === right.link?.url &&
        left.link?.urlTruncated === right.link?.urlTruncated && sameBlock(left.block, right.block);
    }
    function addBlock(blocks: DocumentBlockContext[], block: DocumentBlockContext): boolean {
      if (blocks.some((existing) => sameBlock(existing, block))) return false;
      if (blocks.length >= MAX_BLOCKS) return true;
      blocks.push(block);
      return false;
    }
    function commandState(command: string): boolean | undefined {
      try { return typeof document.queryCommandState === 'function' ? document.queryCommandState(command) : undefined; }
      catch { return undefined; }
    }
    function valueFromSamples(values: readonly boolean[], complete: boolean): FormattingValue {
      if (values.length === 0) return 'unknown';
      const anyOn = values.some(Boolean);
      const anyOff = values.some((value) => !value);
      if (anyOn && anyOff) return 'mixed';
      if (!complete) return 'unknown';
      return anyOn ? 'on' : 'off';
    }
    function collapsedValue(observed: boolean | undefined, fallback: boolean): FormattingValue {
      return (observed ?? fallback) ? 'on' : 'off';
    }
    function positivelyIntersects(range: Range, node: Node): boolean {
      try {
        if (!range.intersectsNode(node)) return false;
        if (!(node instanceof Text)) return true;
        if (node === range.startContainer && range.startOffset >= node.length) return false;
        if (node === range.endContainer && range.endOffset <= 0) return false;
        return node.length > 0;
      } catch { return false; }
    }

    const active = deepActiveElement();
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      if (active.selectionStart !== null && active.selectionEnd !== null) return { error: 'text-control-formatting-unsupported' };
    }
    const selection = getSelection();
    if (!selection || selection.rangeCount < 1 || !selection.anchorNode || !selection.focusNode) return undefined;
    if (selection.rangeCount !== 1) return { error: 'multiple-selection-ranges' };
    const anchorHost = nearestEditingHost(selection.anchorNode);
    const focusHost = nearestEditingHost(selection.focusNode);
    if (!anchorHost && !focusHost) return undefined;
    if (!anchorHost || !focusHost || anchorHost !== focusHost) return { error: 'selection-crosses-editing-hosts' };
    const host = anchorHost;
    const range = selection.getRangeAt(0);
    if (nearestEditingHost(range.startContainer) !== host || nearestEditingHost(range.endContainer) !== host) {
      return { error: 'selection-crosses-editing-hosts' };
    }
    const activeElement = active instanceof Element ? active : null;
    if (document.designMode?.toLowerCase() !== 'on' && (!activeElement || !isWithinHost(activeElement, host))) {
      return { error: 'editing-host-not-focused' };
    }

    if (selection.isCollapsed) {
      const element = selection.focusNode instanceof Element ? selection.focusNode : selection.focusNode.parentElement;
      if (!element || !isWithinHost(element, host)) return { error: 'caret-formatting-unobservable' };
      const sample = sampleForElement(element, host);
      return {
        collapsed: true,
        editingHost: hostDetails(host),
        summary: {
          bold: collapsedValue(commandState('bold'), sample.bold),
          italic: collapsedValue(commandState('italic'), sample.italic),
          underline: collapsedValue(commandState('underline'), sample.underline),
          strike: collapsedValue(commandState('strikeThrough'), sample.strike),
          code: sample.code ? 'on' : 'off',
          link: sample.link ? 'on' : 'off',
        },
        runs: [{ ...sample, textNodes: 0 }],
        runsTruncated: false,
        blocks: [sample.block],
        blocksTruncated: false,
        complete: true,
      };
    }

    const runs: DocumentFormattingRun[] = [];
    const blocks: DocumentBlockContext[] = [];
    const boldValues: boolean[] = [];
    const italicValues: boolean[] = [];
    const underlineValues: boolean[] = [];
    const strikeValues: boolean[] = [];
    const codeValues: boolean[] = [];
    const linkValues: boolean[] = [];
    let visitedTextNodes = 0;
    let selectedTextNodes = 0;
    let runsTruncated = false;
    let blocksTruncated = false;
    let complete = true;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      visitedTextNodes += 1;
      if (visitedTextNodes > MAX_VISITED_TEXT_NODES) { complete = false; break; }
      if (!node.nodeValue || !positivelyIntersects(range, node)) continue;
      selectedTextNodes += 1;
      if (selectedTextNodes > MAX_SELECTED_TEXT_NODES) { complete = false; break; }
      const element = node.parentElement;
      if (!element || !isWithinHost(element, host)) { complete = false; break; }
      const sample = sampleForElement(element, host);
      boldValues.push(sample.bold); italicValues.push(sample.italic); underlineValues.push(sample.underline);
      strikeValues.push(sample.strike); codeValues.push(sample.code); linkValues.push(sample.link !== undefined);
      blocksTruncated ||= addBlock(blocks, sample.block);
      const last = runs[runs.length - 1];
      if (last && sameSample(last, sample)) last.textNodes += 1;
      else if (runs.length < MAX_RUNS) runs.push({ ...sample, textNodes: 1 });
      else runsTruncated = true;
    }

    return {
      collapsed: false,
      editingHost: hostDetails(host),
      summary: {
        bold: valueFromSamples(boldValues, complete),
        italic: valueFromSamples(italicValues, complete),
        underline: valueFromSamples(underlineValues, complete),
        strike: valueFromSamples(strikeValues, complete),
        code: valueFromSamples(codeValues, complete),
        link: valueFromSamples(linkValues, complete),
      },
      runs, runsTruncated, blocks, blocksTruncated, complete,
    };
  });
}

export class DocumentFormattingObserver {
  constructor(private readonly page: SnapshotPageLike) {}
  async snapshot(options: DocumentFormattingOptions = {}): Promise<DocumentFormattingSnapshot> {
    await (this.page as SnapshotPageLike & { refresh?: () => Promise<void> }).refresh?.();
    return snapshotDocumentFormatting(this.page, options);
  }
}
