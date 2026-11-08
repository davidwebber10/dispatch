# Changelog

## Unreleased

- The Coach is off by default. A new install starts with it off, and so does an install where the
  owner never turned it on. An owner who turned it on (or who had turned the Prompt coach on) keeps
  it on. Turn it on in Settings, Plugins.
- Only the person's own words count: messages between agents, task notifications, command echoes,
  the compaction summary and file-attach lines are never read as the person. Agent threads are left
  out of project and range reviews and the look back.
- One-word go-aheads and short check-ins ("proceed", "status?") are normal, never a tip, and never
  quoted.
- Reviews spread findings across threads and quote only the person's own lines.
- A quality gate: more evidence, both "own words" and "would a tip change the next prompt" must be
  yes, a confidence of 0.85, and no second card of a type within 14 days of the last one.
- A one-off clean of the notes on the first load: old records that were not the person's go, and a
  look back read with the old rules offers Run again.

## 1.0.0

The Coach replaces the Prompt coach. It is on by default, with a welcome card first that can turn
it off; an owner who had turned the Prompt coach off keeps the Coach off. Old Prompt
coach observations are not carried over.
