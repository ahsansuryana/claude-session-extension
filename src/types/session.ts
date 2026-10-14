/**
 * Values shared across modules that do not depend on each other.
 *
 * Kept tiny on purpose: the save-only build has no transfer format, no vault
 * and no resume token, so only the root sentinel the conversation tree hangs
 * messages off is needed.
 */

/**
 * `parent_message_uuid` for a top-level message. claude.ai uses this literal
 * sentinel rather than null, and a message whose parent is set to anything
 * else is a second root - a regeneration branch.
 */
export const ROOT_MESSAGE_UUID = '00000000-0000-4000-8000-000000000000' as const;
