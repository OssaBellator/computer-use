import type { InteractionCapability, InteractionNode, Rect } from '../types.js';

interface RawNode {
  path: string;
  role?: string;
  name?: string;
  value?: string;
  expanded?: boolean;
  checked?: boolean | 'mixed';
  selected?: boolean;
  pressed?: boolean | 'mixed';
  activeDescendantId?: string;
  activeDescendantStructuralId?: string;
  scrollAncestorStructuralId?: string;
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

export interface SnapshotFrameLike {
  evaluate<R>(pageFunction: () => R | Promise<R>): Promise<R>;
  parentFrame?(): SnapshotFrameLike | null;
}

export interface SnapshotPageLike {
  frames(): SnapshotFrameLike[];
}

async function extractFrame(frame: SnapshotFrameLike, frameId: string): Promise<InteractionNode[]> {
  const raw = await frame.evaluate((): RawNode[] => {
    const results: RawNode[] = [];
    const visitedRoots = new Set<Document | ShadowRoot>();
    const nonTextInputTypes = new Set([
      'button', 'checkbox', 'color', 'file', 'hidden', 'image',
      'radio', 'range', 'reset', 'submit',
    ]);
    const activatableInputTypes = new Set([
      'button', 'checkbox', 'image', 'radio', 'range', 'reset', 'submit',
    ]);
    const activatableRoles = new Set([
      'button', 'link', 'checkbox', 'radio', 'switch', 'menuitem', 'option', 'tab',
    ]);
    const clippingOverflowValues = new Set(['auto', 'scroll', 'hidden', 'clip']);
    const scrollOverflowValues = new Set(['auto', 'scroll']);
    const selectors = [
      'a[href]', 'button', 'input', 'select', 'textarea',
      '[contenteditable="true"]', '[tabindex]', '[role="button"]',
      '[role="link"]', '[role="textbox"]', '[role="checkbox"]',
      '[role="radio"]', '[role="switch"]', '[role="menuitem"]',
      '[role="option"]', '[role="tab"]', 'nav', 'header', 'form',
      '[aria-expanded]', '[aria-checked]', '[aria-selected]', '[aria-pressed]',
      '[aria-activedescendant]',
    ];
    const selectorText = selectors.join(',');

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
      return parts.reverse().join(' > ');
    }

    function composedParent(element: Element): Element | null {
      if (element.parentElement) return element.parentElement;
      const root = element.getRootNode();
      return root instanceof ShadowRoot ? root.host : null;
    }

    function deepActiveElement(root: Document | ShadowRoot = document): Element | null {
      let active = root.activeElement;
      while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      return active;
    }

    function resolveIdReference(element: Element, id: string): Element | null {
      const root = element.getRootNode();
      return root instanceof ShadowRoot ? root.getElementById(id) : document.getElementById(id);
    }

    function idReferenceText(element: Element, ids: string): string {
      return ids
        .split(/\s+/)
        .map((id) => resolveIdReference(element, id)?.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ');
    }

    function accessibleName(element: Element): string | undefined {
      const aria = element.getAttribute('aria-label')?.trim();
      if (aria) return aria;
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = idReferenceText(element, labelledBy);
        if (text) return text;
      }
      if ((element instanceof HTMLInputElement ||
           element instanceof HTMLSelectElement ||
           element instanceof HTMLTextAreaElement) && element.labels?.length) {
        const text = Array.from(element.labels)
          .map((label) => label.textContent?.trim() ?? '')
          .filter(Boolean)
          .join(' ');
        if (text) return text;
      }
      const text = element.textContent?.replace(/\s+/g, ' ').trim();
      return text ? text.slice(0, 200) : undefined;
    }

    function isTextEntryInput(element: Element): element is HTMLInputElement {
      return element instanceof HTMLInputElement && !nonTextInputTypes.has(element.type.toLowerCase());
    }

    function isScrollableElement(element: Element, style = getComputedStyle(element)): boolean {
      if (!(element instanceof HTMLElement)) return false;
      const canScrollX = scrollOverflowValues.has(style.overflowX) && element.scrollWidth > element.clientWidth;
      const canScrollY = scrollOverflowValues.has(style.overflowY) && element.scrollHeight > element.clientHeight;
      return canScrollX || canScrollY;
    }

    function nearestScrollableAncestor(element: Element): Element | null {
      let current = composedParent(element);
      while (current) {
        if (isScrollableElement(current)) return current;
        current = composedParent(current);
      }
      return null;
    }

    function clippedVisibleRect(element: Element, bounds: DOMRect): Rect | undefined {
      let left = Math.max(0, bounds.left);
      let top = Math.max(0, bounds.top);
      let right = Math.min(window.innerWidth, bounds.right);
      let bottom = Math.min(window.innerHeight, bounds.bottom);

      let ancestor = composedParent(element);
      while (ancestor && right > left && bottom > top) {
        const style = getComputedStyle(ancestor);
        const clipsX = clippingOverflowValues.has(style.overflowX);
        const clipsY = clippingOverflowValues.has(style.overflowY);
        if ((clipsX || clipsY) && ancestor instanceof HTMLElement) {
          const rect = ancestor.getBoundingClientRect();
          const clientLeft = rect.left + ancestor.clientLeft;
          const clientTop = rect.top + ancestor.clientTop;
          const clientRight = clientLeft + ancestor.clientWidth;
          const clientBottom = clientTop + ancestor.clientHeight;
          if (clipsX) {
            left = Math.max(left, clientLeft);
            right = Math.min(right, clientRight);
          }
          if (clipsY) {
            top = Math.max(top, clientTop);
            bottom = Math.min(bottom, clientBottom);
          }
        }
        ancestor = composedParent(ancestor);
      }

      return right > left && bottom > top
        ? { x: left, y: top, width: right - left, height: bottom - top }
        : undefined;
    }

    function collect(root: Document | ShadowRoot): void {
      if (visitedRoots.has(root)) return;
      visitedRoots.add(root);

      for (const element of root.querySelectorAll('*')) {
        const style = getComputedStyle(element);
        const scrollable = isScrollableElement(element, style);
        const semanticCandidate = element.matches(selectorText);

        if (element.shadowRoot) collect(element.shadowRoot);
        if (!semanticCandidate && !scrollable) continue;

        const bounds = element.getBoundingClientRect();
        const rendered =
          bounds.width > 0 && bounds.height > 0 &&
          style.visibility !== 'hidden' && style.display !== 'none' &&
          style.pointerEvents !== 'none' && element.getAttribute('aria-hidden') !== 'true';
        if (!rendered) continue;

        const html = element as HTMLElement;
        const nativeDisabled =
          (element instanceof HTMLButtonElement || element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) &&
          element.disabled;
        const disabled = nativeDisabled || element.getAttribute('aria-disabled') === 'true';
        const fileInput = element instanceof HTMLInputElement && element.type.toLowerCase() === 'file';
        const rangeInput = element instanceof HTMLInputElement && element.type.toLowerCase() === 'range';
        const selectInput = element instanceof HTMLSelectElement;
        const editable = isTextEntryInput(element) ||
          element instanceof HTMLTextAreaElement || html.isContentEditable;
        const focusable = !disabled && html.tabIndex >= 0;
        const role = element.getAttribute('role') ?? element.tagName.toLowerCase();
        const nativeActivatableInput = element instanceof HTMLInputElement &&
          activatableInputTypes.has(element.type.toLowerCase());
        const clickable = !disabled && (
          element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement ||
          element instanceof HTMLSelectElement || nativeActivatableInput ||
          activatableRoles.has(role.toLowerCase()) ||
          typeof (html as HTMLElement & { onclick?: unknown }).onclick === 'function'
        );

        const capabilities: InteractionCapability[] = [];
        if (focusable) capabilities.push('focus');
        if (clickable) capabilities.push('activate');
        if (editable) capabilities.push('type');
        if (fileInput) capabilities.push('upload');
        if (selectInput && !disabled) capabilities.push('select');
        if (rangeInput && !disabled) capabilities.push('set-range');
        if (scrollable) capabilities.push('scroll');
        if (element.hasAttribute('aria-expanded')) capabilities.push('expand');

        const visibleRect = clippedVisibleRect(element, bounds);
        const scrollAncestor = nearestScrollableAncestor(element);
        const ariaChecked = element.getAttribute('aria-checked');
        const ariaPressed = element.getAttribute('aria-pressed');
        const expanded = element.hasAttribute('aria-expanded')
          ? element.getAttribute('aria-expanded') === 'true'
          : undefined;
        const checked = element instanceof HTMLInputElement &&
          (element.type === 'checkbox' || element.type === 'radio')
          ? element.checked
          : ariaChecked === 'mixed' ? 'mixed' :
            ariaChecked === 'true' ? true : ariaChecked === 'false' ? false : undefined;
        const selected = element.hasAttribute('aria-selected')
          ? element.getAttribute('aria-selected') === 'true'
          : undefined;
        const pressed = ariaPressed === 'mixed' ? 'mixed' :
          ariaPressed === 'true' ? true : ariaPressed === 'false' ? false : undefined;
        const activeDescendantId = element.getAttribute('aria-activedescendant') ?? undefined;
        const activeDescendant = activeDescendantId
          ? resolveIdReference(element, activeDescendantId)
          : null;

        const name = accessibleName(element);
        const confidence = Math.max(0.25, Math.min(1,
          0.35 + (focusable ? 0.2 : 0) + (clickable || editable || fileInput || selectInput || rangeInput ? 0.25 : 0) +
          (element.hasAttribute('role') ? 0.1 : 0) + (name ? 0.1 : 0),
        ));

        results.push({
          path: domPath(element), role, name, expanded, checked, selected, pressed, activeDescendantId,
          activeDescendantStructuralId: activeDescendant ? domPath(activeDescendant) : undefined,
          scrollAncestorStructuralId: scrollAncestor ? domPath(scrollAncestor) : undefined,
          value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
            ? element.value
            : html.isContentEditable ? html.innerText : undefined,
          focused: deepActiveElement() === element,
          disabled,
          rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          visibleRect,
          viewportVisible: visibleRect !== undefined,
          focusable, clickable, editable, scrollable, capabilities,
          interactionConfidence: confidence,
        });
      }
    }

    collect(document);
    return results;
  });

  return raw.map((node) => ({
    ...node,
    id: `${frameId}:${node.path}`,
    frameId,
    activeDescendantStructuralId: node.activeDescendantStructuralId
      ? `${frameId}:${node.activeDescendantStructuralId}`
      : undefined,
    scrollAncestorStructuralId: node.scrollAncestorStructuralId
      ? `${frameId}:${node.scrollAncestorStructuralId}`
      : undefined,
  }));
}

function framePath(frame: SnapshotFrameLike, allFrames: readonly SnapshotFrameLike[]): string {
  const index = allFrames.indexOf(frame);
  return index === 0 ? 'main' : `frame-${index}`;
}

export async function snapshotInteractiveDom(page: SnapshotPageLike): Promise<InteractionNode[]> {
  const frames = page.frames();
  const frameIds = new Map(frames.map((frame, index) => [
    frame,
    index === 0 ? 'main' : `frame-${index}`,
  ]));
  const perFrame = await Promise.all(
    frames.map(async (frame) => {
      const frameId = frameIds.get(frame) ?? framePath(frame, frames);
      const parent = frame.parentFrame?.() ?? null;
      const parentFrameId = parent ? frameIds.get(parent) : undefined;
      const nodes = await extractFrame(frame, frameId);
      return nodes.map((node) => ({ ...node, parentFrameId }));
    }),
  );
  return perFrame.flat();
}
