# Cross-adapter integration test matrix

This matrix is intentionally deterministic. It uses synthetic adapters, runtime-owned data, and bounded local-style payloads only. It does not require external machines, GitHub Actions, Windows Tester, purchases, payments, bookings, publication, or security/system mutation.

| Scenario | Adapters / boundary | Deterministic assertion | Coverage |
| --- | --- | --- | --- |
| Browser -> filesystem read | browser -> filesystem | one task routes consecutive observations to the explicit adapter IDs | `computerCrossAdapterIntegration.test.ts` pipeline |
| Filesystem -> local compute | filesystem -> local-compute | compute action executes exactly once after filesystem observation | pipeline |
| Local compute -> terminal/process | local-compute -> process -> terminal | process observation precedes terminal action; terminal approval is explicit | pipeline |
| Process observation -> terminal acknowledgement | process -> terminal | terminal result is dispatched-once + verified and completes | pipeline |
| Task runtime across multiple adapters | browser/filesystem/compute/process/terminal | single runtime completes a five-adapter program | pipeline |
| Target generation changes between observation/freshness and action | desktop-ui | second freshness check returns a new generation; action count remains zero | target generation test |
| Approval then target changes before dispatch | remote-session | approval runs once; second freshness check detects generation change; action count remains zero | approval-generation race |
| Adapter returns unknown dispatch | terminal | runtime terminates `unknown-dispatch` and does not retry | unknown-dispatch tests |
| Verifier throws after dispatched-once | browser -> terminal | checkpoint records unresolved dispatched action before verifier failure | verifier-throw cross-adapter |
| Checkpoint resume after unknown dispatch | terminal -> resumed terminal | resume returns `reconciliation-required`; action count remains zero | unknown-dispatch resume |
| Completed action is never redispatched | local-compute -> filesystem | completed checkpoint skips compute on resume | completed-never-redispatched |
| Side-effecting retry only after definite not-dispatched | terminal | first `not-dispatched` failure retries once; `unknown` never retries | definite-retry / unknown-no-retry |
| Observation retention bounded across adapters | eight browser adapters | retained metadata is capped at runtime limit; dropped count is exact | bounded multi-adapter observations |
| Evidence/data remains machine-shaped/private | adapters + runtime | raw observation payload is absent from runtime records; evidence is bounded by existing runtime path | bounded observations plus existing runtime review tests |
| Caller mutates program/request/result during awaited gates | terminal | approval mutation cannot change snapshotted request; verifier mutation of shared adapter result cannot change runtime-owned result snapshot | mutation-gates |
| Malformed/hostile proxy or accessor result | remote-session | accessor throw is converted to unknown dispatch, never safe-to-retry | hostile-result |
| Acquisition limits enforced before materialization | filesystem | synthetic adapter sees `maxItems=3` before creating exactly three records | acquisition-limits |
| Targetless routing uses `adapterId` | two local-compute adapters | only requested adapter receives action | targetless-routing |
| Desktop/realtime synthetic control | desktop-ui | synthetic realtime control executes through common task runtime | realtime-remote composition |
| Remote-session synthetic transport + task runtime | remote-session | transport action runs as the next runtime step without external remote host | realtime-remote composition |

## Existing hardening reused by this layer

The integration suite composes, rather than replaces, lower-level review coverage. Existing tests already exercise immutable executable snapshots, accessor rejection in task programs, snapshot item/byte budgets, metadata-only observation retention, bounded evidence, verifier exceptions after known/unknown dispatch, and trusted checkpoint provenance. The cross-adapter tests above deliberately route those invariants through multiple registered adapters and task transitions.

## Safety and locality

All adapters in the new suite are in-memory synthetic implementations of `ComputerEnvironmentAdapter`. The terminal-shaped payload is only an inert argv-shaped test value; the synthetic terminal adapter never spawns it. No test performs a real purchase, payment, booking, transfer, publication, security change, system mutation, remote-machine operation, or external network action.
