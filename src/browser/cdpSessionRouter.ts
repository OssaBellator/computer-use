import type { CdpEventSessionLike } from './dialogController.js';

export type CdpMultiplexEventListener = (params: any, sessionId?: string) => void;

/**
 * Browser-root CDP transport contract. Flattened target sessions are addressed
 * by the optional top-level `sessionId` field in the protocol message.
 */
export interface CdpMultiplexConnectionLike {
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<any>;
  on(event: string, listener: CdpMultiplexEventListener): unknown;
  off?(event: string, listener: CdpMultiplexEventListener): unknown;
}

/** Root-domain session view that discards events belonging to attached targets. */
export class CdpRootSession implements CdpEventSessionLike {
  private readonly wrappers = new Map<
    string,
    Map<(params: any) => void, CdpMultiplexEventListener>
  >();

  constructor(readonly connection: CdpMultiplexConnectionLike) {}

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.connection.send(method, params);
  }

  on(event: string, listener: (params: any) => void): void {
    const wrapper: CdpMultiplexEventListener = (params, sessionId) => {
      if (sessionId === undefined) listener(params);
    };
    let eventWrappers = this.wrappers.get(event);
    if (!eventWrappers) {
      eventWrappers = new Map();
      this.wrappers.set(event, eventWrappers);
    }
    const existing = eventWrappers.get(listener);
    if (existing && this.connection.off) this.connection.off(event, existing);
    eventWrappers.set(listener, wrapper);
    this.connection.on(event, wrapper);
  }

  off(event: string, listener: (params: any) => void): void {
    const eventWrappers = this.wrappers.get(event);
    const wrapper = eventWrappers?.get(listener);
    if (!wrapper) return;
    this.connection.off?.(event, wrapper);
    eventWrappers!.delete(listener);
    if (eventWrappers!.size === 0) this.wrappers.delete(event);
  }

  dispose(): void {
    if (this.connection.off) {
      for (const [event, listeners] of this.wrappers) {
        for (const wrapper of listeners.values()) this.connection.off(event, wrapper);
      }
    }
    this.wrappers.clear();
  }
}

/** Event-capable CdpSessionLike view over one flattened target session. */
export class RoutedCdpSession implements CdpEventSessionLike {
  private readonly wrappers = new Map<
    string,
    Map<(params: any) => void, CdpMultiplexEventListener>
  >();
  private disposed = false;

  constructor(
    readonly connection: CdpMultiplexConnectionLike,
    readonly targetId: string,
    readonly sessionId: string,
  ) {}

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.disposed) return Promise.reject(new Error('CDP routed session is detached'));
    return this.connection.send(method, params, this.sessionId);
  }

  on(event: string, listener: (params: any) => void): void {
    if (this.disposed) throw new Error('CDP routed session is detached');
    const wrapper: CdpMultiplexEventListener = (params, sessionId) => {
      if (sessionId === this.sessionId) listener(params);
    };
    let eventWrappers = this.wrappers.get(event);
    if (!eventWrappers) {
      eventWrappers = new Map();
      this.wrappers.set(event, eventWrappers);
    }
    const existing = eventWrappers.get(listener);
    if (existing && this.connection.off) this.connection.off(event, existing);
    eventWrappers.set(listener, wrapper);
    this.connection.on(event, wrapper);
  }

  off(event: string, listener: (params: any) => void): void {
    const eventWrappers = this.wrappers.get(event);
    const wrapper = eventWrappers?.get(listener);
    if (!wrapper) return;
    this.connection.off?.(event, wrapper);
    eventWrappers!.delete(listener);
    if (eventWrappers!.size === 0) this.wrappers.delete(event);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.connection.off) {
      for (const [event, listeners] of this.wrappers) {
        for (const wrapper of listeners.values()) this.connection.off(event, wrapper);
      }
    }
    this.wrappers.clear();
  }

  get detached(): boolean {
    return this.disposed;
  }
}

/** Attaches/activates/detaches Chromium page targets through browser-root CDP. */
export class CdpTargetSessionRouter {
  readonly root: CdpRootSession;

  constructor(readonly connection: CdpMultiplexConnectionLike) {
    this.root = new CdpRootSession(connection);
  }

  async attach(targetId: string): Promise<RoutedCdpSession> {
    if (!targetId) throw new Error('targetId is required');
    const result = await this.connection.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    }) as { sessionId?: string };
    if (typeof result.sessionId !== 'string' || !result.sessionId) {
      throw new Error('Target.attachToTarget did not return a session id');
    }
    return new RoutedCdpSession(this.connection, targetId, result.sessionId);
  }

  async activate(targetId: string): Promise<void> {
    if (!targetId) throw new Error('targetId is required');
    await this.connection.send('Target.activateTarget', { targetId });
  }

  async detach(session: RoutedCdpSession): Promise<void> {
    if (session.detached) return;
    try {
      await this.connection.send('Target.detachFromTarget', { sessionId: session.sessionId });
    } finally {
      session.dispose();
    }
  }

  dispose(): void {
    this.root.dispose();
  }
}
