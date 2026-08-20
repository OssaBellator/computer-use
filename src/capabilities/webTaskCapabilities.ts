import type {
  TaskPredicate,
  TaskProgram,
  TaskStep,
} from '../agent/taskProgram.js';

export const WEB_TASK_CATEGORIES = [
  'information-retrieval-research',
  'communication-collaboration',
  'transactions-commerce',
  'content-consumption-entertainment',
  'content-creation-publishing',
  'identity-account-management',
  'automation-process-triggering',
] as const;

export type WebTaskCategory = typeof WEB_TASK_CATEGORIES[number];

export const BROWSER_TASK_CAPABILITIES = [
  'standalone-browser-runtime',
  'task-program-execution',
  'multi-page',
  'navigation',
  'history',
  'semantic-interaction-observation',
  'document-content-observation',
  'browser-state-observation',
  'visual-observation',
  'network-activity-observation',
  'download-observation',
  'dialog-observation',
  'activation',
  'pointer-input',
  'relative-pointer-input',
  'keyboard-input',
  'text-entry',
  'select-control',
  'scroll',
  'file-upload',
  'file-download',
  'drag-drop',
  'clipboard-read',
  'clipboard-write',
  'rich-text-editing',
  'media-playback-control',
  'fullscreen-control',
  'permissions-control',
  'camera-microphone-control',
  'user-mediated-authentication',
  'credential-passkey-control',
  'commitment-detection',
  'explicit-confirmation-gate',
  'external-side-effect-verification',
  'process-trigger-verification',
  'long-running-task-checkpointing',
  'realtime-control',
  'game-surface-acquisition',
  'temporal-motion-tracking',
] as const;

export type BrowserTaskCapability = typeof BROWSER_TASK_CAPABILITIES[number];
export type CapabilitySupport = 'supported' | 'partial' | 'unsupported';

export interface CapabilityState {
  support: CapabilitySupport;
  note?: string;
}

export interface BrowserCapabilityProfile {
  id: string;
  capabilities: Readonly<
    Partial<Record<BrowserTaskCapability, CapabilitySupport | CapabilityState>>
  >;
}

export interface CapabilityRequirement {
  capability: BrowserTaskCapability;
  level?: 'required' | 'preferred';
  reason?: string;
}

export interface CapabilityAssessmentEntry {
  requirement: CapabilityRequirement;
  support: CapabilitySupport;
  note?: string;
}

export interface CapabilityAssessment {
  /** No required capability is completely unsupported. Partial support may still need policy/task-specific handling. */
  runnable: boolean;
  /** Every required/preferred capability in the target is fully supported. */
  fullySupported: boolean;
  requiredUnsupported: CapabilityAssessmentEntry[];
  requiredPartial: CapabilityAssessmentEntry[];
  preferredUnsupported: CapabilityAssessmentEntry[];
  preferredPartial: CapabilityAssessmentEntry[];
}

export type TaskCommitmentClass =
  | 'observe-only'
  | 'local-reversible'
  | 'remote-reversible'
  | 'remote-publish'
  | 'financial'
  | 'identity-security'
  | 'process-trigger';

export interface WebTaskCategoryDefinition {
  label: string;
  examples: readonly string[];
}

export const WEB_TASK_CATEGORY_DEFINITIONS: Readonly<
  Record<WebTaskCategory, WebTaskCategoryDefinition>
> = {
  'information-retrieval-research': {
    label: 'Information Retrieval & Research',
    examples: [
      'search and factual lookup',
      'news/weather/guides',
      'academic, market, and product research',
    ],
  },
  'communication-collaboration': {
    label: 'Communication & Collaboration',
    examples: [
      'messaging and email',
      'shared documents and whiteboards',
      'project-management workflows',
    ],
  },
  'transactions-commerce': {
    label: 'Transactions & Commerce',
    examples: [
      'shopping',
      'banking and bill workflows',
      'travel and service booking',
    ],
  },
  'content-consumption-entertainment': {
    label: 'Content Consumption & Entertainment',
    examples: [
      'articles, ebooks, and forums',
      'streaming media',
      'browser-based games',
    ],
  },
  'content-creation-publishing': {
    label: 'Content Creation & Publishing',
    examples: [
      'writing and posting',
      'media upload',
      'web design, editing, and coding environments',
    ],
  },
  'identity-account-management': {
    label: 'Identity & Account Management',
    examples: [
      'forms and profiles',
      'privacy/password settings',
      'user-mediated MFA and identity steps',
    ],
  },
  'automation-process-triggering': {
    label: 'Automation & Process Triggering',
    examples: [
      'submit workflows',
      'trigger automations or webhooks through web apps',
      'schedule tasks through web interfaces',
    ],
  },
};

function requirement(
  capability: BrowserTaskCapability,
  level: 'required' | 'preferred' = 'required',
  reason?: string,
): CapabilityRequirement {
  return {
    capability,
    level,
    ...(reason ? { reason } : {}),
  };
}

/**
 * Full-category coverage targets, not a claim that every individual task inside
 * a category needs every listed primitive. These deliberately set a high bar for
 * saying the agent broadly covers an entire category.
 */
export const WEB_TASK_CATEGORY_CAPABILITY_TARGETS: Readonly<
  Record<WebTaskCategory, readonly CapabilityRequirement[]>
> = {
  'information-retrieval-research': [
    requirement('standalone-browser-runtime'),
    requirement('navigation'),
    requirement('document-content-observation'),
    requirement('browser-state-observation'),
    requirement('task-program-execution'),
    requirement('multi-page', 'preferred'),
    requirement('network-activity-observation', 'preferred'),
  ],
  'communication-collaboration': [
    requirement('navigation'),
    requirement('semantic-interaction-observation'),
    requirement('activation'),
    requirement('text-entry'),
    requirement('rich-text-editing'),
    requirement('file-upload', 'preferred'),
    requirement('clipboard-read', 'preferred'),
    requirement('clipboard-write', 'preferred'),
    requirement('camera-microphone-control', 'preferred'),
  ],
  'transactions-commerce': [
    requirement('navigation'),
    requirement('semantic-interaction-observation'),
    requirement('activation'),
    requirement('text-entry'),
    requirement('select-control'),
    requirement('browser-state-observation'),
    requirement('commitment-detection'),
    requirement('explicit-confirmation-gate'),
    requirement('external-side-effect-verification'),
  ],
  'content-consumption-entertainment': [
    requirement('navigation'),
    requirement('document-content-observation'),
    requirement('visual-observation'),
    requirement('media-playback-control'),
    requirement('realtime-control', 'preferred'),
    requirement('game-surface-acquisition', 'preferred'),
    requirement('temporal-motion-tracking', 'preferred'),
  ],
  'content-creation-publishing': [
    requirement('navigation'),
    requirement('text-entry'),
    requirement('rich-text-editing'),
    requirement('file-upload'),
    requirement('clipboard-read'),
    requirement('clipboard-write'),
    requirement('drag-drop', 'preferred'),
    requirement('external-side-effect-verification'),
  ],
  'identity-account-management': [
    requirement('navigation'),
    requirement('semantic-interaction-observation'),
    requirement('text-entry'),
    requirement('select-control'),
    requirement('file-upload', 'preferred'),
    requirement('user-mediated-authentication'),
    requirement('explicit-confirmation-gate'),
    requirement('credential-passkey-control', 'preferred'),
  ],
  'automation-process-triggering': [
    requirement('navigation'),
    requirement('task-program-execution'),
    requirement('semantic-interaction-observation'),
    requirement('activation'),
    requirement('text-entry'),
    requirement('process-trigger-verification'),
    requirement('explicit-confirmation-gate'),
    requirement('long-running-task-checkpointing', 'preferred'),
  ],
};

/**
 * Honest capability snapshot for the standalone Chromium stack at version 0.35.
 * Conditional/opt-in controllers are marked partial rather than pretending they
 * are universally configured.
 */
export const STANDALONE_CHROMIUM_CAPABILITY_PROFILE: BrowserCapabilityProfile = {
  id: 'standalone-chromium-0.35',
  capabilities: {
    'standalone-browser-runtime': 'supported',
    'task-program-execution': 'supported',
    'multi-page': 'supported',
    'navigation': 'supported',
    'history': 'supported',
    'semantic-interaction-observation': 'supported',
    'document-content-observation': {
      support: 'unsupported',
      note: 'interactive semantic snapshots do not yet extract general document/article content',
    },
    'browser-state-observation': 'supported',
    'visual-observation': 'supported',
    'network-activity-observation': {
      support: 'partial',
      note: 'available as explicit opt-in monitoring',
    },
    'download-observation': {
      support: 'partial',
      note: 'requires download controller configuration',
    },
    'dialog-observation': 'supported',
    'activation': 'supported',
    'pointer-input': 'supported',
    'relative-pointer-input': 'supported',
    'keyboard-input': 'supported',
    'text-entry': 'supported',
    'select-control': 'supported',
    'scroll': 'supported',
    'file-upload': {
      support: 'partial',
      note: 'requires upload controller configuration',
    },
    'file-download': {
      support: 'partial',
      note: 'downloads can be monitored when configured',
    },
    'drag-drop': 'unsupported',
    'clipboard-read': 'unsupported',
    'clipboard-write': 'unsupported',
    'rich-text-editing': 'unsupported',
    'media-playback-control': {
      support: 'partial',
      note: 'generic activation can operate some controls but media state is not first-class',
    },
    'fullscreen-control': 'unsupported',
    'permissions-control': 'unsupported',
    'camera-microphone-control': 'unsupported',
    'user-mediated-authentication': {
      support: 'partial',
      note: 'generic UI interaction exists but MFA/passkey/user-handoff state is not modeled',
    },
    'credential-passkey-control': 'unsupported',
    'commitment-detection': {
      support: 'unsupported',
      note: 'program authors can declare risk but page-side commitment semantics are not inferred',
    },
    'explicit-confirmation-gate': {
      support: 'supported',
      note: 'TaskRuntime approval gates and max-risk policy are available',
    },
    'external-side-effect-verification': {
      support: 'partial',
      note: 'generic action verification exists but transaction/publish semantics are not specialized',
    },
    'process-trigger-verification': {
      support: 'partial',
      note: 'generic browser state can be verified but triggered process identity/result is not first-class',
    },
    'long-running-task-checkpointing': 'unsupported',
    'realtime-control': 'supported',
    'game-surface-acquisition': 'supported',
    'temporal-motion-tracking': 'supported',
  },
};

function stateOf(
  profile: BrowserCapabilityProfile,
  capability: BrowserTaskCapability,
): CapabilityState {
  const raw = profile.capabilities[capability];
  if (typeof raw === 'string') return { support: raw };
  return raw ?? { support: 'unsupported' };
}

export function assessCapabilityRequirements(
  profile: BrowserCapabilityProfile,
  requirements: readonly CapabilityRequirement[],
): CapabilityAssessment {
  const result: CapabilityAssessment = {
    runnable: true,
    fullySupported: true,
    requiredUnsupported: [],
    requiredPartial: [],
    preferredUnsupported: [],
    preferredPartial: [],
  };

  for (const item of requirements) {
    const state = stateOf(profile, item.capability);
    const entry: CapabilityAssessmentEntry = {
      requirement: item,
      support: state.support,
      ...(state.note ? { note: state.note } : {}),
    };
    const preferred = item.level === 'preferred';
    if (state.support === 'unsupported') {
      if (preferred) result.preferredUnsupported.push(entry);
      else {
        result.requiredUnsupported.push(entry);
        result.runnable = false;
      }
      result.fullySupported = false;
    } else if (state.support === 'partial') {
      if (preferred) result.preferredPartial.push(entry);
      else result.requiredPartial.push(entry);
      result.fullySupported = false;
    }
  }
  return result;
}

export function assessWebTaskCategory(
  profile: BrowserCapabilityProfile,
  category: WebTaskCategory,
): CapabilityAssessment {
  return assessCapabilityRequirements(
    profile,
    WEB_TASK_CATEGORY_CAPABILITY_TARGETS[category],
  );
}

export function commitmentRequiresExplicitApproval(
  commitment: TaskCommitmentClass,
): boolean {
  return commitment === 'remote-publish' ||
    commitment === 'financial' ||
    commitment === 'identity-security' ||
    commitment === 'process-trigger';
}

const CAPABILITY_RANK = new Map(
  BROWSER_TASK_CAPABILITIES.map((capability, index) => [capability, index] as const),
);

function addPredicateCapabilities(
  predicate: TaskPredicate,
  into: Set<BrowserTaskCapability>,
): void {
  switch (predicate.kind) {
    case 'exists':
    case 'state':
      into.add('semantic-interaction-observation');
      return;
    case 'browser':
      into.add('browser-state-observation');
      return;
    case 'document':
      into.add('document-content-observation');
      return;
    case 'dialog':
      into.add('dialog-observation');
      return;
    case 'targets':
      into.add('multi-page');
      return;
    case 'downloads':
      into.add('download-observation');
      return;
    case 'all':
    case 'any':
      for (const nested of predicate.predicates) {
        addPredicateCapabilities(nested, into);
      }
      return;
    case 'not':
      addPredicateCapabilities(predicate.predicate, into);
      return;
  }
}

function addStepCapabilities(
  step: TaskStep,
  into: Set<BrowserTaskCapability>,
): void {
  switch (step.kind) {
    case 'activate':
      into.add('activation');
      break;
    case 'hover':
      into.add('pointer-input');
      break;
    case 'type':
      into.add('text-entry');
      into.add('keyboard-input');
      break;
    case 'select-option':
      into.add('select-control');
      break;
    case 'upload':
      into.add('file-upload');
      break;
    case 'press-key':
      into.add('keyboard-input');
      break;
    case 'scroll-viewport':
      into.add('scroll');
      break;
    case 'switch-page':
    case 'open-tab':
    case 'close-latest-tab':
      into.add('multi-page');
      break;
    case 'navigate':
      into.add('navigation');
      break;
    case 'history':
      into.add('history');
      break;
    case 'handle-dialog':
      into.add('dialog-observation');
      break;
    case 'wait-network-idle':
      into.add('network-activity-observation');
      break;
    case 'assert':
    case 'branch':
    case 'wait':
      addPredicateCapabilities(step.condition, into);
      break;
    case 'complete':
      if (step.condition) addPredicateCapabilities(step.condition, into);
      break;
    case 'fail':
      break;
  }

  if ('requiresApproval' in step && step.requiresApproval === true) {
    into.add('explicit-confirmation-gate');
  }
  if ('risk' in step && step.risk === 'external-side-effect') {
    into.add('explicit-confirmation-gate');
  }
  if (step.kind === 'upload') {
    into.add('explicit-confirmation-gate');
  }
}

export interface TaskProgramCapabilityAnalysis {
  required: BrowserTaskCapability[];
  externalSideEffectStepIds: string[];
  approvalStepIds: string[];
}

/** Infer the browser/runtime primitives mechanically required by an existing TaskProgram. */
export function analyzeTaskProgramCapabilities(
  program: TaskProgram,
): TaskProgramCapabilityAnalysis {
  const capabilities = new Set<BrowserTaskCapability>(['task-program-execution']);
  const externalSideEffectStepIds: string[] = [];
  const approvalStepIds: string[] = [];

  for (const step of program.steps) {
    addStepCapabilities(step, capabilities);
    if ('risk' in step && step.risk === 'external-side-effect') {
      externalSideEffectStepIds.push(step.id);
    }
    if (
      ('requiresApproval' in step && step.requiresApproval === true) ||
      ('risk' in step && step.risk === 'external-side-effect') ||
      step.kind === 'upload'
    ) {
      approvalStepIds.push(step.id);
    }
  }

  return {
    required: [...capabilities].sort(
      (a, b) => (CAPABILITY_RANK.get(a) ?? 0) - (CAPABILITY_RANK.get(b) ?? 0),
    ),
    externalSideEffectStepIds,
    approvalStepIds,
  };
}
