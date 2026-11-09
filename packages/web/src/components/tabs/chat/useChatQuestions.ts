import { useCallback, useRef, useState } from 'react';
import type { PendingPermission } from '../../../api/types';
import { api, ApiError, type ContentBlock } from '../../../api/client';

// The pending question of a structured chat and the actions on it. Moved out of
// useStructuredChat.ts unchanged (W3-C, move-only split).

export function useChatQuestions(
  terminalId: string,
  setBusy: (busy: boolean) => void,
  showSendFailure: (err: unknown) => void,
) {
  // The AskUserQuestion the CLI is blocked on (mirrored in a ref so the `answer`
  // callback and the tool_result handler read the latest value without re-subscribing).
  const [pending, setPendingState] = useState<PendingPermission | null>(null);
  const permissionRef = useRef<PendingPermission | null>(null);
  const setPending = useCallback((p: PendingPermission | null) => { permissionRef.current = p; setPendingState(p); }, []);

  // How many question actions (a chat reply, Discuss, Dismiss, or Submit) are in flight. Submit is
  // dropped while any other is, so two answers to one question cannot race and a losing Submit
  // cannot bring the old card back.
  const questionActionsRef = useRef(0);

  // A chat reply while a question is pending answers THAT question: the
  // text rides a deny the model reads as the question's result, once, never as its own turn.
  // Images can't ride a deny, so they follow as an images-only turn AFTER the deny lands.
  // The card is not cleared up front: the server's tool_result and null frame clear it. When
  // the question is gone (404) or this harness can't take a reply (409, e.g. Codex), the reply
  // goes out as a normal turn, today's behavior, and the card stays as the server reports it.
  // Any other failure keeps the card, sends nothing, and rejects so the caller can show it.
  const replyToQuestion = useCallback(async (content: string | ContentBlock[]): Promise<boolean> => {
    const p = permissionRef.current;
    if (!terminalId || !p?.questions?.length) return true;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content } as ContentBlock] : content;
    const text = blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
    const images = blocks.filter((b) => b.type === 'image');
    if (!text && !images.length) return true;
    setBusy(true);
    questionActionsRef.current++;
    try {
      await api.answerPermission(terminalId, { requestId: p.requestId, decision: 'deny', reply: text, imageCount: images.length });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        try { await api.sendStructuredMessage(terminalId, content); } catch (sendErr) { setBusy(false); throw sendErr; }
        // A 404 means the server closed the question. A 409 means this harness never took the reply,
        // so the question is still open and the card must stay usable.
        return err.status !== 409;
      }
      setBusy(false);
      throw err;
    } finally {
      questionActionsRef.current--;
    }
    if (permissionRef.current?.requestId === p.requestId) setPending(null);
    if (images.length) await api.sendStructuredMessage(terminalId, images);
    return true;
  }, [terminalId, setPending]);

  // A card's Discuss with no text, or Dismiss: deny the question with the daemon's fixed text.
  // Same contract as replyToQuestion: no optimistic clear, and a failure keeps the card.
  const denyQuestion = useCallback(async (action: 'discuss' | 'dismiss'): Promise<void> => {
    const p = permissionRef.current;
    if (!terminalId || !p) return;
    setBusy(true);
    questionActionsRef.current++;
    try {
      await api.answerPermission(terminalId, { requestId: p.requestId, decision: 'deny', canned: action });
    } catch (err) {
      setBusy(false);
      throw err;
    } finally {
      questionActionsRef.current--;
    }
    if (permissionRef.current?.requestId === p.requestId) setPending(null);
  }, [terminalId, setPending]);

  // The card's own Discuss (with text) and Dismiss buttons. Errors land in the timeline.
  const replyFromCard = useCallback((text: string): Promise<boolean> =>
    replyToQuestion(text).then((settled) => settled, (err) => { showSendFailure(err); return false; }), [replyToQuestion, showSendFailure]);
  const denyFromCard = useCallback((action: 'discuss' | 'dismiss'): Promise<boolean> =>
    denyQuestion(action).then(() => true, (err) => { showSendFailure(err); return false; }), [denyQuestion, showSendFailure]);

  // Answer the pending AskUserQuestion. `answers` is keyed by question TEXT → the chosen
  // option label(s). We fire the REST call (the ws has no inbound channel), clear the card
  // optimistically, and resume the spinner — the CLI unblocks and streams the next turn.
  const answer = useCallback((answers: Record<string, string>) => {
    const p = permissionRef.current;
    if (!p || !terminalId) return;
    // A chat reply, Discuss or Dismiss for this question is already in flight: it decides the question.
    if (questionActionsRef.current > 0) return false;
    questionActionsRef.current++;
    setPending(null);
    setBusy(true);
    api.answerPermission(terminalId, { requestId: p.requestId, decision: 'allow', answers }).catch((err) => {
      // 404: another answer won, or the question is gone. The server's frames settle the card, so do not
      // put the old one back. Any other failure (e.g. the process died) re-surfaces it so it isn't lost.
      if (err instanceof ApiError && err.status === 404) return;
      setBusy(false);
      setPending(p);
    }).finally(() => { questionActionsRef.current--; });
  }, [terminalId, setPending]);

  return { pending, setPending, permissionRef, replyToQuestion, denyQuestion, replyFromCard, denyFromCard, answer };
}
