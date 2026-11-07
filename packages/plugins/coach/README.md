# Coach

A bundled Dispatch plugin. It looks at how you work with AI and suggests one small next step at a
natural break: one headline, one line of why, one action. More detail only when you ask.

It replaces the Prompt coach. It is off by default; if the Prompt coach was on, the Coach starts on.

- **Where it shows:** a card under the message box after a turn ends, a Coach tab in the right
  column, and the Coach screen.
- **What it watches:** the thread events Dispatch already records (prompts you send, tool calls,
  turn ends). The worker (`worker/index.mjs`) runs the detectors, so coaching does not need an open tab.
- **What it keeps:** its documents in the plugin's own storage on your daemon. Memory facts never
  hold prompt content; the card history may keep a short excerpt, removed by Reset.
- **You control it:** how often (Off, Quiet, Normal, Chatty), quiet hours, tip types, projects to
  leave alone, mute, and what it remembers.

Design: `docs/superpowers/specs/2026-11-07-coach-design.md`.
