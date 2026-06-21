import { describe, expect, test } from "bun:test";
import type { AnthropicRequest } from "../providers/anthropic/types";
import {
  hoistSystemMessages,
  sanitizeToolUseIds,
  stripEmptyThinkingBlocks,
  stripThinkingBlocks,
} from "./normalize";

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

describe("stripEmptyThinkingBlocks", () => {
  test("removes a whitespace-only thinking block but keeps the following text block and order", () => {
    const result = stripEmptyThinkingBlocks(
      req({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "\n  " },
              { type: "text", text: "the answer" },
            ],
          },
        ],
      }),
    );

    const content = result.messages[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBe("the answer");
  });

  test("removes an empty-string thinking block", () => {
    const result = stripEmptyThinkingBlocks(
      req({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "" },
              { type: "text", text: "hello" },
            ],
          },
        ],
      }),
    );

    const content = result.messages[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });

  test("keeps a non-whitespace thinking block unchanged", () => {
    const input = req({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me reason about this" },
            { type: "text", text: "done" },
          ],
        },
      ],
    });

    const result = stripEmptyThinkingBlocks(input);
    expect(result).toBe(input); // same reference — no change
    const content = result.messages[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0].thinking).toBe("let me reason about this");
  });

  test("keeps a redacted_thinking block unchanged (opaque data, treated as valid)", () => {
    const input = req({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "EncryptedOpaqueBlob==" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    });

    const result = stripEmptyThinkingBlocks(input);
    expect(result).toBe(input); // same reference — no change
    const content = result.messages[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("redacted_thinking");
  });

  test("does not empty a message whose only block is a whitespace thinking block (guard)", () => {
    const input = req({
      messages: [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "   " }],
        },
      ],
    });

    const result = stripEmptyThinkingBlocks(input);
    const content = result.messages[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("thinking");
  });

  test("leaves string-content messages untouched", () => {
    const input = req({
      messages: [{ role: "user", content: "plain text content" }],
    });

    const result = stripEmptyThinkingBlocks(input);
    expect(result).toBe(input); // same reference — no change
    expect(result.messages[0].content).toBe("plain text content");
  });
});

describe("stripThinkingBlocks", () => {
  test("removes a thinking block (with signature) but keeps the text block and order", () => {
    const result = stripThinkingBlocks(
      req({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "let me reason", signature: "foreign-sig-abc" },
              { type: "text", text: "the answer" },
            ],
          },
        ],
      }),
    );

    const content = result.messages[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBe("the answer");
  });

  test("removes redacted_thinking blocks", () => {
    const result = stripThinkingBlocks(
      req({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "redacted_thinking", data: "EncryptedOpaqueBlob==" },
              { type: "text", text: "answer" },
            ],
          },
        ],
      }),
    );

    const content = result.messages[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });

  test("removes thinking blocks regardless of signature validity or content", () => {
    const result = stripThinkingBlocks(
      req({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "non-whitespace reasoning", signature: "invalid" },
              { type: "thinking", thinking: "" },
              { type: "redacted_thinking", data: "blob" },
              { type: "text", text: "final" },
            ],
          },
        ],
      }),
    );

    const content = result.messages[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBe("final");
  });

  test("drops a thinking-only message and preserves other messages/order", () => {
    const result = stripThinkingBlocks(
      req({
        messages: [
          { role: "user", content: "first" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "internal reasoning", signature: "foreign" },
            ],
          },
          { role: "user", content: "third" },
        ],
      }),
    );

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("first");
    expect(result.messages[1].role).toBe("user");
    expect(result.messages[1].content).toBe("third");
  });

  test("leaves string content and thinking-free messages untouched (same reference)", () => {
    const input = req({
      messages: [
        { role: "user", content: "plain text content" },
        {
          role: "assistant",
          content: [{ type: "text", text: "no thinking here" }],
        },
      ],
    });

    const result = stripThinkingBlocks(input);
    expect(result).toBe(input); // same reference — no change
    expect(result.messages[0].content).toBe("plain text content");
  });

  test("preserves tool_use and tool_result blocks (binding intact)", () => {
    const result = stripThinkingBlocks(
      req({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "deciding to call tool", signature: "foreign" },
              { type: "tool_use", id: "call_1", name: "search", input: {} },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
          },
        ],
      }),
    );

    const assistant = result.messages[0].content as Array<Record<string, unknown>>;
    expect(assistant).toHaveLength(1);
    expect(assistant[0].type).toBe("tool_use");
    expect(assistant[0].id).toBe("call_1");

    const user = result.messages[1].content as Array<Record<string, unknown>>;
    expect(user).toHaveLength(1);
    expect(user[0].type).toBe("tool_result");
    expect(user[0].tool_use_id).toBe("call_1");
  });
});
