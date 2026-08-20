import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { OpenSshProcessProvider } from '../src/computer/sshRemoteSessionBackend.js';

interface SpawnCall {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly options: Readonly<Record<string, unknown>>;
}

function recordingSpawner(calls: SpawnCall[]): typeof spawn {
  return ((executable: string, argv: readonly string[], options: Readonly<Record<string, unknown>>) => {
    calls.push({ executable, argv: [...argv], options });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill(): boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.emit('spawn');
      child.emit('close', 0);
    });
    return child;
  }) as unknown as typeof spawn;
}

test('OpenSSH process provider keeps executable and argv explicit with local shell disabled', async () => {
  const calls: SpawnCall[] = [];
  const provider = new OpenSshProcessProvider({
    executable: '/controlled/bin/ssh',
    processSpawner: recordingSpawner(calls),
    connectTimeoutMs: 100,
    commandTimeoutMs: 100,
    cleanupAckTimeoutMs: 25,
    strictHostKeyChecking: 'yes',
  });
  const endpoint = Object.freeze({
    endpointId: 'argv-boundary',
    protocol: 'ssh' as const,
    host: 'fixture.invalid',
    port: 22,
  });
  const session = await provider.connect(Object.freeze({ endpoint }));
  const remoteOnly = '$(printf local-shell-must-not-run); value with spaces';
  const outcome = await provider.executeArgv(
    session,
    Object.freeze({ command: 'printf', args: Object.freeze(['%s', remoteOnly, "single'quote"]) }),
    Object.freeze({ maxStdoutBytes: 64, maxStderrBytes: 64 }),
  );
  await provider.disconnect(session);

  assert.equal(outcome.dispatch, 'dispatched-once');
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.executable, '/controlled/bin/ssh');
    assert.equal(call.options.shell, false);
    assert.ok(Array.isArray(call.argv));
  }

  const commandCall = calls[1];
  assert.equal(commandCall.argv.includes('fixture.invalid'), true);
  assert.equal(commandCall.argv.includes(remoteOnly), false);
  const remoteCommand = commandCall.argv.at(-1);
  assert.equal(typeof remoteCommand, 'string');
  assert.match(remoteCommand ?? '', /^'printf' '%s' /);
  assert.equal(remoteCommand?.includes("'$(printf local-shell-must-not-run); value with spaces'"), true);
  assert.equal(remoteCommand?.includes("'single'\\''quote'"), true);
});
