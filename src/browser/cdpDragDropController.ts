import { Buffer } from 'node:buffer';
import type { CdpEventSessionLike } from './dialogController.js';

export interface BrowserDragPoint {
  x: number;
  y: number;
}

export type BrowserDragTransferStatus =
  | 'drop-dispatched'
  | 'drag-not-started'
  | 'payload-blocked'
  | 'file-payload-blocked'
  | 'invalid-point'
  | 'protocol-error';

export interface BrowserDragTransferResult {
  status: BrowserDragTransferStatus;
  itemCount: number;
  fileCount: number;
  /** MIME metadata only. Drag item data/title/baseURL and file paths are never returned. */
  mimeTypes: string[];
  /** UTF-8 bytes observed across the intercepted protocol payload before dispatch. */
  totalPayloadBytes: number;
}

export interface BrowserDragTransferOptions {
  maxItems?: number;
  maxFiles?: number;
  maxPayloadBytes?: number;
  /** File-bearing drops are side-effect-prone and are blocked unless explicitly enabled. */
  allowFiles?: boolean;
  dragStartSteps?: number;
  interceptTimeoutMs?: number;
}

interface RawDragItem {
  mimeType?: unknown;
  data?: unknown;
  title?: unknown;
  baseURL?: unknown;
}

interface RawDragData {
  items?: RawDragItem[];
  files?: unknown[];
  dragOperationsMask?: unknown;
}

interface RawDragInterceptedEvent {
  data?: RawDragData;
}

const DEFAULT_MAX_ITEMS = 16;
const DEFAULT_MAX_FILES = 16;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_DRAG_START_STEPS = 5;
const DEFAULT_INTERCEPT_TIMEOUT_MS = 750;

function positiveInteger(name: string, value: number | undefined, fallback: number, ceiling: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer`);
  return Math.min(resolved, ceiling);
}

function finitePoint(point: BrowserDragPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) &&
    Math.abs(point.x) <= 10_000_000 && Math.abs(point.y) <= 10_000_000;
}

function boundedMimeType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 96 || !/^[a-z0-9!#$&^_.+\-]+\/[a-z0-9!#$&^_.+\-]+$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function utf8Bytes(value: unknown): number {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
}

function dragPayloadSummary(data: RawDragData): {
  itemCount: number;
  fileCount: number;
  mimeTypes: string[];
  totalPayloadBytes: number;
} {
  const items = Array.isArray(data.items) ? data.items : [];
  const files = Array.isArray(data.files) ? data.files : [];
  const mimeTypes: string[] = [];
  let totalPayloadBytes = 0;
  for (const item of items) {
    totalPayloadBytes += utf8Bytes(item.data) + utf8Bytes(item.title) + utf8Bytes(item.baseURL) + utf8Bytes(item.mimeType);
    const mimeType = boundedMimeType(item.mimeType);
    if (mimeType && !mimeTypes.includes(mimeType)) mimeTypes.push(mimeType);
  }
  for (const file of files) totalPayloadBytes += utf8Bytes(file);
  return {
    itemCount: items.length,
    fileCount: files.length,
    mimeTypes: mimeTypes.slice(0, 16),
    totalPayloadBytes,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Transfer Chromium-native intercepted drag data to a target point. The source
 * payload is never reconstructed with page-side DragEvent/DataTransfer objects.
 * A `drop-dispatched` result only means CDP accepted the drop input; semantic
 * acceptance by the target must be verified by a higher-level controller.
 */
export class CdpDragDropController {
  constructor(private readonly session: CdpEventSessionLike) {}

  async transfer(
    source: BrowserDragPoint,
    target: BrowserDragPoint,
    options: BrowserDragTransferOptions = {},
  ): Promise<BrowserDragTransferResult> {
    if (!finitePoint(source) || !finitePoint(target)) {
      return { status: 'invalid-point', itemCount: 0, fileCount: 0, mimeTypes: [], totalPayloadBytes: 0 };
    }

    const maxItems = positiveInteger('maxItems', options.maxItems, DEFAULT_MAX_ITEMS, 256);
    const maxFiles = positiveInteger('maxFiles', options.maxFiles, DEFAULT_MAX_FILES, 256);
    const maxPayloadBytes = positiveInteger(
      'maxPayloadBytes',
      options.maxPayloadBytes,
      DEFAULT_MAX_PAYLOAD_BYTES,
      4 * 1024 * 1024,
    );
    const dragStartSteps = positiveInteger('dragStartSteps', options.dragStartSteps, DEFAULT_DRAG_START_STEPS, 32);
    const interceptTimeoutMs = positiveInteger(
      'interceptTimeoutMs',
      options.interceptTimeoutMs,
      DEFAULT_INTERCEPT_TIMEOUT_MS,
      10_000,
    );

    let listener: ((params: RawDragInterceptedEvent) => void) | undefined;
    let pointerDown = false;
    let intercepted = false;
    let activeDragData: RawDragData | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dragData = new Promise<RawDragData | undefined>((resolve) => {
      listener = (params) => {
        if (intercepted) return;
        intercepted = true;
        activeDragData = params?.data;
        if (timer) clearTimeout(timer);
        resolve(activeDragData);
      };
      this.session.on('Input.dragIntercepted', listener);
      timer = setTimeout(() => resolve(undefined), interceptTimeoutMs);
    });

    const cancelDrag = async (data: RawDragData | undefined = activeDragData) => {
      if (!data) return;
      activeDragData = undefined;
      try {
        await this.session.send('Input.dispatchDragEvent', {
          type: 'dragCancel', x: target.x, y: target.y, data,
        });
      } catch {}
    };

    const releasePointer = async () => {
      if (!pointerDown) return;
      pointerDown = false;
      try {
        await this.session.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: target.x,
          y: target.y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
      } catch {}
    };

    try {
      await this.session.send('Input.setInterceptDrags', { enabled: true });
      await this.session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: source.x, y: source.y, button: 'none', buttons: 0,
      });
      await this.session.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: source.x, y: source.y, button: 'left', buttons: 1, clickCount: 1,
      });
      pointerDown = true;
      for (let step = 1; step <= dragStartSteps; step += 1) {
        const progress = step / dragStartSteps;
        await this.session.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: source.x + (target.x - source.x) * progress,
          y: source.y + (target.y - source.y) * progress,
          button: 'left',
          buttons: 1,
        });
        if (!intercepted && step < dragStartSteps) await delay(8);
        if (intercepted) break;
      }

      const data = await dragData;
      if (!data) {
        await releasePointer();
        return { status: 'drag-not-started', itemCount: 0, fileCount: 0, mimeTypes: [], totalPayloadBytes: 0 };
      }
      const summary = dragPayloadSummary(data);
      if (summary.itemCount > maxItems || summary.fileCount > maxFiles || summary.totalPayloadBytes > maxPayloadBytes) {
        await cancelDrag(data);
        await releasePointer();
        return { status: 'payload-blocked', ...summary };
      }
      if (summary.fileCount > 0 && options.allowFiles !== true) {
        await cancelDrag(data);
        await releasePointer();
        return { status: 'file-payload-blocked', ...summary };
      }

      await this.session.send('Input.dispatchDragEvent', {
        type: 'dragEnter', x: target.x, y: target.y, data,
      });
      await this.session.send('Input.dispatchDragEvent', {
        type: 'dragOver', x: target.x, y: target.y, data,
      });
      await this.session.send('Input.dispatchDragEvent', {
        type: 'drop', x: target.x, y: target.y, data,
      });
      activeDragData = undefined;
      await releasePointer();
      return { status: 'drop-dispatched', ...summary };
    } catch {
      await cancelDrag();
      await releasePointer();
      return { status: 'protocol-error', itemCount: 0, fileCount: 0, mimeTypes: [], totalPayloadBytes: 0 };
    } finally {
      if (timer) clearTimeout(timer);
      if (listener) this.session.off?.('Input.dragIntercepted', listener);
      try { await this.session.send('Input.setInterceptDrags', { enabled: false }); } catch {}
    }
  }
}
