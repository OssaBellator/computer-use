import assert from 'node:assert/strict';
import test from 'node:test';

import * as packageApi from '../src/index.js';

const DEFERRED_COMPUTER_EXPORT_CANARIES = [
  // Concrete host/backend adapters remain internal implementation seams.
  'FilesystemComputerEnvironmentAdapter',
  'FilesystemAdapterError',
  'HostTerminalAdapter',
  'TERMINAL_COMMAND_CLASSIFICATIONS',
  'RemoteDispatchError',
  'REMOTE_PROTOCOL_KINDS',

  // Realtime surface contracts remain behind an experimental/internal boundary.
  'REALTIME_INPUT_KINDS',
  'RealtimeSurfaceError',
  'RealtimeInputDispatchError',
] as const;

test('package root does not accidentally export deferred computer implementation modules', () => {
  for (const name of DEFERRED_COMPUTER_EXPORT_CANARIES) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(packageApi, name),
      false,
      `${name} must remain outside the intentional package-root surface`,
    );
  }
});
