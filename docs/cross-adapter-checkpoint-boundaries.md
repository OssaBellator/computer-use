# Cross-adapter checkpoint boundary coverage

This follow-on documents the deterministic checkpoint portability cases added on top of the base cross-adapter integration layer.

| Scenario | Boundary | Assertion |
| --- | --- | --- |
| Completed action then later adapter unavailable | local-compute -> filesystem | JSON-round-tripped checkpoint skips the completed compute action and resumes at filesystem observation |
| Observation then unsupported action | browser -> terminal | checkpoint from preflight stop resumes against a newly capable terminal and dispatches exactly once |
| Unknown dispatch then adapter replacement | remote-session -> resumed remote-session | JSON-round-tripped checkpoint remains reconciliation-required and never redispatches |

All cases use synthetic adapters only. Checkpoints are serialized through `JSON.stringify`/`JSON.parse` before resume so the tests exercise transportable checkpoint state rather than in-memory object identity.
