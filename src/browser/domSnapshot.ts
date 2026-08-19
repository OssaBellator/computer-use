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
}

export interface SnapshotPageLike {
  frames(): SnapshotFrameLike[];
}

async function extractFrame(frame: SnapshotFrameLike, frameId: string): Promise<InteractionNode[]> {
  const raw = await frame.evaluate((): RawNode[] => {
    const results: RawNode[] = [];
    const visited = new Set<Element>();
    const visitedRoots = new Set<Document | ShadowRoot>();
    const nonTextInputTypes = new Set([
      'button', 'checkbox', 'color', 'file', 'hidden', 'image',
      'radio', 'range', 'reset', 'submit',
    ]);
    const selectors = [
      'a[href]', 'button', 'input', 'select', 'textarea',
      '[contenteditable="true"]', '[tabindex]', '[role="button"]',
      '[role="link"]', '[role="textbox"]', '[role="checkbox"]',
      '[role="radio"]', '[role="menuitem"]', 'nav', 'header', 'form',
      '[aria-expanded]', '[aria-checked]', '[aria-selected]', '[aria-pressed]',
      '[aria-activedescendant]',
    ];

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

    function deepActiveElement(root: Document | ShadowRoot = document): Element | null {
      let active = root.activeElement;
      while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      return active;
    }

    function idReferenceText(element: Element, ids: string): string {
      const root = element.getRootNode();
      return ids
        .split(/\s+/)
        .map((id) => {
          const referenced = root instanceof ShadowRoot
            ? root.getElementById(id)
            : document.getElementById(id);
          return referenced?.textContent?.trim() ?? '';
        })
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
      if (element instanceof HTMLInputElement && element.labels?.length) {
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

    function collect(root: Document | ShadowRoot): void {
      if (visitedRoots.has(root)) return;
      visitedRoots.add(root);

      for (const element of root.querySelectorAll(selectors.join(','))) {
        if (visited.has(element)) continue;
        visited.add(element);
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        const visible =
          bounds.width > 0 && bounds.height > 0 &&
          style.visibility !== 'hidden' && style.display !== 'none' &&
          style.pointerEvents !== 'none' && element.getAttribute('aria-hidden') !== 'true';
        if (!visible) continue;

        const html = element as HTMLElement;
        const nativeDisabled =
          (element instanceof HTMLButtonElement || element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) &&
          element.disabled;
        const disabled = nativeDisabled || element.getAttribute('aria-disabled') === 'true';
        const editable = isTextEntryInput(element) ||
          element instanceof HTMLTextAreaElement || html.isContentEditable;
        const focusable = !disabled && html.tabIndex >= 0;
        const role = element.getAttribute('role') ?? element.tagName.toLowerCase();
        const clickable = !disabled && (
          element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement ||
          role === 'button' || role === 'link' ||
          typeof (html as HTMLElement & { onclick?: unknown }).onclick === 'function'
        );
        const scrollable =
          (style.overflowX === 'auto' || style.overflowX === 'scroll' ||
            style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          (html.scrollHeight > html.clientHeight || html.scrollWidth > html.clientWidth);

        const capabilities: InteractionCapability[] = [];
        if (focusable) capabilities.push('focus');
        if (clickable) capabilities.push('activate');
        if (editable) capabilities.push('type');
        if (scrollable) capabilities.push('scroll');
        if (element.hasAttribute('aria-expanded')) capabilities.push('expand');

        const viewportX1 = Math.max(0, bounds.left);
        const viewportY1 = Math.max(0, bounds.top);
        const viewportX2 = Math.min(window.innerWidth, bounds.right);
        const viewportY2 = Math.min(window.innerHeight, bounds.bottom);
        const visibleRect = viewportX2 > viewportX1 && viewportY2 > viewportY1
          ? {
              x: viewportX1,
              y: viewportY1,
              width: viewportX2 - viewportX1,
              height: viewportY2 - viewportY1,
            }
          : undefined;

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

        const name = accessibleName(element);
        const confidence = Math.max(0.25, Math.min(1,
          0.35 + (focusable ? 0.2 : 0) + (clickable || editable ? 0.25 : 0) +
          (element.hasAttribute('role') ? 0.1 : 0) + (name ? 0.1 : 0),
        ));

        results.push({
          path: domPath(element), role, name, expanded, checked, selected, pressed, activeDescendantId,
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

      // Shadow hosts are not necessarily interactive themselves. Traverse every
      // open root independently so a plain layout host cannot hide its controls.
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) collect(element.shadowRoot);
      }
    }

    collect(document);
    return results;
  });

  return raw.map((node) => ({ ...node, id: `${frameId}:${node.path}`, frameId }));
}

function framePath(frame: SnapshotFrameLike, allFrames: readonly SnapshotFrameLike[]): string {
  const index = allFrames.indexOf(frame);
  return index === 0 ? 'main' : `frame-${index}`;
}

export async function snapshotInteractiveDom(page: SnapshotPageLike): Promise<InteractionNode[]> {
  const frames = page.frames();
  const perFrame = await Promise.all(
    frames.map((frame) => extractFrame(frame, framePath(frame, frames))),
  );
  return perFrame.flat();
}
