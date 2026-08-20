import {
  STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
  type BrowserCapabilityProfile,
} from './webTaskCapabilities.js';

/**
 * Capability profile for the standalone Chromium stack after structured
 * document-content observation was added. The 0.35 profile remains exported as
 * a historical snapshot rather than being mutated retroactively.
 */
export const CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE: BrowserCapabilityProfile = {
  id: 'standalone-chromium-0.37',
  capabilities: {
    ...STANDALONE_CHROMIUM_CAPABILITY_PROFILE.capabilities,
    'document-content-observation': {
      support: 'supported',
      note: 'bounded headings/paragraphs/lists/tables/code/links/images/metadata across frames and open Shadow DOM',
    },
  },
};
