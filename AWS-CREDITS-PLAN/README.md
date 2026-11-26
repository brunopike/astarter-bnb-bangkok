# What AWS credits would fund

A market observation has to arrive before a decision can use it. Astarter would use cloud credits to collect observations on time, retain their original bytes and check each paper decision again after its market closes.

## What already runs

| GitHub Actions workflow | Verifiable work |
| --- | --- |
| **Refresh public Brain history** | Configured for 05:37 UTC daily and manual dispatch. Chain and market records are collected and validated separately. A public manual run on 26 November 2026 completed collection, validation and publication. [Workflow](../.github/workflows/brain-history.yml) · [Completed run](https://github.com/brunopike/astarter-bnb-bangkok/actions/runs/45888030503) |
| **Deep Brain paper trade** | Changes to Deep Brain or its workflow trigger Node.js 24 tests, an independent verification pass and a paper run. All three steps passed in the linked push run. [Workflow](../.github/workflows/deep-brain.yml) · [Completed run](https://github.com/brunopike/astarter-bnb-bangkok/actions/runs/45896213827) |

## Proposed AWS workload

1. **Collect before the cutoff.** Schedule the existing collectors with EventBridge Scheduler and ECS tasks. Record source time, arrival time and collection gaps for each venue. [Chain collector](../src/astarter-frontend/scripts/update-brain-chains.py) · [Market collector](../src/astarter-frontend/scripts/update-brain-markets.py)
2. **Preserve the decision and its inputs.** Store dated source responses and decision records in versioned S3 objects. Give each record a content hash so a reviewer can check which bytes the agent saw.
3. **Reconcile after the close.** Schedule the forward paper worker with persistent storage for its ledger. Compare the later venue observation with the registered instruction. Archive the resulting receipt and surface missed sessions or pending receipts. [Forward worker](../src/deep-brain/scripts/brain-proof-forward.mjs) · [Execution checks](../src/deep-brain/brain-execution-invariants.mjs)

We would report **AWS cost per verified asset-session** by dividing collection, storage and reconciliation spend during a UTC reporting period by the number of distinct asset-session pairs verified in that period. The report would also show expected sessions, late observations and pending receipts to make gaps visible.

## BNB Bangkok award eligibility

The event allocates AWS credits to the three leading teams and ten selected projects, primarily through the final-day startup pitch. A company can receive one award. The organizers and AWS determine eligibility, including valid business registration and the AWS Activate requirements. [HackQuest award criteria](https://www.hackquest.io/hackathons/BNB-Bangkok) · [AWS Activate](https://aws.amazon.com/startups/credits/)
