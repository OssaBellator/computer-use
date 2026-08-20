import type { CdpSessionLike } from './cdpIdentity.js';
import type { SnapshotFrameLike, SnapshotPageLike } from './domSnapshot.js';

interface RawFrame {
  id: string;
  parentId?: string;
  url?: string;
  name?: string;
}

interface RawFrameTree {
  frame: RawFrame;
  childFrames?: RawFrameTree[];
}

interface RuntimeEvaluationResult {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/**
 * Snapshot-frame adapter backed only by CDP. Each frame evaluates inside a
 * dedicated isolated world so cross-frame DOM semantics do not require a
 * Playwright/Puppeteer frame object.
 */
export class CdpRuntimeSnapshotFrame implements SnapshotFrameLike {
  private executionContextId?: number;

  constructor(
    readonly page: CdpRuntimeSnapshotPage,
    readonly frameId: string,
    private parentFrameId?: string,
    private frameUrl = '',
    private frameName = '',
  ) {}

  update(parentFrameId: string | undefined, url: string, name: string): void {
    if (url !== this.frameUrl) this.executionContextId = undefined;
    this.parentFrameId = parentFrameId;
    this.frameUrl = url;
    this.frameName = name;
  }

  parentFrame(): SnapshotFrameLike | null {
    return this.parentFrameId ? this.page.frameById(this.parentFrameId) ?? null : null;
  }

  url(): string {
    return this.frameUrl;
  }

  name(): string {
    return this.frameName;
  }

  invalidateContext(): void {
    this.executionContextId = undefined;
  }

  async evaluate<R>(pageFunction: () => R | Promise<R>): Promise<R> {
    const expression = `(${pageFunction.toString()})()`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const contextId = await this.ensureContext();
      let evaluation: RuntimeEvaluationResult;
      try {
        evaluation = await this.page.session.send('Runtime.evaluate', {
          expression,
          contextId,
          returnByValue: true,
          awaitPromise: true,
        }) as RuntimeEvaluationResult;
      } catch (error) {
        if (attempt === 0) {
          this.executionContextId = undefined;
          continue;
        }
        throw error;
      }

      if (evaluation.exceptionDetails) {
        const detail = evaluation.exceptionDetails.exception?.description ??
          evaluation.exceptionDetails.text ?? 'Runtime.evaluate failed';
        throw new Error(detail);
      }
      return evaluation.result?.value as R;
    }
    throw new Error('CDP frame evaluation failed');
  }

  private async ensureContext(): Promise<number> {
    if (this.executionContextId !== undefined) return this.executionContextId;
    const result = await this.page.session.send('Page.createIsolatedWorld', {
      frameId: this.frameId,
      worldName: 'semantic-browser-interaction-engine',
      grantUniveralAccess: false,
    }) as { executionContextId?: number };
    if (typeof result.executionContextId !== 'number') {
      throw new Error('Page.createIsolatedWorld did not return an execution context');
    }
    this.executionContextId = result.executionContextId;
    return this.executionContextId;
  }
}

/**
 * Pure-CDP implementation of SnapshotPageLike. `refresh()` re-reads the live
 * Page frame tree while preserving frame adapters for still-existing frames.
 */
export class CdpRuntimeSnapshotPage implements SnapshotPageLike {
  private readonly framesById = new Map<string, CdpRuntimeSnapshotFrame>();
  private orderedFrameIds: string[] = [];

  constructor(readonly session: CdpSessionLike) {}

  frames(): SnapshotFrameLike[] {
    return this.orderedFrameIds
      .map((id) => this.framesById.get(id))
      .filter((frame): frame is CdpRuntimeSnapshotFrame => frame !== undefined);
  }

  boundedFrames(maxFrames: number): { frames: readonly SnapshotFrameLike[]; complete: boolean } {
    const limit = Math.max(1, Math.floor(maxFrames));
    const frames: SnapshotFrameLike[] = [];
    const count = Math.min(limit, this.orderedFrameIds.length);
    for (let index = 0; index < count; index += 1) {
      const frame = this.framesById.get(this.orderedFrameIds[index]);
      if (frame) frames.push(frame);
    }
    return { frames, complete: this.orderedFrameIds.length <= limit };
  }

  frameById(frameId: string): CdpRuntimeSnapshotFrame | undefined {
    return this.framesById.get(frameId);
  }

  async refresh(): Promise<void> {
    const result = await this.session.send('Page.getFrameTree') as { frameTree?: RawFrameTree };
    if (!result.frameTree?.frame?.id) throw new Error('Page.getFrameTree returned no root frame');

    const seen = new Set<string>();
    const order: string[] = [];
    const visit = (tree: RawFrameTree) => {
      const raw = tree.frame;
      if (!raw?.id) return;
      seen.add(raw.id);
      order.push(raw.id);
      const url = raw.url ?? '';
      const name = raw.name ?? '';
      const existing = this.framesById.get(raw.id);
      if (existing) existing.update(raw.parentId, url, name);
      else {
        this.framesById.set(
          raw.id,
          new CdpRuntimeSnapshotFrame(this, raw.id, raw.parentId, url, name),
        );
      }
      for (const child of tree.childFrames ?? []) visit(child);
    };
    visit(result.frameTree);

    for (const [id, frame] of this.framesById) {
      if (!seen.has(id)) {
        frame.invalidateContext();
        this.framesById.delete(id);
      }
    }
    this.orderedFrameIds = order;
  }
}

export async function createCdpRuntimeSnapshotPage(
  session: CdpSessionLike,
): Promise<CdpRuntimeSnapshotPage> {
  const page = new CdpRuntimeSnapshotPage(session);
  await page.refresh();
  return page;
}
