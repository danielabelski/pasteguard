import { describe, expect, test } from "bun:test";
import type { PlaceholderContext } from "../../masking/context";
import type {
  AnthropicMessage,
  AnthropicRequest,
  AnthropicResponse,
} from "../../providers/anthropic/types";
import { anthropicExtractor } from "./anthropic";

/** Helper to create a minimal request from messages */
function createRequest(
  messages: AnthropicMessage[],
  system?: string | Array<{ type: "text"; text: string }>,
): AnthropicRequest {
  return { model: "claude-3-sonnet-20240229", max_tokens: 1024, messages, system };
}

describe("Anthropic Text Extractor", () => {
  describe("extractTexts", () => {
    test("extracts text from string content", () => {
      const request = createRequest([
        { role: "user", content: "Hello world" },
        { role: "assistant", content: "Hi there" },
      ]);

      const spans = anthropicExtractor.extractTexts(request);

      expect(spans).toHaveLength(2);
      expect(spans[0]).toEqual({
        text: "Hello world",
        path: "messages[0].content",
        messageIndex: 0,
        partIndex: 0,
        role: "user",
      });
      expect(spans[1]).toEqual({
        text: "Hi there",
        path: "messages[1].content",
        messageIndex: 1,
        partIndex: 0,
        role: "assistant",
      });
    });

    test("extracts text from system string", () => {
      const request = createRequest(
        [{ role: "user", content: "Hello" }],
        "You are a helpful assistant",
      );

      const spans = anthropicExtractor.extractTexts(request);

      expect(spans).toHaveLength(2);
      // System comes first with messageIndex: -1
      expect(spans[0]).toEqual({
        text: "You are a helpful assistant",
        path: "system",
        messageIndex: -1,
        partIndex: 0,
        role: "system",
      });
      expect(spans[1]).toEqual({
        text: "Hello",
        path: "messages[0].content",
        messageIndex: 0,
        partIndex: 0,
        role: "user",
      });
    });

    test("extracts text from system array", () => {
      const request = createRequest(
        [{ role: "user", content: "Hello" }],
        [
          { type: "text", text: "First system part" },
          { type: "text", text: "Second system part" },
        ],
      );

      const spans = anthropicExtractor.extractTexts(request);

      expect(spans).toHaveLength(3);
      expect(spans[0]).toEqual({
        text: "First system part",
        path: "system[0].text",
        messageIndex: -1,
        partIndex: 0,
        role: "system",
      });
      expect(spans[1]).toEqual({
        text: "Second system part",
        path: "system[1].text",
        messageIndex: -1,
        partIndex: 1,
        role: "system",
      });
      expect(spans[2].role).toBe("user");
    });

    test("extracts text from text blocks in array content", () => {
      const request = createRequest([
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image:" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
            { type: "text", text: "Be detailed" },
          ],
        },
      ]);

      const spans = anthropicExtractor.extractTexts(request);

      expect(spans).toHaveLength(2);
      expect(spans[0]).toEqual({
        text: "Describe this image:",
        path: "messages[0].content[0].text",
        messageIndex: 0,
        partIndex: 0,
        role: "user",
      });
      expect(spans[1]).toEqual({
        text: "Be detailed",
        path: "messages[0].content[2].text",
        messageIndex: 0,
        partIndex: 2,
        role: "user",
      });
    });

    test("extracts text from thinking blocks", () => {
      const request = createRequest([
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think about this..." },
            { type: "text", text: "Here's my answer" },
          ],
        },
      ]);

      const spans = anthropicExtractor.extractTexts(request);

      expect(spans).toHaveLength(2);
      expect(spans[0]).toEqual({
        text: "Let me think about this...",
        path: "messages[0].content[0].thinking",
        messageIndex: 0,
        partIndex: 0,
        role: "assistant",
      });
      expect(spans[1]).toEqual({
        text: "Here's my answer",
        path: "messages[0].content[1].text",
        messageIndex: 0,
        partIndex: 1,
        role: "assistant",
      });
    });

    test("extracts text from tool_result with string content", () => {
      const request = createRequest([
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_123", content: "Tool output here" }],
        },
      ]);

      const spans = anthropicExtractor.extractTexts(request);

      expect(spans).toHaveLength(1);
      expect(spans[0]).toEqual({
        text: "Tool output here",
        path: "messages[0].content[0].content",
        messageIndex: 0,
        partIndex: 0,
        role: "tool",
      });
    });

    test("extracts text from tool_result with array content, skipping images", () => {
      const request = createRequest([
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_123",
              content: [
                { type: "text", text: "First text block" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
                { type: "text", text: "Second text block" },
              ],
            },
          ],
        },
      ]);

      const spans = anthropicExtractor.extractTexts(request);

      expect(spans).toHaveLength(2);
      expect(spans[0]).toEqual({
        text: "First text block",
        path: "messages[0].content[0].content[0].text",
        messageIndex: 0,
        partIndex: 0,
        nestedPartIndex: 0,
        role: "tool",
      });
      expect(spans[1]).toEqual({
        text: "Second text block",
        path: "messages[0].content[0].content[2].text",
        messageIndex: 0,
        partIndex: 0,
        nestedPartIndex: 2,
        role: "tool",
      });
    });

    test("handles mixed string and array content", () => {
      const request = createRequest([
        { role: "user", content: "Simple message" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Complex response" }],
        },
        { role: "user", content: "Another simple one" },
      ]);

      const spans = anthropicExtractor.extractTexts(request);

      expect(spans).toHaveLength(3);
      expect(spans[0].messageIndex).toBe(0);
      expect(spans[0].role).toBe("user");
      expect(spans[1].messageIndex).toBe(1);
      expect(spans[1].role).toBe("assistant");
      expect(spans[2].messageIndex).toBe(2);
      expect(spans[2].role).toBe("user");
    });

    test("skips redacted_thinking blocks", () => {
      const request = createRequest([
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "encrypted_data" },
            { type: "text", text: "Visible response" },
          ],
        },
      ]);

      const spans = anthropicExtractor.extractTexts(request);

      expect(spans).toHaveLength(1);
      expect(spans[0].text).toBe("Visible response");
    });

    test("skips image blocks", () => {
      const request = createRequest([
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
          ],
        },
      ]);

      const spans = anthropicExtractor.extractTexts(request);

      expect(spans).toHaveLength(1);
      expect(spans[0].text).toBe("Look at this");
    });

    test("skips tool_use blocks", () => {
      const request = createRequest([
        {
          role: "assistant",
          content: [
            { type: "text", text: "Using a tool" },
            { type: "tool_use", id: "tool_1", name: "calculator", input: { x: 5 } },
          ],
        },
      ]);

      const spans = anthropicExtractor.extractTexts(request);

      expect(spans).toHaveLength(1);
      expect(spans[0].text).toBe("Using a tool");
    });

    test("handles empty messages array", () => {
      const request = createRequest([]);
      const spans = anthropicExtractor.extractTexts(request);
      expect(spans).toHaveLength(0);
    });

    test("handles empty content", () => {
      const request = createRequest([{ role: "user", content: "" }]);
      const spans = anthropicExtractor.extractTexts(request);
      expect(spans).toHaveLength(0);
    });
  });

  describe("applyMasked", () => {
    test("applies masked text to string content", () => {
      const request = createRequest([{ role: "user", content: "My email is john@example.com" }]);

      const maskedSpans = [
        {
          path: "messages[0].content",
          maskedText: "My email is [[EMAIL_ADDRESS_1]]",
          messageIndex: 0,
          partIndex: 0,
        },
      ];

      const result = anthropicExtractor.applyMasked(request, maskedSpans);

      expect(result.messages[0].content).toBe("My email is [[EMAIL_ADDRESS_1]]");
    });

    test("applies masked text to system string", () => {
      const request = createRequest(
        [{ role: "user", content: "Hello" }],
        "You are helping John Smith",
      );

      const maskedSpans = [
        {
          path: "system",
          maskedText: "You are helping [[PERSON_1]]",
          messageIndex: -1,
          partIndex: 0,
        },
      ];

      const result = anthropicExtractor.applyMasked(request, maskedSpans);

      expect(result.system).toBe("You are helping [[PERSON_1]]");
    });

    test("applies masked text to system array", () => {
      const request = createRequest(
        [{ role: "user", content: "Hello" }],
        [
          { type: "text", text: "Help John Smith" },
          { type: "text", text: "His email is john@test.com" },
        ],
      );

      const maskedSpans = [
        {
          path: "system[0].text",
          maskedText: "Help [[PERSON_1]]",
          messageIndex: -1,
          partIndex: 0,
        },
        {
          path: "system[1].text",
          maskedText: "His email is [[EMAIL_ADDRESS_1]]",
          messageIndex: -1,
          partIndex: 1,
        },
      ];

      const result = anthropicExtractor.applyMasked(request, maskedSpans);
      const system = result.system as Array<{ type: string; text: string }>;

      expect(system[0].text).toBe("Help [[PERSON_1]]");
      expect(system[1].text).toBe("His email is [[EMAIL_ADDRESS_1]]");
    });

    test("applies masked text to text blocks", () => {
      const request = createRequest([
        {
          role: "user",
          content: [
            { type: "text", text: "Contact: john@example.com" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
            { type: "text", text: "Phone: 555-1234" },
          ],
        },
      ]);

      const maskedSpans = [
        {
          path: "messages[0].content[0].text",
          maskedText: "Contact: [[EMAIL_ADDRESS_1]]",
          messageIndex: 0,
          partIndex: 0,
        },
        {
          path: "messages[0].content[2].text",
          maskedText: "Phone: [[PHONE_NUMBER_1]]",
          messageIndex: 0,
          partIndex: 2,
        },
      ];

      const result = anthropicExtractor.applyMasked(request, maskedSpans);
      const content = result.messages[0].content as Array<{ type: string; text?: string }>;

      expect(content[0].text).toBe("Contact: [[EMAIL_ADDRESS_1]]");
      expect(content[1].type).toBe("image"); // Unchanged
      expect(content[2].text).toBe("Phone: [[PHONE_NUMBER_1]]");
    });

    test("applies masked text to thinking blocks", () => {
      const request = createRequest([
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "User John Smith mentioned..." }],
        },
      ]);

      const maskedSpans = [
        {
          path: "messages[0].content[0].thinking",
          maskedText: "User [[PERSON_1]] mentioned...",
          messageIndex: 0,
          partIndex: 0,
        },
      ];

      const result = anthropicExtractor.applyMasked(request, maskedSpans);
      const content = result.messages[0].content as Array<{ type: string; thinking?: string }>;

      expect(content[0].thinking).toBe("User [[PERSON_1]] mentioned...");
    });

    test("applies masked text to tool_result with string content", () => {
      const request = createRequest([
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool_1", content: "Result for john@test.com" },
          ],
        },
      ]);

      const maskedSpans = [
        {
          path: "messages[0].content[0].content",
          maskedText: "Result for [[EMAIL_ADDRESS_1]]",
          messageIndex: 0,
          partIndex: 0,
        },
      ];

      const result = anthropicExtractor.applyMasked(request, maskedSpans);
      const content = result.messages[0].content as Array<{ type: string; content?: string }>;

      expect(content[0].content).toBe("Result for [[EMAIL_ADDRESS_1]]");
    });

    test("applies masked text to tool_result with array content, preserving images", () => {
      const request = createRequest([
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: [
                { type: "text", text: "Screenshot of john@test.com profile" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "abc123" },
                },
                { type: "text", text: "End of results" },
              ],
            },
          ],
        },
      ]);

      const maskedSpans = [
        {
          path: "messages[0].content[0].content[0].text",
          maskedText: "Screenshot of [[EMAIL_ADDRESS_1]] profile",
          messageIndex: 0,
          partIndex: 0,
          nestedPartIndex: 0,
        },
        {
          path: "messages[0].content[0].content[2].text",
          maskedText: "End of results",
          messageIndex: 0,
          partIndex: 0,
          nestedPartIndex: 2,
        },
      ];

      const result = anthropicExtractor.applyMasked(request, maskedSpans);
      const content = result.messages[0].content as Array<{
        type: string;
        content?: Array<{ type: string; text?: string; source?: unknown }>;
      }>;

      const nestedContent = content[0].content!;
      expect(nestedContent).toHaveLength(3);
      expect(nestedContent[0].type).toBe("text");
      expect(nestedContent[0].text).toBe("Screenshot of [[EMAIL_ADDRESS_1]] profile");
      expect(nestedContent[1].type).toBe("image");
      expect(nestedContent[1].source).toEqual({
        type: "base64",
        media_type: "image/png",
        data: "abc123",
      });
      expect(nestedContent[2].type).toBe("text");
      expect(nestedContent[2].text).toBe("End of results");
    });

    test("preserves messages without masked spans", () => {
      const request = createRequest([
        { role: "user", content: "No PII here" },
        { role: "assistant", content: "My email is john@example.com" },
      ]);

      const maskedSpans = [
        {
          path: "messages[1].content",
          maskedText: "My email is [[EMAIL_ADDRESS_1]]",
          messageIndex: 1,
          partIndex: 0,
        },
      ];

      const result = anthropicExtractor.applyMasked(request, maskedSpans);

      expect(result.messages[0].content).toBe("No PII here"); // Unchanged
      expect(result.messages[1].content).toBe("My email is [[EMAIL_ADDRESS_1]]");
    });

    test("preserves message roles", () => {
      const request = createRequest([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ]);

      const maskedSpans = [
        { path: "messages[0].content", maskedText: "Masked", messageIndex: 0, partIndex: 0 },
      ];

      const result = anthropicExtractor.applyMasked(request, maskedSpans);

      expect(result.messages[0].role).toBe("user");
      expect(result.messages[1].role).toBe("assistant");
    });

    test("creates deep copy of messages", () => {
      const request = createRequest([
        {
          role: "user",
          content: [{ type: "text", text: "Original" }],
        },
      ]);

      const maskedSpans = [
        {
          path: "messages[0].content[0].text",
          maskedText: "Masked",
          messageIndex: 0,
          partIndex: 0,
        },
      ];

      const result = anthropicExtractor.applyMasked(request, maskedSpans);

      // Original should be unchanged
      expect((request.messages[0].content as Array<{ text: string }>)[0].text).toBe("Original");
      expect((result.messages[0].content as Array<{ text: string }>)[0].text).toBe("Masked");
    });
  });

  describe("unmaskResponse", () => {
    test("unmasks placeholders in response content", () => {
      const response: AnthropicResponse = {
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello [[PERSON_1]], your email is [[EMAIL_ADDRESS_1]]" }],
        model: "claude-3-sonnet-20240229",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const context: PlaceholderContext = {
        mapping: {
          "[[PERSON_1]]": "John",
          "[[EMAIL_ADDRESS_1]]": "john@example.com",
        },
        reverseMapping: {
          John: "[[PERSON_1]]",
          "john@example.com": "[[EMAIL_ADDRESS_1]]",
        },
        counters: { PERSON: 1, EMAIL_ADDRESS: 1 },
      };

      const result = anthropicExtractor.unmaskResponse(response, context);

      expect((result.content[0] as { text: string }).text).toBe(
        "Hello John, your email is john@example.com",
      );
    });

    test("applies formatValue function when provided", () => {
      const response: AnthropicResponse = {
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello [[PERSON_1]]" }],
        model: "claude-3-sonnet-20240229",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const context: PlaceholderContext = {
        mapping: { "[[PERSON_1]]": "John" },
        reverseMapping: { John: "[[PERSON_1]]" },
        counters: { PERSON: 1 },
      };

      const result = anthropicExtractor.unmaskResponse(
        response,
        context,
        (val) => `[protected]${val}`,
      );

      expect((result.content[0] as { text: string }).text).toBe("Hello [protected]John");
    });

    test("handles multiple text blocks", () => {
      const response: AnthropicResponse = {
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "First: [[PERSON_1]]" },
          { type: "text", text: "Second: [[PERSON_1]]" },
        ],
        model: "claude-3-sonnet-20240229",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const context: PlaceholderContext = {
        mapping: { "[[PERSON_1]]": "Alice" },
        reverseMapping: { Alice: "[[PERSON_1]]" },
        counters: { PERSON: 1 },
      };

      const result = anthropicExtractor.unmaskResponse(response, context);

      expect((result.content[0] as { text: string }).text).toBe("First: Alice");
      expect((result.content[1] as { text: string }).text).toBe("Second: Alice");
    });

    test("preserves non-text blocks", () => {
      const response: AnthropicResponse = {
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "[[PERSON_1]]" },
          { type: "tool_use", id: "tool_1", name: "calculator", input: { x: 5 } },
        ],
        model: "claude-3-sonnet-20240229",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const context: PlaceholderContext = {
        mapping: { "[[PERSON_1]]": "Bob" },
        reverseMapping: { Bob: "[[PERSON_1]]" },
        counters: { PERSON: 1 },
      };

      const result = anthropicExtractor.unmaskResponse(response, context);

      expect((result.content[0] as { text: string }).text).toBe("Bob");
      expect(result.content[1].type).toBe("tool_use");
    });

    test("preserves response structure", () => {
      const response: AnthropicResponse = {
        id: "resp_abc",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Test" }],
        model: "claude-3-opus",
        stop_reason: "max_tokens",
        stop_sequence: "END",
        usage: { input_tokens: 100, output_tokens: 50 },
      };

      const context: PlaceholderContext = {
        mapping: {},
        reverseMapping: {},
        counters: {},
      };

      const result = anthropicExtractor.unmaskResponse(response, context);

      expect(result.id).toBe("resp_abc");
      expect(result.model).toBe("claude-3-opus");
      expect(result.stop_reason).toBe("max_tokens");
      expect(result.stop_sequence).toBe("END");
      expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    });

    test("handles empty mapping", () => {
      const response: AnthropicResponse = {
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "No placeholders here" }],
        model: "claude-3-sonnet-20240229",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const context: PlaceholderContext = {
        mapping: {},
        reverseMapping: {},
        counters: {},
      };

      const result = anthropicExtractor.unmaskResponse(response, context);

      expect((result.content[0] as { text: string }).text).toBe("No placeholders here");
    });
  });

  // ---------------------------------------------------------------------------
  // BUG CONDITION EXPLORATION TESTS (Property 1: Bug Condition)
  // These encode the EXPECTED (correct/fixed) behavior and are EXPECTED TO FAIL
  // on the current unfixed code. A failure here confirms the bug exists.
  // Spec: .kiro/specs/pasteguard-tools-passthrough-fix (Cause 1, branch argsLeak)
  // **Validates: Requirements 1.2, 1.4**
  // ---------------------------------------------------------------------------
  describe("BUG: tool_use.input unmask leak (Property 1 / argsLeak)", () => {
    test("restores placeholders inside tool_use.input (non-stream)", () => {
      const response: AnthropicResponse = {
        id: "msg_tooluse",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "Let me look that up." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "send_email",
            input: {
              to: "[[EMAIL_ADDRESS_1]]",
              cc: ["[[EMAIL_ADDRESS_1]]", "team@corp.com"],
              subject: "Hello [[PERSON_1]]",
              count: 3,
              flag: true,
            },
            // biome-ignore lint/suspicious/noExplicitAny: tool_use block in response content
          } as any,
        ],
        model: "claude-3-sonnet-20240229",
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const context: PlaceholderContext = {
        mapping: {
          "[[EMAIL_ADDRESS_1]]": "user@example.com",
          "[[PERSON_1]]": "Alice",
        },
        reverseMapping: {
          "user@example.com": "[[EMAIL_ADDRESS_1]]",
          Alice: "[[PERSON_1]]",
        },
        counters: { EMAIL_ADDRESS: 1, PERSON: 1 },
      };

      const result = anthropicExtractor.unmaskResponse(response, context);

      // biome-ignore lint/suspicious/noExplicitAny: reading tool_use input in assertion
      const toolBlock = result.content[1] as any;
      expect(toolBlock.type).toBe("tool_use");
      // EXPECTED (fixed) behavior: every placeholder leaf is restored
      expect(toolBlock.input.to).toBe("user@example.com");
      expect(toolBlock.input.cc).toEqual(["user@example.com", "team@corp.com"]);
      expect(toolBlock.input.subject).toBe("Hello Alice");
      // Structure / non-string leaves are preserved as-is
      expect(toolBlock.input.count).toBe(3);
      expect(toolBlock.input.flag).toBe(true);
      expect(toolBlock.id).toBe("toolu_1");
      expect(toolBlock.name).toBe("send_email");
      // Serialized form must contain no leftover placeholders
      expect(JSON.stringify(result.content)).not.toContain("[[");
      // Text block still unmasked as before
      // biome-ignore lint/suspicious/noExplicitAny: reading text block
      expect((result.content[0] as any).text).toBe("Let me look that up.");
    });
  });

  // ---------------------------------------------------------------------------
  // BUG CONDITION EXPLORATION TEST — OpenAI-shaped body on /anthropic (502 fix)
  // Discovered in e2e (task 4.1): after fix 3.3 made the non-streaming Anthropic
  // path reachable, 9router combo aliases (haiku/sonnet) return an OpenAI-shaped
  // JSON body on /anthropic ({ object: "chat.completion", choices: [...] } with
  // NO top-level `content` array). The old unmaskResponse did `response.content.map`
  // and threw `TypeError: undefined is not an object`, producing HTTP 502.
  // This test encodes the EXPECTED (fixed) behavior: no throw + placeholders
  // restored in the OpenAI-shaped body. It MUST FAIL on the unfixed code.
  // Spec: .kiro/specs/pasteguard-tools-passthrough-fix (task 3.8)
  // **Validates: Requirements 2.1, 2.5**
  // ---------------------------------------------------------------------------
  describe("BUG: OpenAI-shaped body tolerance (task 3.8 / 502 fix)", () => {
    const context: PlaceholderContext = {
      mapping: {
        "[[EMAIL_ADDRESS_1]]": "user@example.com",
        "[[PERSON_1]]": "Alice",
      },
      reverseMapping: {
        "user@example.com": "[[EMAIL_ADDRESS_1]]",
        Alice: "[[PERSON_1]]",
      },
      counters: { EMAIL_ADDRESS: 1, PERSON: 1 },
    };

    // Build an OpenAI chat.completion body as returned by 9router combo aliases.
    function openAiShapedBody() {
      return {
        id: "chatcmpl_combo",
        object: "chat.completion",
        created: 1,
        model: "minimax/MiniMax-Text-01",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello [[PERSON_1]], your email is [[EMAIL_ADDRESS_1]]",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "send_email",
                    arguments: '{"to":"[[EMAIL_ADDRESS_1]]","subject":"Hi [[PERSON_1]]"}',
                  },
                },
              ],
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        // biome-ignore lint/suspicious/noExplicitAny: cross-shaped body passed to anthropic unmask
      } as any;
    }

    test("does not throw on a body with no top-level content array", () => {
      expect(() =>
        anthropicExtractor.unmaskResponse(openAiShapedBody(), context),
      ).not.toThrow();
    });

    test("restores placeholders in OpenAI-shaped message.content and tool_calls", () => {
      // biome-ignore lint/suspicious/noExplicitAny: cross-shaped result inspected in assertions
      const result = anthropicExtractor.unmaskResponse(openAiShapedBody(), context) as any;

      const message = result.choices[0].message;
      expect(message.content).toBe("Hello Alice, your email is user@example.com");
      expect(message.tool_calls[0].function.arguments).toBe(
        '{"to":"user@example.com","subject":"Hi Alice"}',
      );
      // Other fields preserved
      expect(message.tool_calls[0].id).toBe("call_1");
      expect(message.tool_calls[0].function.name).toBe("send_email");
      expect(result.object).toBe("chat.completion");
      // No leftover placeholders anywhere
      expect(JSON.stringify(result)).not.toContain("[[");
    });

    test("returns an unrecognized body shape unchanged instead of throwing", () => {
      // Neither an Anthropic message (content[]) nor OpenAI-shaped (choices[]).
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed body
      const weird = { id: "x", object: "unknown", note: "[[PERSON_1]]" } as any;
      // biome-ignore lint/suspicious/noExplicitAny: inspecting passthrough result
      let result: any;
      expect(() => {
        result = anthropicExtractor.unmaskResponse(weird, context);
      }).not.toThrow();
      // Passed through unchanged (no Anthropic/OpenAI structure to unmask)
      expect(result).toEqual(weird);
    });
  });

  describe("cache_control preservation", () => {
    test("preserves cache_control on text block through applyMasked", () => {
      const request = createRequest([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Contact john@example.com",
              cache_control: { type: "ephemeral" },
              // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
            } as any,
          ],
        },
      ]);

      const maskedSpans = [
        {
          path: "messages[0].content[0].text",
          maskedText: "Contact [[EMAIL_ADDRESS_1]]",
          messageIndex: 0,
          partIndex: 0,
        },
      ];

      const result = anthropicExtractor.applyMasked(request, maskedSpans);
      // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
      const block = (result.messages[0].content as any[])[0];

      expect(block.text).toBe("Contact [[EMAIL_ADDRESS_1]]");
      expect(block.cache_control).toEqual({ type: "ephemeral" });
    });

    test("preserves cache_control on system prompt block through applyMasked", () => {
      const request = createRequest(
        [{ role: "user", content: "Hello" }],
        [
          {
            type: "text",
            text: "You are an assistant. User is John Doe.",
            cache_control: { type: "ephemeral" },
            // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
          } as any,
        ],
      );

      const maskedSpans = [
        {
          path: "system[0].text",
          maskedText: "You are an assistant. User is [[PERSON_1]].",
          messageIndex: -1,
          partIndex: 0,
        },
      ];

      const result = anthropicExtractor.applyMasked(request, maskedSpans);
      // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
      const block = (result.system as any[])[0];

      expect(block.text).toBe("You are an assistant. User is [[PERSON_1]].");
      expect(block.cache_control).toEqual({ type: "ephemeral" });
    });

    test("preserves unknown fields on message through applyMasked", () => {
      const request = createRequest([
        {
          role: "user",
          content: "Hello",
          extra_field: "preserved",
          // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
        } as any,
      ]);

      const maskedSpans = [
        {
          path: "messages[0].content",
          maskedText: "Hello",
          messageIndex: 0,
          partIndex: 0,
        },
      ];

      const result = anthropicExtractor.applyMasked(request, maskedSpans);

      // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
      expect((result.messages[0] as any).extra_field).toBe("preserved");
    });

    test("preserves cache_control when no masking is applied", () => {
      const request = createRequest([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "No PII here",
              cache_control: { type: "ephemeral" },
              // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
            } as any,
          ],
        },
      ]);

      // applyMasked with no-op span (text unchanged)
      const maskedSpans = [
        {
          path: "messages[0].content[0].text",
          maskedText: "No PII here",
          messageIndex: 0,
          partIndex: 0,
        },
      ];

      const result = anthropicExtractor.applyMasked(request, maskedSpans);
      // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
      const block = (result.messages[0].content as any[])[0];

      expect(block.cache_control).toEqual({ type: "ephemeral" });
    });
  });
});


// =============================================================================
// PRESERVATION TESTS (Property 4 & 5: Preservation)
// observation-first: these lock in the CURRENT (unfixed) behavior for inputs
// where isBugCondition is FALSE (plain text, no tools, mode not forced).
// They MUST PASS on the unfixed code and MUST keep passing after the fix.
// Spec: .kiro/specs/pasteguard-tools-passthrough-fix
// **Validates: Requirements 3.1, 3.3, 3.5**
// =============================================================================

describe("PRESERVATION: Anthropic text unmask parity (Property 4)", () => {
  test("restores placeholders in plain-text response content (baseline)", () => {
    const response: AnthropicResponse = {
      id: "msg_pres_1",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "Hi [[PERSON_1]], reach me at [[EMAIL_ADDRESS_1]]" },
        { type: "text", text: "Second mention of [[PERSON_1]]." },
      ],
      model: "claude-3-sonnet-20240229",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const context: PlaceholderContext = {
      mapping: { "[[PERSON_1]]": "Alice", "[[EMAIL_ADDRESS_1]]": "alice@example.com" },
      reverseMapping: { Alice: "[[PERSON_1]]", "alice@example.com": "[[EMAIL_ADDRESS_1]]" },
      counters: { PERSON: 1, EMAIL_ADDRESS: 1 },
    };

    const result = anthropicExtractor.unmaskResponse(response, context);

    // Baseline: text blocks fully restored, no placeholder remnants
    expect((result.content[0] as { text: string }).text).toBe(
      "Hi Alice, reach me at alice@example.com",
    );
    expect((result.content[1] as { text: string }).text).toBe("Second mention of Alice.");
    expect(JSON.stringify(result.content)).not.toContain("[[");
    // Structure preserved
    expect(result.id).toBe("msg_pres_1");
    expect(result.content).toHaveLength(2);
  });

  test("leaves text without placeholders untouched (baseline)", () => {
    const response: AnthropicResponse = {
      id: "msg_pres_2",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Just a normal sentence." }],
      model: "claude-3-sonnet-20240229",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const context: PlaceholderContext = {
      mapping: { "[[PERSON_1]]": "Alice" },
      reverseMapping: { Alice: "[[PERSON_1]]" },
      counters: { PERSON: 1 },
    };

    const result = anthropicExtractor.unmaskResponse(response, context);
    expect((result.content[0] as { text: string }).text).toBe("Just a normal sentence.");
  });
});

describe("PRESERVATION: Anthropic passthrough parity (Property 5)", () => {
  test("applyMasked preserves unknown block fields when no masking applies (.passthrough())", () => {
    const request = createRequest([
      {
        role: "user",
        // unknown message-level field must survive
        extra_message_field: "keep-me-too",
        content: [
          {
            type: "text",
            text: "No PII or secrets here",
            cache_control: { type: "ephemeral" },
            // biome-ignore lint/suspicious/noExplicitAny: testing passthrough of unknown fields
          } as any,
        ],
        // biome-ignore lint/suspicious/noExplicitAny: testing passthrough of unknown fields
      } as any,
    ]);

    // No masked spans -> nothing to change; unknown fields must be preserved.
    const result = anthropicExtractor.applyMasked(request, []);

    // biome-ignore lint/suspicious/noExplicitAny: testing passthrough of unknown fields
    expect((result.messages[0] as any).extra_message_field).toBe("keep-me-too");
    // biome-ignore lint/suspicious/noExplicitAny: testing passthrough of unknown fields
    const block = (result.messages[0].content as any[])[0];
    expect(block.text).toBe("No PII or secrets here");
    expect(block.cache_control).toEqual({ type: "ephemeral" });
  });

  test("applyMasked with no masked spans leaves body content unchanged (baseline)", () => {
    const request = createRequest([
      { role: "user", content: "No PII, no secrets, no tools" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Plain reply" }],
      },
    ]);

    const result = anthropicExtractor.applyMasked(request, []);

    expect(result.messages[0].content).toBe("No PII, no secrets, no tools");
    expect((result.messages[1].content as Array<{ text: string }>)[0].text).toBe("Plain reply");
  });
});
