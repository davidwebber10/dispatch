---
project: Shopify Product Rollup
agentType: researcher
model: sonnet
authority: stage
schedule: {"type":"daily","time":"05:30"}
tz: America/Indianapolis
wallClockCapMin: 30
---
Check that last night's Shopify Product Rollup pipeline ran clean, for both stores, and
diagnose anything that didn't. The production pipeline is AWS Step Functions + Lambda —
it does NOT run through GitHub Actions, so `gh run list` alone will miss it. The delta-sync
migration's staging validation job DOES run through GitHub Actions. Check both.

## 1. The real nightly pipeline (AWS Step Functions)

Each store has its own state machine, `shopify-product-rollup-<store>-production` (store
keys: `b2b`, `commercial` — `infra/template.yaml`'s `RollupStateMachine` resource).

```bash
aws stepfunctions list-state-machines \
  --query "stateMachines[?contains(name,'shopify-product-rollup')].[name,stateMachineArn]" --output table
aws stepfunctions list-executions --state-machine-arn <arn> --max-results 3
aws stepfunctions describe-execution --execution-arn <execution-arn>   # status: SUCCEEDED|FAILED|TIMED_OUT|ABORTED
```

On `FAILED`, pull the failed step's Lambda logs — function names are
`shopify-rollup-<step>-<store>-production` (`transfer-files`, `parse-and-join`,
`compute-rollup`, `fetch-order-counts`, `generate-patch`):

```bash
aws logs tail /aws/lambda/shopify-rollup-<step>-<store>-production --since 20h
aws cloudwatch describe-alarms --alarm-names shopify-rollup-pipeline-failures-<store>-production
```

## 2. Delta-sync validation bridge (GitHub Actions, commercial-staging only)

Delta-sync is mid-migration, not yet live in production; its exit criterion is 5
consecutive clean validation nights in `commercial-staging` (see
`docs/superpowers/plans/2026-08-12-delta-sync-engine-implementation.md` on the unmerged
`delta-sync-engine` branch). A nightly workflow feeds it real production data:

```bash
gh run list --repo polywood/shopify-product-rollup \
  --workflow=commercial-staging-delta-validation-bridge.yml --limit 3
gh run view <run-id> --repo polywood/shopify-product-rollup --log-failed
```

Track the consecutive-clean-night count in your report — it only survives between
incarnations if you write it down (your memory.md, or the digest reads your log.jsonl).

## Diagnosing and fixing

Diagnose from the logs above, never guess. If the root cause is a genuine code bug (not a
transient SFTP hiccup or a self-clearing data alarm), stage a fix on a branch and open a PR
(`git push <remote> <branch>`, `gh pr create` — authority `stage` allows this). Never merge
it, never deploy (no `gh workflow run deploy.yml` / `deploy-delta.yml`), and never re-run
the production state machine or replay a Lambda yourself — a human decides whether
replaying a partial night's data is safe.

If nothing here matches what actually happened, say so and propose the missing recipe via
`proposedBriefChanges` instead of inventing a command.

## Report

Name which store(s) ran clean vs. failed, the failed state/Lambda if any, whether you
staged a fix (link the PR), and the validation bridge's current status. `"attention"` for a
clean pipeline with something worth a glance (an alarm that fired and self-cleared);
`"failed"` only when last night's production data is actually wrong or missing.
