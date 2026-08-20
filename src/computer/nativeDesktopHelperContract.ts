import type { ComputerEffectClass, ComputerObservationLimits } from './environmentAdapter.js';
import type { DesktopBackendActionResult, DesktopVisualAcquisitionLimits } from './desktopUiBackend.js';
import {
  NativeJsonDesktopPlatformBridge,
  type DesktopBridgeExecutor,
} from './nativeDesktopJsonBridge.js';
import type {
  DesktopPlatformBridge,
  DesktopPlatformKind,
  PlatformDesktopAccessibilityObservation,
  PlatformDesktopDispatch,
  PlatformDesktopVisualObservation,
  PlatformDesktopWindow,
} from './desktopPlatformBackend.js';

const HELPER_OPERATIONS = ['enumerate-windows', 'accessibility', 'visual', 'dispatch'] as const;
type HelperOperation = typeof HELPER_OPERATIONS[number];

export interface NativeDesktopHelperDescriptor {
  protocolVersion: 1;
  platform: DesktopPlatformKind;
  operations: readonly HelperOperation[];
  capabilities: readonly ('relative-pointer')[];
}

function descriptor(value: unknown): NativeDesktopHelperDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('native desktop helper descriptor malformed');
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['protocolVersion', 'platform', 'operations', 'capabilities'].includes(key))) {
    throw new Error('native desktop helper descriptor malformed');
  }
  if (raw.protocolVersion !== 1 ||
      (raw.platform !== 'windows-uia' && raw.platform !== 'macos-accessibility' && raw.platform !== 'linux-atspi') ||
      !Array.isArray(raw.operations) || !Array.isArray(raw.capabilities)) {
    throw new Error('native desktop helper descriptor malformed');
  }
  const operations = raw.operations as unknown[];
  if (operations.length !== new Set(operations).size || operations.some((operation) => !HELPER_OPERATIONS.includes(operation as HelperOperation))) {
    throw new Error('native desktop helper operations malformed');
  }
  const capabilities = raw.capabilities as unknown[];
  if (capabilities.length > 1 || capabilities.some((capability) => capability !== 'relative-pointer')) {
    throw new Error('native desktop helper capabilities malformed');
  }
  return Object.freeze({
    protocolVersion: 1,
    platform: raw.platform,
    operations: Object.freeze([...operations] as HelperOperation[]),
    capabilities: Object.freeze([...capabilities] as ('relative-pointer')[]),
  });
}

/**
 * Adds an observation-only helper contract gate in front of the normal native
 * JSON bridge. `describe` itself must never emit OS input. A failed/mismatched
 * description blocks the actual desktop operation.
 *
 * This is protocol/configuration conformance, not executable-file identity. A
 * native helper must still atomically revalidate target instance tokens inside
 * its dispatch operation immediately before native input emission.
 */
export class ContractCheckedDesktopPlatformBridge implements DesktopPlatformBridge {
  readonly id: string;
  readonly platform: DesktopPlatformKind;
  readonly supportsRelativePointer: boolean;
  private readonly delegate: NativeJsonDesktopPlatformBridge;

  constructor(
    id: string,
    platform: DesktopPlatformKind,
    private readonly executor: DesktopBridgeExecutor,
    options?: { supportsRelativePointer?: boolean; maxResponseBytes?: number; timeoutMs?: number },
  ) {
    this.id = id;
    this.platform = platform;
    this.supportsRelativePointer = options?.supportsRelativePointer === true;
    this.delegate = new NativeJsonDesktopPlatformBridge(id, platform, executor, options);
  }

  private async check(required: HelperOperation, relativePointer = false): Promise<void> {
    const raw = await this.executor.invoke('describe', {}, { maxResponseBytes: 8_192, timeoutMs: 2_000 });
    const helper = descriptor(raw);
    if (helper.platform !== this.platform || !helper.operations.includes(required)) {
      throw new Error('native desktop helper contract mismatch');
    }
    const helperRelative = helper.capabilities.includes('relative-pointer');
    if (this.supportsRelativePointer !== helperRelative || (relativePointer && !helperRelative)) {
      throw new Error('native desktop helper capability mismatch');
    }
  }

  async enumerateWindows(limits: Required<ComputerObservationLimits>) {
    await this.check('enumerate-windows');
    return this.delegate.enumerateWindows(limits);
  }

  async accessibility(window: PlatformDesktopWindow, limits: Required<ComputerObservationLimits>): Promise<PlatformDesktopAccessibilityObservation> {
    await this.check('accessibility');
    return this.delegate.accessibility(window, limits);
  }

  async visual(window: PlatformDesktopWindow, limits: DesktopVisualAcquisitionLimits): Promise<PlatformDesktopVisualObservation> {
    await this.check('visual');
    return this.delegate.visual(window, limits);
  }

  async dispatch(action: PlatformDesktopDispatch, effect: ComputerEffectClass): Promise<DesktopBackendActionResult> {
    try {
      await this.check('dispatch', action.kind === 'pointer-relative');
    } catch {
      return Object.freeze({
        status: 'rejected',
        dispatched: false,
        verified: false,
        evidence: Object.freeze(['native-helper-contract-mismatch']),
      });
    }
    return this.delegate.dispatch(action, effect);
  }
}
