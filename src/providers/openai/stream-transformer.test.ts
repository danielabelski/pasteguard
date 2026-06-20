import { describe, expect, test } from "bun:test";
import type { MaskingConfig } from "../../config";
import { createMaskingContext } from "../../pii/mask";
import { createUnmaskingStream } from "./stream-transformer";

const defaultConfig: MaskingConfig = {
  show_markers: false,
  marker_text: "[protected]",
  whitelist: [],
};

/**
 * Helper to create a ReadableStream from SSE data
 */
function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

/**
 * Helper to consume a stream and return all chunks as string
 */
async function consumeStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }

  return result;
}

describe("createUnmaskingStream", () => {
  test("unmasks complete placeholder in single chunk", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    const sseData = `data: {"choices":[{"delta":{"content":"Hello [[EMAIL_ADDRESS_1]]!"}}]}\n\n`;
    const source = createSSEStream([sseData]);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("Hello test@test.com!");
  });

  test("handles [DONE] message", async () => {
    const context = createMaskingContext();

    const chunks = [`data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n`, `data: [DONE]\n\n`];
    const source = createSSEStream(chunks);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("data: [DONE]");
  });

  test("passes through non-content events", async () => {
    const context = createMaskingContext();

    const sseData = `data: {"choices":[{"delta":{}}]}\n\n`;
    const source = createSSEStream([sseData]);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain(`{"choices":[{"delta":{}}]}`);
  });

  test("buffers partial placeholder across chunks", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "a@b.com";

    // Split placeholder across chunks
    const chunks = [
      `data: {"choices":[{"delta":{"content":"Hello [[EMAIL_"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"ADDRESS_1]] world"}}]}\n\n`,
    ];
    const source = createSSEStream(chunks);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    // Should eventually contain the unmasked email
    expect(result).toContain("a@b.com");
  });

  test("flushes remaining buffer on stream end", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    // Partial placeholder that completes only on flush
    const chunks = [`data: {"choices":[{"delta":{"content":"Contact [[EMAIL_ADDRESS_1]]"}}]}\n\n`];
    const source = createSSEStream(chunks);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("test@test.com");
  });

  test("handles multiple placeholders in stream", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "John";
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "john@test.com";

    const sseData = `data: {"choices":[{"delta":{"content":"[[PERSON_1]]: [[EMAIL_ADDRESS_1]]"}}]}\n\n`;
    const source = createSSEStream([sseData]);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("John");
    expect(result).toContain("john@test.com");
  });

  test("handles empty stream", async () => {
    const context = createMaskingContext();
    const source = createSSEStream([]);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toBe("");
  });

  test("passes through malformed data", async () => {
    const context = createMaskingContext();

    const chunks = [`data: not-json\n\n`];
    const source = createSSEStream(chunks);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("not-json");
  });

  test("preserves structured content arrays and only unmasks text parts", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "John";

    const sseData =
      'data: {"choices":[{"delta":{"content":[{"type":"reference","reference_ids":["ref"]},{"type":"text","text":"Hello [[PERSON_1]]"}]}}]}\n\n';
    const source = createSSEStream([sseData]);

    const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).not.toContain("[object Object]");
    expect(result).toContain('"type":"reference"');
    expect(result).toContain('"reference_ids":["ref"]');
    expect(result).toContain('"type":"text"');
    expect(result).toContain('"text":"Hello John"');
  });

  // ---------------------------------------------------------------------------
  // BUG CONDITION EXPLORATION TEST (Property 1: Bug Condition / argsLeak)
  // Encodes EXPECTED (fixed) behavior; EXPECTED TO FAIL on current code where
  // delta.tool_calls passes through without unmasking.
  // Spec: .kiro/specs/pasteguard-tools-passthrough-fix (Cause 1, branch argsLeak)
  // **Validates: Requirements 1.2, 1.4**
  // ---------------------------------------------------------------------------
  describe("BUG: streamed tool_calls.arguments unmask leak", () => {
    test("unmasks placeholders inside streamed delta.tool_calls[].function.arguments", async () => {
      const context = createMaskingContext();
      context.mapping["[[EMAIL_ADDRESS_1]]"] = "user@example.com";

      // A streamed tool call whose arguments carry a complete placeholder.
      const sseData = `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "send_email", arguments: '{"to":"[[EMAIL_ADDRESS_1]]"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`;
      const source = createSSEStream([sseData]);

      const unmaskedStream = createUnmaskingStream(source, context, defaultConfig);
      const result = await consumeStream(unmaskedStream);

      // EXPECTED (fixed) behavior: placeholder restored in the streamed args
      expect(result).toContain("user@example.com");
      expect(result).not.toContain("[[EMAIL_ADDRESS_1]]");
    });
  });
});


// =============================================================================
// PRESERVATION TESTS (Property 4 & 5: Preservation)
// observation-first: lock in CURRENT (unfixed) behavior for plain-text SSE
// streams with NO tool_calls (isBugCondition == false). MUST PASS on the
// unfixed code and stay green after the fix.
// Spec: .kiro/specs/pasteguard-tools-passthrough-fix
// **Validates: Requirements 3.5, 3.6**
// =============================================================================

describe("PRESERVATION: OpenAI text stream parity (Property 4/5)", () => {
  test("unmasks a complete placeholder in a plain-text content stream (baseline)", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "alice@example.com";

    const sseData = `data: {"choices":[{"delta":{"content":"Contact [[EMAIL_ADDRESS_1]]!"}}]}\n\n`;
    const result = await consumeStream(
      createUnmaskingStream(createSSEStream([sseData]), context, defaultConfig),
    );

    expect(result).toContain("alice@example.com");
    expect(result).not.toContain("[[EMAIL_ADDRESS_1]]");
  });

  test("buffers a partial placeholder split across chunks (baseline)", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "a@b.com";

    const chunks = [
      `data: {"choices":[{"delta":{"content":"Hello [[EMAIL_"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"ADDRESS_1]] world"}}]}\n\n`,
    ];
    const result = await consumeStream(
      createUnmaskingStream(createSSEStream(chunks), context, defaultConfig),
    );

    expect(result).toContain("a@b.com");
    expect(result).not.toContain("[[EMAIL_");
  });

  test("preserves [DONE] sentinel and non-content events (baseline)", async () => {
    const context = createMaskingContext();
    const chunks = [
      `data: {"choices":[{"delta":{}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const result = await consumeStream(
      createUnmaskingStream(createSSEStream(chunks), context, defaultConfig),
    );

    expect(result).toContain("data: [DONE]");
    expect(result).toContain(`{"choices":[{"delta":{}}]}`);
    expect(result).toContain("hi");
  });

  test("only unmasks text parts inside structured content arrays (baseline)", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "John";

    const sseData =
      'data: {"choices":[{"delta":{"content":[{"type":"reference","reference_ids":["ref"]},{"type":"text","text":"Hi [[PERSON_1]]"}]}}]}\n\n';
    const result = await consumeStream(
      createUnmaskingStream(createSSEStream([sseData]), context, defaultConfig),
    );

    expect(result).toContain('"type":"reference"');
    expect(result).toContain('"reference_ids":["ref"]');
    expect(result).toContain('"text":"Hi John"');
    expect(result).not.toContain("[[PERSON_1]]");
  });
});
