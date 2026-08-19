import type { CdpSessionLike } from './cdpIdentity.js';

export type BrowserDialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

export interface BrowserDialogState {
  open: true;
  type: BrowserDialogType;
  /** Monotonic local sequence for progress detection without retaining page-provided text. */
  sequence: number;
}

export type BrowserDialogHandleStatus = 'handled' | 'no-dialog' | 'protocol-error';

export interface BrowserDialogHandleResult {
  status: BrowserDialogHandleStatus;
  accepted: boolean;
  type?: BrowserDialogType;
  sequence?: number;
  errorText?: string;
}

export interface CdpEventSessionLike extends CdpSessionLike {
  on(event: string, listener: (params: any) => void): unknown;
  off?(event: string, listener: (params: any) => void): unknown;
}

export interface BrowserDialogController {
  start(): Promise<void>;
  state(): BrowserDialogState | undefined;
  handle(accept: boolean, promptText?: string): Promise<BrowserDialogHandleResult>;
  dispose?(): void;
}

export function isCdpEventSessionLike(session: CdpSessionLike): session is CdpEventSessionLike {
  return typeof (session as Partial<CdpEventSessionLike>).on === 'function';
}

function isDialogType(value: unknown): value is BrowserDialogType {
  return value === 'alert' || value === 'confirm' || value === 'prompt' || value === 'beforeunload';
}

/**
 * Event-backed JavaScript dialog monitor/handler. Deliberately discards dialog
 * message/defaultPrompt text so untrusted page prose is not promoted into task state.
 */
export class CdpDialogController implements BrowserDialogController {
  private current?: BrowserDialogState;
  private sequence = 0;
  private started = false;

  private readonly onOpening = (params: any) => {
    if (!isDialogType(params?.type)) return;
    this.sequence += 1;
    this.current = { open: true, type: params.type, sequence: this.sequence };
  };

  private readonly onClosed = () => {
    this.current = undefined;
  };

  constructor(private readonly session: CdpEventSessionLike) {
    this.session.on('Page.javascriptDialogOpening', this.onOpening);
    this.session.on('Page.javascriptDialogClosed', this.onClosed);
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.session.send('Page.enable');
    this.started = true;
  }

  state(): BrowserDialogState | undefined {
    return this.current ? { ...this.current } : undefined;
  }

  async handle(accept: boolean, promptText?: string): Promise<BrowserDialogHandleResult> {
    const dialog = this.current;
    if (!dialog) return { status: 'no-dialog', accepted: accept };
    try {
      await this.session.send('Page.handleJavaScriptDialog', {
        accept,
        ...(accept && promptText !== undefined ? { promptText } : {}),
      });
      // Some CDP wrappers may deliver javascriptDialogClosed after send() resolves;
      // clear optimistically while preserving the sequence in the result.
      this.current = undefined;
      return {
        status: 'handled',
        accepted: accept,
        type: dialog.type,
        sequence: dialog.sequence,
      };
    } catch (error) {
      return {
        status: 'protocol-error',
        accepted: accept,
        type: dialog.type,
        sequence: dialog.sequence,
        errorText: error instanceof Error ? error.message : String(error),
      };
    }
  }

  dispose(): void {
    this.session.off?.('Page.javascriptDialogOpening', this.onOpening);
    this.session.off?.('Page.javascriptDialogClosed', this.onClosed);
    this.current = undefined;
  }
}
