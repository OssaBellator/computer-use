# Task checkpoints

`src/agent/taskCheckpoint.ts` defines a pure, versioned checkpoint/replay data model for a future `TaskRuntime` recovery integration. It does not invoke a browser and does not modify `TaskRuntime` execution behavior. The checkpoint module uses the existing `TaskProgram` definition and validator so callers cannot accidentally hash an id-only or otherwise lossy projection of a program.

## What a checkpoint contains

A version 1 checkpoint contains only restart-validation state:

- an explicit caller-supplied program ID plus a deterministic SHA-256 hash of the complete task-program definition;
- the next step ID to execute;
- total steps already executed, per-step visit counts, and the consecutive no-progress counter;
- the original execution ceilings for total steps, visits per step, and consecutive no-progress attempts; and
- one opaque 256-bit lowercase-hex browser-state fingerprint derived from a non-sensitive resume-state projection.

The codec deliberately has no extension bag or arbitrary metadata field. Unknown fields are rejected on encode and decode so the checkpoint does not become a general-purpose persistence container.

## Privacy boundary

Checkpoint payloads must not contain trusted input values, typed text, page/document excerpts, URLs or titles, DOM snapshots, cookies, authentication tokens, approval material, amounts, counterparties, file contents, or other browser content. Step IDs and the caller-supplied program ID are treated as non-sensitive program metadata and are length-bounded; callers should therefore keep those identifiers opaque and non-sensitive.

The program itself is never serialized into the checkpoint. `hashTaskProgram()` canonicalizes the complete in-memory `TaskProgram` and stores only its SHA-256 digest. That detects a changed program definition without persisting its literal fields. A plain digest is not encryption for low-entropy program literals, so sensitive values belong in trusted runtime inputs rather than static program text.

Trusted values are supplied again after restart with `bindTrustedTaskResumeInputs(program, trustedInputs)`. The helper first requires a valid current program, selects only **own properties** whose names are declared by that program, and returns an ephemeral frozen object for future runtime integration. Prototype-chain values and unrelated keys are ignored. Trusted values are never written into a checkpoint or included in missing-input errors.

## Deterministic codec and integrity

`serializeTaskCheckpoint()` emits canonical JSON with sorted object keys and sorted visit counters. Re-serializing a decoded checkpoint produces the same byte string.

The serialized envelope includes a SHA-256 digest over the canonical checkpoint payload. `deserializeTaskCheckpoint()` rejects malformed JSON, unknown schema fields, malformed digests, unsupported checkpoint versions, payloads larger than 64 KiB, and integrity mismatches before returning a normalized checkpoint.

The SHA-256 envelope is corruption detection, not an authenticated signature. A party that can rewrite both the payload and digest can forge a new internally consistent checkpoint. Persist checkpoints in trusted storage, or add an external authenticated-storage/MAC layer at the later integration boundary if adversarial storage is in scope.

## Browser-state fingerprint boundary

Version 1 requires exactly 64 lowercase hexadecimal characters for `browserStateFingerprint`. This deliberately does **not** accept the existing 8-hex `taskObservationFingerprint()` value used for in-process progress detection: a 32-bit progress hash is too collision-prone for durable recovery validation.

The future integration must derive the 256-bit checkpoint fingerprint from a specifically reviewed, non-sensitive resume-state projection. The codec does not accept raw browser content and does not define that projection in this branch. Merely hashing secret-bearing typed values, document excerpts, cookies, tokens, amounts, counterparties, or other excluded content is not a substitute for defining a non-sensitive projection.

## Creation and resume compatibility

`createTaskCheckpoint()` is fail-closed. It rejects an invalid `TaskProgram` and refuses to manufacture a checkpoint that is already non-resumable because of impossible state, malformed counters, or exhausted stored budgets.

`checkTaskCheckpointCompatibility()` independently re-validates persisted/decoded state before resume. A checkpoint is not resumable when any of these conditions hold:

- **invalid program** — the currently supplied `TaskProgram` fails the existing task-program validator;
- **wrong program** — the supplied program ID differs;
- **modified program** — the ID matches but the deterministic complete-program hash differs;
- **impossible step** — the current step or a visit counter references a step absent from the current valid program;
- **malformed counters** — visit counters are duplicated, exceed their configured ceiling, or do not add up to the stored executed-step count;
- **exhausted budget** — total steps are exhausted, the current step has consumed its visit allowance, or the consecutive no-progress allowance is exhausted;
- **browser state unverified** — the caller does not provide the current browser fingerprint; or
- **browser state mismatch** — the current fingerprint differs from the persisted fingerprint.

Checkpoint version rejection happens during decoding before compatibility checks. The stored budgets are ceilings, not fresh allowances: restart must not replenish total-step, per-step-visit, or no-progress budgets.

## Size and cardinality bounds

The encoded checkpoint is capped at 64 KiB. Program IDs and step IDs are capped at 128 UTF-8 bytes, visit tables at 256 distinct entries, and integer budgets/counters at 1,000,000. The maximum-cardinality synthetic test verifies that a valid checkpoint remains under the byte cap and that a 257th visit entry is rejected.

## Safe restart boundary

Version 1 represents a **between-steps / before-next-step** resume point. `cursor.stepId` is the next step to execute; `cursor.stepsExecuted` equals the sum of completed visit counts. The codec intentionally has no representation for an in-flight action, partially completed wait, unverified side effect, or pending commitment. A future integration must not write a resumable checkpoint while any of those states are unresolved.

This matters for external side effects: if a process stops after dispatch but before post-action verification and durable checkpoint replacement, the old checkpoint must not be blindly replayed as proof that the side effect did not occur. Recovery for uncertain side effects must fail closed through the existing commitment/verification policy rather than converting uncertainty into an automatic retry.

## Intended future integration

A future `TaskRuntime` integration should checkpoint only at safe step boundaries and, on restart:

1. decode and integrity-check the persisted checkpoint;
2. load and validate the trusted current `TaskProgram` and explicit program ID;
3. capture a fresh 256-bit fingerprint from the reviewed non-sensitive resume-state projection;
4. run compatibility checks;
5. re-bind trusted input values through `bindTrustedTaskResumeInputs()`; and
6. resume using the stored counters and original budget ceilings.

This branch intentionally stops before step 6: `src/agent/taskRuntime.ts` remains unchanged.