# Who hears a worker's reports

Several threads can work in one project at the same time: the overseer, threads you open
yourself, and threads Chat starts. A worker reports to the thread that started it, so a
thread's helpers never wake a different thread.

## The rule

The daemon records the starting thread in the worker's `spawnedBy` field. It sends these
notices to that thread:

- the worker finished a turn
- the worker is blocked and needs help
- the worker asked a question
- the worker was stopped or interrupted
- you sent the worker a message directly
- you answered its question in its own chat

| The worker was started by | The notices go to |
| --- | --- |
| The overseer | The overseer. It is revived if a restart stopped it. |
| An old row with no `spawnedBy` | The overseer (the old behavior). |
| A thread you opened, or another worker | That thread. |
| Chat, or any child of a Chat thread, at any depth | Chat, through its own report path. |
| A scheduled role run | Its own log and the digest (see [roles](roles.md)). |

A notice to a starter that is not the overseer is delivered the way a watch delivers: a
Pretty thread gets a message, and a CLI thread gets the text typed in and submitted.
The daemon never revives such a starter. If the starter is stopped, archived or deleted,
the daemon drops the notice and writes one line to the log. It does not fall back to the
overseer.

## What follows the same rule

- **Owner decisions.** The overseer reads the `owner-decisions` block of a worker's
  report into proposed ledger items only for a worker the overseer started. For any other
  worker the block stays in the report that goes to its starter.
- **Batch line and interim recap.** Both count only the workers the overseer started. A
  worker that another thread started does not keep the overseer's batch open and does not
  arm its interim recap timer.
- **Questions.** A question from a worker that a plain thread started goes to that thread
  as a message. The worker still shows as needing you, so you can answer it yourself. Only
  a question from an overseer worker is taken off you.

## Child threads

A thread key that starts a thread writes `spawnedBy` and the depth. When the caller is a
thread Chat started, it also writes `origin: endless`, so the whole chain under that thread
reports to Chat. Rows made before this change are resolved at notice time: a worker with a
Chat ancestor reports to Chat.

There is no setting for this.
