# E3 Agent evaluation result

- Run: `2026-09-03T10-56-48-838Z`
- Status: **failed**
- Scope: local-agent, full-suite, build
- Started: 2026-09-03T10:56:48.838Z
- Finished: 2026-09-03T10:56:59.772Z
- Privacy: no raw prompts, answers, tool arguments, tool results or secrets were stored.

## Steps

| Step | Status | Exit | Duration |
|---|---|---:|---:|
| TypeScript | passed | 0 | 1637 ms |
| Agent tests | passed | 0 | 727 ms |
| Full repository tests | failed | 1 | 3028 ms |
| Next.js production build | passed | 0 | 5540 ms |

## Datasets

| Dataset | Cases | Status | Source |
|---|---:|---|---|
| main-agent-business | 9 | validated only | `evals/agent-business.json` |
| business-agent-regression | 13 | validated only | `evals/business-agent.json` |
| knowledge-rag | 40 | validated only | `evals/knowledge-rag.json` |

## Release gates

```json
{
  "deterministicWorkflowAccuracy": 1,
  "skillToolsetRoutingAccuracy": 0.98,
  "toolSelectionAccuracy": 0.95,
  "knowledgeRecallAt5": 0.9,
  "citationCorrectness": 0.98,
  "groundedFactAccuracy": 0.95,
  "correctAbstentionRate": 0.95,
  "permissionLeakRate": 0,
  "writeOperationCount": 0
}
```

Notes: Live dataset scoring was not run. Use --live with a signed-in read-only session. Non-passing steps: Full repository tests. Review console output; raw output is not copied into result files.
