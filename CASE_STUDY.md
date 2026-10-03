# Bounded Computer-Use Runtime — Case Study

## Problem

Computer-use systems can mistake transport success for task success. Once that happens, retries may target stale UI state or repeat an action whose side effect is uncertain.

This repository explores a stricter model: freshness, authority, dispatch, verification, and recovery are separate states rather than one boolean success value.

## Constraints

- Browser, terminal, filesystem, desktop UI, process, remote-session, device, and compute environments have different semantics and should not be flattened into a fake universal DOM.
- A target may become stale after observation.
- Consequential actions may require explicit approval.
- Dispatch can succeed while the higher-level effect remains uncertain.
- A non-replayable action must not become retry-safe merely because verification was interrupted.
- Platform-specific adapters have uneven maturity; the public documentation must distinguish foundations from production-validated backends.

## Design decisions

1. **Generation-aware identity.** Surfaces and entities can carry adapter-scoped generations so freshness is an explicit authority claim.
2. **Explicit effect classes.** The runtime distinguishes observe-only and local-reversible work from destructive, external, security-sensitive, remote, or hardware-affecting actions.
3. **Approval before consequential dispatch.** Approval is part of the action boundary rather than an after-the-fact annotation.
4. **Sticky dispatch uncertainty.** Ambiguous side effects are preserved as uncertainty instead of silently converted into a retryable failure.
5. **Independent verification.** A successful dispatch is not treated as proof that the requested state change occurred.
6. **Checkpoint/recovery semantics.** Runtime traces retain enough bounded evidence to reason about continuation without assuming replay is safe.

## Implementation

Reviewer entry points:

- [`src/computer/environmentAdapter.ts`](./src/computer/environmentAdapter.ts) — neutral adapter contract.
- [`src/computer/computerTaskRuntime.ts`](./src/computer/computerTaskRuntime.ts) — cross-adapter runtime.
- [`src/computer/browserEnvironmentAdapter.ts`](./src/computer/browserEnvironmentAdapter.ts) — browser adapter.
- [`docs/computer-use-architecture.md`](./docs/computer-use-architecture.md) — architecture and authority model.
- [`docs/task-checkpoints.md`](./docs/task-checkpoints.md) — checkpoint model.
- [`tests/computerTaskRuntime.test.ts`](./tests/computerTaskRuntime.test.ts) — focused runtime safety tests.
- [`tests/integration/standaloneChromiumSmoke.test.mjs`](./tests/integration/standaloneChromiumSmoke.test.mjs) — Chromium integration smoke.

Chromium is the strongest end-to-end environment in the repository. Other areas range from concrete read-only adapters to backend-neutral foundations.

## Verification

A focused `ComputerTaskRuntime` safety-suite run captured on 2026-10-03 passed **21/21 tests**.

That focused suite exercises:

- target freshness;
- approval;
- retry behavior;
- dispatch uncertainty;
- verification;
- checkpointing;
- non-replayable outcomes.

The README deliberately labels this as focused runtime proof rather than a whole-repository green-build claim.

## Limitations

- The 21/21 result is not evidence that every repository build and test surface is green.
- The repository still has compile/build drift outside the focused proof surface; no broader clean-build claim is made here.
- Chromium is the strongest complete runtime. Several other adapters are neutral foundations, reference implementations, or read-only implementations rather than uniformly production-validated platform backends.
- Experimental Windows provider work has its own validation boundary and should be judged from that PR's recorded evidence rather than inferred from the neutral runtime tests.

## What this demonstrates for a client

This project demonstrates safety-oriented agent runtime design: stale-target handling, authority separation, approval gates, conservative retry rules, dispatch/verification separation, checkpointing, and honest scoping when only part of a larger repository has been validated.