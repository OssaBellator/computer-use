import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenSshProcessProvider } from '../src/computer/sshRemoteSessionBackend.js';

test('OpenSSH provider accepts conservative finite timeout configuration', () => {
  assert.doesNotThrow(() => new OpenSshProcessProvider({ connectTimeoutMs: 1_000, commandTimeoutMs: 5_000, cleanupAckTimeoutMs: 250 }));
});

test('OpenSSH provider rejects non-finite, fractional, zero, negative, and excessive process timeouts', () => {
  const invalid = [0, -1, 1.5, 300_001, Number.NaN, Number.POSITIVE_INFINITY];
  for (const value of invalid) {
    assert.throws(() => new OpenSshProcessProvider({ connectTimeoutMs: value }), /invalid ssh process timeout/);
    assert.throws(() => new OpenSshProcessProvider({ commandTimeoutMs: value }), /invalid ssh process timeout/);
  }
});

test('OpenSSH provider bounds cleanup acknowledgement timeout independently', () => {
  for (const value of [0, -1, 1.5, 5_001, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new OpenSshProcessProvider({ cleanupAckTimeoutMs: value }), /invalid ssh process timeout/);
  }
  assert.doesNotThrow(() => new OpenSshProcessProvider({ cleanupAckTimeoutMs: 5_000 }));
});

test('OpenSSH provider accepts explicit host-key policy without enabling insecure checking', () => {
  assert.doesNotThrow(() => new OpenSshProcessProvider({ strictHostKeyChecking: 'yes' }));
  assert.doesNotThrow(() => new OpenSshProcessProvider({ strictHostKeyChecking: 'accept-new' }));
});
