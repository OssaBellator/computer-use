import { Buffer } from 'node:buffer';
import type { Rect } from '../types.js';
import type { SnapshotFrameLike, SnapshotPageLike } from './domSnapshot.js';

export type DocumentSelectionKind = 'dom' | 'text-control';
export type DocumentSelectionDirection = 'forward' | 'backward' | 'none';

export interface DocumentSelectionPoint {
  /** Structural frame-local path. Text nodes use a ::text(childNodeIndex) suffix. */
  path: string;
  offset: number;
  nodeType: 'element' | 'text' | 'other';
}

export interface DocumentEditingHost {
  path: string;
  tagName: string;
  role?: string;
  contentEditable?: string;
}

export interface DocumentSelectionState {
  frameId: string;
  kind: DocumentSelectionKind;
  collapsed: boolean;
  direction: DocumentSelectionDirection;
  selectedText?: string;
  selectedTextTruncated: boolean;
  anchor?: DocumentSelectionPoint;
  focus?: DocumentSelectionPoint;
  editingHost?: DocumentEditingHost;
  /** Text-control offsets when kind === 'text-control'. */
  start?: number;
  end?: number;
  rangeCount: number;
  /** Frame-local document coordinates in CSS pixels. */
  boundingRect?: Rect;
  /** Bounded individual selection rectangles in frame-local document coordinates. */
  rects: Rect[];
  rectsTruncated: boolean;
}

export interface DocumentSelectionFrameError {
  frameId: string;
  message: string;
}

export interface DocumentSelectionSnapshot {
  selections: DocumentSelectionState[];
  frameErrors: DocumentSelectionFrameError[];
  truncated: boolean;
}

export interface DocumentSelectionOptions {
  /** Maximum UTF-8 bytes retained for selected text. Defaults to 16,384. */
  maxSelectedTextBytes?: number;
  /** Maximum individual range rectangles returned per frame. Defaults to 32. */
  maxRects?: number;
  /** Include a collapsed DOM caret outside an editable host. Defaults to false. */
  includeCollapsedNonEditable?: boolean;
}

interface RawSelectionState extends Omit<DocumentSelectionState, 'frameId'> {}

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

/**
 * Observe browser selection/caret state without mutating the page.
 *
 * Each frame is evaluated independently through the repository's own frame
 * abstraction. Text controls use selectionStart/selectionEnd; ordinary document
 * and contenteditable selections use Selection/Range state.
 */
export async function snapshotDocumentSelection(
  page: SnapshotPageLike,
  options: DocumentSelectionOptions = {},
): Promise<DocumentSelectionSnapshot> {
  const maxSelectedTextBytes = positiveInteger(
    'maxSelectedTextBytes',
    options.maxSelectedTextBytes ?? 16 * 1024,
  );
  const maxRects = positiveInteger('maxRects', options.maxRects ?? 32);
  const includeCollapsedNonEditable = options.includeCollapsedNonEditable ?? false;

  const selections: DocumentSelectionState[] = [];
  const frameErrors: DocumentSelectionFrameError[] = [];
  let truncated = false;

  const frames = page.frames();
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frameId = frameIndex === 0 ? 'main' : `frame-${frameIndex}`;
    let raw: RawSelectionState | undefined;
    try {
      raw = await extractSelectionFrame(frames[frameIndex]);
    } catch (error) {
      frameErrors.push({ frameId, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!raw) continue;
    if (raw.kind === 'dom' && raw.collapsed && !raw.editingHost && !includeCollapsedNonEditable) {
      continue;
    }

    let selectedText = raw.selectedText;
    let selectedTextTruncated = raw.selectedTextTruncated;
    if (selectedText !== undefined) {
      const bounded = truncateUtf8(selectedText, maxSelectedTextBytes);
      selectedText = bounded.value;
      selectedTextTruncated ||= bounded.truncated;
    }
    const rectsTruncated = raw.rectsTruncated || raw.rects.length > maxRects;
    const rects = raw.rects.slice(0, maxRects).map((rect) => ({ ...rect }));
    truncated ||= selectedTextTruncated || rectsTruncated;
    selections.push({
      ...raw,
      frameId,
      ...(selectedText !== undefined ? { selectedText } : {}),
      selectedTextTruncated,
      rects,
      rectsTruncated,
    });
  }

  return { selections, frameErrors, truncated };
}

async function extractSelectionFrame(
  frame: SnapshotFrameLike,
): Promise<RawSelectionState | undefined> {
  return frame.evaluate((): RawSelectionState | undefined => {
    // Hard browser-side caps remain fixed because pure-CDP frame evaluation
    // serializes this function and cannot capture Node-side option variables.
    const MAX_SELECTED_TEXT_CHARS = 32_768;
    const MAX_RECTS = 128;

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

    function nodePoint(node: Node | null, offset: number): DocumentSelectionPoint | undefined {
      if (!node) return undefined;
      if (node.nodeType === Node.ELEMENT_NODE) {
        return { path: elementPath(node as Element), offset, nodeType: 'element' };
      }
      if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
        const index = Array.prototype.indexOf.call(node.parentNode?.childNodes ?? [], node);
        return {
          path: `${elementPath(node.parentElement)}::text(${Math.max(0, index)})`,
          offset,
          nodeType: 'text',
        };
      }
      const parent = node.parentElement;
      return {
        path: parent ? `${elementPath(parent)}::node(${node.nodeType})` : `node(${node.nodeType})`,
        offset,
        nodeType: 'other',
      };
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

    function hostDetails(host: Element | undefined): DocumentEditingHost | undefined {
      if (!host) return undefined;
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

    function boundedText(value: string): { value?: string; truncated: boolean } {
      if (!value) return { truncated: false };
      if (value.length <= MAX_SELECTED_TEXT_CHARS) return { value, truncated: false };
      return { value: value.slice(0, MAX_SELECTED_TEXT_CHARS), truncated: true };
    }

    function documentRect(rect: DOMRect | DOMRectReadOnly): Rect {
      return {
        x: rect.x + scrollX,
        y: rect.y + scrollY,
        width: rect.width,
        height: rect.height,
      };
    }

    const active = deepActiveElement();
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (start !== null && end !== null) {
        const selected = boundedText(active.value.slice(start, end));
        const rect = active.getBoundingClientRect();
        const direction: DocumentSelectionDirection = active.selectionDirection === 'backward'
          ? 'backward'
          : start === end ? 'none' : 'forward';
        const anchorOffset = direction === 'backward' ? end : start;
        const focusOffset = direction === 'backward' ? start : end;
        const pointPath = elementPath(active);
        return {
          kind: 'text-control',
          collapsed: start === end,
          direction,
          ...(selected.value !== undefined ? { selectedText: selected.value } : {}),
          selectedTextTruncated: selected.truncated,
          anchor: { path: pointPath, offset: anchorOffset, nodeType: 'element' },
          focus: { path: pointPath, offset: focusOffset, nodeType: 'element' },
          editingHost: {
            path: pointPath,
            tagName: active.tagName.toLowerCase(),
          },
          start,
          end,
          rangeCount: 1,
          boundingRect: documentRect(rect),
          rects: [documentRect(rect)],
          rectsTruncated: false,
        };
      }
    }

    const selection = getSelection();
    if (!selection || selection.rangeCount < 1) return undefined;
    const host = nearestEditingHost(selection.anchorNode) ?? nearestEditingHost(selection.focusNode);
    const selected = boundedText(selection.toString());
    let direction: DocumentSelectionDirection = 'none';
    if (!selection.isCollapsed && selection.anchorNode && selection.focusNode) {
      try {
        const probe = document.createRange();
        probe.setStart(selection.anchorNode, selection.anchorOffset);
        probe.setEnd(selection.focusNode, selection.focusOffset);
        direction = probe.collapsed ? 'backward' : 'forward';
      } catch {
        direction = 'none';
      }
    }

    const range = selection.getRangeAt(0);
    const allRects = Array.from(range.getClientRects());
    const rects = allRects.slice(0, MAX_RECTS).map(documentRect);
    const bounding = range.getBoundingClientRect();
    const hasBounding = Number.isFinite(bounding.x) && Number.isFinite(bounding.y) &&
      (bounding.width > 0 || bounding.height > 0);
    const anchor = nodePoint(selection.anchorNode, selection.anchorOffset);
    const focus = nodePoint(selection.focusNode, selection.focusOffset);
    const editingHost = hostDetails(host);

    return {
      kind: 'dom',
      collapsed: selection.isCollapsed,
      direction,
      ...(selected.value !== undefined ? { selectedText: selected.value } : {}),
      selectedTextTruncated: selected.truncated,
      ...(anchor ? { anchor } : {}),
      ...(focus ? { focus } : {}),
      ...(editingHost ? { editingHost } : {}),
      rangeCount: selection.rangeCount,
      ...(hasBounding ? { boundingRect: documentRect(bounding) } : {}),
      rects,
      rectsTruncated: allRects.length > MAX_RECTS,
    };
  });
}

export class DocumentSelectionObserver {
  constructor(private readonly page: SnapshotPageLike) {}

  async snapshot(options: DocumentSelectionOptions = {}): Promise<DocumentSelectionSnapshot> {
    await (this.page as SnapshotPageLike & { refresh?: () => Promise<void> }).refresh?.();
    return snapshotDocumentSelection(this.page, options);
  }
}
