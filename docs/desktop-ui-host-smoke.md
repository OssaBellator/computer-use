# Desktop UI native host smoke validation

`tests/nativeDesktopHostSmoke.test.ts` is deliberately opt-in. Normal deterministic tests do not require a desktop session, accessibility permission, screen-capture permission, or a platform helper.

The smoke test is **observation-only**. It enumerates a bounded window set, requests one bounded accessibility observation, and requests one bounded visual observation. It never calls `adapter.act()` and therefore does not emit keyboard, pointer, or focus input.

## Enabling locally

Set:

- `RUN_NATIVE_DESKTOP_SMOKE=1`
- `NATIVE_DESKTOP_HELPER` to a trusted helper executable
- `NATIVE_DESKTOP_PLATFORM` to exactly one of `windows-uia`, `macos-accessibility`, or `linux-atspi`

Optional:

- `NATIVE_DESKTOP_HELPER_ARGS_JSON` as a JSON array of fixed helper arguments
- `NATIVE_DESKTOP_RELATIVE_POINTER=1` only when the helper's `describe` response also advertises `relative-pointer`

The smoke path uses `StdioDesktopBridgeExecutor` and `ContractCheckedDesktopPlatformBridge`, so requests are not placed in argv, helper protocol/platform claims are checked, and native acquisition remains bounded.

The helper must implement the version-1 `describe`, `enumerate-windows`, `accessibility`, and `visual` operations used by the stacked production bridge. Ordinary OS accessibility/screen-capture permissions still apply and are never bypassed.

A passing smoke establishes only that the local helper can safely provide bounded native observations through the adapter seams. It does not establish application-domain correctness and it does not exercise native input dispatch.
