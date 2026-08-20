# Media, fullscreen, and permission state

This branch adds standalone raw-CDP observation for HTML media playback, document fullscreen, browser-window fullscreen, and effective page permission state. The primitives are framework-independent and do not require Playwright, Puppeteer, Selenium/WebDriver, or a page-side event-synthesis layer.

## Media observation

`observeMediaState(session, options)` walks a bounded current frame tree and inspects `audio` / `video` elements in isolated worlds. Each observed element includes a CDP `backendNodeId` and frame id so later operations can resolve the same browser node without relying on page-authored selectors.

The bounded state includes:

- playback classification: `playing`, `paused`, `ended`, or `unknown`;
- muted state and volume in the browser's `0..1` range when observable;
- finite current time and duration up to the configured observation bound (infinite live-stream duration is intentionally omitted);
- bounded playback rate;
- visibility;
- bounded identity fields: frame id, `backendNodeId`, ordinal, tag name, id, and aria label;
- a preferred `activeMedia` identity selected only from currently playing elements, preferring audible/visible video when several elements play simultaneously.

Media source URLs are deliberately excluded from the returned identity/snapshot. Signed streaming URLs can carry bearer-like query credentials, while frame/backend-node identity is sufficient for later browser-native control.

Frame count, media count, retained text, time values, and error retention are all bounded. Protocol or frame failures are recorded rather than silently converted into known state.

## Fullscreen observation

The same snapshot observes two distinct fullscreen concepts:

1. **Document fullscreen** from each frame's `document.fullscreenElement`. When nested frames expose fullscreen elements, the deepest owning frame is preferred so the result points to the actual element rather than only an ancestor iframe container.
2. **Browser-window fullscreen** from `Browser.getWindowForTarget`, reported separately as `fullscreen`, `not-fullscreen`, or `unknown`.

`pageState: unknown` is used when enough frame-level observation failed that an inactive document-fullscreen state cannot be established safely.

## Media/fullscreen controller

`CdpMediaController` provides narrowly scoped ordinary controls:

- play / pause;
- mute and volume;
- seek;
- playback rate;
- request / exit document fullscreen.

The controller resolves the observed `backendNodeId` in the owning frame and calls the browser's native `HTMLMediaElement` / Fullscreen APIs through CDP. It does **not** synthesize `dispatchEvent()` media or fullscreen events and does not set CDP's `userGesture` execution flag. Normal browser autoplay/fullscreen user-activation policy therefore remains in force. Bounded polling returns only after the requested state is verified or a bounded rejection/verification failure is available. Fullscreen and unmuted playback can legitimately be rejected by browser/headless policy.

These controls do not grant permissions and do not automate credentials, passkeys, MFA, CAPTCHA, or other authentication ceremonies.

## Permission observation

`observePermissionState(session, options)` observes a bounded frame tree and combines two independent views:

- `Page.getPermissionsPolicyState` for frame-level Permissions Policy allowance/blocking where Chromium exposes it;
- `navigator.permissions.query()` evaluated through CDP for the effective permission state visible to that frame.

The default requested set is camera, microphone, notifications, geolocation, clipboard-read, and clipboard-write. Additional permission names can be requested; unsupported descriptors become `unknown` rather than being coerced into a grant or denial.

Each permission record separates:

- `state`: effective page state (`granted`, `denied`, `prompt`, or `unknown`), with an explicit Permissions Policy block treated as an effective denial;
- `pageState`: the frame's Permissions API result;
- `policy`: `allowed`, `blocked`, `not-applicable`, or `unknown`, including bounded block reason/frame metadata when available;
- `browserState`: always `unknown` for passive observation.

The `browserState` distinction is deliberate. Chromium CDP exposes permission mutation commands such as `Browser.setPermission` / reset operations, but not a general readback command for the underlying browser/profile permission decision. A page result therefore must not be promoted into a claim that the browser-level setting is known independently of page policy/context.

The observer is read-only: it never calls permission grant, deny, or reset commands.

## Validation boundary

Coverage is deterministic and synthetic/local:

- unit fixtures exercise media bounds, active media selection, nested fullscreen ownership, activation-policy preservation, source-URL omission, native controller verification, Permissions Policy blocking, and browser-level uncertainty;
- a local raw-CDP Chromium smoke test uses an in-memory WAV data URI and an `iframe allow` policy fixture. It verifies real media playback/control and permission-policy observation without external sites or side effects;
- document fullscreen is attempted through the real Fullscreen API. Current headless Chromium may decline it; the smoke test verifies that the operation returns boundedly and observes active ownership when the browser accepts it. Active nested ownership is also covered deterministically by unit fixtures.

No real purchase, payment, booking, transfer, publication, account/security change, deletion, deployment, or external process trigger is used by these tests.
