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
  /** Participates in rendered layout; off-screen rendered content stays readable by default. */
  rendered: boolean;
  /** Intersects the current viewport of the owning frame. */
  inViewport: boolean;
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
  /** UTF-8 bytes retained across textual block fields. */
  totalTextBytes: number;
  truncated: boolean;
  frameErrors: DocumentContentFrameError[];
}

export interface DocumentContentOptions {
  maxBlocks?: number;
  /** Maximum UTF-8 bytes across block text/href/alt/role/name fields. */
  maxTextBytes?: number;
  /** Maximum UTF-8 bytes retained per textual block field. */
  maxTextBytesPerBlock?: number;
  maxDepth?: number;
  includeHidden?: boolean;
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
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
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

function boundedField(
  value: string | undefined,
  remainingBytes: number,
  perFieldBytes: number,
): { value?: string; bytes: number; truncated: boolean } {
  if (value === undefined || value.length === 0) return { bytes: 0, truncated: false };
  if (remainingBytes <= 0) return { bytes: 0, truncated: true };
  const bounded = truncateUtf8(value, Math.min(remainingBytes, perFieldBytes));
  return { value: bounded.value, bytes: bounded.bytes, truncated: bounded.truncated };
}

/**
 * Bounded structured reading model over the repo's own frame abstraction.
 * Browser-side extraction has independent element/block/string budgets; host
 * limits then apply exact UTF-8 bounds across the combined multi-frame result.
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
    const frameId = frameIndex === 0 ? 'main' : `frame-${frameIndex}`;
    let raw: RawDocumentFrame;
    try {
      raw = await extractDocumentFrame(sourceFrames[frameIndex]);
    } catch (error) {
      frameErrors.push({ frameId, message: error instanceof Error ? error.message : String(error) });
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
        ...(candidate.rect ? { rect: { ...candidate.rect } } : {}),
        rendered: candidate.rendered,
        inViewport: candidate.inViewport,
        truncated: false,
      };

      for (const field of ['text', 'href', 'alt', 'role', 'name'] as const) {
        const copied = boundedField(
          candidate[field],
          maxTextBytes - totalTextBytes,
          maxTextBytesPerBlock,
        );
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
    const MAX_VISITED_ELEMENTS = 20_000;
    const MAX_BLOCKS = 2_000;
    const MAX_TOTAL_TEXT_CHARS = 250_000;
    const MAX_FIELD_CHARS = 12_000;
    const MAX_URL_CHARS = 4_096;
    const MAX_ROLE_CHARS = 256;
    const MAX_METADATA_CHARS = 8_192;
    const MAX_DEPTH = 128;

    const blocks: RawDocumentBlock[] = [];
    const visited = new Set<Element>();
    let visitedElements = 0;
    let textChars = 0;
    let truncated = false;

    function clipScalar(value: string | null | undefined, maxChars: number): { value?: string; truncated: boolean } {
      if (!value) return { truncated: false };
      const normalized = value.replace(/\s+/g, ' ').trim();
      if (!normalized) return { truncated: false };
      if (normalized.length <= maxChars) return { value: normalized, truncated: false };
      truncated = true;
      return { value: normalized.slice(0, maxChars), truncated: true };
    }

    function takeString(
      value: string | null | undefined,
      preserveWhitespace = false,
      maxChars = MAX_FIELD_CHARS,
    ): { value?: string; truncated: boolean } {
      if (!value) return { truncated: false };
      const normalized = preserveWhitespace
        ? value.replace(/\r\n?/g, '\n').trim()
        : value.replace(/\s+/g, ' ').trim();
      if (!normalized) return { truncated: false };
      const available = Math.max(0, MAX_TOTAL_TEXT_CHARS - textChars);
      const limit = Math.min(maxChars, available);
      if (limit <= 0) {
        truncated = true;
        return { truncated: true };
      }
      const shortened = normalized.length > limit;
      const output = shortened ? normalized.slice(0, limit) : normalized;
      textChars += output.length;
      if (shortened) truncated = true;
      return { value: output, truncated: shortened };
    }

    function elementText(element: Element, preserveWhitespace = false): { value?: string; truncated: boolean } {
      const available = Math.min(MAX_FIELD_CHARS, Math.max(0, MAX_TOTAL_TEXT_CHARS - textChars));
      if (available <= 0) {
        truncated = true;
        return { truncated: true };
      }
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let raw = '';
      let shortened = false;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const data = (node as Text).data;
        if (!data) continue;
        const piece = preserveWhitespace
          ? data.replace(/\r\n?/g, '\n')
          : data.replace(/\s+/g, ' ');
        if (!piece) continue;
        const remaining = available - raw.length;
        if (remaining <= 0) {
          shortened = true;
          break;
        }
        if (piece.length > remaining) {
          raw += piece.slice(0, remaining);
          shortened = true;
          break;
        }
        raw += piece;
      }
      const normalized = preserveWhitespace ? raw.trim() : raw.replace(/\s+/g, ' ').trim();
      if (!normalized) return { truncated: shortened };
      textChars += normalized.length;
      if (shortened) truncated = true;
      return { value: normalized, truncated: shortened };
    }

    function fixedElementText(element: Element, limit = 1_024): string | undefined {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let raw = '';
      for (let node = walker.nextNode(); node && raw.length < limit; node = walker.nextNode()) {
        const piece = (node as Text).data.replace(/\s+/g, ' ');
        raw += piece.slice(0, limit - raw.length);
      }
      const normalized = raw.replace(/\s+/g, ' ').trim();
      return normalized || undefined;
    }

    function elementSegment(element: Element): string {
      let index = 1;
      for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === element.tagName) index += 1;
      }
      return `${element.tagName.toLowerCase()}:nth-of-type(${index})`;
    }

    function domPath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.documentElement && parts.length < MAX_DEPTH * 2 + 2) {
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

    function resolvedUrl(value: string | null): { value?: string; truncated: boolean } {
      const clipped = clipScalar(value, MAX_URL_CHARS);
      if (!clipped.value) return clipped;
      try {
        return { value: new URL(clipped.value, document.baseURI).href, truncated: clipped.truncated };
      } catch {
        return clipped;
      }
    }

    function accessibleName(element: Element): string | undefined {
      const direct = element.getAttribute('aria-label')?.trim();
      if (direct) return direct;
      const labelledBy = element.getAttribute('aria-labelledby')?.trim();
      if (labelledBy) {
        let output = '';
        for (const id of labelledBy.split(/\s+/).slice(0, 16)) {
          const label = document.getElementById(id);
          const text = label ? fixedElementText(label) : undefined;
          if (!text) continue;
          output += `${output ? ' ' : ''}${text}`;
          if (output.length >= 1_024) return output.slice(0, 1_024);
        }
        if (output) return output;
      }
      return element.getAttribute('title')?.trim() || undefined;
    }

    function geometry(element: Element): { rect?: Rect; rendered: boolean; inViewport: boolean } {
      const style = getComputedStyle(element);
      const rects = element.getClientRects();
      const rendered = style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.visibility !== 'collapse' &&
        rects.length > 0;
      if (!rects.length) return { rendered, inViewport: false };
      const rect = element.getBoundingClientRect();
      return {
        rect: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height },
        rendered,
        inViewport: rendered && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight,
      };
    }

    function emit(
      element: Element,
      depth: number,
      kind: DocumentContentBlockKind,
      details: {
        elementText?: boolean;
        preserveWhitespace?: boolean;
        level?: number;
        href?: string;
        hrefTruncated?: boolean;
        alt?: string;
        role?: string;
        name?: string;
      } = {},
    ): void {
      if (blocks.length >= MAX_BLOCKS || textChars >= MAX_TOTAL_TEXT_CHARS) {
        truncated = true;
        return;
      }
      const text = details.elementText ? elementText(element, details.preserveWhitespace) : { truncated: false };
      const href = details.href === undefined ? { truncated: false } : takeString(details.href, false, MAX_URL_CHARS);
      const alt = details.alt === undefined ? { truncated: false } : takeString(details.alt);
      const role = details.role === undefined ? { truncated: false } : takeString(details.role, false, MAX_ROLE_CHARS);
      const name = details.name === undefined ? { truncated: false } : takeString(details.name);
      const box = geometry(element);
      blocks.push({
        path: domPath(element),
        kind,
        tagName: element.tagName.toLowerCase(),
        depth,
        ...(text.value ? { text: text.value } : {}),
        ...(details.level !== undefined ? { level: details.level } : {}),
        ...(href.value ? { href: href.value } : {}),
        ...(alt.value ? { alt: alt.value } : {}),
        ...(role.value ? { role: role.value } : {}),
        ...(name.value ? { name: name.value } : {}),
        ...(box.rect ? { rect: box.rect } : {}),
        rendered: box.rendered,
        inViewport: box.inViewport,
        truncated: text.truncated || href.truncated || alt.truncated || role.truncated || name.truncated || details.hrefTruncated === true,
      });
    }

    function visit(element: Element, depth: number): void {
      if (visited.has(element)) return;
      visitedElements += 1;
      if (visitedElements > MAX_VISITED_ELEMENTS || depth > MAX_DEPTH || blocks.length >= MAX_BLOCKS) {
        truncated = true;
        return;
      }
      visited.add(element);
      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute('role')?.trim().toLowerCase() || undefined;

      if (/^h[1-6]$/.test(tag)) emit(element, depth, 'heading', { elementText: true, level: Number(tag.slice(1)) });
      else if (tag === 'p') emit(element, depth, 'paragraph', { elementText: true });
      else if (tag === 'li') emit(element, depth, 'list-item', { elementText: true });
      else if (tag === 'dt') emit(element, depth, 'definition-term', { elementText: true });
      else if (tag === 'dd') emit(element, depth, 'definition-description', { elementText: true });
      else if (tag === 'caption') emit(element, depth, 'table-caption', { elementText: true });
      else if (tag === 'th' || tag === 'td') emit(element, depth, 'table-cell', { elementText: true, role });
      else if (tag === 'pre') emit(element, depth, 'code', { elementText: true, preserveWhitespace: true });
      else if (tag === 'code' && element.closest('pre') === null) emit(element, depth, 'code', { elementText: true, preserveWhitespace: true });
      else if (tag === 'blockquote' || tag === 'q') emit(element, depth, 'quote', { elementText: true });
      else if (tag === 'figcaption') emit(element, depth, 'figcaption', { elementText: true });

      if (tag === 'a') {
        const url = resolvedUrl(element.getAttribute('href'));
        emit(element, depth, 'link', {
          elementText: true,
          href: url.value,
          hrefTruncated: url.truncated,
          name: accessibleName(element),
        });
      } else if (tag === 'img') {
        emit(element, depth, 'image', {
          alt: element.getAttribute('alt') ?? undefined,
          name: accessibleName(element),
        });
      }

      const landmark = tag === 'main' || tag === 'article' || tag === 'nav' ||
        tag === 'aside' || tag === 'header' || tag === 'footer' ||
        role === 'main' || role === 'article' || role === 'navigation' ||
        role === 'complementary' || role === 'banner' || role === 'contentinfo' ||
        role === 'search' || role === 'region';
      if (landmark) emit(element, depth, 'landmark', { role: role ?? tag, name: accessibleName(element) });

      if (blocks.length >= MAX_BLOCKS || textChars >= MAX_TOTAL_TEXT_CHARS || visitedElements >= MAX_VISITED_ELEMENTS) {
        truncated = true;
        return;
      }

      if (tag === 'slot') {
        const assigned = (element as HTMLSlotElement).assignedElements({ flatten: true });
        if (assigned.length) {
          for (let index = 0; index < assigned.length && index < MAX_VISITED_ELEMENTS; index += 1) {
            visit(assigned[index], depth + 1);
            if (visitedElements >= MAX_VISITED_ELEMENTS) break;
          }
          return;
        }
      }

      const shadow = (element as HTMLElement).shadowRoot;
      if (shadow) {
        for (let child = shadow.firstElementChild; child; child = child.nextElementSibling) {
          if (child.tagName.toLowerCase() === 'slot') {
            const assigned = (child as HTMLSlotElement).assignedElements({ flatten: true });
            if (assigned.length) {
              for (let index = 0; index < assigned.length && index < MAX_VISITED_ELEMENTS; index += 1) {
                visit(assigned[index], depth + 1);
                if (visitedElements >= MAX_VISITED_ELEMENTS) break;
              }
              continue;
            }
          }
          visit(child, depth + 1);
          if (visitedElements >= MAX_VISITED_ELEMENTS) break;
        }
        return;
      }

      for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
        visit(child, depth + 1);
        if (visitedElements >= MAX_VISITED_ELEMENTS) break;
      }
    }

    if (document.documentElement) visit(document.documentElement, 0);

    const title = clipScalar(document.title, MAX_METADATA_CHARS).value ?? '';
    const language = clipScalar(document.documentElement?.lang, 128).value;
    const description = clipScalar(
      document.querySelector('meta[name="description" i]')?.getAttribute('content'),
      MAX_METADATA_CHARS,
    ).value;
    const canonical = resolvedUrl(
      document.querySelector('link[rel~="canonical" i]')?.getAttribute('href') ?? null,
    );

    return {
      title,
      ...(language ? { language } : {}),
      ...(description ? { description } : {}),
      ...(canonical.value ? { canonicalUrl: canonical.value } : {}),
      blocks,
      truncated: truncated || canonical.truncated,
    };
  });
}
