# Clipboard and drag/drop foundations

This slice adds browser-native low-level primitives for explicit clipboard access and HTML drag transfer without introducing page-side synthetic clipboard/drag events, permission mutation, or a browser-automation framework dependency.

It is intentionally a foundation rather than a claim that broad `clipboard-read`, `clipboard-write`, or `drag-drop` task capabilities are fully supported. Rich-editor integration, task-risk integration, and generic semantic drop acceptance still require higher-level work.

## Explicit clipboard access

`CdpClipboardController` invokes the page's native Clipboard API from an isolated CDP world.

Supported payload types are deliberately limited to:

- `text/plain`
- `text/html`

Default bounds are 16 KiB per supported type and 32 KiB total. Caller-supplied writes are rejected before CDP dispatch when they exceed the configured limits. Returned reads are independently re-bounded on the host by exact UTF-8 bytes before they are exposed to the caller.

Clipboard access is **explicit only**. There is no passive clipboard observer because an OS clipboard can contain passwords, tokens, private messages, financial information, or unrelated application data.

The controller does not:

- set CDP `userGesture: true`;
- call `Browser.setPermission`, `Browser.grantPermissions`, or permission-reset commands;
- bypass browser/user activation or Clipboard API policy;
- retain browser exception messages influenced by page content.

Normal browser policy is therefore authoritative. A read or write can return `rejected` or `unavailable`, with only a bounded browser exception **name** such as `NotAllowedError` retained.

Write results contain MIME/count metadata but never echo the written text or HTML. Explicit read results necessarily return the requested bounded clipboard payload to the direct caller; higher layers must not place that payload into ordinary task traces.

### Current read-memory limitation

When Chromium exposes `navigator.clipboard.read()`, the current browser-side function obtains supported Blob text before applying its return bound. The CDP response and host-visible result remain bounded, but an unusually large clipboard item can transiently occupy more memory inside the isolated page world than the final bound. A follow-up hardening can slice Blob bytes before decoding. This is not a reason to promote clipboard capability support yet.

## Native drag transfer

`CdpDragDropController` uses Chromium's `Input.setInterceptDrags` / `Input.dragIntercepted` path:

1. enable drag interception;
2. issue native CDP mouse movement/press/movement from the caller-supplied source point;
3. require Chromium to produce native `DragData`;
4. bound the intercepted payload before forwarding it;
5. dispatch CDP `dragEnter`, `dragOver`, and `drop` at the target point;
6. release the pointer and disable interception in cleanup.

The controller does **not** construct `DragEvent`, `DataTransfer`, or `dispatchEvent()` objects inside page JavaScript.

Default transfer bounds are:

- 16 drag items;
- 16 files;
- 64 KiB across intercepted item data/title/base URL/MIME metadata and file-path strings;
- 5 bounded drag-start pointer steps;
- 750 ms interception timeout.

File-bearing drag data is blocked by default. A direct caller must set `allowFiles: true` before a file-bearing drop can be dispatched. This does not replace higher-level approval/risk policy for file upload or other consequential drop targets.

Returned results expose only:

- status;
- item count;
- file count;
- sanitized MIME types;
- aggregate payload byte count.

They never return drag text, HTML, URLs, item titles, base URLs, or file paths.

## Verification boundary

`drop-dispatched` means Chromium accepted the native drop input. It does **not** claim that the target semantically accepted the operation.

The synthetic raw-Chromium fixture instruments a local draggable source and drop target and verifies that:

- Chromium itself supplies the intercepted data;
- the controller never reconstructs the payload page-side;
- the target receives exactly one drop;
- the controller result does not contain the transferred text.

A future semantic layer should bind source/target identities, observe target-specific acceptance, and integrate TaskRuntime risk/approval rules before `drag-drop` is promoted from its current unsupported capability status.

## Safety and architecture boundaries

- No GitHub Actions or Windows Tester are used.
- No Playwright/Puppeteer/Selenium/WebDriver runtime dependency is introduced.
- No permission bypass, synthetic user activation, anti-bot, stealth, fingerprint spoofing, or CAPTCHA behavior is added.
- No real clipboard secrets, external file uploads, purchases, payments, bookings, publications, account/security changes, deployments, or external process triggers are used by tests.
- File-bearing drag dispatch is opt-in at the low-level controller and should remain approval-gated when integrated into task execution.
