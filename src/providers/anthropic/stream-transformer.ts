/**
 * Anthropic SSE stream transformer for unmasking PII and secrets
 *
 * Anthropic uses a different SSE format than OpenAI:
 * - event: message_start / content_block_start / content_block_delta / etc.
 * - data: {...}
 *
 * Text content arrives in content_block_delta events with delta.type === "text_delta".
 * Tool-call arguments arrive in content_block_delta events with
 * delta.type === "input_json_delta" (field `partial_json`), fragmented across many
 * chunks until the owning content_block_stop.
 *
 * The transformer is event-oriented and block-safe:
 * - It parses whole SSE event blocks (separated by a blank line) instead of raw
 *   lines, so framing (`event:` + `data:` + blank-line separator) is always intact.
 * - Partial-placeholder buffering for text_delta is keyed PER BLOCK INDEX, so a
 *   half-emitted placeholder from one block can never bleed into another block.
 * - input_json_delta fragments for a tool_use block are accumulated and only
 *   unmasked + emitted (as a single input_json_delta) when the block stops. This
 *   prevents splitting a placeholder across fragments and guarantees valid JSON.
 * - On stream end leftover buffers are flushed ONLY for their own block, as a delta
 *   of the same type and index. No stray text_delta {index:0} is ever injected.
 */

import type { MaskingConfig } from "../../config";
import type { PlaceholderContext } from "../../masking/context";
import { flushMaskingBuffer, unmask, unmaskStreamChunk } from "../../pii/mask";
import { flushSecretsMaskingBuffer, unmaskSecrets, unmaskSecretsStreamChunk } from "../../secrets/mask";

interface ParsedDelta {
  type?: string;
  text?: string;
  partial_json?: string;
  [key: string]: unknown;
}

interface ParsedEvent {
  type?: string;
  index?: number;
  delta?: ParsedDelta;
  content_block?: { type?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Creates a transform stream that unmasks Anthropic SSE content
 */
export function createAnthropicUnmaskingStream(
  source: ReadableStream<Uint8Array>,
  piiContext: PlaceholderContext | undefined,
  config: MaskingConfig,
  secretsContext?: PlaceholderContext,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Accumulates raw text until full event blocks (separated by a blank line) arrive.
  let blockBuffer = "";

  // Per-block partial-placeholder buffers for text_delta unmasking, keyed by block index.
  const piiBuffers = new Map<number, string>();
  const secretsBuffers = new Map<number, string>();

  // Per-block accumulated tool_use JSON (input_json_delta.partial_json), keyed by block index.
  const toolJsonBuffers = new Map<number, string>();

  return new ReadableStream({
    async start(controller) {
      const reader = source.getReader();

      const enqueue = (text: string): void => {
        controller.enqueue(encoder.encode(text));
      };

      /** Emit a fully-framed SSE event. */
      const emitEvent = (eventType: string, payload: unknown): void => {
        enqueue(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      /** Re-emit an original event block verbatim (transparent pass-through). */
      const passthrough = (block: string): void => {
        enqueue(`${block}\n\n`);
      };

      /** Fully restore placeholders in a complete (assembled) string. */
      const restoreFull = (text: string): string => {
        let out = text;
        if (piiContext) {
          out = unmask(out, piiContext, config);
        }
        if (secretsContext) {
          out = unmaskSecrets(out, secretsContext);
        }
        return out;
      };

      /** Flush leftover text buffer for a block; returns flushed text (may be empty). */
      const flushTextBuffer = (index: number): string => {
        let flushed = "";
        const piiLeftover = piiBuffers.get(index);
        if (piiLeftover) {
          flushed = piiContext
            ? flushMaskingBuffer(piiLeftover, piiContext, config)
            : piiLeftover;
        }
        const secretsLeftover = secretsBuffers.get(index);
        if (secretsLeftover) {
          flushed += secretsContext
            ? flushSecretsMaskingBuffer(secretsLeftover, secretsContext)
            : secretsLeftover;
        }
        piiBuffers.delete(index);
        secretsBuffers.delete(index);
        return flushed;
      };

      /** Emit the accumulated tool_use JSON for a block as a single input_json_delta. */
      const flushToolJson = (index: number): void => {
        const assembled = toolJsonBuffers.get(index);
        toolJsonBuffers.delete(index);
        if (!assembled) {
          return;
        }
        const restored = restoreFull(assembled);
        emitEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: restored },
        });
      };

      /** Unmask a text_delta payload using per-block streaming buffers. */
      const processTextDelta = (index: number, text: string): string => {
        let processedText = text;

        if (piiContext && processedText) {
          const { output, remainingBuffer } = unmaskStreamChunk(
            piiBuffers.get(index) ?? "",
            processedText,
            piiContext,
            config,
          );
          piiBuffers.set(index, remainingBuffer);
          processedText = output;
        }

        if (secretsContext && processedText) {
          const { output, remainingBuffer } = unmaskSecretsStreamChunk(
            secretsBuffers.get(index) ?? "",
            processedText,
            secretsContext,
          );
          secretsBuffers.set(index, remainingBuffer);
          processedText = output;
        }

        return processedText;
      };

      /** Process a single complete SSE event block. */
      const processBlock = (block: string): void => {
        if (block.trim() === "") {
          return;
        }

        const lines = block.split("\n");
        let eventType: string | undefined;
        const dataLines: string[] = [];
        let hasData = false;

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7);
          } else if (line.startsWith("data: ")) {
            dataLines.push(line.slice(6));
            hasData = true;
          }
        }

        // No data payload (e.g. a lone comment line) -> pass through verbatim.
        if (!hasData) {
          passthrough(block);
          return;
        }

        const data = dataLines.join("\n");

        let parsed: ParsedEvent;
        try {
          parsed = JSON.parse(data) as ParsedEvent;
        } catch {
          // Unparseable data -> pass through verbatim.
          passthrough(block);
          return;
        }

        const type = parsed.type;
        const eventName = eventType ?? type ?? "content_block_delta";

        if (type === "content_block_start") {
          // Track tool_use blocks so their input_json_delta fragments are accumulated.
          if (typeof parsed.index === "number" && parsed.content_block?.type === "tool_use") {
            toolJsonBuffers.set(parsed.index, toolJsonBuffers.get(parsed.index) ?? "");
          }
          passthrough(block);
          return;
        }

        if (type === "content_block_delta") {
          const index = typeof parsed.index === "number" ? parsed.index : 0;
          const deltaType = parsed.delta?.type;

          if (deltaType === "text_delta") {
            const processedText = processTextDelta(index, parsed.delta?.text ?? "");
            // Only emit if there is content left after buffering (matches prior behavior).
            if (processedText) {
              emitEvent(eventName, {
                ...parsed,
                delta: { ...parsed.delta, text: processedText },
              });
            }
            return;
          }

          if (deltaType === "input_json_delta") {
            // Accumulate; emit a single unmasked delta at content_block_stop.
            const fragment = parsed.delta?.partial_json ?? "";
            toolJsonBuffers.set(index, (toolJsonBuffers.get(index) ?? "") + fragment);
            return;
          }

          // Other delta types (thinking_delta, signature_delta, ...) -> pass through.
          passthrough(block);
          return;
        }

        if (type === "content_block_stop") {
          const index = typeof parsed.index === "number" ? parsed.index : 0;

          if (toolJsonBuffers.has(index)) {
            // Tool_use block: emit assembled+unmasked JSON, then the stop event.
            flushToolJson(index);
            passthrough(block);
            return;
          }

          // Text (or other) block: flush leftover buffer as a same-index text_delta
          // BEFORE the stop event, so nothing leaks past the block boundary.
          const flushed = flushTextBuffer(index);
          if (flushed) {
            emitEvent("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: flushed },
            });
          }
          passthrough(block);
          return;
        }

        // All other events (message_start, message_delta, message_stop, ping, ...).
        passthrough(block);
      };

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            // Process any trailing (incomplete-by-framing) block content.
            if (blockBuffer.trim() !== "") {
              processBlock(blockBuffer);
            }
            blockBuffer = "";

            // Flush leftover text buffers for blocks that never received a stop,
            // each as a same-type, same-index delta. No stray {index:0} injection.
            for (const index of [...piiBuffers.keys(), ...secretsBuffers.keys()]) {
              const flushed = flushTextBuffer(index);
              if (flushed) {
                emitEvent("content_block_delta", {
                  type: "content_block_delta",
                  index,
                  delta: { type: "text_delta", text: flushed },
                });
              }
            }

            // Flush leftover tool_use JSON for blocks that never received a stop.
            for (const index of [...toolJsonBuffers.keys()]) {
              flushToolJson(index);
            }

            controller.close();
            break;
          }

          blockBuffer += decoder.decode(value, { stream: true });

          // Split on the blank-line event separator; keep the trailing partial block.
          const blocks = blockBuffer.split("\n\n");
          blockBuffer = blocks.pop() ?? "";

          for (const block of blocks) {
            processBlock(block);
          }
        }
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}
