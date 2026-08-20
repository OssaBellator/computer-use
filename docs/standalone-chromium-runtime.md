# Standalone Chromium runtime

The project can now launch and control Chromium without Playwright, Puppeteer, Selenium/WebDriver, or a third-party CDP websocket client.

## Transport

Chromium is launched with `--remote-debugging-pipe`. On Chromium, browser-root CDP commands are written as UTF-8 JSON followed by a NUL byte on child fd 3, and responses/events are read from fd 4 with the same framing.

`CdpPipeConnection` implements the existing `CdpMultiplexConnectionLike` contract, including flattened target-session `sessionId` routing. That lets the same `CdpTargetSessionRouter`, `MultiPageCdpAgent`, semantic interaction engine, and task engine run on top of the in-repo transport.

```text
Node process
   |
   +-- child_process.spawn()
   |
   v
Chromium --remote-debugging-pipe
   | fd 3 commands / fd 4 responses+events
   v
CdpPipeConnection
   |
   v
CdpTargetSessionRouter
   |
   +-- browser-root target lifecycle
   |
   +-- flattened per-page RoutedCdpSession
            |
            v
      pure CDP semantic engine
            |
            v
      MultiPageCdpAgent
            |
            v
      MultiPageTaskEngine
```

No local debugging HTTP port is opened by this path.

## One-call semantic browser agent

```ts
import { launchStandaloneBrowserAgent } from './dist/src/index.js';

const browser = await launchStandaloneBrowserAgent({
  chromium: {
    executablePath: process.env.CHROMIUM_BIN,
    headless: true,
  },
  page: {
    networkActivity: true,
  },
});

try {
  await browser.taskEngine.refresh();
  await browser.taskEngine.navigate('https://example.com/');
} finally {
  await browser.shutdown();
}
```

The compatibility Playwright input adapter remains available for callers that already have such an environment, but the project itself does not require it for Chromium startup, page/session routing, semantic observation, input, navigation, or multi-page task execution.

## Process lifecycle

`launchStandaloneChromium()`:

1. resolves an explicit Chromium executable, environment override, or a small set of common platform paths;
2. creates a disposable profile when `userDataDir` is omitted;
3. launches Chromium with the remote-debugging pipe;
4. creates `CdpPipeConnection` over fd 3/4;
5. verifies the transport with `Browser.getVersion` before returning;
6. exposes target listing, first-page attachment, page creation, activation, and closing through the existing router.

`shutdown()` first disposes routed sessions, asks Chromium to close, then uses a bounded forced-exit fallback. Temporary profiles are removed unless preservation was explicitly requested.

Chromium sandboxing is not disabled by default. `noSandbox: true` exists only as an explicit option for local/container environments that cannot run the sandbox.

## Transport bounds and failure semantics

The pipe connection is fail-closed and bounded:

- maximum bytes per framed CDP message;
- maximum number of commands awaiting replies;
- per-command timeouts;
- malformed JSON closes the transport and rejects pending work;
- protocol error code/message/data are preserved in `CdpProtocolError`;
- late replies after a timeout are ignored;
- event-listener exceptions are isolated from transport parsing and can be surfaced through `onListenerError`.

These bounds matter because the transport is foundational: a broken listener or unbounded pending-command queue must not destabilize a long-running task or realtime control session.

## Local validation

The normal unit suite includes deterministic stream-level framing/regression tests. The Chromium suite includes two additional local fixtures:

- direct process/runtime smoke: launch, version handshake, attach first page, create/activate/close another page, and temporary-profile cleanup;
- standalone semantic-agent smoke: launch the same raw-pipe runtime, select a page through `MultiPageCdpAgent`, then verify semantic button activation and text entry through `MultiPageTaskEngine`.

No GitHub Actions or Windows Tester is required for these tests.

## Current boundaries

The runtime is deliberately Chromium/CDP-specific today. Independence from browser-automation frameworks is different from browser-engine portability: Firefox/WebKit would need native protocol/runtime implementations rather than a Playwright abstraction layer.

The next general-web slices should build on this runtime instead of adding framework-specific page APIs. In particular, task planning, downloads/uploads, permissions, clipboard/media, authentication flows, and long-running process state should depend on the repo's own browser/session contracts.
