# E3 Agent evaluation result

- Run: `2026-09-03T19-30-25-181Z`
- Status: **passed**
- Scope: local-agent, full-suite
- Started: 2026-09-03T19:30:25.181Z
- Finished: 2026-09-03T19:30:30.942Z
- Privacy: no raw prompts, answers, tool arguments, tool results or secrets were stored.

## Steps

| Step | Status | Exit | Duration |
|---|---|---:|---:|
| TypeScript | passed | 0 | 1648 ms |
| Agent tests | passed | 0 | 959 ms |
| Evaluation validator tests | passed | 0 | 134 ms |
| Full repository tests | passed | 0 | 3017 ms |

## Datasets

| Dataset | Cases | Status | Source |
|---|---:|---|---|
| main-agent-business | 20 | validated only | `evals/agent-business.json` |
| business-agent-regression | 13 | validated only | `evals/business-agent.json` |
| knowledge-rag | 40 | validated only | `evals/knowledge-rag.json` |

## Release gates

```json
{
  "deterministicWorkflowAccuracy": 1,
  "structuredQueryPlanAccuracy": 1,
  "structuredPlanToolCoverageAccuracy": 1,
  "structuredPlanTrajectoryAccuracy": 1,
  "structuredPlanDimensionAccuracy": 1,
  "crossDomainAnswerCoverageAccuracy": 1,
  "skillToolsetRoutingAccuracy": 0.98,
  "toolSelectionAccuracy": 0.95,
  "knowledgeRecallAt5": 0.9,
  "citationCorrectness": 0.98,
  "groundedFactAccuracy": 0.95,
  "correctAbstentionRate": 0.95,
  "permissionLeakRate": 0,
  "writeOperationCount": 0,
  "tracePrivacyLeakRate": 0
}
```

Notes: Live dataset scoring was not run. Use --live with a signed-in read-only session.
