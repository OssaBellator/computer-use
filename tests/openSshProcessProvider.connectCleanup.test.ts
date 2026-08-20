import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { stat } from 'node:fs/promises';
import { OpenSshProcessProvider } from '../src/computer/sshRemoteSessionBackend.js';

test('ambiguous initial OpenSSH connect is bounded and removes its control directory', async () => {
  let killCalls = 0;
  let controlPath: string | undefined;
  const processSpawner = ((_: string, argv: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill(): boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { killCalls++; return false; };

    const controlIndex = argv.indexOf('-S');
    if (controlPath === undefined && controlIndex >= 0) controlPath = argv[controlIndex + 1];

    queueMicrotask(() => {
      child.emit('spawn');
      if (argv.includes('-O') && argv.includes('exit')) child.emit('close', 0);
      // Initial `-N -f` connect deliberately never closes.
    });
    return child;
  }) as unknown as typeof spawn;

  const provider = new OpenSshProcessProvider({
    processSpawner,
    connectTimeoutMs: 10,
    commandTimeoutMs: 25,
    cleanupAckTimeoutMs: 10,
  });
  const endpoint = Object.freeze({ endpointId: 'connect-cleanup', protocol: 'ssh' as const, host: 'fixture.invalid', port: 22 });

  const started = Date.now();
  await assert.rejects(() => provider.connect(Object.freeze({ endpoint })), /ssh connect ambiguous/);
  assert.ok(Date.now() - started < 500);
  assert.equal(killCalls, 1);
  assert.equal(typeof controlPath, 'string');

  const controlDirectory = dirname(controlPath as string);
  await assert.rejects(
    () => stat(controlDirectory),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT'),
  );
});
