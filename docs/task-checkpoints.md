# Task checkpoints

`src/agent/taskCheckpoint.ts` defines a pure, versioned checkpoint/replay data model for a future `TaskRuntime` recovery integration. This module does not invoke a browser and does not modify or depend on `TaskRuntime` execution behavior.

## What a checkpoint contains

A version 1 checkpoint contains only restart-validation state:

- an explicit caller-supplied program ID plus a deterministic SHA-256 hash of the complete task-program definition;
- the next step ID to execute;
- total steps already executed, per-step visit counts, and the consecutive no-progress counter;
- the original execution ceilings for total steps, visits per step, and consecutive no-progress attempts; and
- one opaque lowercase-hex browser-state fingerprint captured from the existing observation channel.

The codec deliberately has no extension bag or arbitrary metadata field. Unknown fields are rejected on encode and decode so callers cannot accidentally smuggle unrelated browser or user data into persisted checkpoints.

## Privacy boundary

Checkpoint payloads must not contain trusted input values, typed text, page/document excerpts, URLs or titles, DOM snapshots, cookies, authentication tokens, approval material, amounts, counterparties, file contents, or other browser content. Step IDs and the caller-supplied program ID are treated as non-sensitive program metadata and are length-bounded; callers should therefore keep those identifiers opaque and non-sensitive.

The program itself is never serialized into the checkpoint. `hashTaskProgram()` canonicalizes the in-memory program and stores only its SHA-256 digest. That digest detects a changed program definition without persisting the program's literal values. As with any plain digest, it should not be treated as encryption for low-entropy program literals; sensitive values belong in trusted runtime inputs rather than static program text.

Trusted values are supplied again after restart with `bindTrustedTaskResumeInputs(program, trustedInputs)`. The helper selects only input names declared by the current program and returns an ephemeral object for the future runtime integration. It never writes those values into a checkpoint and never includes values in missing-input errors.

## Deterministic codec and integrity

`serializeTaskCheckpoint()` emits canonical JSON with sorted object keys and sorted visit counters. Re-serializing a decoded checkpoint produces the same byte string.

The serialized envelope includes a SHA-256 digest over the canonical checkpoint payload. `deserializeTaskCheckpoint()` rejects malformed JSON, unknown schema fields, malformed digests, unsupported checkpoint versions, payloads larger than 64 KiB, and integrity mismatches before returning a checkpoint.

The SHA-256 envelope is corruption detection, not an authenticated signature. A party that can rewrite both the payload and digest can forge a new internally consistent checkpoint. Persist checkpoints in trusted storage, or add an external authenticated-storage/MAC layer at the integration boundary if adversarial storage is in scope.

## Resume compatibility

`checkTaskCheckpointCompatibility()` is intentionally fail-closed. A checkpoint is not resumable when any of these conditions hold:

- **wrong program** — the supplied program ID differs;
- **modified program** — the ID matches but the deterministic program hash differs;
- **impossible step** — the current step or a visit counter references a step absent from the current program;
- **malformed counters** — visit counters are duplicated, exceed their configured ceiling, or do not add up to the stored executed-step count;
- **exhausted budget** — total steps are exhausted, the current step has consumed its visit allowance, or the consecutive no-progress allowance is exhausted;
- **browser state unverified** — the caller does not provide the current browser fingerprint; or
- **browser state mismatch** — the current fingerprint differs from the persisted fingerprint.

Checkpoint version rejection happens during decoding before compatibility checks.

The stored budgets are ceilings, not fresh allowances. A restart must not replenish total-step, per-step-visit, or no-progress budgets.

## Size and cardinality bounds

The encoded checkpoint is capped at 64 KiB. Program IDs and step IDs are capped at 128 UTF-8 bytes, visit tables at 256 distinct entries, and integer budgets/counters at 1,000,000. These bounds keep persistence predictable and prevent a checkpoint from becoming a general-purpose data container.

## Intended future integration

A future `TaskRuntime` integration can checkpoint only at safe step boundaries, with `cursor.stepId` representing the next step to execute and `cursor.stepsExecuted` equal to the sum of completed visit counts. On restart it should:

1. decode and integrity-check the persisted checkpoint;
2. load the trusted current task program and explicit program ID;
3. capture a fresh non-sensitive browser-state fingerprint;
4. run compatibility checks;
5. re-bind trusted input values through `bindTrustedTaskResumeInputs()`; and
6. resume using the stored counters and original budget ceilings.

This branch intentionally stops before step 6: `src/agent/taskRuntime.ts` is not modified here.
