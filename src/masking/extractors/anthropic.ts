/**
 * Anthropic request extractor for format-agnostic masking
 *
 * Extracts text from Anthropic request structures and handles unmasking
 * in responses. Anthropic has different content types:
 * - String content (simple)
 * - Content blocks array (text, image, tool_use, tool_result, thinking)
 * - System prompt (string or content blocks) - SEPARATE from messages
 *
 * System spans use messageIndex -1 to distinguish from message spans.
 */

import type { PlaceholderContext } from "../../masking/context";
import type {
  AnthropicRequest,
  AnthropicResponse,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
} from "../../providers/anthropic/types";
import type { OpenAIResponse } from "../../providers/openai/types";
import type { MaskedSpan, RequestExtractor, TextSpan } from "../types";
import { openaiExtractor } from "./openai";

/** System content uses messageIndex -1 */
const SYSTEM_MESSAGE_INDEX = -1;

/**
 * Extract text from a single content block
 */
function extractBlockText(block: ContentBlock): string {
  if (block.type === "text") {
    return (block as TextBlock).text;
  }
  if (block.type === "thinking") {
    return (block as ThinkingBlock).thinking;
  }
  if (block.type === "redacted_thinking") {
    return "";
  }
  if (block.type === "tool_result") {
    const toolResult = block as ToolResultBlock;
    if (typeof toolResult.content === "string") {
      return toolResult.content;
    }
    if (Array.isArray(toolResult.content)) {
      return toolResult.content.map(extractBlockText).filter(Boolean).join("\n");
    }
  }
  return "";
}

/**
 * Extract text from content (string or block array)
 */
export function extractAnthropicTextContent(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(extractBlockText).filter(Boolean).join("\n");
  }
  return "";
}

/**
 * Extract text from system prompt (for logging/debugging)
 */
export function extractSystemText(system: string | ContentBlock[] | undefined): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return extractAnthropicTextContent(system);
}

/**
 * Anthropic request extractor
 *
 * Extracts text from both system (messageIndex: -1) and messages.
 */
export const anthropicExtractor: RequestExtractor<AnthropicRequest, AnthropicResponse> = {
  extractTexts(request: AnthropicRequest): TextSpan[] {
    const spans: TextSpan[] = [];

    // Extract system text (messageIndex: -1)
    if (request.system) {
      if (typeof request.system === "string") {
        if (request.system) {
          spans.push({
            text: request.system,
            path: "system",
            messageIndex: SYSTEM_MESSAGE_INDEX,
            partIndex: 0,
            role: "system",
          });
        }
      } else if (Array.isArray(request.system)) {
        for (let partIdx = 0; partIdx < request.system.length; partIdx++) {
          const block = request.system[partIdx];
          const text = extractBlockText(block);
          if (text) {
            const pathSuffix =
              block.type === "text" ? "text" : block.type === "thinking" ? "thinking" : null;
            if (pathSuffix) {
              spans.push({
                text,
                path: `system[${partIdx}].${pathSuffix}`,
                messageIndex: SYSTEM_MESSAGE_INDEX,
                partIndex: partIdx,
                role: "system",
              });
            }
          }
        }
      }
    }

    // Extract message text
    for (let msgIdx = 0; msgIdx < request.messages.length; msgIdx++) {
      const msg = request.messages[msgIdx];

      if (typeof msg.content === "string") {
        if (msg.content) {
          spans.push({
            text: msg.content,
            path: `messages[${msgIdx}].content`,
            messageIndex: msgIdx,
            partIndex: 0,
            role: msg.role,
          });
        }
      } else if (Array.isArray(msg.content)) {
        for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
          const block = msg.content[partIdx];

          if (block.type === "text") {
            const text = (block as TextBlock).text;
            if (text) {
              spans.push({
                text,
                path: `messages[${msgIdx}].content[${partIdx}].text`,
                messageIndex: msgIdx,
                partIndex: partIdx,
                role: msg.role,
              });
            }
          } else if (block.type === "thinking") {
            const text = (block as ThinkingBlock).thinking;
            if (text) {
              spans.push({
                text,
                path: `messages[${msgIdx}].content[${partIdx}].thinking`,
                messageIndex: msgIdx,
                partIndex: partIdx,
                role: msg.role,
              });
            }
          } else if (block.type === "tool_result") {
            const toolResult = block as ToolResultBlock;
            if (typeof toolResult.content === "string") {
              if (toolResult.content) {
                spans.push({
                  text: toolResult.content,
                  path: `messages[${msgIdx}].content[${partIdx}].content`,
                  messageIndex: msgIdx,
                  partIndex: partIdx,
                  role: "tool",
                });
              }
            } else if (Array.isArray(toolResult.content)) {
              for (let nestedIdx = 0; nestedIdx < toolResult.content.length; nestedIdx++) {
                const nestedBlock = toolResult.content[nestedIdx];
                if (nestedBlock.type === "text") {
                  const text = (nestedBlock as TextBlock).text;
                  if (text) {
                    spans.push({
                      text,
                      path: `messages[${msgIdx}].content[${partIdx}].content[${nestedIdx}].text`,
                      messageIndex: msgIdx,
                      partIndex: partIdx,
                      nestedPartIndex: nestedIdx,
                      role: "tool",
                    });
                  }
                }
              }
            }
          }
        }
      }
    }

    return spans;
  },

  applyMasked(request: AnthropicRequest, maskedSpans: MaskedSpan[]): AnthropicRequest {
    // Separate system spans from message spans
    const systemSpans = maskedSpans.filter((s) => s.messageIndex === SYSTEM_MESSAGE_INDEX);
    const messageSpans = maskedSpans.filter((s) => s.messageIndex >= 0);

    // Apply system masking
    let maskedSystem = request.system;
    if (systemSpans.length > 0 && request.system) {
      if (typeof request.system === "string") {
        const span = systemSpans.find((s) => s.partIndex === 0);
        if (span) {
          maskedSystem = span.maskedText;
        }
      } else if (Array.isArray(request.system)) {
        maskedSystem = request.system.map((block, partIdx) => {
          const span = systemSpans.find((s) => s.partIndex === partIdx);
          if (!span) return block;

          if (block.type === "text") {
            return { ...block, text: span.maskedText };
          }
          if (block.type === "thinking") {
            return { ...block, thinking: span.maskedText };
          }
          return block;
        });
      }
    }

    // Apply message masking
    const maskedMessages = request.messages.map((msg, msgIdx) => {
      const msgSpans = messageSpans.filter((s) => s.messageIndex === msgIdx);
      if (msgSpans.length === 0) return msg;

      if (typeof msg.content === "string") {
        const span = msgSpans.find((s) => s.partIndex === 0);
        if (span) {
          return { ...msg, content: span.maskedText };
        }
        return msg;
      }

      if (Array.isArray(msg.content)) {
        const maskedContent = msg.content.map((block, partIdx) => {
          const partSpans = msgSpans.filter((s) => s.partIndex === partIdx);
          if (partSpans.length === 0) return block;

          if (block.type === "text") {
            const span = partSpans.find((s) => s.nestedPartIndex === undefined);
            if (span) return { ...block, text: span.maskedText };
          }
          if (block.type === "thinking") {
            const span = partSpans.find((s) => s.nestedPartIndex === undefined);
            if (span) return { ...block, thinking: span.maskedText };
          }
          if (block.type === "tool_result") {
            const toolResult = block as ToolResultBlock;
            if (typeof toolResult.content === "string") {
              const span = partSpans.find((s) => s.nestedPartIndex === undefined);
              if (span) return { ...block, content: span.maskedText };
            }
            if (Array.isArray(toolResult.content)) {
              const maskedNestedContent = toolResult.content.map((nestedBlock, nestedIdx) => {
                const span = partSpans.find((s) => s.nestedPartIndex === nestedIdx);
                if (span && nestedBlock.type === "text") {
                  return { ...nestedBlock, text: span.maskedText };
                }
                return nestedBlock;
              });
              return { ...block, content: maskedNestedContent };
            }
          }
          return block;
        });
        return { ...msg, content: maskedContent };
      }

      return msg;
    });

    return { ...request, system: maskedSystem, messages: maskedMessages };
  },

  unmaskResponse(
    response: AnthropicResponse,
    context: PlaceholderContext,
    formatValue?: (original: string) => string,
  ): AnthropicResponse {
    const unmaskText = (text: string): string => {
      let result = text;
      for (const [placeholder, original] of Object.entries(context.mapping)) {
        const value = formatValue ? formatValue(original) : original;
        result = result.replaceAll(placeholder, value);
      }
      return result;
    };

    // Tolerate non-Anthropic bodies on the /anthropic endpoint.
    // 9router combo aliases (e.g. haiku/sonnet) may return an OpenAI-shaped
    // chat.completion JSON ({ object: "chat.completion", choices: [...] }) with
    // NO top-level `content` array. Dereferencing `response.content.map` on such
    // a body throws and surfaces as HTTP 502. Detect the body shape first.
    if (!Array.isArray(response.content)) {
      // OpenAI-shaped body: unmask via the OpenAI extractor (handles
      // choices[].message.content + tool_calls[].function.arguments + legacy
      // function_call.arguments), preserving structure.
      // biome-ignore lint/suspicious/noExplicitAny: cross-format body on /anthropic
      const maybeOpenAI = response as any;
      if (Array.isArray(maybeOpenAI.choices)) {
        return openaiExtractor.unmaskResponse(
          maybeOpenAI as OpenAIResponse,
          context,
          formatValue,
          // biome-ignore lint/suspicious/noExplicitAny: returning cross-format body unchanged-in-type
        ) as any;
      }
      // Unknown shape: return unchanged rather than throwing.
      return response;
    }

    return {
      ...response,
      content: response.content.map((block) => {
        if (block.type === "text") {
          return { ...block, text: unmaskText((block as TextBlock).text) };
        }
        if (block.type === "tool_use") {
          // Restore placeholders that may have leaked into tool call arguments.
          // Walk the input object recursively, unmasking every string leaf while
          // preserving structure, arrays, numbers, booleans and keys unchanged.
          // biome-ignore lint/suspicious/noExplicitAny: tool_use block input is provider-shaped
          const toolBlock = block as any;
          return { ...toolBlock, input: unmaskDeep(toolBlock.input, unmaskText) };
        }
        return block;
      }),
    };
  },
};

/**
 * Recursively restore placeholders in every string leaf of a value.
 *
 * - Strings are unmasked via `unmaskText`.
 * - Arrays are mapped element-wise, preserving order and length.
 * - Plain objects are walked value-by-value, preserving keys.
 * - Numbers, booleans, null and other primitives pass through unchanged.
 */
function unmaskDeep(value: unknown, unmaskText: (text: string) => string): unknown {
  if (typeof value === "string") {
    return unmaskText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => unmaskDeep(item, unmaskText));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = unmaskDeep(val, unmaskText);
    }
    return result;
  }
  return value;
}
