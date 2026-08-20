# Media, fullscreen, and permission state

This branch adds standalone raw-CDP observation for HTML media playback, document fullscreen, browser-window fullscreen, and effective page permission state. The primitives remain framework-independent and do not require Playwright, Puppeteer, Selenium/WebDriver, synthetic DOM event dispatch, or permission mutation.

## Media observation

`observeMediaState(session, options)` walks a bounded current frame tree and inspects `audio` / `video` elements in each frame's isolated world, including elements inside open shadow roots. Each retained identity contains the owning frame and CDP `backendNodeId`; media source URLs are deliberately not retained because signed URLs can contain credentials or bearer-like query material.

The bounded state includes:

- playback classification: `playing`, `paused`, `ended`, or `unknown`;
- muted state and volume in the browser's `0..1` range when observable;
- finite current time and duration up to the configured observation bound;
- bounded playback rate;
- visibility;
- bounded identity fields: frame id, `backendNodeId`, ordinal, tag name, id, and aria label;
- a preferred `activeMedia` identity selected only from currently playing elements, preferring audible/visible video when several elements play simultaneously.

Frame count, media count, retained text, time values, permission names, and retained errors are bounded. If a configured bound causes observations or errors to be dropped, `truncated` is set. Closed shadow-root internals are not claimed as complete by the DOM-based snapshot.

## Fullscreen observation

The same snapshot observes two distinct fullscreen concepts:

1. **Document fullscreen** from each frame. For open shadow trees, the observer follows `ShadowRoot.fullscreenElement` to the deepest JS-observable owner; across nested frames, the deepest observed owning frame is preferred.
2. **Browser-window fullscreen** from `Browser.getWindowForTarget`, reported separately as `fullscreen`, `not-fullscreen`, or `unknown`.

`pageState: unknown` is used when frame-level observation is incomplete enough that an inactive document-fullscreen result cannot be established safely.

## Media/fullscreen controller

`CdpMediaController` provides narrowly scoped ordinary media controls, while `CdpFullscreenController` handles fullscreen for any observed element identity containing a frame id and `backendNodeId`:

- play / pause;
- mute and volume;
- seek;
- playback rate;
- request / exit document fullscreen.

The controllers resolve the observed `backendNodeId` in the owning frame and call native `HTMLMediaElement` / Fullscreen APIs through CDP. They do **not** synthesize `dispatchEvent()` behavior and do **not** set CDP `userGesture`; autoplay/fullscreen user-activation policy therefore remains the browser's decision. Operations return only after the requested state is verified or a bounded rejection/verification failure is available. A real browser input can supply activation when a caller intentionally performs one through the normal input layer.

Fullscreen verification is shadow-root aware, and generic fullscreen requests are not restricted to media elements. Exiting fullscreen is idempotent: an already-inactive document is a verified final state. Fullscreen or playback can legitimately return `rejected` when browser policy requires activation or otherwise disallows the operation.

These controls do not grant permissions and do not automate credentials, passkeys, MFA, CAPTCHA, or other authentication ceremonies.

## Permission observation

`observePermissionState(session, options)` observes a bounded frame tree and combines two independent views:

- `Page.getPermissionsPolicyState` for frame-level Permissions Policy allowance/blocking where Chromium exposes it;
- `navigator.permissions.query()` evaluated through CDP for the effective permission state visible to that frame.

The default requested set is camera, microphone, notifications, geolocation, clipboard-read, and clipboard-write. Additional bounded permission names can be requested. When a custom name matches a feature returned by Chromium's Permissions Policy state (for example `midi` or a policy-only feature such as `fullscreen`), that policy state is retained even if the Permissions API query itself is unsupported.

Each permission record separates:

- `state`: effective page state (`granted`, `denied`, `prompt`, or `unknown`), with an explicit Permissions Policy block treated as an effective denial;
- `pageState`: the frame's Permissions API result;
- `policy`: `allowed`, `blocked`, `not-applicable`, or `unknown`, including bounded block reason/frame metadata when available;
- `browserState`: always `unknown` for passive observation.

The `browserState` distinction is deliberate. Current CDP exposes permission mutation commands such as `Browser.setPermission` and reset operations, but no general passive readback of the underlying browser/profile permission decision. A page result therefore is not promoted into an independent browser-level claim.

The observer is read-only: it never calls permission grant, deny, or reset commands.

## Validation boundary

Coverage is deterministic and synthetic/local:

- unit fixtures exercise media bounds/privacy, active media selection, nested fullscreen ownership, no synthetic user-activation elevation, native rejection propagation, custom Permissions Policy matching, and browser-level uncertainty;
- a local raw-CDP Chromium smoke test uses an in-memory WAV inside an open shadow root and a local `srcdoc` iframe policy fixture;
- the Chromium smoke proves fullscreen is not silently elevated without user activation, allows the browser to decide pre-activation playback policy, then uses ordinary CDP mouse input to create real activation before verifying playback succeeds;
- no external sites or transaction-like effects are used.

No real purchase, payment, booking, transfer, publication, account/security change, deletion, deployment, or external process trigger is used by these tests.
