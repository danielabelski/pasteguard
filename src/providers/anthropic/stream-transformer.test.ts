import { describe, expect, test } from "bun:test";
import type { MaskingConfig } from "../../config";
import { createMaskingContext } from "../../pii/mask";
import { createAnthropicUnmaskingStream } from "./stream-transformer";

const defaultConfig: MaskingConfig = {
  show_markers: false,
  marker_text: "[protected]",
  whitelist: [],
};

/**
 * Helper to create a ReadableStream from Anthropic SSE data
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

/**
 * Helper to create Anthropic SSE format
 */
function createAnthropicEvent(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createTextDelta(text: string, index = 0): string {
  return createAnthropicEvent("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
}

describe("createAnthropicUnmaskingStream", () => {
  test("unmasks complete placeholder in single chunk", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    const sseData = createTextDelta("Hello [[EMAIL_ADDRESS_1]]!");
    const source = createSSEStream([sseData]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("Hello test@test.com!");
  });

  test("handles message_start event", async () => {
    const context = createMaskingContext();

    const messageStart = createAnthropicEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-sonnet",
      },
    });
    const source = createSSEStream([messageStart]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("message_start");
    expect(result).toContain("msg_123");
  });

  test("passes through non-text-delta events unchanged", async () => {
    const context = createMaskingContext();

    const contentBlockStart = createAnthropicEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    const source = createSSEStream([contentBlockStart]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("content_block_start");
  });

  test("buffers partial placeholder across chunks", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "a@b.com";

    // Split placeholder across chunks
    const chunks = [createTextDelta("Hello [[EMAIL_"), createTextDelta("ADDRESS_1]] world")];
    const source = createSSEStream(chunks);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    // Should eventually contain the unmasked email
    expect(result).toContain("a@b.com");
  });

  test("flushes remaining buffer on stream end", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "test@test.com";

    const chunks = [createTextDelta("Contact [[EMAIL_ADDRESS_1]]")];
    const source = createSSEStream(chunks);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("test@test.com");
  });

  test("handles multiple placeholders in stream", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "John";
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "john@test.com";

    const sseData = createTextDelta("[[PERSON_1]]: [[EMAIL_ADDRESS_1]]");
    const source = createSSEStream([sseData]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("John");
    expect(result).toContain("john@test.com");
  });

  test("handles empty stream", async () => {
    const context = createMaskingContext();
    const source = createSSEStream([]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toBe("");
  });

  test("passes through malformed data", async () => {
    const context = createMaskingContext();

    const chunks = [`event: content_block_delta\ndata: not-json\n\n`];
    const source = createSSEStream(chunks);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("not-json");
  });

  test("handles message_stop event", async () => {
    const context = createMaskingContext();

    const messageStop = createAnthropicEvent("message_stop", { type: "message_stop" });
    const source = createSSEStream([messageStop]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("message_stop");
  });

  test("handles ping events", async () => {
    const context = createMaskingContext();

    const ping = createAnthropicEvent("ping", { type: "ping" });
    const source = createSSEStream([ping]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("ping");
  });

  test("unmasks secrets context", async () => {
    const piiContext = createMaskingContext();
    const secretsContext = createMaskingContext();
    secretsContext.mapping["[[SECRET_OPENSSH_PRIVATE_KEY_1]]"] = "secret-key-value";

    const sseData = createTextDelta("Key: [[SECRET_OPENSSH_PRIVATE_KEY_1]]");
    const source = createSSEStream([sseData]);

    const unmaskedStream = createAnthropicUnmaskingStream(
      source,
      piiContext,
      defaultConfig,
      secretsContext,
    );
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("secret-key-value");
  });

  test("unmasks both PII and secrets", async () => {
    const piiContext = createMaskingContext();
    piiContext.mapping["[[PERSON_1]]"] = "Alice";

    const secretsContext = createMaskingContext();
    secretsContext.mapping["[[SECRET_API_KEY_1]]"] = "sk-12345";

    const sseData = createTextDelta("[[PERSON_1]]'s key: [[SECRET_API_KEY_1]]");
    const source = createSSEStream([sseData]);

    const unmaskedStream = createAnthropicUnmaskingStream(
      source,
      piiContext,
      defaultConfig,
      secretsContext,
    );
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("Alice");
    expect(result).toContain("sk-12345");
  });

  test("handles line buffering for split chunks", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Bob";

    // Simulate a chunk that splits in the middle of the SSE format
    const chunks = [
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi `,
      `[[PERSON_1]]"}}\n\n`,
    ];
    const source = createSSEStream(chunks);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("Bob");
  });

  test("re-assembles and unmasks tool_use input_json_delta into a single delta", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "user@example.com";

    // A tool_use block whose JSON arguments are fragmented across input_json_delta
    // events, with a placeholder split across two fragments.
    const chunks = [
      createAnthropicEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "send", input: {} },
      }),
      createAnthropicEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"to":"[[EMAIL_' },
      }),
      createAnthropicEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'ADDRESS_1]]"}' },
      }),
      createAnthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
      createAnthropicEvent("message_stop", { type: "message_stop" }),
    ];
    const source = createSSEStream(chunks);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);
    const events = parseDataEvents(result);

    // The fragmented JSON is re-assembled and unmasked into exactly one delta.
    const jsonDeltas = events.filter((e) => e.delta?.type === "input_json_delta");
    expect(jsonDeltas.length).toBe(1);
    expect(jsonDeltas[0]?.index).toBe(0);
    expect(jsonDeltas[0]?.delta?.partial_json).toBe('{"to":"user@example.com"}');

    // The placeholder is fully restored; none leaks to the client.
    expect(result).not.toContain("[[EMAIL_");
    // Block framing is preserved (the input_json_delta precedes its stop).
    expect(result).toContain("content_block_stop");
  });

  test("handles content_block_stop events", async () => {
    const context = createMaskingContext();

    const blockStop = createAnthropicEvent("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    });
    const source = createSSEStream([blockStop]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("content_block_stop");
  });

  test("handles message_delta events", async () => {
    const context = createMaskingContext();

    const messageDelta = createAnthropicEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 42 },
    });
    const source = createSSEStream([messageDelta]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("message_delta");
    expect(result).toContain("end_turn");
  });

  test("preserves event type lines", async () => {
    const context = createMaskingContext();

    const sseData = createTextDelta("Hello world");
    const source = createSSEStream([sseData]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("event: content_block_delta");
  });

  test("handles undefined pii context", async () => {
    const sseData = createTextDelta("Plain text without placeholders");
    const source = createSSEStream([sseData]);

    const unmaskedStream = createAnthropicUnmaskingStream(source, undefined, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("Plain text without placeholders");
  });

  test("handles multiple consecutive text deltas", async () => {
    const context = createMaskingContext();
    context.mapping["[[PERSON_1]]"] = "Jane";

    const chunks = [
      createTextDelta("Hello "),
      createTextDelta("[[PERSON_1]]"),
      createTextDelta("! How are you?"),
    ];
    const source = createSSEStream(chunks);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);

    expect(result).toContain("Jane");
    expect(result).toContain("How are you?");
  });
});

// -----------------------------------------------------------------------------
// BUG CONDITION EXPLORATION TESTS (Property 2: Bug Condition / sseCorruption)
// These encode the EXPECTED (correct/fixed) behavior and are EXPECTED TO FAIL
// on the current unfixed code, which unconditionally injects a stray
// content_block_delta {index:0, text_delta} on flush and uses a single global
// buffer that bleeds across blocks.
// Spec: .kiro/specs/pasteguard-tools-passthrough-fix (Cause 2, branch sseCorruption)
// **Validates: Requirements 1.3**
// -----------------------------------------------------------------------------

interface ParsedEvent {
  type?: string;
  index?: number;
  delta?: { type?: string; text?: string; partial_json?: string };
  content_block?: { type?: string };
}

/** Parse the ordered list of `data:` JSON events from transformer output. */
function parseDataEvents(output: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("data: ")) {
      const payload = line.slice(6);
      try {
        events.push(JSON.parse(payload) as ParsedEvent);
      } catch {
        // ignore non-JSON data lines
      }
    }
  }
  return events;
}

function isTextDelta(e: ParsedEvent): boolean {
  return e.type === "content_block_delta" && e.delta?.type === "text_delta";
}

describe("BUG: tool_use SSE structural integrity (Property 2 / sseCorruption)", () => {
  test("does not inject a stray text_delta {index:0} on flush around a tool_use block", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "user@example.com";

    // Text block (index 0) ending with a partial placeholder that buffers,
    // followed by a tool_use block (index 1).
    const chunks = [
      createAnthropicEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      createTextDelta("Contact [[EMAIL_ADDRESS_1", 0),
      createAnthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
      createAnthropicEvent("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
      }),
      createAnthropicEvent("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
      }),
      createAnthropicEvent("content_block_stop", { type: "content_block_stop", index: 1 }),
      createAnthropicEvent("message_stop", { type: "message_stop" }),
    ];
    const source = createSSEStream(chunks);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);
    const events = parseDataEvents(result);

    // Index of the tool_use block start
    const toolStartIdx = events.findIndex(
      (e) => e.type === "content_block_start" && e.content_block?.type === "tool_use",
    );
    expect(toolStartIdx).toBeGreaterThanOrEqual(0);

    // EXPECTED (fixed) behavior: no text_delta is emitted after the tool_use
    // block has started (the unconditional flush injection is the bug).
    const strayAfterTool = events
      .slice(toolStartIdx)
      .find((e) => isTextDelta(e));
    expect(strayAfterTool).toBeUndefined();
  });

  test("cross-block buffer does not bleed from text block into tool_use block", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "user@example.com";

    const chunks = [
      createAnthropicEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      // Partial placeholder at the end of the text block -> buffered
      createTextDelta("Email: [[EMAIL_", 0),
      createAnthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
      createAnthropicEvent("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_2", name: "lookup", input: {} },
      }),
      createAnthropicEvent("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"a":"b"}' },
      }),
      createAnthropicEvent("content_block_stop", { type: "content_block_stop", index: 1 }),
      createAnthropicEvent("message_stop", { type: "message_stop" }),
    ];
    const source = createSSEStream(chunks);

    const unmaskedStream = createAnthropicUnmaskingStream(source, context, defaultConfig);
    const result = await consumeStream(unmaskedStream);
    const events = parseDataEvents(result);

    const toolStartIdx = events.findIndex(
      (e) => e.type === "content_block_start" && e.content_block?.type === "tool_use",
    );
    expect(toolStartIdx).toBeGreaterThanOrEqual(0);

    // EXPECTED (fixed) behavior: no content_block_delta carrying index 0 (the
    // text block) may appear once the tool_use block (index 1) has started.
    const bledDelta = events
      .slice(toolStartIdx)
      .find((e) => e.type === "content_block_delta" && e.index === 0);
    expect(bledDelta).toBeUndefined();
  });
});


// =============================================================================
// PRESERVATION TESTS (Property 4 & 5: Preservation)
// observation-first: lock in CURRENT (unfixed) behavior for plain-text SSE
// streams with NO tool_use blocks (isBugCondition == false). MUST PASS on the
// unfixed code and stay green after the fix.
// Spec: .kiro/specs/pasteguard-tools-passthrough-fix
// **Validates: Requirements 3.5, 3.6**
// =============================================================================

describe("PRESERVATION: Anthropic text stream parity (Property 4/5)", () => {
  test("unmasks a complete placeholder in a plain-text stream (baseline)", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "alice@example.com";

    const source = createSSEStream([createTextDelta("Contact [[EMAIL_ADDRESS_1]] now")]);
    const result = await consumeStream(
      createAnthropicUnmaskingStream(source, context, defaultConfig),
    );

    expect(result).toContain("alice@example.com");
    expect(result).not.toContain("[[EMAIL_ADDRESS_1]]");
    // Streaming framing preserved: emitted as content_block_delta / text_delta
    expect(result).toContain("event: content_block_delta");
    const events = parseDataEvents(result);
    expect(events.some(isTextDelta)).toBe(true);
  });

  test("buffers a partial placeholder split across chunks in a text stream (baseline)", async () => {
    const context = createMaskingContext();
    context.mapping["[[EMAIL_ADDRESS_1]]"] = "a@b.com";

    const source = createSSEStream([
      createTextDelta("Hello [[EMAIL_"),
      createTextDelta("ADDRESS_1]] world"),
    ]);
    const result = await consumeStream(
      createAnthropicUnmaskingStream(source, context, defaultConfig),
    );

    expect(result).toContain("a@b.com");
    expect(result).not.toContain("[[EMAIL_");
  });

  test("unmasks both PII and secrets in a plain-text stream (baseline)", async () => {
    const piiContext = createMaskingContext();
    piiContext.mapping["[[PERSON_1]]"] = "Alice";
    const secretsContext = createMaskingContext();
    secretsContext.mapping["[[SECRET_API_KEY_1]]"] = "sk-12345";

    const source = createSSEStream([
      createTextDelta("[[PERSON_1]]'s key: [[SECRET_API_KEY_1]]"),
    ]);
    const result = await consumeStream(
      createAnthropicUnmaskingStream(source, piiContext, defaultConfig, secretsContext),
    );

    expect(result).toContain("Alice");
    expect(result).toContain("sk-12345");
    expect(result).not.toContain("[[");
  });

  test("passes plain text without placeholders through unchanged (baseline)", async () => {
    const source = createSSEStream([createTextDelta("A normal sentence with no placeholders.")]);
    const result = await consumeStream(
      createAnthropicUnmaskingStream(source, undefined, defaultConfig),
    );

    expect(result).toContain("A normal sentence with no placeholders.");
  });
});
