import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import { FilesystemComputerEnvironmentAdapter } from '../src/computer/filesystemAdapter.js';
import {
  LOCAL_COMPUTE_CAPABILITY,
  LocalComputeAdapter,
  localComputeJobEntity,
  type LocalComputeJson,
} from '../src/computer/localComputeAdapter.js';
import { HostProcessAdapter, ProcessIdentityStore } from '../src/computer/processAdapter.js';
import { HostTerminalAdapter } from '../src/computer/terminalAdapter.js';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '33333333333333333333333333333333';

test('temporary filesystem read composes with real local compute through one runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'computer-cross-local-'));
  try {
    await writeFile(join(root, 'input.txt'), 'local fixture only');
    const filesystem = new FilesystemComputerEnvironmentAdapter({ adapterId: 'filesystem:local-integration', rootPath: root });
    const file = await filesystem.resolvePath('input.txt');
    const compute = new LocalComputeAdapter({
      id: 'compute:local-integration',
      operations: [{
        id: 'fixture.add',
        effect: 'pure-read-only',
        execute(input: LocalComputeJson) {
          const value = input as { a: number; b: number };
          return { sum: value.a + value.b };
        },
      }],
    });
    const registry = new ComputerEnvironmentRegistry();
    registry.register(filesystem);
    registry.register(compute);

    const program: ComputerTaskProgram = {
      id: 'real-filesystem-compute-composition',
      entry: 'read',
      steps: [
        {
          kind: 'action',
          id: 'read',
          request: {
            adapterId: filesystem.descriptor.id,
            actionId: 'read',
            capability: 'filesystem.read',
            effect: 'observe-only',
            idempotency: 'read-only',
            target: file,
            payload: { maxBytes: 64 },
          },
          target: { entity: file },
          checkpointBinding: 'filesystem-read-max-64-v1',
          onSuccess: 'compute',
        },
        {
          kind: 'action',
          id: 'compute',
          request: {
            adapterId: compute.descriptor.id,
            actionId: 'compute',
            capability: LOCAL_COMPUTE_CAPABILITY,
            effect: 'observe-only',
            idempotency: 'read-only',
            payload: {
              job: { jobId: 'fixture-sum', generation: 0 },
              operation: 'fixture.add',
              input: { a: 20, b: 22 },
            },
          },
          checkpointBinding: 'fixture-sum-20-22-v1',
        },
      ],
    };

    const result = await new ComputerTaskRuntime(program, registry, { executionId: EXECUTION_ID }).run();
    assert.equal(result.status, 'completed');

    const observed = await compute.observe({
      adapterId: compute.descriptor.id,
      channel: 'compute',
      target: localComputeJobEntity(compute.descriptor.id, { jobId: 'fixture-sum', generation: 0 }),
    });
    assert.equal(JSON.stringify(observed).includes('local fixture only'), false);
    assert.equal((observed.data as { executionState?: string } | null)?.executionState, 'completed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real local process observation composes with harmless bounded terminal argv execution', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'computer-cross-terminal-'));
  try {
    const identities = new ProcessIdentityStore('process:local-integration');
    const processAdapter = new HostProcessAdapter(identities);
    const terminal = new HostTerminalAdapter('terminal:local-integration', identities);
    const registry = new ComputerEnvironmentRegistry();
    registry.register(processAdapter);
    registry.register(terminal);

    const program: ComputerTaskProgram = {
      id: 'real-process-terminal-composition',
      entry: 'processes',
      steps: [
        {
          kind: 'observe',
          id: 'processes',
          request: {
            adapterId: processAdapter.descriptor.id,
            channel: 'process',
            limits: { maxItems: 4, maxTextBytes: 512 },
          },
          next: 'execute',
        },
        {
          kind: 'action',
          id: 'execute',
          request: {
            adapterId: terminal.descriptor.id,
            actionId: 'execute',
            capability: 'terminal.execute.argv',
            effect: 'security-sensitive',
            idempotency: 'non-idempotent',
            payload: {
              mode: 'argv',
              executable: process.execPath,
              argv: ['-e', 'process.stdout.write("cross-adapter-ok")'],
              cwd,
              timeoutMs: 2000,
              maxOutputBytes: 64,
              classification: 'local-compute',
            },
          },
          checkpointBinding: 'local-node-cross-adapter-ok-v1',
          verification: 'local-terminal-fixture',
        },
      ],
    };

    let approvals = 0;
    let verifications = 0;
    const result = await new ComputerTaskRuntime(program, registry, {
      executionId: EXECUTION_ID,
      hooks: {
        approve: async () => { approvals += 1; return true; },
        verifiers: {
          'local-terminal-fixture': async ({ adapterResult }) => {
            verifications += 1;
            assert.equal(adapterResult.status, 'completed');
            assert.equal(adapterResult.dispatch, 'dispatched-once');
            return { state: 'verified', evidence: ['local-terminal-fixture-verified'] };
          },
        },
      },
    }).run();

    assert.equal(result.status, 'completed');
    assert.equal(approvals, 1);
    assert.equal(verifications, 1);
    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0]?.adapterId, processAdapter.descriptor.id);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
