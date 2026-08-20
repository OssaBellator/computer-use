# Game region acquisition

Visual game policies should not require every caller to hand-author a screenshot crop. `CdpGameRegionLocator` provides a bounded heuristic acquisition pass for common browser-game rendering surfaces and returns a main-viewport clip that can be fed directly into the existing visual observer or motion sampler.

## Candidate surfaces

The locator searches the live Chromium DOM for:

- `canvas`
- `video`
- `iframe`
- elements with `role="application"`

The set is intentionally narrow. It catches common WebGL/Canvas games, streamed/video-driven surfaces, embedded game frames, and explicitly application-like regions without treating arbitrary large page sections as games.

Before `DOM.performSearch`, the locator calls `DOM.getDocument` to materialize the document tree. This is required for reliable search results on a freshly attached Chromium target.

## Geometry and ranking

Each candidate is resolved through `DOM.getBoxModel` and intersected with the browser-authoritative main viewport. Candidates are rejected when they are too small, fully offscreen, or insufficiently visible.

The default bounds are:

- minimum width: 96 CSS pixels
- minimum height: 64 CSS pixels
- minimum visible fraction: 0.25
- maximum inspected search results: 128
- maximum returned candidates: 8

Ranking is deterministic. Visible area is combined with visible fraction and a modest surface-kind prior:

1. canvas
2. video
3. role=application
4. iframe

The kind prior is not absolute. A substantially larger embedded frame can still outrank a small canvas, while an accessible game canvas can beat a somewhat larger wrapper frame.

The result includes both the complete border box (`rect`) and the visible main-viewport crop (`clip`). `clip` is the safe value for bounded screenshot capture.

## Usage

```ts
const locator = new CdpGameRegionLocator(session);
const located = await locator.locate();

if (!located.primary) {
  throw new Error('No likely game surface found');
}

const visual = new CdpVisualObserver(session);
const sampler = new VisualMotionSampler(visual, {
  capture: {
    clip: located.primary.clip,
    scale: 0.5,
    maxBytes: 512 * 1024,
  },
});

const first = await sampler.sample();
```

A caller that keeps a game open across layout changes should re-run acquisition when navigation, resize, fullscreen changes, or a stale/invalid capture indicates that the old region is no longer authoritative.

## Failure and safety semantics

The locator is a heuristic, not a classifier that proves a page is a game. It returns likely rendering regions and leaves behavioral verification to the closed-loop policy.

Individual detached or unsupported candidates are skipped so one transient DOM node does not invalidate the whole bounded search. Search resources are discarded in a `finally` block. Option validation happens before browser work, and both inspected results and returned candidates have hard limits.

The locator reads browser DOM/geometry state only. It does not mutate navigator properties, inject input events, bypass access controls, or add anti-abuse evasion behavior.

## Regression coverage

Unit regressions cover deterministic ranking, tiny/offscreen filtering, result bounds, cleanup, and fail-fast option validation.

`tests/integration/gameRegionLocatorSmoke.test.mjs` launches local Chromium, creates a deterministic page with tiny, hidden, and dominant game canvases, confirms that the dominant visible canvas is selected, then passes the returned clip to `CdpVisualObserver`. The captured PNG must have the exact discovered 480×270 dimensions.

No GitHub Actions or platform UI automation is required for this regression; it runs through the repository's local Chromium path.
