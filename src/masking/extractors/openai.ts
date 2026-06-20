/**
 * OpenAI request extractor for format-agnostic masking
 *
 * Extracts text content from OpenAI-format requests and responses,
 * enabling the core masking service to work without knowledge of
 * the specific request structure.
 *
 * For OpenAI, system prompts are regular messages with role "system",
 * so no special handling is needed.
 */

import { type PlaceholderContext, restorePlaceholders } from "../../masking/context";
import type { OpenAIRequest, OpenAIResponse } from "../../providers/openai/types";
import type { OpenAIContentPart } from "../../utils/content";
import type { MaskedSpan, RequestExtractor, TextSpan } from "../types";

function unmaskContent(
  content: OpenAIResponse["choices"][number]["message"]["content"],
  context: PlaceholderContext,
  formatValue?: (original: string) => string,
) {
  if (typeof content === "string") {
    return restorePlaceholders(content, context, formatValue);
  }

  if (Array.isArray(content)) {
    return content.map((part: OpenAIContentPart) => {
      if (part.type === "text" && typeof part.text === "string") {
        return {
          ...part,
          text: restorePlaceholders(part.text, context, formatValue),
        };
      }

      return part;
    });
  }

  return content;
}

/** Shape of a tool call's function payload we need to unmask. */
interface ToolCallFunction {
  name?: string;
  arguments?: unknown;
}

interface ToolCall {
  function?: ToolCallFunction;
}

/**
 * Restores placeholders inside a tool call's `function.arguments`.
 *
 * `arguments` is a serialized JSON string. Placeholders use the `[[TYPE_N]]`
 * format and contain no JSON metacharacters, so restoring them directly in the
 * serialized string keeps the JSON valid. Non-string `arguments` and other
 * fields (id, type, name) are preserved untouched.
 */
function unmaskToolCallArguments<T extends { function?: ToolCallFunction }>(
  toolCall: T,
  context: PlaceholderContext,
  formatValue?: (original: string) => string,
): T {
  const fn = toolCall.function;
  if (!fn || typeof fn.arguments !== "string") {
    return toolCall;
  }

  return {
    ...toolCall,
    function: {
      ...fn,
      arguments: restorePlaceholders(fn.arguments, context, formatValue),
    },
  };
}

/**
 * Restores placeholders in a response message's tool-call payloads:
 * `tool_calls[].function.arguments` (and legacy `function_call.arguments`).
 *
 * Returns a new message object; all other fields are preserved.
 */
function unmaskMessageToolCalls<T extends Record<string, unknown>>(
  message: T,
  context: PlaceholderContext,
  formatValue?: (original: string) => string,
): T {
  const result: Record<string, unknown> = { ...message };

  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls)) {
    result.tool_calls = toolCalls.map((toolCall) =>
      toolCall && typeof toolCall === "object"
        ? unmaskToolCallArguments(toolCall as ToolCall, context, formatValue)
        : toolCall,
    );
  }

  const functionCall = message.function_call;
  if (functionCall && typeof functionCall === "object") {
    const fn = functionCall as ToolCallFunction;
    if (typeof fn.arguments === "string") {
      result.function_call = {
        ...fn,
        arguments: restorePlaceholders(fn.arguments, context, formatValue),
      };
    }
  }

  return result as T;
}

/**
 * OpenAI request extractor
 *
 * Handles both string content and multimodal array content.
 * System prompts are just messages with role "system".
 */
export const openaiExtractor: RequestExtractor<OpenAIRequest, OpenAIResponse> = {
  extractTexts(request: OpenAIRequest): TextSpan[] {
    const spans: TextSpan[] = [];

    for (let msgIdx = 0; msgIdx < request.messages.length; msgIdx++) {
      const msg = request.messages[msgIdx];

      if (typeof msg.content === "string") {
        spans.push({
          text: msg.content,
          path: `messages[${msgIdx}].content`,
          messageIndex: msgIdx,
          partIndex: 0,
          role: msg.role,
        });
        continue;
      }

      if (Array.isArray(msg.content)) {
        for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
          const part = msg.content[partIdx] as OpenAIContentPart;
          if (part.type === "text" && typeof part.text === "string") {
            spans.push({
              text: part.text,
              path: `messages[${msgIdx}].content[${partIdx}].text`,
              messageIndex: msgIdx,
              partIndex: partIdx,
              role: msg.role,
            });
          }
        }
      }
    }

    return spans;
  },

  applyMasked(request: OpenAIRequest, maskedSpans: MaskedSpan[]): OpenAIRequest {
    const lookup = new Map<string, string>();
    for (const span of maskedSpans) {
      lookup.set(`${span.messageIndex}:${span.partIndex}`, span.maskedText);
    }

    const maskedMessages = request.messages.map((msg, msgIdx) => {
      if (typeof msg.content === "string") {
        const key = `${msgIdx}:0`;
        const masked = lookup.get(key);
        if (masked !== undefined) {
          return { ...msg, content: masked };
        }
        return msg;
      }

      if (Array.isArray(msg.content)) {
        const transformedContent = msg.content.map((part: OpenAIContentPart, partIdx: number) => {
          const key = `${msgIdx}:${partIdx}`;
          const masked = lookup.get(key);
          if (part.type === "text" && masked !== undefined) {
            return { ...part, text: masked };
          }
          return part;
        });
        return { ...msg, content: transformedContent };
      }

      return msg;
    });

    return { ...request, messages: maskedMessages };
  },

  unmaskResponse(
    response: OpenAIResponse,
    context: PlaceholderContext,
    formatValue?: (original: string) => string,
  ): OpenAIResponse {
    return {
      ...response,
      choices: response.choices.map((choice) => {
        const messageWithContent = {
          ...choice.message,
          content: unmaskContent(choice.message.content, context, formatValue),
        };
        // Also restore placeholders in tool-call arguments (tool_calls[].function.arguments
        // and legacy function_call.arguments), preserving all other fields.
        const message = unmaskMessageToolCalls(
          messageWithContent as unknown as Record<string, unknown>,
          context,
          formatValue,
        ) as unknown as OpenAIResponse["choices"][number]["message"];
        return {
          ...choice,
          message,
        };
      }),
    };
  },
};
