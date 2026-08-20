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

function ownData(value: object, key: string): unknown {
  let property:PropertyDescriptor|undefined;
  try { property = Object.getOwnPropertyDescriptor(value, key); }
  catch { throw new Error('native desktop helper descriptor malformed'); }
  if (!property || !('value' in property) || property.get !== undefined || property.set !== undefined || !property.enumerable) {
    throw new Error('native desktop helper descriptor malformed');
  }
  return property.value;
}

function descriptorObject(value: unknown): object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('native desktop helper descriptor malformed');
  return value;
}

function capturedArray(value: unknown, maxItems: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('native desktop helper descriptor malformed');
  let lengthProperty:PropertyDescriptor|undefined;
  try { lengthProperty = Object.getOwnPropertyDescriptor(value, 'length'); }
  catch { throw new Error('native desktop helper descriptor malformed'); }
  if (!lengthProperty || !('value' in lengthProperty) || !Number.isSafeInteger(lengthProperty.value) || lengthProperty.value < 0 || lengthProperty.value > maxItems) {
    throw new Error('native desktop helper descriptor malformed');
  }
  const length = lengthProperty.value as number;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let property:PropertyDescriptor|undefined;
    try { property = Object.getOwnPropertyDescriptor(value, String(index)); }
    catch { throw new Error('native desktop helper descriptor malformed'); }
    if (!property || !('value' in property) || property.get !== undefined || property.set !== undefined || !property.enumerable) {
      throw new Error('native desktop helper descriptor malformed');
    }
    result.push(property.value);
  }
  return Object.freeze(result);
}

function descriptor(value: unknown): NativeDesktopHelperDescriptor {
  const object = descriptorObject(value);
  const protocolVersion = ownData(object, 'protocolVersion');
  const platform = ownData(object, 'platform');
  const operations = capturedArray(ownData(object, 'operations'), HELPER_OPERATIONS.length);
  const capabilities = capturedArray(ownData(object, 'capabilities'), 1);

  if (protocolVersion !== 1 ||
      (platform !== 'windows-uia' && platform !== 'macos-accessibility' && platform !== 'linux-atspi')) {
    throw new Error('native desktop helper descriptor malformed');
  }
  if (operations.length !== new Set(operations).size || operations.some((operation) => !HELPER_OPERATIONS.includes(operation as HelperOperation))) {
    throw new Error('native desktop helper operations malformed');
  }
  if (capabilities.some((capability) => capability !== 'relative-pointer')) {
    throw new Error('native desktop helper capabilities malformed');
  }
  return Object.freeze({
    protocolVersion: 1,
    platform,
    operations: Object.freeze([...operations] as HelperOperation[]),
    capabilities: Object.freeze([...capabilities] as ('relative-pointer')[]),
  });
}

/**
 * Adds an observation-only helper contract gate in front of the normal native
 * JSON bridge. `describe` itself must never emit OS input. A failed/mismatched
 * description blocks the actual desktop operation.
 *
 * Only the four authority-bearing descriptor fields and bounded array indices
 * are acquired. Unknown provider-owned fields/symbols are ignored because they
 * confer no authority; this avoids unbounded own-key enumeration.
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
