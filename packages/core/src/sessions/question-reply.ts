/**
 * What the model reads when the user answers its AskUserQuestion card without picking an option:
 * a chat reply, an empty Discuss, or a Dismiss. Each rides a deny `control_response`, and the
 * Claude CLI hands the message to the model verbatim as the question's is_error tool_result.
 *
 * The wording lives here once. The web's AnsweredQuestionCard detects
 * QUESTION_REPLY_PREFIX in that tool_result, so keep packages/web's copy in step
 * (components/tabs/chat/questionReply.ts). A test on each side pins the string.
 */

/** Fixed start of a reply's deny message. The web finds it with `includes`, never `startsWith`. */
export const QUESTION_REPLY_PREFIX = 'The user did not pick an option. They replied: ';

/** Fixed start of an image-only reply's deny message. */
export const QUESTION_REPLY_IMAGE_ONLY = 'The user did not pick an option. They replied with an image only.';

/** The model's next move after a reply. If AskUserQuestion is ever forbidden, say "ask again in plain text" here. */
export const QUESTION_REPLY_GUIDANCE =
  'Treat this as their answer. If it settles the question, continue. If it pushes back on the options or ' +
  'asks for more context, answer them in plain text and then ask again with revised options. Do not proceed on a guess.';

/** The empty-Discuss deny: the user wants more context before choosing. */
export const QUESTION_DISCUSS_MESSAGE =
  'The user needs more context before choosing. Explain the options and the tradeoffs in plain text, then ask again.';

/** The Dismiss deny: the user closed the card without answering. */
export const QUESTION_DISMISS_MESSAGE =
  'The user dismissed these questions without answering. Do not ask them again right now. ' +
  'Continue on your best judgment, or stop and say what you need.';

/** A canned card action that denies with fixed text. */
export type QuestionCannedAction = 'discuss' | 'dismiss';

export const QUESTION_CANNED_MESSAGES: Record<QuestionCannedAction, string> = {
  discuss: QUESTION_DISCUSS_MESSAGE,
  dismiss: QUESTION_DISMISS_MESSAGE,
};

/**
 * The deny message for a chat reply. `imageCount` images follow as their own turn (a deny can only
 * carry text), so the model is told to expect them.
 */
export function questionReplyMessage(reply: string, imageCount = 0): string {
  const text = reply.trim();
  const images = imageCount === 1 ? '1 image. It follows' : `${imageCount} images. They follow`;
  let head: string;
  if (!text) head = `${QUESTION_REPLY_IMAGE_ONLY} (${images} in the next message.)`;
  else if (imageCount > 0) head = `${QUESTION_REPLY_PREFIX}${text}\n\n(They also attached ${images} in the next message.)`;
  else head = `${QUESTION_REPLY_PREFIX}${text}`;
  return `${head}\n\n${QUESTION_REPLY_GUIDANCE}`;
}
