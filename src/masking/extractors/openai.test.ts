import { describe, expect, test } from "bun:test";
import type { PlaceholderContext } from "../../masking/context";
import type { OpenAIMessage, OpenAIRequest, OpenAIResponse } from "../../providers/openai/types";
import { openaiExtractor } from "./openai";

/** Helper to create a minimal request from messages */
function createRequest(messages: OpenAIMessage[]): OpenAIRequest {
  return { model: "gpt-4", messages };
}

describe("OpenAI Text Extractor", () => {
  describe("extractTexts", () => {
    test("extracts text from string content", () => {
      const request = createRequest([
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello world" },
      ]);

      const spans = openaiExtractor.extractTexts(request);

      expect(spans).toHaveLength(2);
      expect(spans[0]).toEqual({
        text: "You are helpful",
        path: "messages[0].content",
        messageIndex: 0,
        partIndex: 0,
        role: "system",
      });
      expect(spans[1]).toEqual({
        text: "Hello world",
        path: "messages[1].content",
        messageIndex: 1,
        partIndex: 0,
        role: "user",
      });
    });

    test("extracts text from multimodal array content", () => {
      const request = createRequest([
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image:" },
            { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
            { type: "text", text: "Be detailed" },
          ],
        },
      ]);

      const spans = openaiExtractor.extractTexts(request);

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

    test("handles mixed string and array content", () => {
      const request = createRequest([
        { role: "system", content: "System prompt" },
        {
          role: "user",
          content: [{ type: "text", text: "User message with image" }],
        },
        { role: "assistant", content: "Assistant response" },
      ]);

      const spans = openaiExtractor.extractTexts(request);

      expect(spans).toHaveLength(3);
      expect(spans[0].messageIndex).toBe(0);
      expect(spans[0].role).toBe("system");
      expect(spans[1].messageIndex).toBe(1);
      expect(spans[1].role).toBe("user");
      expect(spans[2].messageIndex).toBe(2);
      expect(spans[2].role).toBe("assistant");
    });

    test("skips null/undefined content", () => {
      const request = createRequest([
        { role: "user", content: "Hello" },
        { role: "assistant", content: null as unknown as string },
      ]);

      const spans = openaiExtractor.extractTexts(request);

      expect(spans).toHaveLength(1);
      expect(spans[0].text).toBe("Hello");
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

      const result = openaiExtractor.applyMasked(request, maskedSpans);

      expect(result.messages[0].content).toBe("My email is [[EMAIL_ADDRESS_1]]");
    });

    test("applies masked text to multimodal content", () => {
      const request = createRequest([
        {
          role: "user",
          content: [
            { type: "text", text: "Contact: john@example.com" },
            { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
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

      const result = openaiExtractor.applyMasked(request, maskedSpans);
      const content = result.messages[0].content as Array<{ type: string; text?: string }>;

      expect(content[0].text).toBe("Contact: [[EMAIL_ADDRESS_1]]");
      expect(content[1].type).toBe("image_url"); // Unchanged
      expect(content[2].text).toBe("Phone: [[PHONE_NUMBER_1]]");
    });

    test("preserves messages without masked spans", () => {
      const request = createRequest([
        { role: "system", content: "You are helpful" },
        { role: "user", content: "My email is john@example.com" },
      ]);

      const maskedSpans = [
        {
          path: "messages[1].content",
          maskedText: "My email is [[EMAIL_ADDRESS_1]]",
          messageIndex: 1,
          partIndex: 0,
        },
      ];

      const result = openaiExtractor.applyMasked(request, maskedSpans);

      expect(result.messages[0].content).toBe("You are helpful"); // Unchanged
      expect(result.messages[1].content).toBe("My email is [[EMAIL_ADDRESS_1]]");
    });
  });

  describe("unmaskResponse", () => {
    test("unmasks placeholders in response content", () => {
      const response: OpenAIResponse = {
        id: "test-id",
        object: "chat.completion",
        created: 123456,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello [[PERSON_1]], your email is [[EMAIL_ADDRESS_1]]",
            },
            finish_reason: "stop",
          },
        ],
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

      const result = openaiExtractor.unmaskResponse(response, context);

      expect(result.choices[0].message.content).toBe("Hello John, your email is john@example.com");
    });

    test("applies formatValue function when provided", () => {
      const response: OpenAIResponse = {
        id: "test-id",
        object: "chat.completion",
        created: 123456,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello [[PERSON_1]]" },
            finish_reason: "stop",
          },
        ],
      };

      const context: PlaceholderContext = {
        mapping: { "[[PERSON_1]]": "John" },
        reverseMapping: { John: "[[PERSON_1]]" },
        counters: { PERSON: 1 },
      };

      const result = openaiExtractor.unmaskResponse(
        response,
        context,
        (val) => `[protected]${val}`,
      );

      expect(result.choices[0].message.content).toBe("Hello [protected]John");
    });

    test("handles multiple choices", () => {
      const response: OpenAIResponse = {
        id: "test-id",
        object: "chat.completion",
        created: 123456,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Option A: [[PERSON_1]]" },
            finish_reason: "stop",
          },
          {
            index: 1,
            message: { role: "assistant", content: "Option B: [[PERSON_1]]" },
            finish_reason: "stop",
          },
        ],
      };

      const context: PlaceholderContext = {
        mapping: { "[[PERSON_1]]": "John" },
        reverseMapping: { John: "[[PERSON_1]]" },
        counters: { PERSON: 1 },
      };

      const result = openaiExtractor.unmaskResponse(response, context);

      expect(result.choices[0].message.content).toBe("Option A: John");
      expect(result.choices[1].message.content).toBe("Option B: John");
    });

    test("preserves non-string content", () => {
      const response: OpenAIResponse = {
        id: "test-id",
        object: "chat.completion",
        created: 123456,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null as unknown as string },
            finish_reason: "stop",
          },
        ],
      };

      const context: PlaceholderContext = {
        mapping: {},
        reverseMapping: {},
        counters: {},
      };

      const result = openaiExtractor.unmaskResponse(response, context);

      expect(result.choices[0].message.content).toBeNull();
    });

    test("unmasks text parts inside structured response content arrays", () => {
      const response: OpenAIResponse = {
        id: "test-id",
        object: "chat.completion",
        created: 123456,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                { type: "reference", reference_ids: ["ref"] },
                { type: "text", text: "Hello [[PERSON_1]]" },
                // biome-ignore lint/suspicious/noExplicitAny: testing structured content preservation
              ] as any,
            },
            finish_reason: "stop",
          },
        ],
      };

      const context: PlaceholderContext = {
        mapping: { "[[PERSON_1]]": "John" },
        reverseMapping: { John: "[[PERSON_1]]" },
        counters: { PERSON: 1 },
      };

      const result = openaiExtractor.unmaskResponse(response, context);
      const content = result.choices[0].message.content as Array<{
        type: string;
        text?: string;
        reference_ids?: string[];
      }>;

      expect(content[0]).toEqual({ type: "reference", reference_ids: ["ref"] });
      expect(content[1]).toEqual({ type: "text", text: "Hello John" });
    });
  });

  // ---------------------------------------------------------------------------
  // BUG CONDITION EXPLORATION TEST (Property 1: Bug Condition)
  // Encodes EXPECTED (fixed) behavior; EXPECTED TO FAIL on current code.
  // Spec: .kiro/specs/pasteguard-tools-passthrough-fix (Cause 1, branch argsLeak)
  // **Validates: Requirements 1.2, 1.4**
  // ---------------------------------------------------------------------------
  describe("BUG: tool_calls.arguments unmask leak (Property 1 / argsLeak)", () => {
    test("restores placeholders inside tool_calls[].function.arguments (non-stream)", () => {
      const response: OpenAIResponse = {
        id: "test-id",
        object: "chat.completion",
        created: 123456,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "send_email",
                    arguments:
                      '{"to":"[[EMAIL_ADDRESS_1]]","subject":"Hi [[PERSON_1]]"}',
                  },
                },
              ],
              // biome-ignore lint/suspicious/noExplicitAny: tool_calls on response message
            } as any,
            finish_reason: "stop",
          },
        ],
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

      const result = openaiExtractor.unmaskResponse(response, context);

      // biome-ignore lint/suspicious/noExplicitAny: reading tool_calls in assertion
      const toolCalls = (result.choices[0].message as any).tool_calls;
      const args = toolCalls[0].function.arguments as string;

      // EXPECTED (fixed) behavior: placeholders restored, valid JSON preserved
      const parsed = JSON.parse(args);
      expect(parsed.to).toBe("user@example.com");
      expect(parsed.subject).toBe("Hi Alice");
      expect(args).not.toContain("[[");
      // Other tool_call fields preserved
      expect(toolCalls[0].id).toBe("call_1");
      expect(toolCalls[0].type).toBe("function");
      expect(toolCalls[0].function.name).toBe("send_email");
    });
  });

  describe("unknown field preservation", () => {
    test("preserves name field on message through applyMasked", () => {
      const request = createRequest([
        {
          role: "user",
          content: "Contact john@example.com",
          name: "test_user",
          // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
        } as any,
      ]);

      const maskedSpans = [
        {
          path: "messages[0].content",
          maskedText: "Contact [[EMAIL_ADDRESS_1]]",
          messageIndex: 0,
          partIndex: 0,
        },
      ];

      const result = openaiExtractor.applyMasked(request, maskedSpans);

      // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
      expect((result.messages[0] as any).name).toBe("test_user");
      expect(result.messages[0].content).toBe("Contact [[EMAIL_ADDRESS_1]]");
    });

    test("preserves tool_calls on assistant message through applyMasked", () => {
      const request = createRequest([
        { role: "user", content: "What is the weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
          // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
        } as any,
      ]);

      const maskedSpans = [
        {
          path: "messages[0].content",
          maskedText: "What is the weather?",
          messageIndex: 0,
          partIndex: 0,
        },
      ];

      const result = openaiExtractor.applyMasked(request, maskedSpans);

      // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
      expect((result.messages[1] as any).tool_calls).toHaveLength(1);
      // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
      expect((result.messages[1] as any).tool_calls[0].id).toBe("call_123");
    });

    test("preserves unknown fields on content part through applyMasked", () => {
      const request = createRequest([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Hello John Doe",
              custom_field: "preserved",
              // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
            } as any,
          ],
        },
      ]);

      const maskedSpans = [
        {
          path: "messages[0].content[0].text",
          maskedText: "Hello [[PERSON_1]]",
          messageIndex: 0,
          partIndex: 0,
        },
      ];

      const result = openaiExtractor.applyMasked(request, maskedSpans);

      // biome-ignore lint/suspicious/noExplicitAny: testing unknown field preservation
      const part = (result.messages[0].content as any[])[0];
      expect(part.text).toBe("Hello [[PERSON_1]]");
      expect(part.custom_field).toBe("preserved");
    });
  });
});


// =============================================================================
// PRESERVATION TESTS (Property 4 & 5: Preservation)
// observation-first: lock in CURRENT (unfixed) behavior for non-tool, plain-text
// inputs (isBugCondition == false). MUST PASS on unfixed code and stay green
// after the fix.
// Spec: .kiro/specs/pasteguard-tools-passthrough-fix
// **Validates: Requirements 3.1, 3.3, 3.5**
// =============================================================================

describe("PRESERVATION: OpenAI text unmask parity (Property 4)", () => {
  test("restores placeholders in plain string content (baseline)", () => {
    const response: OpenAIResponse = {
      id: "pres-1",
      object: "chat.completion",
      created: 1,
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hi [[PERSON_1]], your email is [[EMAIL_ADDRESS_1]]",
          },
          finish_reason: "stop",
        },
      ],
    };
    const context: PlaceholderContext = {
      mapping: { "[[PERSON_1]]": "Alice", "[[EMAIL_ADDRESS_1]]": "alice@example.com" },
      reverseMapping: { Alice: "[[PERSON_1]]", "alice@example.com": "[[EMAIL_ADDRESS_1]]" },
      counters: { PERSON: 1, EMAIL_ADDRESS: 1 },
    };

    const result = openaiExtractor.unmaskResponse(response, context);

    expect(result.choices[0].message.content).toBe("Hi Alice, your email is alice@example.com");
    expect(JSON.stringify(result.choices)).not.toContain("[[");
  });

  test("restores placeholders inside text content-array parts (baseline)", () => {
    const response: OpenAIResponse = {
      id: "pres-2",
      object: "chat.completion",
      created: 1,
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Hello [[PERSON_1]]" },
              // biome-ignore lint/suspicious/noExplicitAny: structured content baseline
            ] as any,
          },
          finish_reason: "stop",
        },
      ],
    };
    const context: PlaceholderContext = {
      mapping: { "[[PERSON_1]]": "Bob" },
      reverseMapping: { Bob: "[[PERSON_1]]" },
      counters: { PERSON: 1 },
    };

    const result = openaiExtractor.unmaskResponse(response, context);
    const content = result.choices[0].message.content as Array<{ type: string; text?: string }>;
    expect(content[0]).toEqual({ type: "text", text: "Hello Bob" });
  });
});

describe("PRESERVATION: OpenAI passthrough parity (Property 5)", () => {
  test("applyMasked preserves unknown message fields when no masking applies (.passthrough())", () => {
    const request = createRequest([
      {
        role: "user",
        content: "No PII or secrets here",
        // unknown message-level fields must survive
        name: "test_user",
        extra_message_field: "keep-me-too",
        // biome-ignore lint/suspicious/noExplicitAny: testing passthrough of unknown fields
      } as any,
    ]);

    // No masked spans -> nothing to change; unknown fields must be preserved.
    const result = openaiExtractor.applyMasked(request, []);

    // biome-ignore lint/suspicious/noExplicitAny: testing passthrough of unknown fields
    expect((result.messages[0] as any).name).toBe("test_user");
    // biome-ignore lint/suspicious/noExplicitAny: testing passthrough of unknown fields
    expect((result.messages[0] as any).extra_message_field).toBe("keep-me-too");
    expect(result.messages[0].content).toBe("No PII or secrets here");
  });

  test("applyMasked with no masked spans leaves body content unchanged (baseline)", () => {
    const request = createRequest([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "No PII, no secrets, no tools" },
    ]);

    const result = openaiExtractor.applyMasked(request, []);

    expect(result.messages[0].content).toBe("You are helpful");
    expect(result.messages[1].content).toBe("No PII, no secrets, no tools");
  });
});
