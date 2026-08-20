# Task checkpoints

`src/agent/taskCheckpoint.ts` defines a pure, versioned checkpoint/replay data model for a future `TaskRuntime` recovery integration. It does not invoke a browser and does not modify `TaskRuntime` execution behavior. The checkpoint module uses the existing `TaskProgram` definition and validator so callers cannot accidentally hash an id-only or otherwise lossy projection of a program.

## What a checkpoint contains

A version 1 checkpoint contains only restart-validation state:

- an explicit caller-supplied program ID plus a deterministic SHA-256 hash of the complete valid task-program definition;
- a caller-generated opaque execution ID that identifies one logical run of that program;
- the next step ID to execute;
- total steps already completed, per-step visit counts, and the consecutive no-progress counter;
- the original execution ceilings for total steps, visits per step, and consecutive no-progress attempts; and
- one opaque 256-bit lowercase-hex browser-state fingerprint derived from a non-sensitive resume-state projection.

The codec deliberately has no extension bag or arbitrary metadata field. Unknown fields are rejected on encode and decode so the checkpoint does not become a general-purpose persistence container.

## Execution identity

Program identity is not enough to identify a resumable execution. The same `TaskProgram` can run multiple times with different trusted inputs while producing the same non-sensitive browser fingerprint. Reusing a checkpoint across those runs could otherwise skip steps performed with a different input set.

`execution.id` closes that gap. Callers must generate a fresh, non-sensitive 128-256 bit opaque identifier for each logical task execution and persist/recover the same identifier with that run. Version 1 accepts 32-64 lowercase hexadecimal characters. Do not place user data in the execution ID and do not derive it from secrets, amounts, counterparties, or other trusted input values.

`checkTaskCheckpointCompatibility()` rejects a checkpoint with `wrong-execution` when the supplied execution ID does not match. This is a run-binding check, not authentication: possession of the ID is not proof of authority.

## Privacy boundary

Checkpoint payloads must not contain trusted input values, typed text, page/document excerpts, URLs or titles, DOM snapshots, cookies, authentication tokens, approval material, amounts, counterparties, file contents, or other browser content. Step IDs and the caller-supplied program ID are treated as non-sensitive program metadata and are length-bounded; callers should therefore keep those identifiers opaque and non-sensitive as well.

The program itself is never serialized into the checkpoint. `hashTaskProgram()` first requires a valid current `TaskProgram`, then canonicalizes the complete in-memory program and stores only its SHA-256 digest. That detects a changed program definition without persisting its literal fields. A plain digest is not encryption for low-entropy program literals, so sensitive values belong in trusted runtime inputs rather than static program text.

Trusted values are supplied again after restart. `bindTrustedTaskResumeInputs(program, trustedInputs)` requires a valid current program and selects only own **data properties** whose names are declared by that program. Prototype-chain values, accessors/getters, and unrelated keys are ignored. The returned object is ephemeral and frozen; trusted values are never written into a checkpoint or included in missing-input errors.

For recovery code, prefer `prepareTaskCheckpointResume(checkpoint, options)`. It validates the program ID/hash, execution ID, cursor/counters/budgets, and current browser fingerprint before reading or exposing any trusted input properties. Only after all compatibility checks pass does it bind the declared trusted inputs.

## Deterministic codec and integrity

`serializeTaskCheckpoint()` emits canonical JSON with sorted object keys and visit counters sorted by locale-independent JavaScript string code-unit order. Re-serializing a decoded checkpoint produces the same byte string regardless of host locale settings.

Created and decoded checkpoints are deeply frozen across the checkpoint object, identity records, cursor, visit table/entries, and budgets. This preserves the validated counters and execution ceilings against accidental in-process mutation between decode, compatibility checks, and future resume integration.

The serialized envelope includes a SHA-256 digest over the canonical checkpoint payload. `deserializeTaskCheckpoint()` rejects malformed JSON, unknown schema fields, malformed digests, unsupported checkpoint versions, payloads larger than 64 KiB, and integrity mismatches before returning a normalized checkpoint.

The SHA-256 envelope is corruption detection, not an authenticated signature. A party that can rewrite both the payload and digest can forge a new internally consistent checkpoint. Persist checkpoints in trusted storage, or add an external authenticated-storage/MAC layer at the later integration boundary if adversarial storage is in scope.

Integrity also does not provide freshness. `execution.id` prevents accidental cross-run reuse, but an older valid checkpoint from the **same** execution remains a validly encoded object. The future persistence layer must atomically replace checkpoints and must not roll back to an older revision. If rollback detection is required across storage failures or adversarial storage, keep a trusted external high-water mark or authenticated revision outside this codec.

## Browser-state fingerprint boundary

Version 1 requires exactly 64 lowercase hexadecimal characters for `browserStateFingerprint`. This deliberately does **not** accept the existing 8-hex `taskObservationFingerprint()` value used for in-process progress detection: a 32-bit progress hash is too collision-prone for durable recovery validation.

The future integration must derive the 256-bit checkpoint fingerprint from a specifically reviewed, non-sensitive resume-state projection. The codec does not accept raw browser content and does not define that projection in this branch. Merely hashing secret-bearing typed values, document excerpts, cookies, tokens, amounts, counterparties, or other excluded content is not a substitute for defining a non-sensitive projection.

## Creation and resume compatibility

`createTaskCheckpoint()` is fail-closed. It rejects an invalid `TaskProgram`, malformed execution identity, and any checkpoint state that is already non-resumable because of impossible graph history, malformed counters, exhausted stored budgets, or a cursor that is inconsistent with a safe between-step boundary.

`checkTaskCheckpointCompatibility()` independently re-validates persisted/decoded state before resume. A checkpoint is not resumable when any of these conditions hold:

- **invalid program** — the currently supplied `TaskProgram` fails the existing task-program validator;
- **wrong program** — the supplied program ID differs;
- **modified program** — the ID matches but the deterministic complete-program hash differs;
- **wrong execution** — the supplied logical execution ID differs or is not a valid opaque execution ID;
- **impossible step/history** — the current step or a visit counter references a step absent from the current valid program, the zero-step cursor is not the entry step, or the visited/cursor graph cannot be reached from the entry through already visited steps;
- **malformed counters** — visit counters are duplicated, exceed their configured ceiling, do not add up to the stored executed-step count, or the consecutive no-progress count exceeds the number of completed steps;
- **exhausted budget** — total steps are exhausted, the current step has consumed its visit allowance, or the consecutive no-progress allowance is exhausted;
- **browser state unverified** — the caller does not provide the current browser fingerprint; or
- **browser state mismatch** — the current fingerprint differs from the persisted fingerprint.

The graph-history check is intentionally a necessary structural check, not an attempt to recreate branch predicate results. It proves that the cursor/visited set could arise along program edges; it does not infer past page state.

Checkpoint version rejection happens during decoding before compatibility checks. The stored budgets are ceilings, not fresh allowances: restart must not replenish total-step, per-step-visit, or no-progress budgets.

## Size and cardinality bounds

The encoded checkpoint is capped at 64 KiB. Program IDs and step IDs are capped at 128 UTF-8 bytes, visit tables at 256 distinct entries, integer budgets/counters at 1,000,000, and execution IDs at 128-256 bits represented as lowercase hex. The maximum-cardinality synthetic test verifies that a valid checkpoint remains under the byte cap and that a 257th visit entry is rejected.

## Safe restart boundary

Version 1 represents a **between-steps / before-next-step** resume point. `cursor.stepId` is the next step to execute; `cursor.stepsExecuted` equals the sum of completed visit counts. The codec intentionally has no representation for an in-flight action, partially completed wait, unverified side effect, or pending commitment. A future integration must not write a resumable checkpoint while any of those states are unresolved.

This matters for external side effects: if a process stops after dispatch but before post-action verification and durable checkpoint replacement, the old checkpoint must not be blindly replayed as proof that the side effect did not occur. Recovery for uncertain side effects must fail closed through the existing commitment/verification policy rather than converting uncertainty into an automatic retry.

## Intended future integration

A future `TaskRuntime` integration should checkpoint only at safe step boundaries and, on restart:

1. decode and integrity-check the persisted checkpoint;
2. load and validate the trusted current `TaskProgram`, explicit program ID, and logical execution ID;
3. capture a fresh 256-bit fingerprint from the reviewed non-sensitive resume-state projection;
4. call `prepareTaskCheckpointResume()` with those identities plus freshly supplied trusted inputs;
5. abort if compatibility or input binding is not ready; and
6. resume using the stored cursor/counters and original budget ceilings.

The application must associate the execution ID with the same logical trusted input set across restart; the codec deliberately does not fingerprint or serialize those values.

This branch intentionally stops before step 6: `src/agent/taskRuntime.ts` remains unchanged.
