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
  id: 'standalone-chromium-0.43',
  capabilities: {
    ...STANDALONE_CHROMIUM_CAPABILITY_PROFILE.capabilities,
    'document-content-observation': {
      support: 'supported',
      note: 'bounded structured content across frames/open Shadow DOM plus derived main-content ranking, boilerplate classification, table relationships, deterministic diffs, and targeted refresh hints',
    },
    'relative-pointer-input': {
      support: 'supported',
      note: 'native relative pointer path plus explicit pointer-lock observation/lifecycle and bounded reacquisition hooks for realtime contexts',
    },
    'rich-text-editing': {
      support: 'partial',
      note: 'bounded selection/caret and formatting-run observation with native insertion/replacement/select-all/delete and verified bold/italic/underline operations; rich clipboard/editor-model synchronization remain incomplete',
    },
    'clipboard-read': {
      support: 'partial',
      note: 'explicit bounded text/plain/text/html Clipboard API reads exist and preserve normal browser permission policy; passive observation and rich-editor integration remain incomplete',
    },
    'clipboard-write': {
      support: 'partial',
      note: 'explicit bounded text/plain/text/html Clipboard API writes exist without permission mutation or synthetic user activation; broad editor/task integration remains incomplete',
    },
    'drag-drop': {
      support: 'partial',
      note: 'Chromium-native intercepted DragData transfer exists with bounded payload metadata, default file blocking, and explicit dragCancel on blocked transfers; semantic target acceptance and TaskRuntime policy integration remain incomplete',
    },
    'media-playback-control': {
      support: 'partial',
      note: 'first-class bounded HTML media observation plus native playback/mute/volume/seek/rate controls with post-operation verification; arbitrary native media applications are outside the browser profile',
    },
    'fullscreen-control': {
      support: 'partial',
      note: 'document/browser-window fullscreen state is observed and native request/exit operations are verified when browser policy permits them; activation requirements are not bypassed',
    },
    'permissions-control': {
      support: 'partial',
      note: 'page-visible permission/policy state is observed with explicit unknown browser-profile state; the stack does not auto-grant or bypass sensitive permissions',
    },
    'commitment-detection': {
      support: 'partial',
      note: 'TaskRuntime detects strong or context-corroborated purchase/booking/transfer/subscription/publish/destructive/security/process commitments from bounded semantic/document state and gates them before activation; site-specific semantics remain heuristic',
    },
    'external-side-effect-verification': {
      support: 'partial',
      note: 'approved commitments require fresh target/material/result-neutral preflight, exactly one dispatch, bounded outcome polling, material mismatch checks, and provider-neutral labeled result identity; unrelated tabs and unbound cross-provider success remain fail-closed',
    },
    'process-trigger-verification': {
      support: 'partial',
      note: 'process-trigger result text and labeled durable identifiers can be bound without redispatch, but provider-specific execution state and the broader computer-use process adapter are not yet integrated',
    },
    'long-running-task-checkpointing': {
      support: 'partial',
      note: 'a versioned deterministic, integrity-checked, execution-bound and deeply frozen checkpoint codec exists, but TaskRuntime resume/persistence integration remains future work',
    },
    'realtime-control': {
      support: 'supported',
      note: 'held input, independent control/perception cadence, pointer-lock lifecycle, game-region/renderer lifecycle, visual motion tracking, and bounded control/effect calibration foundations are available',
    },
  },
};
