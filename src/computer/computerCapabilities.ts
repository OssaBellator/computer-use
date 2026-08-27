export const COMPUTER_TASK_CATEGORIES = [
  'document-media-production',
  'data-processing-analytics',
  'file-storage-management',
  'system-administration-security',
  'communication-remote-access',
  'gaming-digital-entertainment',
  'process-automation',
] as const;

export type ComputerTaskCategory = typeof COMPUTER_TASK_CATEGORIES[number];

export interface ComputerTaskCategoryDefinition {
  label: string;
  examples: readonly string[];
}

export const COMPUTER_TASK_CATEGORY_DEFINITIONS: Readonly<Record<ComputerTaskCategory, ComputerTaskCategoryDefinition>> = {
  'document-media-production': {
    label: 'Document Creation & Media Production',
    examples: [
      'office documents, spreadsheets, and presentations',
      'video, audio, graphics, and 3D production',
      'local IDE editing, debugging, and compilation',
    ],
  },
  'data-processing-analytics': {
    label: 'Data Processing & Analytics',
    examples: [
      'calculations, financial models, and statistics',
      'local model execution',
      'CAD and scientific simulation workflows',
    ],
  },
  'file-storage-management': {
    label: 'File & Storage Management',
    examples: [
      'directory organization and compression',
      'backup and restore workflows',
      'drive/storage and synchronization operations',
    ],
  },
  'system-administration-security': {
    label: 'System Administration & Security',
    examples: [
      'OS, display, and peripheral settings',
      'software installation, updates, firewalls, and security scans',
      'terminal diagnostics and resource monitoring',
    ],
  },
  'communication-remote-access': {
    label: 'Communication & Remote Access',
    examples: [
      'desktop messaging and conferencing',
      'VoIP and media-session controls',
      'remote desktop and SSH sessions',
    ],
  },
  'gaming-digital-entertainment': {
    label: 'Gaming & Digital Entertainment',
    examples: [
      'locally installed games and emulators',
      'VR applications',
      'offline high-quality media playback',
    ],
  },
  'process-automation': {
    label: 'Process Automation',
    examples: [
      'shell and batch scripts',
      'macro workflows',
      'bulk local conversion and processing pipelines',
    ],
  },
};

export const COMPUTER_CAPABILITIES = [
  'adapter-routing',
  'semantic-ui-observation',
  'visual-observation',
  'document-observation',
  'selection-observation',
  'pointer-input',
  'relative-pointer-input',
  'keyboard-input',
  'text-input',
  'clipboard-read',
  'clipboard-write',
  'drag-drop',
  'document-editing',
  'spreadsheet-editing',
  'presentation-editing',
  'media-editing',
  'code-development',
  'local-compute',
  'model-execution',
  'filesystem-observation',
  'file-read',
  'file-write',
  'file-move-copy',
  'file-delete',
  'archive-compression',
  'backup-restore',
  'storage-partitioning',
  'process-observation',
  'process-launch',
  'process-control',
  'terminal-execution',
  'software-installation',
  'system-settings',
  'security-settings',
  'device-settings',
  'network-session',
  'remote-desktop',
  'ssh-session',
  'communication-control',
  'media-playback',
  'game-control',
  'hardware-device-control',
  'task-checkpointing',
  'explicit-confirmation-gate',
  'side-effect-verification',
  'credential-application',
  'authentication-factor-application',
] as const;

export type ComputerCapability = typeof COMPUTER_CAPABILITIES[number];
export type ComputerCapabilitySupport = 'supported' | 'partial' | 'unsupported';

export interface ComputerCapabilityState {
  support: ComputerCapabilitySupport;
  note?: string;
}

export interface ComputerCapabilityProfile {
  id: string;
  capabilities: Readonly<Partial<Record<ComputerCapability, ComputerCapabilitySupport | ComputerCapabilityState>>>;
}

export interface ComputerCapabilityRequirement {
  capability: ComputerCapability;
  level?: 'required' | 'preferred';
}

export interface ComputerCapabilityAssessmentEntry {
  requirement: ComputerCapabilityRequirement;
  support: ComputerCapabilitySupport;
  note?: string;
}

export interface ComputerCapabilityAssessment {
  runnable: boolean;
  fullySupported: boolean;
  requiredUnsupported: ComputerCapabilityAssessmentEntry[];
  requiredPartial: ComputerCapabilityAssessmentEntry[];
  preferredUnsupported: ComputerCapabilityAssessmentEntry[];
  preferredPartial: ComputerCapabilityAssessmentEntry[];
}

function requirement(capability: ComputerCapability, level: 'required' | 'preferred' = 'required'): ComputerCapabilityRequirement {
  return { capability, level };
}

/**
 * Full-category coverage targets. Individual tasks may need only a subset, but
 * these intentionally keep the bar high before claiming a whole computer-use
 * category is broadly covered.
 */
export const COMPUTER_TASK_CATEGORY_CAPABILITY_TARGETS: Readonly<Record<ComputerTaskCategory, readonly ComputerCapabilityRequirement[]>> = {
  'document-media-production': [
    requirement('semantic-ui-observation'),
    requirement('keyboard-input'),
    requirement('text-input'),
    requirement('document-editing'),
    requirement('file-read'),
    requirement('file-write'),
    requirement('clipboard-read'),
    requirement('clipboard-write'),
    requirement('spreadsheet-editing', 'preferred'),
    requirement('presentation-editing', 'preferred'),
    requirement('media-editing', 'preferred'),
    requirement('code-development', 'preferred'),
    requirement('drag-drop', 'preferred'),
  ],
  'data-processing-analytics': [
    requirement('local-compute'),
    requirement('filesystem-observation'),
    requirement('file-read'),
    requirement('file-write'),
    requirement('process-observation'),
    requirement('terminal-execution', 'preferred'),
    requirement('model-execution', 'preferred'),
  ],
  'file-storage-management': [
    requirement('filesystem-observation'),
    requirement('file-read'),
    requirement('file-write'),
    requirement('file-move-copy'),
    requirement('file-delete'),
    requirement('archive-compression'),
    requirement('backup-restore', 'preferred'),
    requirement('storage-partitioning', 'preferred'),
    requirement('explicit-confirmation-gate'),
    requirement('side-effect-verification'),
  ],
  'system-administration-security': [
    requirement('process-observation'),
    requirement('process-launch'),
    requirement('process-control'),
    requirement('terminal-execution'),
    requirement('software-installation'),
    requirement('system-settings'),
    requirement('security-settings'),
    requirement('device-settings', 'preferred'),
    requirement('explicit-confirmation-gate'),
    requirement('side-effect-verification'),
  ],
  'communication-remote-access': [
    requirement('semantic-ui-observation'),
    requirement('communication-control'),
    requirement('network-session'),
    requirement('remote-desktop'),
    requirement('ssh-session'),
    requirement('explicit-confirmation-gate'),
    requirement('side-effect-verification'),
  ],
  'gaming-digital-entertainment': [
    requirement('visual-observation'),
    requirement('pointer-input'),
    requirement('keyboard-input'),
    requirement('media-playback'),
    requirement('game-control'),
    requirement('relative-pointer-input', 'preferred'),
    requirement('hardware-device-control', 'preferred'),
  ],
  'process-automation': [
    requirement('adapter-routing'),
    requirement('task-checkpointing'),
    requirement('process-observation'),
    requirement('process-launch'),
    requirement('process-control'),
    requirement('terminal-execution'),
    requirement('filesystem-observation'),
    requirement('file-read'),
    requirement('file-write'),
    requirement('explicit-confirmation-gate'),
    requirement('side-effect-verification'),
  ],
};

export function computerCapabilityState(
  profile: ComputerCapabilityProfile,
  capability: ComputerCapability,
): ComputerCapabilityState {
  const value = profile.capabilities[capability];
  if (typeof value === 'string') return { support: value };
  return value ?? { support: 'unsupported' };
}

export function assessComputerCapabilities(
  profile: ComputerCapabilityProfile,
  requirements: readonly ComputerCapabilityRequirement[],
): ComputerCapabilityAssessment {
  const result: ComputerCapabilityAssessment = {
    runnable: true,
    fullySupported: true,
    requiredUnsupported: [],
    requiredPartial: [],
    preferredUnsupported: [],
    preferredPartial: [],
  };

  for (const item of requirements) {
    const state = computerCapabilityState(profile, item.capability);
    const entry: ComputerCapabilityAssessmentEntry = {
      requirement: item,
      support: state.support,
      ...(state.note ? { note: state.note } : {}),
    };
    const preferred = item.level === 'preferred';
    if (state.support === 'unsupported') {
      (preferred ? result.preferredUnsupported : result.requiredUnsupported).push(entry);
      if (!preferred) result.runnable = false;
      result.fullySupported = false;
    } else if (state.support === 'partial') {
      (preferred ? result.preferredPartial : result.requiredPartial).push(entry);
      result.fullySupported = false;
    }
  }

  return result;
}

export function assessComputerTaskCategory(
  profile: ComputerCapabilityProfile,
  category: ComputerTaskCategory,
): ComputerCapabilityAssessment {
  return assessComputerCapabilities(profile, COMPUTER_TASK_CATEGORY_CAPABILITY_TARGETS[category]);
}
