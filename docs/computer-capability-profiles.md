# Computer-use capability profiles

The integrated computer-use runtime is broader than the standalone Chromium runtime, so capability reporting is intentionally split into historical browser profiles and a separate environment-neutral computer-use composition.

`standalone-chromium-0.43` remains the historical browser profile. Its meaning is not widened to include desktop UI, filesystem, process, terminal, remote-session, system/device, local-compute, document-model, or other non-browser environments. The current integrated source profile is `computer-use-integrated-0.43`, defined in `src/computer/computerUseCapabilityProfiles.ts` as a composition of independently scoped component profiles.

## Implementation status vocabulary

Computer-use profiles use five implementation statuses:

- `implemented`: usable source behavior exists in the stated scope now.
- `implemented-foundation`: the neutral model/runtime semantics exist, but the broad end-user capability is not fully integrated.
- `backend-required`: the neutral adapter/backend contract exists, but production behavior depends on a backend that core does not provide.
- `partial`: some real behavior exists, but the capability is incomplete even within its stated scope.
- `unsupported`: current source intentionally does not provide the capability.

The profile also records one or more scopes. Composition means that a capability exists in at least one recorded scope; it does not mean every environment implements that capability.

## Current source distinctions

The profiles intentionally preserve boundaries that are easy to overclaim:

- Filesystem observation and bounded UTF-8 reads are implemented. Filesystem write, move/copy, delete, archive/compression, backup/restore, and storage partitioning are not implied and remain unsupported by the filesystem adapter.
- Process listing/inspection is implemented. The process adapter advertises observation/inspection only and rejects lifecycle actions; terminal child spawning is not treated as general process lifecycle control.
- Terminal argv/shell execution is implemented as bounded process execution with executable/cwd identity binding and dispatch ambiguity handling. It is not local compute.
- Local compute is a registered-operation, trusted in-process cooperative execution model. Deadlines and memory are cooperative/accounting bounds, not hard isolation, and the generic adapter is not a production ML/model runtime.
- Desktop UI has an environment-neutral `NativeDesktopUiBackend` contract and adapter semantics. This is reported as `backend-required`, not as production Windows/macOS/Linux desktop support; the synthetic backend is not production OS support.
- Remote-session code models SSH/RDP/VNC session identity, bounded observation, and dispatch outcomes, but production transports are backend-provided. A dispatched remote command/input is not by itself proof of the remote application's semantic effect, so application side-effect verification remains partial.
- System/device code has bounded observation/mutation contracts, approval/ledger/baseline/verification seams, and explicit unsupported high-risk operations. Production privileged behavior still requires a backend. Disk partitioning/destructive storage, firmware flashing, firewall/antivirus mutation, privileged account mutation, and software installation are not promoted by the profile.
- Document identity/observation/intent/verification modules are semantic foundations. They do not imply production Office, spreadsheet, presentation, CAD, or media-editor integration.
- Realtime/game/media modules provide neutral acquisition/calibration/control foundations, while the historical browser profile separately records the browser realtime capabilities it actually implements.
- `ComputerTaskRuntime` now restores validated execution-bound checkpoints, retains unresolved-dispatch state, emits checkpoints, gates approval-required effects, and carries verification decisions. Domain/application verification remains adapter- or verifier-specific.

## High-risk explicitness

`HIGH_RISK_COMPUTER_CAPABILITIES` identifies capability classes that must remain explicit in complete profiles. `validateComputerUseCapabilityProfile(..., { requireComplete: true, requireExplicitHighRisk: true })` mechanically rejects an integrated profile that omits those states, preventing omission from being mistaken for support.

This profile layer describes current source behavior only. It is not a roadmap and should not be advanced when only an interface, test double, or planned backend exists.
