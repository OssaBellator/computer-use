import type { CdpEventSessionLike } from './dialogController.js';
import {
  navigationPolicyViolation,
  type NavigationPolicy,
} from './navigationController.js';

export interface NavigationGuardSummary {
  paused: number;
  continued: number;
  blocked: number;
  /** Monotonic local sequence only; blocked destination URLs/reasons are not retained. */
  latestBlockedSequence?: number;
}

/**
 * Request-boundary navigation containment for page-initiated document loads.
 * It intercepts Document requests through CDP Fetch before the request is sent,
 * applies the same NavigationPolicy as explicit navigation, and retains no URL.
 */
export class CdpNavigationGuard {
  private started = false;
  private paused = 0;
  private continued = 0;
  private blocked = 0;
  private blockedSequence = 0;

  private readonly onPaused = (params: any) => {
    void this.handlePaused(params).catch(() => {
      // A protocol transport failure cannot safely be recovered here. The page
      // session will surface that failure through its normal browser lifecycle.
    });
  };

  constructor(
    private readonly session: CdpEventSessionLike,
    readonly policy: NavigationPolicy = {},
  ) {
    session.on('Fetch.requestPaused', this.onPaused);
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.session.send('Fetch.enable', {
      patterns: [{
        urlPattern: '*',
        resourceType: 'Document',
        requestStage: 'Request',
      }],
    });
    this.started = true;
  }

  summary(): NavigationGuardSummary {
    return {
      paused: this.paused,
      continued: this.continued,
      blocked: this.blocked,
      ...(this.blockedSequence > 0
        ? { latestBlockedSequence: this.blockedSequence }
        : {}),
    };
  }

  dispose(): void {
    this.session.off?.('Fetch.requestPaused', this.onPaused);
  }

  private async handlePaused(params: any): Promise<void> {
    const requestId = typeof params?.requestId === 'string' ? params.requestId : undefined;
    if (!requestId) return;
    this.paused += 1;

    // Fetch patterns should already restrict this to Document, but continue any
    // unexpected resource rather than applying document navigation policy to it.
    if (params?.resourceType !== 'Document') {
      await this.session.send('Fetch.continueRequest', { requestId });
      this.continued += 1;
      return;
    }

    const url = typeof params?.request?.url === 'string' ? params.request.url : '';
    let violation: string | undefined;
    try {
      violation = navigationPolicyViolation(url, this.policy);
    } catch {
      violation = 'invalid navigation URL';
    }

    if (violation) {
      await this.session.send('Fetch.failRequest', {
        requestId,
        errorReason: 'BlockedByClient',
      });
      this.blocked += 1;
      this.blockedSequence += 1;
      return;
    }

    await this.session.send('Fetch.continueRequest', { requestId });
    this.continued += 1;
  }
}
