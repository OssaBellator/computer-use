import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenSshProcessProvider } from '../src/computer/sshRemoteSessionBackend.js';

test('OpenSSH provider accepts conservative finite timeout configuration', () => {
  assert.doesNotThrow(() => new OpenSshProcessProvider({ connectTimeoutMs: 1_000, commandTimeoutMs: 5_000 }));
});

test('OpenSSH provider accepts explicit host-key policy without enabling insecure checking', () => {
  assert.doesNotThrow(() => new OpenSshProcessProvider({ strictHostKeyChecking: 'yes' }));
  assert.doesNotThrow(() => new OpenSshProcessProvider({ strictHostKeyChecking: 'accept-new' }));
});
