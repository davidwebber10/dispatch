# Plan: a chat reply answers a pending AskUserQuestion

Status: implemented on branch `fix/ask-user-question-reply`. Base: `main` at v2.47.7 (73504b9).
Owner decisions already made: ledger N1 (reply resolves the question as a deny with the reply text, sent once, no separate user turn), N4 (deny wording), N5 (images in a reply).
Revised after the spike (agent 6a5399f4) and the design review (agent 6f39d532, approve with changes). See "Corrections" below; the sections after it are already updated.
Out of scope: the separate `askMode` setting and a blocking AskUserQuestion for the coordinator.

## Problem

Control Plane asked questions through the inline AskQuestionCard ("NEEDS YOU / paused").
The user did not like the options and typed a reply in the composer.
Nothing happened.
The card stayed up.
The Claude CLI stayed parked on its `can_use_tool` control_request.
The reply was written to stdin as a `user` turn and queued behind that request.

The card even says "or reply below" (`AskQuestionCard.tsx:127`), so the UI invites the exact action that fails.

## Corrections

The spike ran the real CLI 2.1.296. The review checked the plan against 73504b9.

1. A clear must not re-emit `permission` with `null`. `runtime/adapter.ts:69` turns every `permission` emit into `permission.requested`, which marks the thread needs-input and pushes. The manager emits a new `permission-cleared` event. `ws/structured.ts` forwards it as the `{ type: 'permission', pending: null }` frame. The adapter ignores it.
2. A null `permission` frame must not touch `busy` in `useStructuredChat.ts:581`. After a reply the client sets busy, and a null frame would flicker it off.
3. Drop the interrupt pre-deny. The CLI answers an interrupt while blocked on `can_use_tool`, and clears the question itself. It sends `{"type":"control_cancel_request","request_id":"<pending id>"}` in the same millisecond as the interrupt reply. Then come two tool_results ("The user doesn't want to proceed with this tool use... STOP..." and "[Request interrupted by user for tool use]") and a `result`. The manager handles the cancel. Clear-on-`result` stays only as a backstop.
4. In the `result` handler, the backstop clear runs BEFORE the idle and needs-help emits.
5. No optimistic client clear on Stop. The server's null frame does it. On a reply, the client does not clear the card until the POST returns 204. A 409 or 404 keeps the card and sends the text as a normal turn. A 500 keeps the card and sends nothing. On Codex, Grok and OpenCode the card therefore stays up, like today.
6. A deny with a message becomes an `is_error` tool_result with our exact text. Detect the reply prefix with `includes`, not `startsWith`, pinned by a fixture of the captured frame.
7. A plain user turn sent while a question is pending queues, and runs inside the same turn after the deny. Confirms the lost-reply bug.
8. `answer_agent` (`overseer/agency-mcp.ts:861`) sends no requestId today. The coordinator notice from `formatAgentQuestion` now names the requestId, and `answer_agent` passes it. A mismatch errors.
9. A human reply in a worker's chat sends the coordinator a dedicated `question-answered` notice: the human answered that question in the agent's chat, and `answer_agent` is not needed. Not `noteUserMessageToAgent`.
10. Images (N5): the deny carries the text. A second images-only turn is sent AFTER the deny POST resolves, so stdin order is deny then turn.
11. Discuss-empty and Dismiss denies are logged as `canned` rows, like the need-card ack.

## Verified code map

All refs checked against 73504b9.

| Ref | What is there |
| --- | --- |
| `packages/web/src/components/tabs/chat/AskQuestionCard.tsx:29-131` | The card. `autoSubmit` at :34 submits a lone single-select question on first tap (:50). Footer "or reply below" at :127. No Other, Discuss or Dismiss. |
| `AskQuestionCard.tsx:143-164, 196-271` | `parseAnsweredResult` and `AnsweredQuestionCard`. A result that does not match the CLI template falls back to showing `resultText` in italics (:254-256). |
| `packages/web/src/components/overseer/components/Stream.tsx:681-688` | Coordinator renders `<AskQuestionCard>` from `coordinatorPending`, keyed by requestId. |
| `packages/web/src/components/tabs/chat/ChatView.tsx:308-316` | Worker chat renders the same card from `pending`. |
| `ChatView.tsx:720-731` | Answered AskUserQuestion becomes `AnsweredQuestionCard` once its tool_result exists. |
| `packages/web/src/components/tabs/chat/useStructuredChat.ts:579-582` | `permission` ws frame sets `pending` (a null `pending` clears it). |
| `useStructuredChat.ts:796-798` | Pending clears only when a tool_result for its `toolUseId` arrives. |
| `useStructuredChat.ts:820-841` | `result` frame. Does not touch `pending`. |
| `useStructuredChat.ts:852-867` | `send()`. Plain `api.sendStructuredMessage`, ignores `pending`. |
| `useStructuredChat.ts:872-882` | `answer()`. Allow-only, optimistic clear, restores pending on POST failure. |
| `packages/web/src/components/overseer/store.ts:278-328` | `sendDirective`. The coordinator composer path. Calls `api.sendStructuredMessage` at :325. Never looks at `coordinatorPending`. |
| `store.ts:749-752` | `useCoordinatorSync` pushes `pending, answer` into the store. |
| `store.ts:342-360` | `needAction`. Worker need card. Deny sends no message. |
| `packages/web/src/components/overseer/live.ts:526-539` | `needFromPending` builds the worker need card from `questions[0]` only. |
| `live.ts:365-391` | Coordinator stream pairs its own AskUserQuestion with the tool_result into `answeredQuestion`. |
| `packages/web/src/api/client.ts:108-114` | `sendStructuredMessage` always tags `source: 'user'`. `answerPermission` takes `{ requestId, decision, answers, message }`. |
| `packages/core/src/routes/terminals.ts:137-154` | `POST /message`. `canned` turns are need-card acks. |
| `terminals.ts:162-176` | `POST /permission`. 404 when nothing matches. |
| `packages/core/src/sessions/service.ts:1671-1694` | `answerPermission`. Allow logs via `logQuestionCardAnswer`. Deny logs nothing and defaults the message to "Denied". |
| `service.ts:1706-1717` | `logQuestionCardAnswer`. One `user` row per answer. |
| `service.ts:1047-1063, 1071-1091` | `sendStructuredMessage` and `logCoordinatorMessage` (coordinators only). |
| `service.ts:1260-1268` | `routeAgentQuestionToCoordinator`. A worker's question is sent to the coordinator, which answers with `answer_agent`. |
| `service.ts:1737-1740` | `interrupt`. Pass-through to the manager. |
| `packages/core/src/structured/manager.ts:329-372` | `can_use_tool` handling. AskUserQuestion always becomes `session.pending` (:352-364). |
| `manager.ts:384-439` | `result` handling. Does not clear `session.pending`. |
| `manager.ts:486-516` | `sendMessage`. Writes a `user` turn. The CLI holds it until the control_request is answered. |
| `manager.ts:551-571` | `answerPermission`. Writes `control_response`, clears pending, emits `resolved`. No `permission` null emit. |
| `manager.ts:606-612` | `interrupt`. Writes the `interrupt` control_request. Leaves `pending` set. |
| `manager.ts` (whole file) | No handling of `control_cancel_request`. The installed CLI (2.1.296) does emit it. |
| `packages/core/src/ws/structured.ts:145-156` | Forwards `permission` emits. Replays a live pending on connect. No `resolved` forwarding. |
| `packages/core/src/structured/codex-manager.ts:624-634` + `codex-translate.ts:512-521` | Codex `item/tool/requestUserInput`. Deny returns `{ answers: {} }`. The message is dropped. |

Two facts the fix leans on.
First, a Claude deny `control_response` becomes the AskUserQuestion tool_result (is_error) and the turn continues.
So every viewer's card clears through the existing tool_result path at :796-798, and both answered-record renderers get a durable pair.
Second, a `permission` frame with `pending: null` already clears the client (:580). The server just never sends one.

## Design

### Reply path (required behavior 1)

Keep it on `answerPermission`, per N1. Add one field.

- `POST /permission` accepts `reply?: string`.
  Only valid with `decision: 'deny'` and a pending that has `questions`.
- `service.answerPermission` builds the deny message from `reply` on the server.
  The wording lives in one place (see "Deny wording" below).
- On delivery it logs the RAW reply text, not the wrapped message, via a new `logQuestionCardReply(terminalId, reply)`.
  This calls `logCoordinatorMessage(terminalId, reply, 'user')`, same as `logQuestionCardAnswer`.
  Ledger quote checks then match the user's own words.
- For a worker (typed agent), send the coordinator a dedicated `question-answered` notice with the reply.
  The coordinator was told the agent is paused (`service.ts:1260`). It must learn the human answered, and that `answer_agent` is not needed.
- `requestId` is REQUIRED for a reply. No fallback to "whatever is pending".
  That is the race guard (see Edge cases).

Client:

- New `replyToQuestion(text, images?)` in `useStructuredChat`, next to `answer()`.
  It reads `permissionRef.current`, sets busy, and POSTs `{ requestId, decision: 'deny', reply: text }`.
  It does not clear the card first. A 204 clears it, and the tool_result and null frame clear it everywhere.
- On 404 (the question is already gone) or 409 (this harness cannot take a reply) it falls back to `api.sendStructuredMessage(text)`.
  The words are never lost. They arrive as a normal turn. The card stays as the server reports it.
- On other errors the card stays, nothing is sent, and the error shows.
- Images (N5): after the deny POST resolves, the images go out as one images-only turn.
- `send()` in useStructuredChat routes to `replyToQuestion` when `permissionRef.current?.questions?.length` and the payload has text.
  This covers the worker ChatView.
- `sendDirective` in store.ts does the same with `get().coordinatorPending`.
  Push a `coordinatorReply` function into the store next to `coordinatorAnswer` (`store.ts:751`), so the hook owns the logic once.
- `canned` sends (need-card acks) never take this path.

Answered record:

- The deny's tool_result text starts with the fixed prefix `The user did not pick an option. They replied: `.
- `AnsweredQuestionCard` finds the prefix anywhere in the result (`includes`) and renders "answered in chat" plus the reply text, instead of the italic raw result.
- The same component serves `ChatView.tsx:728` and the coordinator stream (`live.ts:391`), so one change covers both.
- Export the prefix constants from a shared place. Web has no core import today, so duplicate the string in a small web constant and pin it with a test on each side.

### Deny wording (required behavior 2)

N1 fixes the prefix. The model also needs to know the expected next move.
A bare deny reads like "the user said no", and the model may drop the question.

Proposed full message:

```
The user did not pick an option. They replied: <text>

Treat this as their answer. If it settles the question, continue. If it pushes back on the options or asks for more context, answer them in plain text and then ask again with revised options. Do not proceed on a guess.
```

Decided as N4. The full text lives in ONE server constant. The prefix stays verbatim, so detection is not affected.

Verification is behavioral, not unit-level. See Test plan, "live model check".

### Card actions (required behavior 3)

- Remove `autoSubmit`. Every card submits through the Submit button.
- Per question, add an "Other" option with a text input.
  Selecting it and typing makes the answer that text. It goes through the normal allow path.
  `logQuestionCardAnswer` already logs free text verbatim, and `AnsweredQuestionCard` already renders a non-matching answer as free text (:259-263).
  Multi-select plus Other joins with ", " like other picks.
- Footer actions next to Submit:
  - "Discuss" opens a small text box. Sending it calls the same reply path as the composer.
    Empty Discuss sends a canned message: "The user needs more context before choosing. Explain the options and the tradeoffs in plain text, then ask again." Logged as a `canned` row.
  - "Dismiss" denies with "The user dismissed these questions without answering. Do not ask them again right now. Continue on your best judgment, or stop and say what you need." Logged as a `canned` row.
- Change "or reply below" to "or reply below to discuss".
- New prop: `onReply(text)` and `onDismiss()`. `ChatView` and `Stream` wire them from the hook and the store.

### Stale cards (required behavior 4)

Server side, in `ClaudeStructuredSessionManager`:

- New private `clearPending(terminalId, session)`. Sets `pending = null`, emits `resolved`, and emits `permission-cleared`.
  `ws/structured.ts` forwards `permission-cleared` as the `{ type: 'permission', pending: null }` frame.
  The harness adapter does not listen to it, so a clear never becomes `permission.requested`.
  Used in `answerPermission` and `setEscalate` too, so every viewer clears even without a tool_result.
- Handle `{ type: 'control_cancel_request', request_id }`. If it matches `pending.requestId`, call `clearPending`.
- On `result`, if `pending` is still set, call `clearPending` before the idle and needs-help emits. A backstop only.
- `interrupt()` is unchanged. The CLI cancels its own request (spike).

Client side, in `useStructuredChat`:

- Clear `pending` on a `result` frame. Replay is safe: the server re-sends a live pending after the replay (`:464`).
- A null `permission` frame clears `pending` and leaves `busy` alone.
- No optimistic clear on Stop. The server's null frame clears it.

### Worker chats (in scope)

- Worker ChatView gets everything above for free through `useStructuredChat` and the shared card.
- The Overseer worker need card (`live.ts:526-539`, `store.ts:342-360`) stays option buttons for `questions[0]` only.
  Change only one thing: its "Deny" sends the Dismiss message, not the bare default "Denied".
  Full multi-question support in the need card is out of scope. Its "Open" action already reaches the full card.
- Coordinator `answer_agent` after the human already replied: `answerPermission` returns false, and the tool errors.
  Make that error say "The user already answered this question in the agent's chat." Look in `agency-mcp.ts` near `answerAgent`.
- `answer_agent` takes a `requestId`, named in the coordinator's question notice, and sends it. A mismatch (a newer question is up) errors instead of answering the wrong question.

### Codex parity (out of scope)

Codex `requestUserInput` deny returns `{ answers: {} }` and drops the message (`codex-translate.ts:513`).
A reply cannot ride the deny there.
Parity needs a different shape: empty answers, then the reply as a `turn/steer`.
That is its own small change with its own model check.

For this change, add a guard so Codex does not regress.
`service.answerPermission` with `reply` returns a distinct `unsupported` result for non-Claude managers, and the route answers 409.
The client treats 409 like 404 and falls back to a normal send. The card stays up. That is today's behavior.
Grok and OpenCode get the same guard.

### Interaction with the later askMode / blocking-coordinator work

- That work will change when the coordinator may call AskUserQuestion. It does not change how a pending is answered. This plan stays valid.
- If askMode adds a non-blocking question type (answered by a later user turn), the composer routing in `send()`/`sendDirective` must skip it. Keep the routing check on `pending.questions` from a live `can_use_tool`, not on "a card is visible".
- The deny wording tells the model to ask again. If askMode later forbids AskUserQuestion for the coordinator, the wording must say "ask again in plain text" instead. Keep the wording in one server constant so that is a one-line change.

## Ordered tasks

0. **Spike.** Done (agent 6a5399f4). See Corrections 3, 6 and 7.
1. **Core manager.** `packages/core/src/structured/manager.ts`: `clearPending`, `permission-cleared`, `control_cancel_request`, backstop clear on `result`. `ws/structured.ts` forwards the clear. Tests in `packages/core/tests/structured/manager.test.ts`, `tests/ws/structured.test.ts` and `src/runtime/contract.test.ts`.
2. **Core service.** `packages/core/src/sessions/service.ts`: `reply` option on `answerPermission`, deny wording constant, `logQuestionCardReply`, worker `question-answered` notice, non-Claude `unsupported`, `canned` logging for Discuss-empty and Dismiss, requestId in the coordinator question notice.
3. **Core route and MCP.** `packages/core/src/routes/terminals.ts` (`reply`, 404 vs 409). `packages/core/src/overseer/agency-mcp.ts` (`answer_agent` requestId and error text).
4. **Web API.** `packages/web/src/api/client.ts`: `reply` on `answerPermission`; surface status so the caller can tell 404/409 from other errors.
5. **Web hook.** `useStructuredChat.ts`: `replyToQuestion`, `dismissQuestion`, routing in `send()` with the N5 image split, clear on `result`, null frame leaves busy alone. Export them in the return value (:987).
6. **Web store.** `overseer/store.ts`: `coordinatorReply`/`coordinatorDismiss` in state, routing in `sendDirective`, wiring at :751. `needAction` deny message.
7. **Web card.** `AskQuestionCard.tsx`: drop `autoSubmit`, add Other, Discuss, Dismiss; "answered in chat" in `AnsweredQuestionCard`. Wire props in `ChatView.tsx:314` and `Stream.tsx:685`.
8. **Live model check** (see Test plan). Adjust wording if it fails.
9. **Release note** when shipped, per `docs/RELEASING.md`.

Tasks 1-3 and 4-7 can run in parallel once the wire shape (`reply`, 404/409) is fixed in task 2.

## Edge cases

- **New question between click and POST.** Question A shows. The user types. A resolves elsewhere and question B arrives. The client POSTs with A's requestId. The manager rejects the mismatch (`manager.ts:558`). The route returns 404. The client sends the text as a normal turn, which queues behind B. B stays on screen. No wrong answer is given to B. Same for card clicks: `answer()` already carries the requestId.
- **requestId matching.** The reply path must not use the `requestId || pending.requestId` fallback (`service.ts:1687, 1693`). Require it and return 404 when absent.
- **Multiple pending questions.** One `can_use_tool` carries N questions. A reply resolves all N with one deny. The answered record shows "answered in chat" once, with the question list collapsed under it. Only one control_request can be pending per session, so there is no queue of cards.
- **Reply with no question pending.** Normal send. No change from today.
- **Pending frame not yet arrived.** The server has a pending, the client does not know yet. The reply goes out as a normal turn and queues. The card then appears. The user replies again. Acceptable, and no worse than today.
- **Attachments in the reply.** A deny message is text only. Decided as N5: deny with the text plus "(They also attached N image(s). They follow in the next message.)", then send an images-only turn after the deny POST resolves. It queues and lands after the deny result. Image-only reply with no text: same, with "They replied with an image only."
- **Two viewers.** One replies. The other clears through the deny's tool_result and the `permission: null` frame from `permission-cleared`.
- **Reply on a thread that died.** `answerPermission` returns false (no session). 404, then the fallback send revives the thread through `ensureStructuredAlive`. The question is lost with the old process, which is today's behavior.
- **Empty or whitespace reply.** Already blocked by `send()` trimming.
- **Canned need-card ack while pending.** Not a reply. Keep the plain send.
- **Coordinator `message_agent` to a worker with a pending question.** Not a human reply. Keep the plain send. `answer_agent` is the coordinator's tool for this.
- **Reply during compaction.** Compaction cannot run while the CLI is blocked on a control_request. No special case.

## Test plan

Unit, core (vitest):

- manager: `control_cancel_request` matching clears pending and emits `resolved` then `permission-cleared`. Non-matching id is ignored.
- manager: a `result` with a stale pending clears it, before the idle emit (assert order).
- manager: `interrupt()` with a pending question writes no deny. The fake CLI's cancel clears it.
- manager: `answerPermission` emits `permission-cleared` and never a null `permission`.
- manager: a deny with a message on a question echoes as the is_error tool_result with that text (fake CLI).
- adapter and status: a clear yields no `permission.requested`, no needs-input and no push.
- ws: `permission-cleared` is forwarded as the null frame.
- service: `reply` builds the exact message with the N1 prefix. It logs one `user` row with the raw reply. It does not call `sendMessage`.
- service: `reply` without `requestId` returns not-found. Mismatched id returns not-found and logs nothing.
- service: `reply` on a Codex/Grok/OpenCode thread returns `unsupported` and writes nothing.
- service: a worker reply sends the coordinator the `question-answered` notice.
- service: Discuss-empty and Dismiss log a `canned` row.
- agency-mcp: `answer_agent` passes the requestId and errors on a mismatch.
- route: 204, 404, 409, and 400 for `reply` with `decision: 'allow'`.

Unit, web (vitest + testing-library):

- AskQuestionCard: single-select does not submit on tap; Submit does. Other input produces the typed answer. Discuss with text calls `onReply`. Dismiss calls `onDismiss`.
- AnsweredQuestionCard: a result with the prefix anywhere renders "answered in chat" and the reply. Pinned by the captured frame fixture.
- useStructuredChat: `send()` with a question pending posts `answerPermission` with `reply` and the requestId, and does not call `sendStructuredMessage`. A plain gated tool pending is a normal send. On 404 and 409 it keeps the card and calls `sendStructuredMessage`. On 500 it keeps the card and sends nothing. A block array splits into the deny then an images-only send. A `result` frame clears pending. A null frame leaves busy alone.
- store: `sendDirective` with `coordinatorPending` routes to `coordinatorReply`.
- Invert the existing auto-submit test in `AskQuestionCard.test.tsx` (:17-25).

End to end (`/verify` skill, isolated daemon):

- Fake CLI emits a `can_use_tool` AskUserQuestion. POST `/message`-equivalent reply via `/permission` with `reply`. Assert the deny `control_response` on stdin and no `user` turn.
- Same, then `control_cancel_request`. Assert a `permission: null` frame on the ws.

Live model check (manual, real Claude, before merge):

- Ask Control Plane to ask a two-option question. Reply "Neither. Why not do X instead?". Expect it to answer in text and re-ask with revised options. Run 3 times.
- Reply "Go with the second one." Expect it to continue without re-asking.
- Dismiss. Expect it to continue or stop, and not re-ask in the same turn.
- Repeat the first case in a worker ChatView.

## Risks

- **Model abandons after a deny.** The main behavioral risk. Mitigated by the wording and the live check. Wording is one constant.
- **CLI protocol drift.** Deny tool_result text or `control_cancel_request` shape may change in later CLI versions. The prefix detection falls back to the italic raw result, so it degrades safely. Pin with a captured-frame fixture test.
- **Ledger quoting.** A reply is now logged through a new path. A bug there means a real user instruction is unquotable. Covered by the service test.
- **Coordinator confusion on worker replies.** The coordinator may still try `answer_agent`. Covered by the notice and the clearer error.
- **Removing auto-submit adds a tap on mobile.** Deliberate. Flag in the release note.

## Size

Medium. About 9 source files and 6 test files. Roughly 400 to 600 lines including tests. Two to three days with the live check.

## Design review

Done. Agent 6f39d532, approve with changes. All required changes are folded in above (Corrections).

## Owner decisions

- OD-1: deny wording tail. Decided as N4.
- OD-2: attachments in a reply. Decided as N5.
