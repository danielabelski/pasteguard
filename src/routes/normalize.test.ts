import { describe, expect, test } from "bun:test";
import type { AnthropicRequest } from "../providers/anthropic/types";
import { hoistSystemMessages, sanitizeToolUseIds } from "./normalize";

// biome-ignore lint/suspicious/noExplicitAny: tests construct partial requests
function req(partial: any): AnthropicRequest {
  return { model: "claude-3", max_tokens: 100, ...partial } as AnthropicRequest;
}

describe("hoistSystemMessages", () => {
  test("hoists a role:system message with string content into top-level system", () => {
    const result = hoistSystemMessages(
      req({
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "hi" },
        ],
      }),
    );

    expect(result.system).toBe("You are helpful");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  test("joins array content of a role:system message and hoists it", () => {
    const result = hoistSystemMessages(
      req({
        messages: [
          {
            role: "system",
            content: [
              { type: "text", text: "line one" },
              { type: "text", text: "line two" },
            ],
          },
          { role: "user", content: "hi" },
        ],
      }),
    );

    expect(result.system).toBe("line one\nline two");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  test("preserves existing top-level system by prepending it (not lost)", () => {
    const result = hoistSystemMessages(
      req({
        system: "base system",
        messages: [
          { role: "system", content: "extra system" },
          { role: "user", content: "hi" },
        ],
      }),
    );

    expect(result.system).toBe("base system\nextra system");
    expect(result.messages).toHaveLength(1);
  });

  test("leaves messages without a system role untouched and preserves order", () => {
    const input = req({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
    });

    const result = hoistSystemMessages(input);

    expect(result).toBe(input); // same reference — no change
    expect(result.messages.map((m) => m.content)).toEqual(["first", "second", "third"]);
  });
});

describe("sanitizeToolUseIds", () => {
  test("replaces dots and colons in tool_use.id with underscores", () => {
    const result = sanitizeToolUseIds(
      req({
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call.abc:123", name: "search", input: {} }],
          },
        ],
      }),
    );

    const block = (result.messages[0].content as Array<Record<string, unknown>>)[0];
    expect(block.id).toBe("call_abc_123");
  });

  test("sanitizes matching tool_result.tool_use_id identically", () => {
    const result = sanitizeToolUseIds(
      req({
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call.abc:123", name: "search", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call.abc:123", content: "ok" }],
          },
        ],
      }),
    );

    const useBlock = (result.messages[0].content as Array<Record<string, unknown>>)[0];
    const resultBlock = (result.messages[1].content as Array<Record<string, unknown>>)[0];
    expect(useBlock.id).toBe("call_abc_123");
    expect(resultBlock.tool_use_id).toBe("call_abc_123");
    // binding preserved: both sanitized to the same value
    expect(resultBlock.tool_use_id).toBe(useBlock.id);
  });

  test("leaves already-valid ids untouched", () => {
    const input = req({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "valid_id-123", name: "search", input: {} }],
        },
      ],
    });

    const result = sanitizeToolUseIds(input);
    const block = (result.messages[0].content as Array<Record<string, unknown>>)[0];
    expect(block.id).toBe("valid_id-123");
  });

  test("leaves non-array message content untouched", () => {
    const input = req({
      messages: [{ role: "user", content: "plain text content" }],
    });

    const result = sanitizeToolUseIds(input);
    expect(result.messages[0].content).toBe("plain text content");
  });
});
