import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { OpenSshProcessProvider } from '../src/computer/sshRemoteSessionBackend.js';

function ambiguousControlSpawner(onKill: () => void): typeof spawn {
  return ((_: string, argv: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill(): boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { onKill(); return false; };
    queueMicrotask(() => {
      child.emit('spawn');
      if (argv.includes('-N') && argv.includes('-f')) child.emit('close', 0);
      // Control-exit deliberately never closes, even after kill() rejects termination.
    });
    return child;
  }) as unknown as typeof spawn;
}

function providerWithAmbiguousControl(onKill: () => void) {
  return new OpenSshProcessProvider({
    processSpawner: ambiguousControlSpawner(onKill),
    connectTimeoutMs: 10,
    commandTimeoutMs: 25,
    cleanupAckTimeoutMs: 10,
  });
}

const endpoint = Object.freeze({ endpointId: 'lifecycle-ambiguity', protocol: 'ssh' as const, host: 'fixture.invalid', port: 22 });

test('disconnect ambiguity is bounded and consumes provider ownership before reporting failure', async () => {
  let killCalls = 0;
  const provider = providerWithAmbiguousControl(() => { killCalls++; });
  const session = await provider.connect(Object.freeze({ endpoint }));

  const started = Date.now();
  await assert.rejects(() => provider.disconnect(session), /ssh disconnect ambiguous/);
  assert.ok(Date.now() - started < 500);
  assert.equal(killCalls, 1);

  await assert.rejects(() => provider.disconnect(session), /unknown openssh session/);
});

test('failed-connect cleanup ambiguity is bounded and consumes exact candidate ownership', async () => {
  let killCalls = 0;
  const provider = providerWithAmbiguousControl(() => { killCalls++; });
  const session = await provider.connect(Object.freeze({ endpoint }));

  const started = Date.now();
  await assert.rejects(() => provider.cleanupFailedConnect(session), /ssh failed-connect cleanup ambiguous/);
  assert.ok(Date.now() - started < 500);
  assert.equal(killCalls, 1);

  const outcome = await provider.executeArgv(
    session,
    Object.freeze({ command: 'must-not-run', args: Object.freeze([]) }),
    Object.freeze({ maxStdoutBytes: 32, maxStderrBytes: 32 }),
  );
  assert.deepEqual(outcome, { dispatch: 'not-dispatched', status: 'failed', evidence: 'ssh.session-not-owned' });
});
