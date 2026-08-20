import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopUiEnvironmentAdapter, type DesktopSystemObservationData } from '../src/computer/desktopUiAdapter.js';
import { PlatformDesktopUiBackend, type DesktopPlatformKind } from '../src/computer/desktopPlatformBackend.js';
import { ContractCheckedDesktopPlatformBridge } from '../src/computer/nativeDesktopHelperContract.js';
import { StdioDesktopBridgeExecutor } from '../src/computer/nativeDesktopStdioExecutor.js';

function platform(value: string | undefined): DesktopPlatformKind | undefined {
  return value === 'windows-uia' || value === 'macos-accessibility' || value === 'linux-atspi' ? value : undefined;
}

function helperArgs(value: string | undefined): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error('NATIVE_DESKTOP_HELPER_ARGS_JSON must be a JSON string array');
  }
  return [...parsed];
}

test('opt-in native desktop helper observation smoke', async (t) => {
  if (process.env.RUN_NATIVE_DESKTOP_SMOKE !== '1') {
    t.skip('set RUN_NATIVE_DESKTOP_SMOKE=1 with a local trusted native helper');
    return;
  }
  const executable = process.env.NATIVE_DESKTOP_HELPER;
  const expectedPlatform = platform(process.env.NATIVE_DESKTOP_PLATFORM);
  if (!executable || !expectedPlatform) {
    t.skip('NATIVE_DESKTOP_HELPER and NATIVE_DESKTOP_PLATFORM are required');
    return;
  }

  const command = {
    executable,
    args: helperArgs(process.env.NATIVE_DESKTOP_HELPER_ARGS_JSON),
    maxRequestBytes: 65_536,
    maxResponseBytes: 1_000_000,
    timeoutMs: 5_000,
    supportsRelativePointer: process.env.NATIVE_DESKTOP_RELATIVE_POINTER === '1',
  };
  const executor = new StdioDesktopBridgeExecutor(command);
  const bridge = new ContractCheckedDesktopPlatformBridge(
    `host-smoke:${expectedPlatform}`,
    expectedPlatform,
    executor,
    { supportsRelativePointer: command.supportsRelativePointer, maxResponseBytes: command.maxResponseBytes, timeoutMs: command.timeoutMs },
  );
  const backend = new PlatformDesktopUiBackend(bridge);
  const adapter = new DesktopUiEnvironmentAdapter(backend, `desktop-host-smoke:${expectedPlatform}`);

  const systemEnvelope = await adapter.observe({
    adapterId: adapter.descriptor.id,
    channel: 'system',
    limits: { maxItems: 16, maxTextBytes: 8_192, maxDepth: 2 },
  });
  assert.equal(systemEnvelope.environment, 'desktop-ui');
  const system = systemEnvelope.data as DesktopSystemObservationData;
  assert.ok(system.windows.length <= 16);
  if (system.windows.length === 0) {
    t.skip('native helper reported no desktop windows in the current session');
    return;
  }

  const first = system.windows[0]!;
  const semantic = await adapter.observe({
    adapterId: adapter.descriptor.id,
    channel: 'semantic-ui',
    surface: first.surface,
    limits: { maxItems: 32, maxTextBytes: 8_192, maxDepth: 4 },
  });
  assert.equal(semantic.surface?.surfaceId, first.surface.surfaceId);
  assert.equal(semantic.surface?.generation, first.surface.generation);

  const visual = await adapter.observe({
    adapterId: adapter.descriptor.id,
    channel: 'visual',
    surface: first.surface,
    limits: { maxItems: 256, maxTextBytes: 1_000_000, maxDepth: 1 },
  });
  assert.equal(visual.surface?.surfaceId, first.surface.surfaceId);
  assert.equal(visual.surface?.generation, first.surface.generation);

  // Intentionally no adapter.act() call here. Host smoke remains observation-only.
  assert.equal(adapter.descriptor.capabilities.includes('desktop.keyboard'), true);
});
