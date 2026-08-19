import type { Frame, Page } from 'playwright-core';
import type { InteractionCapability, InteractionNode, Rect } from '../types.js';

interface RawNode {
  path: string;
  role?: string;
  name?: string;
  value?: string;
  focused: boolean;
  disabled: boolean;
  rect?: Rect;
  focusable: boolean;
  clickable: boolean;
  editable: boolean;
  scrollable: boolean;
  capabilities: InteractionCapability[];
  interactionConfidence: number;
}

async function extractFrame(frame: Frame, frameId: string): Promise<InteractionNode[]> {
  const raw = await frame.evaluate((): RawNode[] => {
    const results: RawNode[] = [];
    const visited = new Set<Element>();

    const selectors = [
      'a[href]',
      'button',
      'input',
      'select',
      'textarea',
      '[contenteditable="true"]',
      '[tabindex]',
      '[role="button"]',
      '[role="link"]',
      '[role="textbox"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="menuitem"]',
      'nav',
      'header',
      'form',
      '[aria-expanded]',
    ];

    function domPath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.documentElement) {
        let index = 1;
        let sibling = current.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === current.tagName) index += 1;
          sibling = sibling.previousElementSibling;
        }
        parts.push(`${current.tagName.toLowerCase()}:nth-of-type(${index})`);
        const root = current.getRootNode();
        current = root instanceof ShadowRoot ? root.host : current.parentElement;
      }
      return parts.reverse().join(' > ');
    }

    function accessibleName(element: Element): string | undefined {
      const aria = element.getAttribute('aria-label')?.trim();
      if (aria) return aria;
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
          .filter(Boolean)
          .join(' ');
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

    function collect(root: Document | ShadowRoot): void {
      for (const element of root.querySelectorAll(selectors.join(','))) {
        if (visited.has(element)) continue;
        visited.add(element);

        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        const visible =
          bounds.width > 0 &&
          bounds.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          style.pointerEvents !== 'none' &&
          element.getAttribute('aria-hidden') !== 'true';
        if (!visible) continue;

        const html = element as HTMLElement;
        const disabled =
          (element instanceof HTMLButtonElement ||
            element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement ||
            element instanceof HTMLTextAreaElement) &&
          element.disabled;
        const editable =
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          html.isContentEditable;
        const explicitTabIndex = html.tabIndex;
        const focusable = !disabled && explicitTabIndex >= 0;
        const role = element.getAttribute('role') ?? element.tagName.toLowerCase();
        const clickable =
          !disabled &&
          (element instanceof HTMLButtonElement ||
            element instanceof HTMLAnchorElement ||
            role === 'button' ||
            role === 'link' ||
            typeof (html as HTMLElement & { onclick?: unknown }).onclick === 'function');
        const scrollable =
          (style.overflowX === 'auto' ||
            style.overflowX === 'scroll' ||
            style.overflowY === 'auto' ||
            style.overflowY === 'scroll') &&
          (html.scrollHeight > html.clientHeight || html.scrollWidth > html.clientWidth);

        const capabilities: InteractionCapability[] = [];
        if (focusable) capabilities.push('focus');
        if (clickable) capabilities.push('activate');
        if (editable) capabilities.push('type');
        if (scrollable) capabilities.push('scroll');
        if (element.hasAttribute('aria-expanded')) capabilities.push('expand');

        const confidence = Math.max(
          0.25,
          Math.min(
            1,
            0.35 +
              (focusable ? 0.2 : 0) +
              (clickable || editable ? 0.25 : 0) +
              (element.hasAttribute('role') ? 0.1 : 0) +
              (accessibleName(element) ? 0.1 : 0),
          ),
        );

        results.push({
          path: domPath(element),
          role,
          name: accessibleName(element),
          value:
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
              ? element.value
              : undefined,
          focused: document.activeElement === element,
          disabled,
          rect: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          },
          focusable,
          clickable,
          editable,
          scrollable,
          capabilities,
          interactionConfidence: confidence,
        });

        if (element.shadowRoot) collect(element.shadowRoot);
      }
    }

    collect(document);
    return results;
  });

  return raw.map((node) => ({
    ...node,
    id: `${frameId}:${node.path}`,
    frameId,
  }));
}

/**
 * Captures a lightweight semantic/spatial snapshot for every currently
 * attached frame. Open shadow roots are traversed within each frame.
 */
export async function snapshotInteractiveDom(page: Page): Promise<InteractionNode[]> {
  const frames = page.frames();
  const perFrame = await Promise.all(
    frames.map((frame, index) => extractFrame(frame, `frame-${index}`)),
  );
  return perFrame.flat();
}
