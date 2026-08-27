# DP11 completion audit

## Source status

The originally supplied `DP11 preparation and expansion^.docx` physically truncates during DKG-84, so the repository's earlier audit could only prove DKG-79 through DKG-83 from that file. A later fuller DP11 expansion reviewed during implementation provides high-level DKG-84 embodiment-routing, DKG-85 evaluation, DKG-86 progressive-enablement, and stronger production-gate criteria. This audit therefore no longer treats DKG-85/DKG-86 as undefined; it separates mechanism coverage, empirical evidence, and remaining production proof.

## Requirement status

| Package | Status | Repository evidence | Remaining gap |
| --- | --- | --- | --- |
| DKG-79 | implemented / source-proven | SHA-pinned contracts, effect/trust/retention/verification audits, Windows Tester publication receipts | production proof is governed by the shared DP11 release gate |
| DKG-80 | implemented / source-proven | production UIA host, generation identity, bounded cache, event invalidation, exact-target pattern actions, modal/integrity/ambiguity handling, stale-control tests, secret-value redaction | broader application/provider coverage remains evaluation work |
| DKG-81 | implemented / source-proven | exact HWND WGC, DPI/frame generation, transient retention, one-shot grounding payload, frame-bound coordinates, guarded native input, foreground/human-interference/UIPI gates | broader application/provider coverage remains evaluation work |
| DKG-82 | implemented for visible criteria | effect authority, untrusted-content zero authority, pre-dispatch revalidation, sticky UNKNOWN, semantic verification, weak visual evidence, privacy retention, sensitive-field handling | shared production gate still needs quantitative hostile-content/recovery/privacy evidence |
| DKG-83 | implemented / source-proven | granular neutral capability profile plus Windows-to-neutral capability projection; no single omnipotent computer-use permission | production enablement must continue using granular capabilities, not a global permission |
| DKG-84 | mechanism implemented; production evidence partial | exact-target UIA support probing; authority-preserving routing; bounded per-candidate reliability/verification/cost/foreground/risk scores; full candidate/selection DecisionExposure; authoritative-conflict blocking; VM/host provider-difference evidence | expand routing corpus across applications/providers and establish release thresholds; scores are peer tie-breakers only and cannot cross authority tiers |
| DKG-85 | evaluation mechanism implemented; sourced baseline complete; production corpus incomplete | explicit seven-stratum evaluation ledger; replay-identifiable provenance; fresh protected-VM semantic-only/raw-only WinForms evidence; exact-SHA automated recovery, long-horizon, grounding, and hostile-content evidence; WPF provider-diversity evidence; baseline has one passing sourced case in every stratum | one case per stratum is not production proof: release policy now measures attempted count, success rate, distinct embodiment breadth, and distinct source breadth per stratum; broader application diversity, fault campaigns, thresholds, and release-environment runs remain required |
| DKG-86 | progressive-enablement mechanism implemented; production policy incomplete | exact CU-0 through CU-8 level vocabulary; validated complete policy table; granular capability requirements; partial/unsupported capability blocks eligibility; adjacent levels do not implicitly inherit requirements; level assessment explicitly grants no authority | define and approve the concrete production CU-level capability/evaluation policy and bind rollout/disablement criteria to release evidence |

## Current empirical receipts

- `a43015db804b28b338af1a9cd76c00e1df860895` — CU progressive-enablement mechanism, exact receipt `xrc_mtb427va_f0d5d32d439491bc154a01b7`, 249/249 PASS.
- `270f092a7eb1863b224f91a9cf46bba19c879e51` — sourced DKG85 baseline evidence, exact receipt `xrc_mtb4sdji_8e1951981cf965689f2976c6`, 251/251 PASS.
- Fresh protected-Windows-Sandbox smoke evidence on the unchanged WinForms target separately proved `semantic-only` Value/Invoke/RangeValue/Window execution and verification plus `raw-only` equivalent text/button, range=73, and minimize/restore effects. Raw success remains weak evidence and never upgrades to semantic authority.
- Exact committed WPF target `ce14a09a64de03862226b945ff7d4d2bfb827e79` broadens provider coverage: normal-host run `uca_wpf_exact_host_27aug26_z11a` exposed Value/Invoke/Toggle/RangeValue/SelectionItem/Window and verified every transition, while protected-VM run `uca_wpf_exact_vm_27aug26_z62b` failed before semantic dispatch with COM `0x8000401A`. The expanded DKG85 corpus retains that VM result as a failed grounding/provider-availability case. The native UIA host now classifies COM/invalid-operation failures during window/control resolution and snapshot revalidation as pre-dispatch `inaccessible`, allowing routing to treat the semantic embodiment as unsupported without claiming an action occurred; the pattern-dispatch boundary remains unchanged and post-boundary exceptions remain sticky UNKNOWN. Exact self-contained artifact runs from `38969949b6107b6266cf8e386a09b2ca96c16d8f` then exercised both recovery branches: protected-VM run `uca_dp11_wpf_sha_pinned_vm_0827_02` saw semantic UIA unavailable before dispatch, considered raw fallback, could not establish foreground authority, and refused raw dispatch; normal-host run `uca_dp11_wpf_sha_pinned_host_0827_01` completed every semantic action and verification with no raw fallback. The corpus records both outcomes with their exact run identities.
- Exact published WinForms smoke `2af373cf4375c2d4a9ff73a35900f5dfbb27ee93` supports bounded batch repetitions. Protected-VM batch sources `uca_smoke_repeat_vm_sem5_27aug26_au11` and `uca_smoke_repeat_vm_raw5_27aug26_au72` each completed 5/5 iterations. These raise attempted/repetition counts while remaining one source each, so they cannot manufacture source breadth.
- The expanded corpus also splits independently tested safety/fault behaviors into a 14-case automated campaign pinned to exact suite SHA `f0b429e13a3ddca588804298feb7450859c6a6c6` / receipt `xrc_mtb6ibe2_e68af5f20368acfe237072ca`: four grounding cases, four recovery/fault cases, four long-horizon cases, and two hostile-content cases. This improves fault/source breadth but is not counted as new application diversity.

## Stronger production gate still open

DP11 must not be promoted merely because all mechanisms exist. The production gate still needs a release-facing quantitative corpus that demonstrates, at minimum:

- no blind retry after possible consequential dispatch;
- no consequential success asserted solely from dispatch;
- authoritative state-transition verification where semantic verification exists;
- prompt-injection/hostile-content authority isolation;
- human-interference handling and UNKNOWN semantics;
- routing quality and fallback visibility across multiple embodiments/providers;
- recovery/fault-injection behavior, including stale identity and process-loss cases;
- privacy/secret-retention behavior for credential-adjacent workflows;
- cross-embodiment equivalence without authority flattening;
- long-horizon suspend/resume, re-authentication, anti-rollback, and hierarchical-task behavior;
- explicit disablement/progressive-enablement policy with no automatic authority inheritance.

## Release decision

`main` promotion remains blocked, but no longer because DKG-84 through DKG-86 are undefined. It is blocked because the implementation has reached **mechanism-complete / baseline-evidence-present** status without yet reaching **production-proof-complete** status.

Promotion should require an explicit production-gate policy with quantitative thresholds, a DKG85 corpus satisfying that policy in the release environment, and a reviewed DKG86 CU-level rollout/disablement mapping. Until those conditions are met, `dp11-leading-edge-foundations` remains the integration branch and `main` stays unchanged.
