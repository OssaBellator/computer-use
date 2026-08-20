import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import {
  OpenSshProcessProvider,
  type SshProviderConnectRequest,
} from '../src/computer/sshRemoteSessionBackend.js';

const endpoint = Object.freeze({ endpointId: 'ssh-timeout-fixture', protocol: 'ssh' as const, host: 'fixture.invalid', port: 22 });

function syntheticSpawner(onKill: () => void): typeof spawn {
  return ((_: string, argv: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill(signal?: NodeJS.Signals | number): boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { onKill(); return false; };

    queueMicrotask(() => {
      child.emit('spawn');
      const isConnect = argv.includes('-N') && argv.includes('-f');
      const isControlExit = argv.includes('-O') && argv.includes('exit');
      if (isConnect || isControlExit) child.emit('close', 0);
      // Command execution deliberately never closes, even after kill() rejects termination.
    });
    return child;
  }) as unknown as typeof spawn;
}

test('spawned command with failed kill and no close resolves within cleanup hard ceiling as unknown', async () => {
  let killCalls = 0;
  const provider = new OpenSshProcessProvider({
    processSpawner: syntheticSpawner(() => { killCalls++; }),
    connectTimeoutMs: 25,
    commandTimeoutMs: 10,
    cleanupAckTimeoutMs: 10,
  });
  const request: SshProviderConnectRequest = Object.freeze({ endpoint });
  const session = await provider.connect(request);

  const started = Date.now();
  const outcome = await provider.executeArgv(
    session,
    Object.freeze({ command: 'do-once', args: Object.freeze([]) }),
    Object.freeze({ maxStdoutBytes: 32, maxStderrBytes: 32 }),
  );
  const elapsed = Date.now() - started;

  assert.equal(outcome.dispatch, 'unknown');
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.evidence, 'ssh.command-timeout');
  assert.equal(killCalls, 1);
  assert.ok(elapsed < 500, `bounded timeout path took ${elapsed}ms`);

  await provider.disconnect(session);
});
