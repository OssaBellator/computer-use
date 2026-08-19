import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { CdpEventSessionLike } from './dialogController.js';

export type BrowserDownloadLifecycle = 'in-progress' | 'completed' | 'canceled';

export interface BrowserDownloadState {
  guid: string;
  state: BrowserDownloadLifecycle;
  receivedBytes: number;
  totalBytes?: number;
  /** Monotonic local identity; page URL/suggested filename are deliberately not retained. */
  sequence: number;
}

export interface BrowserDownloadSummary {
  total: number;
  inProgress: number;
  completed: number;
  canceled: number;
  latest?: BrowserDownloadState;
  latestCompleted?: BrowserDownloadState;
}

export interface BrowserDownloadControllerOptions {
  /** Explicit absolute filesystem root. Files are written under opaque CDP GUID names. */
  downloadPath: string;
  maxTrackedDownloads?: number;
}

function clone(state: BrowserDownloadState): BrowserDownloadState {
  return { ...state };
}

function finiteBytes(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeLifecycle(value: unknown): BrowserDownloadLifecycle | undefined {
  if (value === 'inProgress') return 'in-progress';
  if (value === 'completed' || value === 'canceled') return value;
  return undefined;
}

/**
 * Event-backed download verifier. `allowAndName` forces GUID filenames so page-controlled
 * suggested filenames cannot escape or influence the configured download directory.
 */
export class CdpDownloadController {
  readonly downloadPath: string;
  readonly maxTrackedDownloads: number;
  private readonly byGuid = new Map<string, BrowserDownloadState>();
  private sequence = 0;
  private started = false;

  private readonly onBegin = (params: any) => {
    if (typeof params?.guid !== 'string') return;
    const existing = this.byGuid.get(params.guid);
    this.byGuid.set(params.guid, {
      guid: params.guid,
      state: existing?.state ?? 'in-progress',
      receivedBytes: existing?.receivedBytes ?? 0,
      ...(existing?.totalBytes !== undefined ? { totalBytes: existing.totalBytes } : {}),
      sequence: existing?.sequence ?? ++this.sequence,
    });
    this.trimTerminalHistory();
  };

  private readonly onProgress = (params: any) => {
    if (typeof params?.guid !== 'string') return;
    const lifecycle = normalizeLifecycle(params.state);
    if (!lifecycle) return;
    const existing = this.byGuid.get(params.guid);
    const receivedBytes = finiteBytes(params.receivedBytes) ?? existing?.receivedBytes ?? 0;
    const totalBytes = finiteBytes(params.totalBytes) ?? existing?.totalBytes;
    this.byGuid.set(params.guid, {
      guid: params.guid,
      state: lifecycle,
      receivedBytes,
      ...(totalBytes !== undefined ? { totalBytes } : {}),
      sequence: existing?.sequence ?? ++this.sequence,
    });
    this.trimTerminalHistory();
  };

  constructor(
    private readonly session: CdpEventSessionLike,
    options: BrowserDownloadControllerOptions,
  ) {
    if (!options.downloadPath || !isAbsolute(options.downloadPath)) {
      throw new Error('downloadPath must be an explicit absolute path');
    }
    this.downloadPath = resolve(options.downloadPath);
    this.maxTrackedDownloads = Math.max(1, Math.floor(options.maxTrackedDownloads ?? 128));
    session.on('Browser.downloadWillBegin', this.onBegin);
    session.on('Browser.downloadProgress', this.onProgress);
  }

  async start(): Promise<void> {
    if (this.started) return;
    await mkdir(this.downloadPath, { recursive: true });
    await this.session.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: this.downloadPath,
      eventsEnabled: true,
    });
    this.started = true;
  }

  downloads(): BrowserDownloadState[] {
    return [...this.byGuid.values()].sort((a, b) => a.sequence - b.sequence).map(clone);
  }

  summary(): BrowserDownloadSummary {
    const downloads = this.downloads();
    const completed = downloads.filter((item) => item.state === 'completed');
    return {
      total: downloads.length,
      inProgress: downloads.filter((item) => item.state === 'in-progress').length,
      completed: completed.length,
      canceled: downloads.filter((item) => item.state === 'canceled').length,
      ...(downloads.length ? { latest: downloads.at(-1) } : {}),
      ...(completed.length ? { latestCompleted: completed.at(-1) } : {}),
    };
  }

  completedPath(guid: string): string | undefined {
    const item = this.byGuid.get(guid);
    return item?.state === 'completed' ? join(this.downloadPath, item.guid) : undefined;
  }

  private trimTerminalHistory(): void {
    if (this.byGuid.size <= this.maxTrackedDownloads) return;
    const terminal = [...this.byGuid.values()]
      .filter((item) => item.state !== 'in-progress')
      .sort((a, b) => a.sequence - b.sequence);
    for (const item of terminal) {
      if (this.byGuid.size <= this.maxTrackedDownloads) break;
      this.byGuid.delete(item.guid);
    }
  }

  dispose(): void {
    this.session.off?.('Browser.downloadWillBegin', this.onBegin);
    this.session.off?.('Browser.downloadProgress', this.onProgress);
    this.byGuid.clear();
  }
}
