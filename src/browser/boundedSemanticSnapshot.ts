import type { InteractionCapability, InteractionNode, Rect } from '../types.js';
import type { SnapshotFrameLike, SnapshotPageLike } from './domSnapshot.js';

export interface BoundedSemanticSnapshotLimits {
  maxItems: number;
  maxTextBytes: number;
  maxDepth: number;
}

export interface BoundedSemanticSnapshotResult {
  nodes: InteractionNode[];
  complete: boolean;
  truncated: boolean;
}

interface BoundedFrameSource {
  boundedFrames(maxFrames: number): { frames: readonly SnapshotFrameLike[]; complete: boolean };
}

interface RawBoundedNode {
  path: string;
  role?: string;
  name?: string;
  value?: string;
  focused: boolean;
  disabled: boolean;
  rect?: Rect;
  visibleRect?: Rect;
  viewportVisible: boolean;
  focusable: boolean;
  clickable: boolean;
  editable: boolean;
  scrollable: boolean;
  capabilities: InteractionCapability[];
  interactionConfidence: number;
}

interface RawBoundedFrameResult {
  nodes: RawBoundedNode[];
  truncated: boolean;
  textBytes: number;
}

function boundedExtractor(
  maxItems: number,
  maxTextBytes: number,
  maxDepth: number,
): () => RawBoundedFrameResult {
  const source = `() => {
    const MAX_ITEMS = ${Math.max(1, Math.floor(maxItems))};
    const MAX_TEXT_BYTES = ${Math.max(1, Math.floor(maxTextBytes))};
    const MAX_DEPTH = ${Math.max(1, Math.floor(maxDepth))};
    const MAX_VISITED = Math.min(16384, Math.max(64, MAX_ITEMS * 64));
    const MAX_SIBLING_SCAN = 128;
    const encoder = new TextEncoder();
    const results = [];
    let textBytes = 0;
    let visited = 0;
    let truncated = false;
    const selectors = [
      'a[href]', 'button', 'input', 'select', 'textarea',
      '[contenteditable="true"]', '[tabindex]', '[role="button"]', '[role="link"]',
      '[role="textbox"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
      '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
      '[role="option"]', '[role="tab"]', '[role="treeitem"]', '[role="gridcell"]',
      '[role="columnheader"]', '[role="rowheader"]', '[role="grid"]', '[role="listbox"]',
      '[role="menu"]', '[role="menubar"]', '[role="radiogroup"]', '[role="tablist"]',
      '[role="toolbar"]', '[role="tree"]', '[role="treegrid"]', 'nav', 'header', 'form',
      '[aria-expanded]', '[aria-checked]', '[aria-selected]', '[aria-pressed]', '[aria-activedescendant]'
    ].join(',');
    const nonTextInputTypes = new Set(['button','checkbox','color','file','hidden','image','radio','range','reset','submit']);
    const activatableInputTypes = new Set(['button','checkbox','image','radio','range','reset','submit']);
    const activatableRoles = new Set(['button','link','checkbox','radio','switch','menuitem','menuitemcheckbox','menuitemradio','option','tab','treeitem']);
    const scrollOverflowValues = new Set(['auto','scroll']);

    const bytes = (value) => encoder.encode(value).byteLength;
    const boundedText = (value) => {
      if (typeof value !== 'string' || !value) return undefined;
      let out = '';
      for (const char of value.replace(/\\s+/g, ' ').trim()) {
        const next = bytes(char);
        if (textBytes + next > MAX_TEXT_BYTES) { truncated = true; break; }
        out += char;
        textBytes += next;
      }
      return out || undefined;
    };
    const directText = (element) => {
      let result = '';
      let count = 0;
      for (let node = element.firstChild; node && count < 16; node = node.nextSibling, count += 1) {
        if (node.nodeType === Node.TEXT_NODE && node.nodeValue) result += ' ' + node.nodeValue;
      }
      if (count >= 16) truncated = true;
      return result.trim();
    };
    const elementSegment = (element) => {
      let index = 1;
      let scanned = 0;
      for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        scanned += 1;
        if (scanned > MAX_SIBLING_SCAN) { truncated = true; return undefined; }
        if (sibling.tagName === element.tagName) index += 1;
      }
      return element.tagName.toLowerCase() + ':nth-of-type(' + index + ')';
    };
    const domPath = (element) => {
      const parts = [];
      let current = element;
      let depth = 0;
      while (current && current !== document.documentElement) {
        depth += 1;
        if (depth > MAX_DEPTH) { truncated = true; return undefined; }
        const segment = elementSegment(current);
        if (!segment) return undefined;
        parts.push(segment);
        const root = current.getRootNode();
        if (root instanceof ShadowRoot) {
          parts.push('::shadow');
          current = root.host;
        } else current = current.parentElement;
      }
      return parts.reverse().join(' > ');
    };
    const activeElement = () => {
      let active = document.activeElement;
      let depth = 0;
      while (active instanceof HTMLElement && active.shadowRoot?.activeElement && depth < MAX_DEPTH) {
        active = active.shadowRoot.activeElement;
        depth += 1;
      }
      return active;
    };
    const accessibleName = (element) => {
      const aria = element.getAttribute('aria-label')?.trim();
      if (aria) return aria;
      const title = element.getAttribute('title')?.trim();
      if (title) return title;
      const placeholder = element.getAttribute('placeholder')?.trim();
      if (placeholder) return placeholder;
      return directText(element);
    };
    const visibleRect = (bounds) => {
      const left = Math.max(0, bounds.left), top = Math.max(0, bounds.top);
      const right = Math.min(window.innerWidth, bounds.right), bottom = Math.min(window.innerHeight, bounds.bottom);
      return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : undefined;
    };
    const stack = [];
    if (document.documentElement) stack.push({ element: document.documentElement, depth: 0 });
    while (stack.length && results.length < MAX_ITEMS && textBytes < MAX_TEXT_BYTES && visited < MAX_VISITED) {
      const current = stack.pop();
      const element = current.element;
      const depth = current.depth;
      visited += 1;
      if (depth < MAX_DEPTH) {
        if (element.nextElementSibling) stack.push({ element: element.nextElementSibling, depth });
        if (element.firstElementChild) stack.push({ element: element.firstElementChild, depth: depth + 1 });
        if (element.shadowRoot?.firstElementChild) stack.push({ element: element.shadowRoot.firstElementChild, depth: depth + 1 });
      } else if (element.firstElementChild || element.shadowRoot?.firstElementChild) truncated = true;
      const style = getComputedStyle(element);
      const scrollable = element instanceof HTMLElement && ((scrollOverflowValues.has(style.overflowX) && element.scrollWidth > element.clientWidth) || (scrollOverflowValues.has(style.overflowY) && element.scrollHeight > element.clientHeight));
      if (!element.matches(selectors) && !scrollable) continue;
      const bounds = element.getBoundingClientRect();
      const rendered = bounds.width > 0 && bounds.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none' && element.getAttribute('aria-hidden') !== 'true';
      if (!rendered) continue;
      const html = element;
      const nativeDisabled = (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) && element.disabled;
      const disabled = nativeDisabled || element.getAttribute('aria-disabled') === 'true';
      const inputType = element instanceof HTMLInputElement ? element.type.toLowerCase() : '';
      const editable = (element instanceof HTMLInputElement && !nonTextInputTypes.has(inputType)) || element instanceof HTMLTextAreaElement || html.isContentEditable;
      const focusable = !disabled && html.tabIndex >= 0;
      const role = element.getAttribute('role') || element.tagName.toLowerCase();
      const clickable = !disabled && (element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement || element instanceof HTMLSelectElement || (element instanceof HTMLInputElement && activatableInputTypes.has(inputType)) || activatableRoles.has(role.toLowerCase()) || typeof html.onclick === 'function');
      const capabilities = [];
      if (focusable) capabilities.push('focus');
      if (clickable) capabilities.push('activate');
      if (editable) capabilities.push('type');
      if (element instanceof HTMLInputElement && inputType === 'file') capabilities.push('upload');
      if (element instanceof HTMLSelectElement && !disabled) capabilities.push('select');
      if (element instanceof HTMLInputElement && inputType === 'range' && !disabled) capabilities.push('set-range');
      if (scrollable) capabilities.push('scroll');
      if (element.hasAttribute('aria-expanded')) capabilities.push('expand');
      const path = domPath(element);
      if (!path) continue;
      const clipped = visibleRect(bounds);
      const rawValue = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element.value : html.isContentEditable ? directText(element) : undefined;
      const name = boundedText(accessibleName(element));
      const value = boundedText(rawValue);
      const boundedRole = boundedText(role);
      results.push({
        path,
        role: boundedRole,
        name,
        value,
        focused: activeElement() === element,
        disabled,
        rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        visibleRect: clipped,
        viewportVisible: clipped !== undefined,
        focusable,
        clickable,
        editable,
        scrollable,
        capabilities,
        interactionConfidence: Math.max(0.25, Math.min(1, 0.35 + (focusable ? 0.2 : 0) + (clickable || editable ? 0.25 : 0) + (element.hasAttribute('role') ? 0.1 : 0) + (name ? 0.1 : 0)))
      });
    }
    if (stack.length || visited >= MAX_VISITED || results.length >= MAX_ITEMS || textBytes >= MAX_TEXT_BYTES) truncated = true;
    return { nodes: results, truncated, textBytes };
  }`;
  return new Function(`return (${source});`)() as () => RawBoundedFrameResult;
}

export async function snapshotInteractiveDomBounded(
  page: SnapshotPageLike,
  limits: BoundedSemanticSnapshotLimits,
): Promise<BoundedSemanticSnapshotResult> {
  const source = page as SnapshotPageLike & Partial<BoundedFrameSource>;
  if (typeof source.boundedFrames !== 'function') return { nodes: [], complete: false, truncated: true };
  const maxItems = Math.max(1, Math.floor(limits.maxItems));
  const maxTextBytes = Math.max(1, Math.floor(limits.maxTextBytes));
  const maxDepth = Math.max(1, Math.floor(limits.maxDepth));
  const frameBudget = Math.max(1, Math.min(32, maxDepth));
  const supplied = source.boundedFrames(frameBudget);
  if (supplied.frames.length > frameBudget) return { nodes: [], complete: false, truncated: true };
  const frameIds = new Map(supplied.frames.map((frame, index) => [frame, index === 0 ? 'main' : `frame-${index}`]));
  const nodes: InteractionNode[] = [];
  let textBytes = 0;
  let truncated = !supplied.complete;
  for (const [index, frame] of supplied.frames.entries()) {
    if (nodes.length >= maxItems || textBytes >= maxTextBytes) { truncated = true; break; }
    const frameId = index === 0 ? 'main' : `frame-${index}`;
    const remainingItems = maxItems - nodes.length;
    const remainingTextBytes = maxTextBytes - textBytes;
    const extracted = await frame.evaluate(boundedExtractor(remainingItems, remainingTextBytes, maxDepth));
    textBytes += extracted.textBytes;
    truncated ||= extracted.truncated;
    const parent = frame.parentFrame?.() ?? null;
    const parentFrameId = parent ? frameIds.get(parent) : undefined;
    for (const node of extracted.nodes) {
      nodes.push({
        ...node,
        id: `${frameId}:${node.path}`,
        structuralId: `${frameId}:${node.path}`,
        frameId,
        ...(parentFrameId ? { parentFrameId } : {}),
      });
      if (nodes.length >= maxItems) { truncated = true; break; }
    }
  }
  return { nodes, complete: !truncated, truncated };
}
