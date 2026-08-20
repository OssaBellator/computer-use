import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { OpenSshProcessProvider } from '../src/computer/sshRemoteSessionBackend.js';

type CommandBehavior = Readonly<{
  stream: 'stdout' | 'stderr';
  bytes: number;
}>;

function outputSpawner(behavior: CommandBehavior, onKill: () => void): typeof spawn {
  return ((_: string, argv: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill(): boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      onKill();
      queueMicrotask(() => child.emit('close', null));
      return true;
    };
    queueMicrotask(() => {
      child.emit('spawn');
      const control = (argv.includes('-N') && argv.includes('-f')) || (argv.includes('-O') && argv.includes('exit'));
      if (control) {
        child.emit('close', 0);
        return;
      }
      child[behavior.stream].write(Buffer.alloc(behavior.bytes, 0x61));
      if (behavior.bytes <= 32) child.emit('close', 0);
    });
    return child;
  }) as unknown as typeof spawn;
}

async function executeWith(behavior: CommandBehavior) {
  let killCalls = 0;
  const provider = new OpenSshProcessProvider({
    processSpawner: outputSpawner(behavior, () => { killCalls++; }),
    connectTimeoutMs: 100,
    commandTimeoutMs: 100,
    cleanupAckTimeoutMs: 25,
  });
  const endpoint = Object.freeze({ endpointId: 'output-boundary', protocol: 'ssh' as const, host: 'fixture.invalid', port: 22 });
  const session = await provider.connect(Object.freeze({ endpoint }));
  const outcome = await provider.executeArgv(
    session,
    Object.freeze({ command: 'emit-output', args: Object.freeze([]) }),
    Object.freeze({ maxStdoutBytes: 32, maxStderrBytes: 32 }),
  );
  await provider.disconnect(session);
  return { outcome, killCalls };
}

for (const stream of ['stdout', 'stderr'] as const) {
  test(`OpenSSH ${stream} acquisition overrun terminates once and stays dispatch-unknown`, async () => {
    const { outcome, killCalls } = await executeWith({ stream, bytes: 33 });
    assert.equal(outcome.dispatch, 'unknown');
    assert.equal(outcome.status, 'unknown');
    assert.equal(outcome.evidence, 'ssh.output-bound');
    assert.equal(killCalls, 1);
  });
}

test('OpenSSH output exactly at the byte ceiling may complete normally', async () => {
  const { outcome, killCalls } = await executeWith({ stream: 'stdout', bytes: 32 });
  assert.equal(outcome.dispatch, 'dispatched-once');
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.value?.stdout?.length, 32);
  assert.equal(killCalls, 0);
});
