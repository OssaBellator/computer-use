import { CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE } from '../capabilities/standaloneChromiumCapabilities.js';
import {
  COMPUTER_CAPABILITIES,
  computerCapabilityState,
  type ComputerCapability,
  type ComputerCapabilityProfile,
} from './computerCapabilities.js';
import { computerProfileFromBrowserProfile } from './browserCapabilityBridge.js';

/**
 * Computer-use implementation status is intentionally richer than the historical
 * browser three-state support projection. These values describe what exists in
 * source today, not roadmap intent.
 */
export const COMPUTER_CAPABILITY_IMPLEMENTATION_STATUSES = [
  'implemented',
  'implemented-foundation',
  'backend-required',
  'partial',
  'unsupported',
] as const;

export type ComputerCapabilityImplementationStatus =
  typeof COMPUTER_CAPABILITY_IMPLEMENTATION_STATUSES[number];

export const COMPUTER_CAPABILITY_SCOPES = [
  'browser',
  'desktop-ui',
  'filesystem',
  'process',
  'terminal',
  'remote-session',
  'system-device',
  'local-compute',
  'realtime-media-game',
  'document-model',
  'computer-task-runtime',
] as const;

export type ComputerCapabilityScope = typeof COMPUTER_CAPABILITY_SCOPES[number];

export interface ComputerCapabilityImplementationState {
  status: ComputerCapabilityImplementationStatus;
  scopes: readonly ComputerCapabilityScope[];
  note?: string;
}

export interface ComputerUseCapabilityProfile {
  id: string;
  version: string;
  kind: 'component' | 'composition';
  capabilities: Readonly<Partial<Record<ComputerCapability, ComputerCapabilityImplementationState>>>;
}

export const HIGH_RISK_COMPUTER_CAPABILITIES = [
  'file-delete',
  'storage-partitioning',
  'process-control',
  'software-installation',
  'system-settings',
  'security-settings',
  'device-settings',
  'hardware-device-control',
] as const satisfies readonly ComputerCapability[];

const STATUS_RANK: Readonly<Record<ComputerCapabilityImplementationStatus, number>> = {
  unsupported: 0,
  'backend-required': 1,
  'implemented-foundation': 2,
  partial: 3,
  implemented: 4,
};

function state(
  status: ComputerCapabilityImplementationStatus,
  scope: ComputerCapabilityScope,
  note?: string,
): ComputerCapabilityImplementationState {
  return Object.freeze({
    status,
    scopes: Object.freeze([scope]),
    ...(note ? { note } : {}),
  });
}

export function computerCapabilityImplementationState(
  profile: ComputerUseCapabilityProfile,
  capability: ComputerCapability,
): ComputerCapabilityImplementationState {
  return profile.capabilities[capability] ?? Object.freeze({
    status: 'unsupported',
    scopes: Object.freeze([]),
    note: 'not provided by this capability profile',
  });
}

export function validateComputerUseCapabilityProfile(
  profile: ComputerUseCapabilityProfile,
  options: { requireComplete?: boolean; requireExplicitHighRisk?: boolean } = {},
): readonly string[] {
  const errors: string[] = [];
  if (!profile.id.trim()) errors.push('profile.id.empty');
  if (!/^\d+\.\d+(?:\.\d+)?$/u.test(profile.version)) errors.push('profile.version.invalid');

  for (const [capability, raw] of Object.entries(profile.capabilities)) {
    if (!COMPUTER_CAPABILITIES.includes(capability as ComputerCapability)) {
      errors.push(`capability.unknown:${capability}`);
      continue;
    }
    if (!raw || !COMPUTER_CAPABILITY_IMPLEMENTATION_STATUSES.includes(raw.status)) {
      errors.push(`capability.status.invalid:${capability}`);
      continue;
    }
    if (raw.scopes.length < 1) errors.push(`capability.scope.empty:${capability}`);
    for (const scope of raw.scopes) {
      if (!COMPUTER_CAPABILITY_SCOPES.includes(scope)) errors.push(`capability.scope.invalid:${capability}`);
    }
  }

  if (options.requireComplete) {
    for (const capability of COMPUTER_CAPABILITIES) {
      if (!Object.prototype.hasOwnProperty.call(profile.capabilities, capability)) {
        errors.push(`capability.missing:${capability}`);
      }
    }
  }
  if (options.requireExplicitHighRisk) {
    for (const capability of HIGH_RISK_COMPUTER_CAPABILITIES) {
      if (!Object.prototype.hasOwnProperty.call(profile.capabilities, capability)) {
        errors.push(`high-risk-capability.not-explicit:${capability}`);
      }
    }
  }
  return Object.freeze(errors);
}

function legacyProfileToImplementationProfile(
  profile: ComputerCapabilityProfile,
  id: string,
  scope: ComputerCapabilityScope,
): ComputerUseCapabilityProfile {
  const capabilities: Partial<Record<ComputerCapability, ComputerCapabilityImplementationState>> = {};
  for (const capability of COMPUTER_CAPABILITIES) {
    const legacy = computerCapabilityState(profile, capability);
    const status: ComputerCapabilityImplementationStatus = legacy.support === 'supported'
      ? 'implemented'
      : legacy.support === 'partial'
        ? 'partial'
        : 'unsupported';
    capabilities[capability] = state(status, scope, legacy.note);
  }
  return Object.freeze({ id, version: '0.43', kind: 'component', capabilities: Object.freeze(capabilities) });
}

/** Historical browser 0.43 is projected; its source profile is not rewritten. */
export const BROWSER_043_COMPUTER_CAPABILITY_PROFILE = legacyProfileToImplementationProfile(
  computerProfileFromBrowserProfile(CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE),
  'computer-browser-projection-0.43',
  'browser',
);

export const COMPUTER_TASK_RUNTIME_CAPABILITY_PROFILE: ComputerUseCapabilityProfile = Object.freeze({
  id: 'computer-task-runtime-0.2',
  version: '0.2',
  kind: 'component',
  capabilities: Object.freeze({
    'adapter-routing': state('implemented', 'computer-task-runtime', 'ComputerEnvironmentRegistry performs explicit adapter routing and identity checks'),
    'task-checkpointing': state('implemented', 'computer-task-runtime', 'ComputerTaskRuntime restores validated execution-bound checkpoints, tracks unresolved dispatch, and emits deterministic checkpoints'),
    'explicit-confirmation-gate': state('implemented', 'computer-task-runtime', 'approval hooks are enforced before dispatch for effects classified as requiring approval'),
    'side-effect-verification': state('partial', 'computer-task-runtime', 'adapter verification state and named verifier hooks are enforced, while domain-specific verification remains external to the neutral runtime'),
  }),
});

export const FILESYSTEM_CAPABILITY_PROFILE: ComputerUseCapabilityProfile = Object.freeze({
  id: 'filesystem-adapter-1.0', version: '1.0', kind: 'component', capabilities: Object.freeze({
    'filesystem-observation': state('implemented', 'filesystem', 'bounded rooted directory/file metadata observation with identity, traversal, symlink, mount-boundary, and race checks'),
    'file-read': state('implemented', 'filesystem', 'bounded UTF-8 file reads are implemented with no-follow identity and race validation'),
    'file-write': state('unsupported', 'filesystem', 'filesystem adapter exposes observation/read only; no write action is advertised'),
    'file-move-copy': state('unsupported', 'filesystem', 'no filesystem mutation capability is advertised'),
    'file-delete': state('unsupported', 'filesystem', 'destructive filesystem mutation is not implemented'),
    'archive-compression': state('unsupported', 'filesystem', 'no archive/compression action is implemented'),
    'backup-restore': state('unsupported', 'filesystem', 'no backup/restore action is implemented'),
    'storage-partitioning': state('unsupported', 'filesystem', 'filesystem observation/read is not storage-device partition control'),
  }),
});

export const PROCESS_CAPABILITY_PROFILE: ComputerUseCapabilityProfile = Object.freeze({
  id: 'process-adapter-1.0', version: '1.0', kind: 'component', capabilities: Object.freeze({
    'process-observation': state('implemented', 'process', 'host process listing/inspection is implemented; Linux uses bounded /proc inspection and other platforms fall back to the current process'),
    'process-launch': state('unsupported', 'process', 'process adapter advertises observe/inspect only; terminal child spawning is not general process lifecycle control'),
    'process-control': state('unsupported', 'process', 'process actions fail closed as process.lifecycle.unsupported'),
  }),
});

export const TERMINAL_CAPABILITY_PROFILE: ComputerUseCapabilityProfile = Object.freeze({
  id: 'terminal-adapter-1.0', version: '1.0', kind: 'component', capabilities: Object.freeze({
    'terminal-execution': state('implemented', 'terminal', 'bounded argv and shell-mode execution bind executable/cwd identity, classify effects, capture bounded output, and preserve dispatch ambiguity'),
    'local-compute': state('unsupported', 'terminal', 'terminal execution is process execution and is not the registered in-process local-compute model'),
    'process-launch': state('unsupported', 'terminal', 'spawned command processes are execution details rather than a general lifecycle API'),
    'process-control': state('unsupported', 'terminal', 'timeout cleanup does not expose general process lifecycle control'),
  }),
});

export const LOCAL_COMPUTE_CAPABILITY_PROFILE: ComputerUseCapabilityProfile = Object.freeze({
  id: 'local-compute-adapter-1.0', version: '1.0', kind: 'component', capabilities: Object.freeze({
    'local-compute': state('implemented', 'local-compute', 'registered operations execute in a trusted in-process cooperative model with bounded JSON/artifact accounting; deadlines and memory are not hard isolation'),
    'model-execution': state('unsupported', 'local-compute', 'no production local ML/model runtime is provided by the generic operation registry'),
    'terminal-execution': state('unsupported', 'local-compute', 'local compute does not expose shell or arbitrary process execution'),
  }),
});

export const DESKTOP_UI_CAPABILITY_PROFILE: ComputerUseCapabilityProfile = Object.freeze({
  id: 'desktop-ui-contract-1.0', version: '1.0', kind: 'component', capabilities: Object.freeze({
    'semantic-ui-observation': state('backend-required', 'desktop-ui', 'neutral accessibility contract and adapter logic exist, but production OS accessibility requires a NativeDesktopUiBackend'),
    'visual-observation': state('backend-required', 'desktop-ui', 'bounded backend-owned visual capture contract exists; production OS capture requires a backend'),
    'pointer-input': state('backend-required', 'desktop-ui', 'neutral absolute pointer contract exists; production OS input requires a backend'),
    'relative-pointer-input': state('backend-required', 'desktop-ui', 'relative pointer support is backend-declared and is not universal production OS support'),
    'keyboard-input': state('backend-required', 'desktop-ui', 'neutral keyboard input contract exists; production OS input requires a backend'),
    'text-input': state('backend-required', 'desktop-ui', 'neutral text input contract exists; production OS input requires a backend'),
  }),
});

export const REMOTE_SESSION_CAPABILITY_PROFILE: ComputerUseCapabilityProfile = Object.freeze({
  id: 'remote-session-contract-1.0', version: '1.0', kind: 'component', capabilities: Object.freeze({
    'network-session': state('backend-required', 'remote-session', 'session identity/lifecycle and bounded observation/dispatch contracts exist, but transport implementations are supplied by RemoteSessionBackend'),
    'remote-desktop': state('backend-required', 'remote-session', 'RDP/VNC protocol kinds and display/input seams exist; no production transport backend is implied'),
    'ssh-session': state('backend-required', 'remote-session', 'SSH command dispatch seam exists; production SSH transport is backend-provided'),
    'side-effect-verification': state('partial', 'remote-session', 'dispatch outcome is tracked, but transport completion does not by itself verify remote application-level effect'),
  }),
});

export const SYSTEM_DEVICE_CAPABILITY_PROFILE: ComputerUseCapabilityProfile = Object.freeze({
  id: 'system-device-contract-1.0', version: '1.0', kind: 'component', capabilities: Object.freeze({
    'system-settings': state('backend-required', 'system-device', 'bounded observation/mutation, approval, ledger, baseline, dispatch and verification contracts exist; production privileged backend is not included'),
    'security-settings': state('backend-required', 'system-device', 'generic security-setting contract exists, while firewall/antivirus/account privileged mutations are mechanically unsupported by the adapter'),
    'device-settings': state('backend-required', 'system-device', 'generic peripheral configuration contract requires a production backend and privilege support'),
    'hardware-device-control': state('backend-required', 'system-device', 'device/peripheral identity and configuration seam exists; direct hardware control is backend/platform dependent'),
    'storage-partitioning': state('unsupported', 'system-device', 'disk partitioning and destructive storage capabilities are explicitly excluded'),
    'software-installation': state('unsupported', 'system-device', 'no software/package installation capability is defined'),
  }),
});

export const DOCUMENT_MODEL_CAPABILITY_PROFILE: ComputerUseCapabilityProfile = Object.freeze({
  id: 'document-model-foundation-1.0', version: '1.0', kind: 'component', capabilities: Object.freeze({
    'document-observation': state('implemented-foundation', 'document-model', 'environment-neutral document identity/observation structures exist, but no production Office/CAD application integration is implied'),
    'selection-observation': state('implemented-foundation', 'document-model', 'semantic selection/caret model foundations exist without a production native editor backend'),
    'document-editing': state('implemented-foundation', 'document-model', 'document intent and verification semantics exist; production native Office/CAD editing integration is not present'),
    'spreadsheet-editing': state('unsupported', 'document-model', 'no production spreadsheet application integration'),
    'presentation-editing': state('unsupported', 'document-model', 'no production presentation application integration'),
    'media-editing': state('unsupported', 'document-model', 'document semantics are not a media-production editor integration'),
  }),
});

export const REALTIME_MEDIA_GAME_CAPABILITY_PROFILE: ComputerUseCapabilityProfile = Object.freeze({
  id: 'realtime-surface-foundation-1.0', version: '1.0', kind: 'component', capabilities: Object.freeze({
    'game-control': state('implemented-foundation', 'realtime-media-game', 'neutral realtime surface identity, control/effect calibration, and tracking foundations exist; arbitrary installed-game control remains backend/input-route dependent'),
    'media-playback': state('implemented-foundation', 'realtime-media-game', 'realtime/media surface foundations exist, while general native media application control is not integrated'),
  }),
});

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function composeComputerUseCapabilityProfiles(
  id: string,
  version: string,
  profiles: readonly ComputerUseCapabilityProfile[],
): ComputerUseCapabilityProfile {
  if (!id.trim()) throw new Error('computer-use capability profile id must be non-empty');
  if (!/^\d+\.\d+(?:\.\d+)?$/u.test(version)) throw new Error('computer-use capability profile version is invalid');
  if (profiles.length < 1) throw new Error('at least one computer-use capability profile is required');

  const capabilities: Partial<Record<ComputerCapability, ComputerCapabilityImplementationState>> = {};
  for (const capability of COMPUTER_CAPABILITIES) {
    let strongest: ComputerCapabilityImplementationStatus = 'unsupported';
    const scopes = new Set<ComputerCapabilityScope>();
    const notes = new Set<string>();
    let explicitlyMentioned = false;

    for (const profile of profiles) {
      const raw = profile.capabilities[capability];
      if (!raw) continue;
      explicitlyMentioned = true;
      if (STATUS_RANK[raw.status] > STATUS_RANK[strongest]) strongest = raw.status;
      for (const scope of raw.scopes) scopes.add(scope);
      if (raw.note) notes.add(`${profile.id}: ${raw.note}`);
    }

    capabilities[capability] = Object.freeze({
      status: strongest,
      scopes: Object.freeze([...scopes].sort(codeUnitCompare)),
      note: explicitlyMentioned
        ? [...notes].sort(codeUnitCompare).join(' | ') || undefined
        : 'no integrated component currently provides this capability',
    });
  }

  return Object.freeze({ id, version, kind: 'composition', capabilities: Object.freeze(capabilities) });
}

/**
 * Current integrated computer-use source profile. It is a composition of the
 * historical browser 0.43 projection plus neutral runtime/adapter foundations;
 * it is intentionally not a replacement meaning for standalone-chromium-0.43.
 */
export const CURRENT_COMPUTER_USE_CAPABILITY_PROFILE = composeComputerUseCapabilityProfiles(
  'computer-use-integrated-1.0',
  '1.0',
  [
    BROWSER_043_COMPUTER_CAPABILITY_PROFILE,
    COMPUTER_TASK_RUNTIME_CAPABILITY_PROFILE,
    FILESYSTEM_CAPABILITY_PROFILE,
    PROCESS_CAPABILITY_PROFILE,
    TERMINAL_CAPABILITY_PROFILE,
    LOCAL_COMPUTE_CAPABILITY_PROFILE,
    DESKTOP_UI_CAPABILITY_PROFILE,
    REMOTE_SESSION_CAPABILITY_PROFILE,
    SYSTEM_DEVICE_CAPABILITY_PROFILE,
    DOCUMENT_MODEL_CAPABILITY_PROFILE,
    REALTIME_MEDIA_GAME_CAPABILITY_PROFILE,
  ],
);