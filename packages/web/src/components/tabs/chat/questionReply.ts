/**
 * How a chat reply to an AskUserQuestion shows up in its tool_result. The daemon writes this text
 * (packages/core/src/sessions/question-reply.ts) and the Claude CLI passes it through verbatim as
 * the question's is_error result. Web has no core import, so the strings are copied here. A test
 * on each side pins them; change both together.
 */
export const QUESTION_REPLY_PREFIX = 'The user did not pick an option. They replied: ';
export const QUESTION_REPLY_IMAGE_ONLY = 'The user did not pick an option. They replied with an image only.';

/**
 * The user's own reply inside a question's tool_result, or null when the result is not a reply.
 * Found with `includes`, not `startsWith`: a CLI may wrap the message. The guidance line is the last
 * paragraph and the attachment note sits just before it, so both are cut off the end.
 */
export function parseQuestionReply(resultText: string): { reply: string; imageOnly: boolean } | null {
  if (resultText.includes(QUESTION_REPLY_IMAGE_ONLY)) return { reply: '', imageOnly: true };
  const at = resultText.indexOf(QUESTION_REPLY_PREFIX);
  if (at === -1) return null;
  let body = resultText.slice(at + QUESTION_REPLY_PREFIX.length);
  const lastBreak = body.lastIndexOf('\n\n');
  if (lastBreak !== -1) body = body.slice(0, lastBreak);
  body = body.replace(/\n\n\(They also attached \d+ images?\. (?:It follows|They follow) in the next message\.\)$/, '');
  return { reply: body.trim(), imageOnly: false };
}
