import type { WindowsProcessGeneration } from './windowsUiaContract.js';
import type { WindowsInputIntegrityContext, WindowsIntegrityLevel } from './windowsInputIntegrity.js';

export const WINDOWS_MANDATORY_INTEGRITY_RIDS = Object.freeze({
  untrusted:0x0000,
  low:0x1000,
  medium:0x2000,
  mediumPlus:0x2100,
  high:0x3000,
  system:0x4000,
  protected:0x5000,
} as const);

export interface WindowsProcessTokenIntegrityReader {
  /** Read TokenIntegrityLevel for the current process token. */
  currentProcessIntegrityRid():Promise<number>;
  /**
   * Read TokenIntegrityLevel for the exact generation-bearing target process.
   * Native implementations must verify the process start identity before and
   * after token acquisition so PID reuse cannot redirect authority.
   */
  processIntegrityRid(process:WindowsProcessGeneration):Promise<number>;
}

export function classifyWindowsIntegrityRid(rid:number):WindowsIntegrityLevel|undefined {
  if (!Number.isSafeInteger(rid) || rid < 0) return undefined;
  switch (rid) {
    case WINDOWS_MANDATORY_INTEGRITY_RIDS.untrusted:return 'untrusted';
    case WINDOWS_MANDATORY_INTEGRITY_RIDS.low:return 'low';
    case WINDOWS_MANDATORY_INTEGRITY_RIDS.medium:return 'medium';
    case WINDOWS_MANDATORY_INTEGRITY_RIDS.mediumPlus:return 'medium-plus';
    case WINDOWS_MANDATORY_INTEGRITY_RIDS.high:return 'high';
    case WINDOWS_MANDATORY_INTEGRITY_RIDS.system:return 'system';
    case WINDOWS_MANDATORY_INTEGRITY_RIDS.protected:return 'protected';
    default:return undefined;
  }
}

/**
 * Resolves the caller/target integrity context directly before native input.
 * Any token-read failure, PID-generation mismatch, or noncanonical RID leaves
 * the corresponding side unknown; the UIPI gate then fails closed.
 */
export async function resolveWindowsInputIntegrityContext(
  reader:WindowsProcessTokenIntegrityReader,
  target:WindowsProcessGeneration,
):Promise<WindowsInputIntegrityContext> {
  const [caller,targetRid] = await Promise.allSettled([
    reader.currentProcessIntegrityRid(),
    reader.processIntegrityRid(target),
  ]);
  return Object.freeze({
    ...(caller.status === 'fulfilled' ? {caller:classifyWindowsIntegrityRid(caller.value)} : {}),
    ...(targetRid.status === 'fulfilled' ? {target:classifyWindowsIntegrityRid(targetRid.value)} : {}),
  });
}
