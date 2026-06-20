/**
 * Anthropic request normalization helpers
 *
 * Pure, side-effect-free transforms applied to an incoming Anthropic request before
 * it is forwarded upstream. Extracted from routes/anthropic.ts so the behavior can be
 * unit tested in isolation. Each helper returns the request unchanged (same reference)
 * when there is nothing to normalize.
 */

import type { AnthropicRequest } from "../providers/anthropic/types";

/** Flattens a single content block (string or { text }) to its text, else "". */
function blockToText(b: unknown): string {
  if (typeof b === "string") return b;
  if (b && typeof b === "object" && "text" in b) return (b as { text: string }).text;
  return "";
}

/**
 * Hoists any role:"system" messages from the messages array into the top-level
 * `system` field. Anthropic's API does not support role:"system" inside messages
 * (it's a beta feature some clients use), but expects system content in the separate
 * "system" field. Any existing top-level system content is preserved and prepended.
 */
export function hoistSystemMessages(request: AnthropicRequest): AnthropicRequest {
  if (!Array.isArray(request.messages)) return request;

  const systemTexts: string[] = [];
  const filteredMessages = [];
  for (const msg of request.messages) {
    if (msg.role === "system") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map(blockToText).join("\n")
            : "";
      if (text.trim()) systemTexts.push(text);
    } else {
      filteredMessages.push(msg);
    }
  }

  if (systemTexts.length === 0) return request;

  const existingSystem =
    typeof request.system === "string" && request.system.trim()
      ? `${request.system}\n`
      : Array.isArray(request.system)
        ? `${request.system.map(blockToText).join("\n")}\n`
        : "";

  return {
    ...request,
    system: existingSystem + systemTexts.join("\n"),
    messages: filteredMessages,
  };
}

/**
 * Sanitizes tool_use.id and tool_result.tool_use_id to match Anthropic's required
 * pattern ^[a-zA-Z0-9_-]+$. Non-Claude models in combos may emit IDs with invalid
 * characters (dots, colons, etc.) that cause 400 errors. Replacement is applied
 * consistently across the whole request so tool_use ↔ tool_result binding is preserved.
 */
export function sanitizeToolUseIds(request: AnthropicRequest): AnthropicRequest {
  if (!Array.isArray(request.messages)) return request;

  const sanitizeId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, "_");

  return {
    ...request,
    messages: request.messages.map((msg) => {
      if (!Array.isArray(msg.content)) return msg;
      const content = msg.content.map((block: Record<string, unknown>) => {
        // tool_use block: sanitize block.id
        if (block.type === "tool_use" && typeof block.id === "string") {
          const sanitized = sanitizeId(block.id);
          if (sanitized !== block.id) {
            return { ...block, id: sanitized };
          }
        }
        // tool_result block: sanitize block.tool_use_id
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const sanitized = sanitizeId(block.tool_use_id);
          if (sanitized !== block.tool_use_id) {
            return { ...block, tool_use_id: sanitized };
          }
        }
        return block;
      });
      return { ...msg, content };
    }),
  };
}
