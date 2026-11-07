# Prompt coach

The coach's goal is to level you up in how you engage with AI: not as a parrot, not as a
file editor, but with leverage. After each prompt you send to a thread, it judges the prompt
against `rubric.md` (outcome, context, scope, plan, verification, leverage), names one
habit, and shows one observation and one better version under the composer. "Use this" puts
the better version in the composer; nothing is sent by itself.

The Coach screen (desktop rail, phone Plugins tab) shows your habits this week against last
week, and the recent observations.

Settings → Prompt coach: the style (quiet, normal, direct), whether it may read your prompts
at all, and projects to leave alone.

It needs `read:prompts` (to see what you send), `read:threads`, and `model:assist` (one
model call per judged prompt, metered on Settings → Plugins). It never posts to a thread.

Edit `rubric.md` to change what it values: copy the plugin to local first (Settings →
Plugins → Copy to local…), because a bundled plugin updates with Dispatch.
