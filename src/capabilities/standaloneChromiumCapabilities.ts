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
  id: 'standalone-chromium-0.41',
  capabilities: {
    ...STANDALONE_CHROMIUM_CAPABILITY_PROFILE.capabilities,
    'document-content-observation': {
      support: 'supported',
      note: 'bounded headings/paragraphs/lists/tables/code/links/images/metadata across frames and open Shadow DOM',
    },
    'rich-text-editing': {
      support: 'partial',
      note: 'bounded selection/caret observation plus exact native insertion/replacement/select-all/delete; formatting, rich clipboard, drag/drop, and editor-specific document verification remain incomplete',
    },
    'commitment-detection': {
      support: 'partial',
      note: 'TaskRuntime detects strong or context-corroborated purchase/booking/transfer/subscription/publish/destructive/security/process commitments from bounded semantic/document state and gates them before activation; site-specific semantics remain heuristic',
    },
    'external-side-effect-verification': {
      support: 'partial',
      note: 'approved detected commitments require a fresh result-neutral same-frame baseline before input, then bounded outcome verification for confirmed/pending/declined/canceled/unknown states plus material amount/currency/counterparty/schedule/recurrence mismatch checks; provider-specific receipts and durable result identity remain heuristic/incomplete',
    },
    'process-trigger-verification': {
      support: 'partial',
      note: 'detected process triggers require the same fresh verification baseline and can classify explicit queued/started/completed/failed/canceled result text without retrying the trigger, but process identity and provider-specific execution state are not yet first-class',
    },
  },
};
