import type { MaskingConfig } from "../../config";
import type { PlaceholderContext } from "../../masking/context";
import { flushMaskingBuffer, unmaskStreamChunk } from "../../pii/mask";
import { flushSecretsMaskingBuffer, unmaskSecretsStreamChunk } from "../../secrets/mask";
import type { OpenAIContentPart } from "../../utils/content";

function unmaskTextContent(
  text: string,
  piiBuffer: string,
  piiContext: PlaceholderContext | undefined,
  config: MaskingConfig,
  secretsBuffer: string,
  secretsContext?: PlaceholderContext,
): { text: string; piiBuffer: string; secretsBuffer: string } {
  let processedText = text;
  let nextPiiBuffer = piiBuffer;
  let nextSecretsBuffer = secretsBuffer;

  if (piiContext) {
    const { output, remainingBuffer } = unmaskStreamChunk(
      nextPiiBuffer,
      processedText,
      piiContext,
      config,
    );
    nextPiiBuffer = remainingBuffer;
    processedText = output;
  }

  if (secretsContext && processedText) {
    const { output, remainingBuffer } = unmaskSecretsStreamChunk(
      nextSecretsBuffer,
      processedText,
      secretsContext,
    );
    nextSecretsBuffer = remainingBuffer;
    processedText = output;
  }

  return { text: processedText, piiBuffer: nextPiiBuffer, secretsBuffer: nextSecretsBuffer };
}

/** Per (choice index, tool_call index) streaming buffers for tool-call arguments. */
type ToolCallArgBuffers = Map<string, { piiBuffer: string; secretsBuffer: string }>;

interface StreamedToolCall {
  index?: number;
  function?: { arguments?: string };
}

/**
 * Unmasks placeholders inside streamed `delta.tool_calls[].function.arguments`.
 *
 * Arguments arrive as JSON-string fragments across multiple chunks, so partial
 * placeholders are buffered per (choice index, tool_call index) pair using the
 * same streaming unmask mechanism as text content. The tool_calls structure
 * (index, id, type, function.name) is preserved; only the `arguments` string
 * fragments are transformed in place.
 *
 * Returns true when the parsed chunk carried any tool_calls (so the caller can
 * forward the chunk even when it has no `delta.content`).
 */
function processToolCallDeltas(
  parsed: { choices?: Array<{ index?: number; delta?: { tool_calls?: StreamedToolCall[] } }> },
  buffers: ToolCallArgBuffers,
  piiContext: PlaceholderContext | undefined,
  config: MaskingConfig,
  secretsContext?: PlaceholderContext,
): boolean {
  const choices = parsed.choices;
  if (!Array.isArray(choices)) {
    return false;
  }

  let found = false;

  for (const choice of choices) {
    const toolCalls = choice?.delta?.tool_calls;
    if (!Array.isArray(toolCalls)) {
      continue;
    }

    const choiceIndex = typeof choice.index === "number" ? choice.index : 0;

    for (const toolCall of toolCalls) {
      found = true;

      const args = toolCall.function?.arguments;
      if (typeof args !== "string" || args.length === 0) {
        continue;
      }

      const toolCallIndex = typeof toolCall.index === "number" ? toolCall.index : 0;
      const key = `${choiceIndex}:${toolCallIndex}`;
      const prev = buffers.get(key) ?? { piiBuffer: "", secretsBuffer: "" };

      const unmasked = unmaskTextContent(
        args,
        prev.piiBuffer,
        piiContext,
        config,
        prev.secretsBuffer,
        secretsContext,
      );

      buffers.set(key, { piiBuffer: unmasked.piiBuffer, secretsBuffer: unmasked.secretsBuffer });
      // function is guaranteed defined because args came from it.
      (toolCall.function as { arguments?: string }).arguments = unmasked.text;
    }
  }

  return found;
}

/**
 * Creates a transform stream that unmasks SSE content
 *
 * Processes Server-Sent Events (SSE) chunks, buffering partial placeholders
 * and unmasking complete ones before forwarding to the client.
 *
 * Supports both PII unmasking and secrets unmasking, or either alone.
 */
export function createUnmaskingStream(
  source: ReadableStream<Uint8Array>,
  piiContext: PlaceholderContext | undefined,
  config: MaskingConfig,
  secretsContext?: PlaceholderContext,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let piiBuffer = "";
  let secretsBuffer = "";
  // Per (choice index, tool_call index) buffers for streamed tool-call arguments.
  const toolCallBuffers: ToolCallArgBuffers = new Map();

  return new ReadableStream({
    async start(controller) {
      const reader = source.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            // Flush remaining buffer content before closing
            let flushed = "";

            // Flush PII buffer first
            if (piiBuffer && piiContext) {
              flushed = flushMaskingBuffer(piiBuffer, piiContext, config);
            } else if (piiBuffer) {
              flushed = piiBuffer;
            }

            // Then flush secrets buffer
            if (secretsBuffer && secretsContext) {
              flushed += flushSecretsMaskingBuffer(secretsBuffer, secretsContext);
            } else if (secretsBuffer) {
              flushed += secretsBuffer;
            }

            // Only emit a trailing content chunk when there is actually buffered
            // text content. Never emit an empty/erroneous content chunk.
            if (flushed) {
              const finalEvent = {
                id: `flush-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                choices: [
                  {
                    index: 0,
                    delta: { content: flushed },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalEvent)}\n\n`));
            }

            // Flush any leftover tool-call argument buffers as tool_calls deltas,
            // preserving the (choice index, tool_call index) structure.
            for (const [key, buf] of toolCallBuffers) {
              let argFlushed = "";

              if (buf.piiBuffer && piiContext) {
                argFlushed = flushMaskingBuffer(buf.piiBuffer, piiContext, config);
              } else if (buf.piiBuffer) {
                argFlushed = buf.piiBuffer;
              }

              if (buf.secretsBuffer && secretsContext) {
                argFlushed += flushSecretsMaskingBuffer(buf.secretsBuffer, secretsContext);
              } else if (buf.secretsBuffer) {
                argFlushed += buf.secretsBuffer;
              }

              if (!argFlushed) {
                continue;
              }

              const [choiceIndexStr, toolCallIndexStr] = key.split(":");
              const finalEvent = {
                id: `flush-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                choices: [
                  {
                    index: Number(choiceIndexStr),
                    delta: {
                      tool_calls: [
                        {
                          index: Number(toolCallIndexStr),
                          function: { arguments: argFlushed },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalEvent)}\n\n`));
            }

            controller.close();
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6);

              if (data === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                continue;
              }

              try {
                const parsed = JSON.parse(data);
                const hadToolCalls = processToolCallDeltas(
                  parsed,
                  toolCallBuffers,
                  piiContext,
                  config,
                  secretsContext,
                );
                const content = parsed.choices?.[0]?.delta?.content;

                if (typeof content === "string") {
                  const unmasked = unmaskTextContent(
                    content,
                    piiBuffer,
                    piiContext,
                    config,
                    secretsBuffer,
                    secretsContext,
                  );
                  piiBuffer = unmasked.piiBuffer;
                  secretsBuffer = unmasked.secretsBuffer;

                  if (unmasked.text) {
                    parsed.choices[0].delta.content = unmasked.text;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
                  }
                } else if (Array.isArray(content)) {
                  const processedContent = content.flatMap((part: OpenAIContentPart) => {
                    if (part.type !== "text" || typeof part.text !== "string") {
                      return [part];
                    }

                    const unmasked = unmaskTextContent(
                      part.text,
                      piiBuffer,
                      piiContext,
                      config,
                      secretsBuffer,
                      secretsContext,
                    );
                    piiBuffer = unmasked.piiBuffer;
                    secretsBuffer = unmasked.secretsBuffer;

                    if (!unmasked.text) {
                      return [];
                    }

                    return [{ ...part, text: unmasked.text }];
                  });

                  if (processedContent.length > 0) {
                    parsed.choices[0].delta.content = processedContent;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
                  }
                } else if (hadToolCalls) {
                  // tool_calls delta (no content): forward with unmasked arguments
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
                } else {
                  // Pass through non-content events
                  controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                }
              } catch {
                // Pass through unparseable data
                controller.enqueue(encoder.encode(`${line}\n`));
              }
            } else if (line.trim()) {
              controller.enqueue(encoder.encode(`${line}\n`));
            }
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
