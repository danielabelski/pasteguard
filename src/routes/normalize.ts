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

/**
 * Removes "thinking" content blocks whose thinking text is empty or whitespace-only.
 *
 * Anthropic rejects requests where a thinking block contains only whitespace with
 * `400 invalid_request_error: "each thinking block must contain non-whitespace
 * thinking"`. Such blocks can appear in replayed conversation history when an upstream
 * router converts a non-Claude fallback response into Claude format and emits an empty
 * reasoning block. This normalization strips those blocks so the request validates.
 *
 * - Only "thinking" blocks are inspected (text lives in `block.thinking`).
 * - "redacted_thinking" blocks are always KEPT: their `data` is opaque (no readable
 *   text), so they cannot be classified as empty and are valid as-is.
 * - Guard: if removing empty thinking block(s) would leave a message's content array
 *   empty, the message is left untouched (a fully-empty content array is itself
 *   invalid). In practice assistant turns carrying a whitespace thinking block also
 *   contain text/tool_use blocks, so removal is safe.
 * - Only array content is processed; string content and other blocks/order are preserved.
 */
export function stripEmptyThinkingBlocks(request: AnthropicRequest): AnthropicRequest {
  if (!Array.isArray(request.messages)) return request;

  let changed = false;

  const messages = request.messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;

    const filtered = msg.content.filter((block: Record<string, unknown>) => {
      if (block.type === "thinking") {
        const text = typeof block.thinking === "string" ? block.thinking : "";
        // Drop only when the thinking text is empty or whitespace-only.
        return text.trim().length > 0;
      }
      // redacted_thinking and all other block types are always kept.
      return true;
    });

    // Guard: never empty out a message's content array.
    if (filtered.length === 0 || filtered.length === msg.content.length) return msg;

    changed = true;
    return { ...msg, content: filtered };
  });

  if (!changed) return request;

  return { ...request, messages };
}

/**
 * Removes ALL "thinking" and "redacted_thinking" content blocks from every message.
 *
 * Anthropic validates the `signature` of EVERY thinking block in the request and
 * rejects foreign signatures with `400 invalid_request_error: "messages.N.content.M:
 * Invalid \`signature\` in \`thinking\` block"`. This happens when replayed conversation
 * history contains assistant thinking blocks authored by NON-Claude fallback providers
 * (e.g. gpt-5.4/kimi in a combo route) — their signatures cannot be re-signed for
 * Anthropic. Stripping every thinking/redacted_thinking block before forwarding is the
 * only safe fix. It also supersedes stripEmptyThinkingBlocks: removing all thinking
 * blocks necessarily removes the whitespace-only ones too.
 *
 * - Only array content is processed; string content and non-thinking blocks (text,
 *   tool_use, tool_result, image, etc.) are preserved with original order.
 * - If a message's content array becomes EMPTY after removal, the whole message is
 *   dropped from the messages array (empty content is invalid; a thinking-only turn
 *   carries no other payload, so dropping is safe).
 * - Returns the same request reference when there are no thinking/redacted_thinking
 *   blocks anywhere (no-op fast path).
 */
export function stripThinkingBlocks(request: AnthropicRequest): AnthropicRequest {
  if (!Array.isArray(request.messages)) return request;

  const isThinking = (block: Record<string, unknown>): boolean =>
    block.type === "thinking" || block.type === "redacted_thinking";

  let changed = false;
  const messages = [];

  for (const msg of request.messages) {
    if (!Array.isArray(msg.content)) {
      messages.push(msg);
      continue;
    }

    const filtered = msg.content.filter((block: Record<string, unknown>) => !isThinking(block));

    if (filtered.length === msg.content.length) {
      // No thinking blocks in this message — keep as-is.
      messages.push(msg);
      continue;
    }

    changed = true;

    // Drop the entire message if removing thinking blocks left it empty.
    if (filtered.length === 0) continue;

    messages.push({ ...msg, content: filtered });
  }

  if (!changed) return request;

  return { ...request, messages };
}

/**
 * Regex lookaround pattern (`(?=`, `(?!`, `(?<=`, `(?<!`) — used to detect
 * incompatible patterns that OpenAI/Codex rejects with 400 "Invalid JSON schema:
 * regex lookaround is not supported".
 */
const LOOKAROUND_RE = /\(\?[=!<]/;

/**
 * Recursively walks a JSON Schema object and removes any `pattern` field whose
 * value contains regex lookaround. Other `pattern` values are preserved.
 *
 * Handles nested `properties`, `items`, `allOf`/`anyOf`/`oneOf`, `additionalProperties`,
 * `$defs`/`definitions`, and `prefixItems`.
 */
function stripPatternsDeep(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    if (Array.isArray(schema)) return schema.map(stripPatternsDeep);
    return schema;
  }

  const obj = schema as Record<string, unknown>;
  let changed = false;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (key === "pattern" && typeof value === "string" && LOOKAROUND_RE.test(value)) {
      // Drop this pattern field entirely
      changed = true;
      continue;
    }
    // Recurse into sub-schemas (objects and arrays that can contain nested schemas)
    if (
      (key === "allOf" || key === "anyOf" || key === "oneOf" || key === "prefixItems") &&
      Array.isArray(value)
    ) {
      const stripped = value.map(stripPatternsDeep);
      result[key] = stripped;
      if (stripped.some((v, i) => v !== value[i])) changed = true;
    } else if (value !== null && typeof value === "object") {
      // Any nested object may be or contain a sub-schema — recurse
      const stripped = stripPatternsDeep(value);
      result[key] = stripped;
      if (stripped !== value) changed = true;
    } else {
      result[key] = value;
    }
  }

  return changed ? result : obj;
}

/**
 * Strips regex `pattern` fields containing lookaround assertions from all tool
 * `input_schema` definitions in the request.
 *
 * OpenAI/Codex rejects JSON Schemas that use regex lookaround (`(?=`, `(?!`,
 * `(?<=`, `(?<!)`) with `400 Invalid JSON schema: regex lookaround is not
 * supported`. Since `pattern` is an optional validation hint (not required for
 * model behavior), removing it is safe and prevents combo-fallback failures on
 * codex/openai providers.
 *
 * Only processes `request.tools[].input_schema`; messages and other fields are
 * untouched. Returns the same reference if no patterns needed stripping (no-op).
 */
export function stripLookaroundPatterns(request: AnthropicRequest): AnthropicRequest {
  if (!Array.isArray(request.tools) || request.tools.length === 0) return request;

  let changed = false;
  const tools = request.tools.map((tool: Record<string, unknown>) => {
    const schema = tool.input_schema;
    if (!schema || typeof schema !== "object") return tool;

    const stripped = stripPatternsDeep(schema);
    if (stripped === schema) return tool;

    changed = true;
    return { ...tool, input_schema: stripped };
  });

  if (!changed) return request;
  return { ...request, tools };
}
