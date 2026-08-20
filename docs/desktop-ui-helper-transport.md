# Native desktop helper transport

The desktop platform bridge can be driven by any `DesktopBridgeExecutor`. For production helpers that may receive typed text or other sensitive UI payloads, prefer `StdioDesktopBridgeExecutor` over command-line request transport.

## Privacy boundary

`StdioDesktopBridgeExecutor` starts an explicitly configured helper with fixed snapshotted argv and writes the versioned JSON request to the helper's stdin. Dispatch payloads therefore do not become `--request` command-line arguments visible through ordinary process-list inspection.

The executor does not place helper stderr in returned errors, neutral action evidence, or adapter observations. Helper stderr is consumed only under a small bound. Error classification is deliberately generic.

This is transport minimization, not a security sandbox. The configured helper executable is trusted host authority and can observe its own stdin and inherited process environment. Callers remain responsible for selecting and securing the helper binary.

## Bounds

Before process launch the executor bounds:

- executable and fixed argument count/bytes;
- configured environment override count/bytes;
- serialized request bytes;
- requested timeout and maximum response bytes.

During execution it incrementally bounds stdout before JSON parsing. Over-budget output or timeout terminates the helper process and rejects the invocation. Stderr is not accumulated beyond its small diagnostic ceiling. Failure paths wait for helper termination acknowledgement under a separate finite cleanup deadline before settling; inability to confirm termination is reported explicitly rather than treating cleanup as complete.

## Dispatch uncertainty

The executor intentionally does not claim whether native input occurred when a helper fails, times out, disconnects, or returns malformed output. Once a desktop dispatch invocation reaches the backend/helper boundary, such failures must remain conservative. `DesktopUiEnvironmentAdapter` maps a thrown backend invocation to `dispatch: 'unknown'` rather than making a possibly emitted side effect retry-safe.

Transport success likewise does not prove application-domain success.

## Usage

Create the normal platform bridge with an explicitly supplied stdin executor, for example conceptually:

```ts
const command = { executable: '/trusted/native-helper' };
const bridge = windowsUiAutomationBridge(command, new StdioDesktopBridgeExecutor(command));
```

The same executor can be supplied to the macOS Accessibility and Linux AT-SPI bridge factories. Relative-pointer support remains an explicit helper capability and is not inferred from the transport.
