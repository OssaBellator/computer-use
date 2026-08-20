import { Buffer } from 'node:buffer';
import type { Rect } from '../types.js';
import type { SnapshotFrameLike, SnapshotPageLike } from './domSnapshot.js';

export type DocumentContentBlockKind =
  | 'heading'
  | 'paragraph'
  | 'list-item'
  | 'definition-term'
  | 'definition-description'
  | 'table-caption'
  | 'table-cell'
  | 'code'
  | 'quote'
  | 'figcaption'
  | 'link'
  | 'image'
  | 'landmark';

export interface DocumentContentBlock {
  /** Stable structural identity within the owning frame, including open-shadow boundaries. */
  id: string;
  frameId: string;
  kind: DocumentContentBlockKind;
  tagName: string;
  depth: number;
  text?: string;
  level?: number;
  href?: string;
  alt?: string;
  role?: string;
  name?: string;
  /** Frame-local document coordinates in CSS pixels. */
  rect?: Rect;
  /** Participates in rendered layout; off-screen rendered content remains readable by default. */
  rendered: boolean;
  /** Intersects the current viewport of the owning frame. */
  inViewport: boolean;
  /** Text was shortened by either browser-side hard bounds or caller bounds. */
  truncated: boolean;
}

export interface DocumentFrameContent {
  frameId: string;
  title: string;
  language?: string;
  description?: string;
  canonicalUrl?: string;
  includedBlocks: number;
  browserExtractionTruncated: boolean;
}

export interface DocumentContentFrameError {
  frameId: string;
  message: string;
}

export interface DocumentContentSnapshot {
  frames: DocumentFrameContent[];
  blocks: DocumentContentBlock[];
  totalTextBytes: number;
  /** True when any browser/caller bound omitted or shortened content. */
  truncated: boolean;
  frameErrors: DocumentContentFrameError[];
}

export interface DocumentContentOptions {
  /** Maximum returned blocks across all frames. Defaults to 500. */
  maxBlocks?: number;
  /** Maximum UTF-8 bytes across block text/alt/name fields. Defaults to 262,144. */
  maxTextBytes?: number;
  /** Maximum UTF-8 bytes retained per textual field. Defaults to 8,192. */
  maxTextBytesPerBlock?: number;
  /** Maximum DOM/composed-tree depth returned. Defaults to 64. */
  maxDepth?: number;
  /** Include elements that do not participate in rendered layout. Defaults to false. */
  includeHidden?: boolean;
  /** Restrict to blocks intersecting each frame's current viewport. Defaults to false. */
  viewportOnly?: boolean;
}

interface RawDocumentBlock {
  path: string;
  kind: DocumentContentBlockKind;
  tagName: string;
  depth: number;
  text?: string;
  level?: number;
  href?: string;
  alt?: string;
  role?: string;
  name?: string;
  rect?: Rect;
  rendered: boolean;
  inViewport: boolean;
  truncated: boolean;
}

interface RawDocumentFrame {
  title: string;
  language?: string;
  description?: string;
  canonicalUrl?: string;
  blocks: RawDocumentBlock[];
  truncated: boolean;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean; bytes: number } {
  const originalBytes = Buffer.byteLength(value, 'utf8');
  if (originalBytes <= maxBytes) return { value, truncated: false, bytes: originalBytes };
  let output = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return { value: output, truncated: true, bytes };
}

function copyBoundedField(
  value: string | undefined,
  remainingBytes: number,
  perFieldBytes: number,
): { value?: string; bytes: number; truncated: boolean } {
  if (value === undefined || value.length === 0 || remainingBytes <= 0) {
    return { bytes: 0, truncated: value !== undefined && value.length > 0 };
  }
  const bounded = truncateUtf8(value, Math.min(remainingBytes, perFieldBytes));
  return { value: bounded.value, bytes: bounded.bytes, truncated: bounded.truncated };
}

/**
 * Bounded structured reading model over the repo's own frame abstraction.
 *
 * Browser-side extraction has independent hard safety caps so even callers that
 * request very large host-side limits cannot cause an unbounded frame payload.
 * Caller limits are then applied exactly in UTF-8 bytes across the combined
 * multi-frame result.
 */
export async function snapshotDocumentContent(
  page: SnapshotPageLike,
  options: DocumentContentOptions = {},
): Promise<DocumentContentSnapshot> {
  const maxBlocks = positiveInteger('maxBlocks', options.maxBlocks ?? 500);
  const maxTextBytes = positiveInteger('maxTextBytes', options.maxTextBytes ?? 256 * 1024);
  const maxTextBytesPerBlock = positiveInteger(
    'maxTextBytesPerBlock',
    options.maxTextBytesPerBlock ?? 8 * 1024,
  );
  const maxDepth = positiveInteger('maxDepth', options.maxDepth ?? 64);
  const includeHidden = options.includeHidden ?? false;
  const viewportOnly = options.viewportOnly ?? false;

  const blocks: DocumentContentBlock[] = [];
  const frames: DocumentFrameContent[] = [];
  const frameErrors: DocumentContentFrameError[] = [];
  let totalTextBytes = 0;
  let truncated = false;

  const sourceFrames = page.frames();
  for (let frameIndex = 0; frameIndex < sourceFrames.length; frameIndex += 1) {
    if (blocks.length >= maxBlocks || totalTextBytes >= maxTextBytes) {
      truncated = true;
      break;
    }
    const frame = sourceFrames[frameIndex];
    const frameId = frameIndex === 0 ? 'main' : `frame-${frameIndex}`;
    let raw: RawDocumentFrame;
    try {
      raw = await extractDocumentFrame(frame);
    } catch (error) {
      frameErrors.push({
        frameId,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    let includedBlocks = 0;
    for (const candidate of raw.blocks) {
      if (candidate.depth > maxDepth) continue;
      if (!includeHidden && !candidate.rendered) continue;
      if (viewportOnly && !candidate.inViewport) continue;
      if (blocks.length >= maxBlocks || totalTextBytes >= maxTextBytes) {
        truncated = true;
        break;
      }

      let fieldTruncated = candidate.truncated;
      const next: DocumentContentBlock = {
        id: `${frameId}:${candidate.path}`,
        frameId,
        kind: candidate.kind,
        tagName: candidate.tagName,
        depth: candidate.depth,
        ...(candidate.level !== undefined ? { level: candidate.level } : {}),
        ...(candidate.href !== undefined ? { href: candidate.href } : {}),
        ...(candidate.role !== undefined ? { role: candidate.role } : {}),
        ...(candidate.rect !== undefined ? { rect: { ...candidate.rect } } : {}),
        rendered: candidate.rendered,
        inViewport: candidate.inViewport,
        truncated: false,
      };

      for (const field of ['text', 'alt', 'name'] as const) {
        const remaining = maxTextBytes - totalTextBytes;
        const copied = copyBoundedField(candidate[field], remaining, maxTextBytesPerBlock);
        if (copied.value !== undefined) next[field] = copied.value;
        totalTextBytes += copied.bytes;
        fieldTruncated ||= copied.truncated;
      }
      next.truncated = fieldTruncated;
      truncated ||= fieldTruncated;
      blocks.push(next);
      includedBlocks += 1;
    }

    frames.push({
      frameId,
      title: raw.title,
      ...(raw.language ? { language: raw.language } : {}),
      ...(raw.description ? { description: raw.description } : {}),
      ...(raw.canonicalUrl ? { canonicalUrl: raw.canonicalUrl } : {}),
      includedBlocks,
      browserExtractionTruncated: raw.truncated,
    });
    truncated ||= raw.truncated;
  }

  return { frames, blocks, totalTextBytes, truncated, frameErrors };
}

async function extractDocumentFrame(frame: SnapshotFrameLike): Promise<RawDocumentFrame> {
  return frame.evaluate((): RawDocumentFrame => {
    // Independent browser-side hard bounds. Host-side options can only make the
    // returned snapshot smaller than these limits.
    const MAX_BLOCKS = 2_000;
    const MAX_TOTAL_TEXT_CHARS = 250_000;
    const MAX_TEXT_CHARS_PER_BLOCK = 12_000;
    const MAX_DEPTH = 128;

    const blocks: RawDocumentBlock[] = [];
    const visited = new Set<Element>();
    let textChars = 0;
    let truncated = false;

    function normalizeText(value: string | null | undefined, preserveWhitespace = false): string {
      if (!value) return '';
      if (preserveWhitespace) {
        return value.replace(/\r\n?/g, '\n').trim();
      }
      return value.replace(/\s+/g, ' ').trim();
    }

    function boundedText(value: string, preserveWhitespace = false): { text?: string; truncated: boolean } {
      const normalized = normalizeText(value, preserveWhitespace);
      if (!normalized) return { truncated: false };
      const available = Math.max(0, MAX_TOTAL_TEXT_CHARS - textChars);
      const limit = Math.min(MAX_TEXT_CHARS_PER_BLOCK, available);
      if (limit <= 0) {
        truncated = true;
        return { truncated: true };
      }
      const shortened = normalized.length > limit;
      const text = shortened ? normalized.slice(0, limit) : normalized;
      textChars += text.length;
      if (shortened) truncated = true;
      return { text, truncated: shortened };
    }

    function elementSegment(element: Element): string {
      let index = 1;
      let sibling = element.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === element.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      return `${element.tagName.toLowerCase()}:nth-of-type(${index})`;
    }

    function domPath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.documentElement) {
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

    function resolvedUrl(value: string | null): string | undefined {
      if (!value) return undefined;
      try {
        return new URL(value, document.baseURI).href;
      } catch {
        return value;
      }
    }

    function accessibleName(element: Element): string | undefined {
      const direct = element.getAttribute('aria-label')?.trim();
      if (direct) return direct;
      const labelledBy = element.getAttribute('aria-labelledby')?.trim();
      if (labelledBy) {
        const label = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (label) return label;
      }
      const title = element.getAttribute('title')?.trim();
      return title || undefined;
    }

    function geometry(element: Element): { rect?: Rect; rendered: boolean; inViewport: boolean } {
      const style = getComputedStyle(element);
      const clientRects = element.getClientRects();
      const rendered = style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.visibility !== 'collapse' &&
        clientRects.length > 0;
      if (!clientRects.length) return { rendered, inViewport: false };
      const rect = element.getBoundingClientRect();
      const resultRect = {
        x: rect.x + scrollX,
        y: rect.y + scrollY,
        width: rect.width,
        height: rect.height,
      };
      const inViewport = rendered &&
        rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
      return { rect: resultRect, rendered, inViewport };
    }

    function emit(
      element: Element,
      depth: number,
      kind: DocumentContentBlockKind,
      details: {
        text?: string;
        preserveWhitespace?: boolean;
        level?: number;
        href?: string;
        alt?: string;
        role?: string;
        name?: string;
      } = {},
    ): void {
      if (blocks.length >= MAX_BLOCKS || textChars >= MAX_TOTAL_TEXT_CHARS) {
        truncated = true;
        return;
      }
      const text = details.text === undefined
        ? { truncated: false }
        : boundedText(details.text, details.preserveWhitespace);
      const alt = details.alt === undefined ? { truncated: false } : boundedText(details.alt);
      const name = details.name === undefined ? { truncated: false } : boundedText(details.name);
      const box = geometry(element);
      blocks.push({
        path: domPath(element),
        kind,
        tagName: element.tagName.toLowerCase(),
        depth,
        ...(text.text ? { text: text.text } : {}),
        ...(details.level !== undefined ? { level: details.level } : {}),
        ...(details.href ? { href: details.href } : {}),
        ...(alt.text ? { alt: alt.text } : {}),
        ...(details.role ? { role: details.role } : {}),
        ...(name.text ? { name: name.text } : {}),
        ...(box.rect ? { rect: box.rect } : {}),
        rendered: box.rendered,
        inViewport: box.inViewport,
        truncated: text.truncated || alt.truncated || name.truncated,
      });
    }

    function visit(element: Element, depth: number): void {
      if (visited.has(element) || depth > MAX_DEPTH || blocks.length >= MAX_BLOCKS) {
        if (depth > MAX_DEPTH || blocks.length >= MAX_BLOCKS) truncated = true;
        return;
      }
      visited.add(element);

      const tag = element.tagName.toLowerCase();
      const text = element.textContent ?? '';
      const role = element.getAttribute('role')?.trim().toLowerCase() || undefined;

      if (/^h[1-6]$/.test(tag)) {
        emit(element, depth, 'heading', { text, level: Number(tag.slice(1)) });
      } else if (tag === 'p') {
        emit(element, depth, 'paragraph', { text });
      } else if (tag === 'li') {
        emit(element, depth, 'list-item', { text });
      } else if (tag === 'dt') {
        emit(element, depth, 'definition-term', { text });
      } else if (tag === 'dd') {
        emit(element, depth, 'definition-description', { text });
      } else if (tag === 'caption') {
        emit(element, depth, 'table-caption', { text });
      } else if (tag === 'th' || tag === 'td') {
        emit(element, depth, 'table-cell', { text, role });
      } else if (tag === 'pre') {
        emit(element, depth, 'code', { text, preserveWhitespace: true });
      } else if (tag === 'code' && element.closest('pre') === null) {
        emit(element, depth, 'code', { text, preserveWhitespace: true });
      } else if (tag === 'blockquote' || tag === 'q') {
        emit(element, depth, 'quote', { text });
      } else if (tag === 'figcaption') {
        emit(element, depth, 'figcaption', { text });
      }

      if (tag === 'a') {
        const anchor = element as HTMLAnchorElement;
        emit(element, depth, 'link', {
          text,
          href: resolvedUrl(anchor.getAttribute('href')),
          name: accessibleName(element),
        });
      } else if (tag === 'img') {
        const image = element as HTMLImageElement;
        emit(element, depth, 'image', {
          alt: image.getAttribute('alt') ?? undefined,
          name: accessibleName(element),
        });
      }

      const landmark = tag === 'main' || tag === 'article' || tag === 'nav' ||
        tag === 'aside' || tag === 'header' || tag === 'footer' ||
        role === 'main' || role === 'article' || role === 'navigation' ||
        role === 'complementary' || role === 'banner' || role === 'contentinfo' ||
        role === 'search' || role === 'region';
      if (landmark) {
        emit(element, depth, 'landmark', {
          role: role ?? tag,
          name: accessibleName(element),
        });
      }

      if (blocks.length >= MAX_BLOCKS || textChars >= MAX_TOTAL_TEXT_CHARS) {
        truncated = true;
        return;
      }

      const shadow = (element as HTMLElement).shadowRoot;
      if (shadow) {
        for (const child of Array.from(shadow.children)) {
          if (child.tagName.toLowerCase() === 'slot') {
            const slot = child as HTMLSlotElement;
            const assigned = slot.assignedElements({ flatten: true });
            if (assigned.length) {
              for (const assignedElement of assigned) visit(assignedElement, depth + 1);
              continue;
            }
          }
          visit(child, depth + 1);
        }
        return;
      }

      for (const child of Array.from(element.children)) visit(child, depth + 1);
    }

    if (document.documentElement) visit(document.documentElement, 0);

    const description = document.querySelector('meta[name="description" i]')
      ?.getAttribute('content')?.trim() || undefined;
    const canonicalUrl = resolvedUrl(
      document.querySelector('link[rel~="canonical" i]')?.getAttribute('href') ?? null,
    );
    const language = document.documentElement?.lang?.trim() || undefined;

    return {
      title: document.title ?? '',
      ...(language ? { language } : {}),
      ...(description ? { description } : {}),
      ...(canonicalUrl ? { canonicalUrl } : {}),
      blocks,
      truncated,
    };
  });
}
