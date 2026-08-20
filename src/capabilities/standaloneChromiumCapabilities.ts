import {
  STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
  type BrowserCapabilityProfile,
} from './webTaskCapabilities.js';

/**
 * Capability profile for the current standalone Chromium stack. The 0.35 base
 * profile remains exported as a historical snapshot rather than being mutated
 * retroactively.
 */
export const CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE: BrowserCapabilityProfile = {
  id: 'standalone-chromium-0.42',
  capabilities: {
    ...STANDALONE_CHROMIUM_CAPABILITY_PROFILE.capabilities,
    'document-content-observation': {
      support: 'supported',
      note: 'bounded structured content across frames/open Shadow DOM plus deterministic main-content ranking, boilerplate classification, table relationships, snapshot diffs, and uncertainty-aware refresh hints',
    },
    'rich-text-editing': {
      support: 'partial',
      note: 'bounded selection/caret and formatting observation plus exact native insertion/replacement/select-all/delete and verified bold/italic/underline shortcuts; rich clipboard, drag/drop, collaborative-editor synchronization, and editor-specific model verification remain incomplete',
    },
    'commitment-detection': {
      support: 'partial',
      note: 'TaskRuntime detects strong or context-corroborated purchase/booking/transfer/subscription/publish/destructive/security/process commitments from bounded semantic/document state and gates them before activation; site-specific semantics remain heuristic',
    },
    'external-side-effect-verification': {
      support: 'partial',
      note: 'fresh target/material and result-neutral baselines precede exactly one dispatch; explicit outcomes and material mismatches are verified afterward, with bounded durable labeled IDs binding redirects and opener-associated popups; provider-specific reconciliation and unbound cross-provider handoffs remain incomplete',
    },
    'process-trigger-verification': {
      support: 'partial',
      note: 'process triggers use the same no-redispatch verifier and can bind labeled deployment/workflow/job/process IDs across supported result handoffs; provider APIs and execution-state reconciliation remain incomplete',
    },
    'relative-pointer-input': {
      support: 'supported',
      note: 'relative CDP pointer movement is guarded by explicit pointer-lock/pointer-capture lifecycle state, owner identity, loss detection, and bounded reacquisition hooks',
    },
    'realtime-control': {
      support: 'supported',
      note: 'persistent held-key/button control and independent perception cadence are supplemented by bounded generic control-effect calibration; key probes require explicit caller safety/focus attestation',
    },
    'media-playback-control': {
      support: 'partial',
      note: 'bounded HTMLMediaElement playback observation plus native play/pause/mute/volume/seek/rate control with ordinary browser activation policy; custom-player semantics and site-specific controls are not fully modeled',
    },
    'fullscreen-control': {
      support: 'partial',
      note: 'document fullscreen ownership and browser-window fullscreen state are observed; native document request/exit is verified without user-activation elevation, while browser-window control remains incomplete',
    },
    'permissions-control': {
      support: 'partial',
      note: 'bounded page Permissions API and Permissions Policy state are observed read-only; browser/profile permission grant/deny/reset is intentionally not automated by this layer',
    },
    'long-running-task-checkpointing': {
      support: 'partial',
      note: 'versioned deterministic privacy-bounded checkpoint serialization, integrity/schema validation, program compatibility, budget/visit validation, and trusted-input re-provisioning are available as a pure codec; TaskRuntime persistence/resume integration remains future work',
    },
  },
};
