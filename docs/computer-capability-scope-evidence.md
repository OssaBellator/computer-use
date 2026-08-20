# Computer capability scope evidence

Integrated computer-use profiles report the strongest implementation state found across their component profiles. Their `scopes` field is provenance: it records environments that contributed an explicit state, including explicit `unsupported` evidence. It must not be read as "supported in every listed scope".

Use `collectComputerCapabilityScopeEvidence` when a caller needs an environment-by-environment answer. The helper keeps states separate by scope, chooses the strongest state only among claims for the same scope, and retains the contributing profile ids and notes.

For example, `terminal-execution` can be `implemented` in the terminal scope while remaining explicitly `unsupported` in browser and local-compute scopes. Likewise, browser document editing can remain `partial` while the environment-neutral document model is only an `implemented-foundation`.

This distinction prevents integrated composition from widening an adapter's actual source behavior and keeps unsupported/backend-required evidence mechanically visible to policy or diagnostics code.
