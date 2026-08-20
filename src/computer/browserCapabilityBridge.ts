import type {
  BrowserCapabilityProfile,
  BrowserTaskCapability,
  CapabilityState,
  CapabilitySupport,
} from '../capabilities/webTaskCapabilities.js';
import type {
  ComputerCapability,
  ComputerCapabilityProfile,
  ComputerCapabilityState,
  ComputerCapabilitySupport,
} from './computerCapabilities.js';

function browserState(
  profile: BrowserCapabilityProfile,
  capability: BrowserTaskCapability,
): CapabilityState {
  const value = profile.capabilities[capability];
  if (typeof value === 'string') return { support: value };
  return value ?? { support: 'unsupported' };
}

function support(value: CapabilitySupport): ComputerCapabilitySupport {
  return value;
}

function mapped(
  profile: BrowserCapabilityProfile,
  capability: BrowserTaskCapability,
  note: string,
): ComputerCapabilityState {
  const state = browserState(profile, capability);
  return {
    support: support(state.support),
    note: state.note ? `${note}; browser profile: ${state.note}` : note,
  };
}

function partialIfAvailable(
  profile: BrowserCapabilityProfile,
  capability: BrowserTaskCapability,
  note: string,
): ComputerCapabilityState {
  const state = browserState(profile, capability);
  return {
    support: state.support === 'unsupported' ? 'unsupported' : 'partial',
    note: state.note ? `${note}; browser profile: ${state.note}` : note,
  };
}

function unsupported(note: string): ComputerCapabilityState {
  return { support: 'unsupported', note };
}

/**
 * Project a browser capability profile into the broader computer-use taxonomy.
 * This is deliberately conservative: web file upload is not local filesystem
 * control, page navigation is not remote-desktop/SSH control, and browser game
 * input is not universal OS/game input.
 */
export function computerProfileFromBrowserProfile(
  profile: BrowserCapabilityProfile,
  id = `computer-via-${profile.id}`,
): ComputerCapabilityProfile {
  const capabilities: Partial<Record<ComputerCapability, ComputerCapabilitySupport | ComputerCapabilityState>> = {
    'adapter-routing': unsupported('single browser adapter profile; cross-environment adapter routing is not implemented'),
    'semantic-ui-observation': mapped(profile, 'semantic-interaction-observation', 'browser semantic/interactive UI only'),
    'visual-observation': mapped(profile, 'visual-observation', 'browser viewport/renderer visual observation only'),
    'document-observation': mapped(profile, 'document-content-observation', 'browser document content only'),
    'selection-observation': mapped(profile, 'rich-text-editing', 'browser selection/caret observation is bundled with rich editing'),
    'pointer-input': mapped(profile, 'pointer-input', 'browser pointer input only'),
    'relative-pointer-input': mapped(profile, 'relative-pointer-input', 'browser relative pointer path only'),
    'keyboard-input': mapped(profile, 'keyboard-input', 'browser keyboard input only'),
    'text-input': mapped(profile, 'text-entry', 'browser editable text entry only'),
    'clipboard-read': mapped(profile, 'clipboard-read', 'explicit browser clipboard integration only when the browser profile promotes it'),
    'clipboard-write': mapped(profile, 'clipboard-write', 'explicit browser clipboard integration only when the browser profile promotes it'),
    'drag-drop': mapped(profile, 'drag-drop', 'browser drag/drop only when semantic acceptance and policy integration are promoted'),
    'document-editing': mapped(profile, 'rich-text-editing', 'browser rich-document editing only'),
    'spreadsheet-editing': unsupported('no general native spreadsheet application adapter'),
    'presentation-editing': unsupported('no general native presentation application adapter'),
    'media-editing': unsupported('no local media-production application adapter'),
    'code-development': unsupported('no IDE/build/debug adapter'),
    'local-compute': unsupported('browser JavaScript execution is not a general local-compute adapter'),
    'model-execution': unsupported('no local ML/model execution adapter'),
    'filesystem-observation': unsupported('web file upload/download does not expose the local filesystem graph'),
    'file-read': unsupported('no direct bounded local file read adapter'),
    'file-write': unsupported('no direct bounded local file write adapter'),
    'file-move-copy': unsupported('no local filesystem mutation adapter'),
    'file-delete': unsupported('no local filesystem deletion adapter'),
    'archive-compression': unsupported('no local archive/compression adapter'),
    'backup-restore': unsupported('no backup/restore adapter'),
    'storage-partitioning': unsupported('no storage/partition management adapter'),
    'process-observation': unsupported('browser target observation is not OS process observation'),
    'process-launch': unsupported('Chromium child-process launch is runtime plumbing, not general process launch capability'),
    'process-control': unsupported('no general OS process-control adapter'),
    'terminal-execution': unsupported('no local terminal/shell execution adapter'),
    'software-installation': unsupported('no package/software installation adapter'),
    'system-settings': unsupported('no OS settings adapter'),
    'security-settings': unsupported('no firewall/antivirus/security-policy adapter'),
    'device-settings': unsupported('no peripheral/device settings adapter'),
    'network-session': unsupported('browser network observation is not general network-session control'),
    'remote-desktop': unsupported('no RDP/VNC desktop-session adapter'),
    'ssh-session': unsupported('no SSH session adapter'),
    'communication-control': partialIfAvailable(
      profile,
      'semantic-interaction-observation',
      'browser semantic interaction can operate some web communication UIs, but desktop/VoIP/session state is not generalized',
    ),
    'media-playback': mapped(profile, 'media-playback-control', 'HTML media playback only'),
    'game-control': partialIfAvailable(
      profile,
      'realtime-control',
      'browser realtime/game controls exist, but this does not cover arbitrary locally installed games or OS input routing',
    ),
    'hardware-device-control': unsupported('no direct hardware/VR/peripheral control adapter'),
    'task-checkpointing': mapped(profile, 'long-running-task-checkpointing', 'browser task checkpoint foundation only'),
    'explicit-confirmation-gate': mapped(profile, 'explicit-confirmation-gate', 'browser TaskRuntime approval gate'),
    'side-effect-verification': mapped(profile, 'external-side-effect-verification', 'browser commitment/result verification only'),
  };

  return { id, capabilities };
}
