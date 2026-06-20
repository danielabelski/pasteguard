import { describe, expect, test } from "bun:test";
import type { SecretsDetectionConfig } from "../config";
import { openaiExtractor } from "../masking/extractors/openai";
import type { OpenAIMessage, OpenAIRequest, OpenAIResponse } from "../providers/openai/types";
import { processSecretsRequest } from "./secrets";

// =============================================================================
// PRESERVATION TESTS (Property 5: Preservation)
// observation-first: lock in the CURRENT secrets_detection.action policy
// (block / mask / route_local) for NON-TOOL, plain-text content
// (isBugCondition == false). MUST PASS on the unfixed code and stay green
// after the fix.
// Spec: .kiro/specs/pasteguard-tools-passthrough-fix
// **Validates: Requirements 3.4**
// =============================================================================

/** Minimal OpenAI request from messages. */
function createRequest(messages: OpenAIMessage[]): OpenAIRequest {
  return { model: "gpt-4", messages };
}

/** A reliably-detected secret (OpenAI-style API key). */
const SECRET = "sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx";

function baseConfig(action: SecretsDetectionConfig["action"]): SecretsDetectionConfig {
  return {
    enabled: true,
    action,
    entities: ["API_KEY_SK"],
    max_scan_chars: 200000,
    log_detected_types: true,
    scan_roles: ["user", "assistant", "tool"],
  };
}

describe("PRESERVATION: secrets policy parity for non-tool text (Property 5)", () => {
  test("disabled detection passes through unchanged (baseline)", () => {
    const request = createRequest([{ role: "user", content: `key is ${SECRET}` }]);
    const result = processSecretsRequest(request, { ...baseConfig("mask"), enabled: false }, openaiExtractor);

    expect(result.blocked).toBe(false);
    expect(result.masked).toBe(false);
    expect(result.request).toBe(request);
  });

  test("no secret present -> not blocked, not masked (baseline)", () => {
    const request = createRequest([{ role: "user", content: "just a normal message" }]);
    const result = processSecretsRequest(request, baseConfig("block"), openaiExtractor);

    expect(result.blocked).toBe(false);
    expect(result.masked).toBe(false);
    expect(result.detection?.detected).toBe(false);
  });

  test('action "block" blocks a secret in user text (baseline)', () => {
    const request = createRequest([{ role: "user", content: `my key is ${SECRET}` }]);
    const result = processSecretsRequest(request, baseConfig("block"), openaiExtractor);

    expect(result.blocked).toBe(true);
    expect(result.masked).toBe(false);
    expect(result.blockedTypes).toContain("API_KEY_SK");
    expect(result.blockedReason).toContain("API_KEY_SK");
  });

  test('action "mask" replaces the secret with a placeholder and is reversible (baseline)', () => {
    const request = createRequest([{ role: "user", content: `my key is ${SECRET}` }]);
    const result = processSecretsRequest(request, baseConfig("mask"), openaiExtractor);

    expect(result.blocked).toBe(false);
    expect(result.masked).toBe(true);
    expect(result.maskingContext).toBeDefined();

    const maskedContent = result.request.messages[0].content as string;
    // Secret removed, placeholder injected
    expect(maskedContent).not.toContain(SECRET);
    expect(maskedContent).toContain("[[");
    // Mapping is reversible back to the original secret
    expect(Object.values(result.maskingContext!.mapping)).toContain(SECRET);

    // Round-trip: a response echoing the placeholder is restored to the secret
    const placeholder = Object.keys(result.maskingContext!.mapping).find(
      (p) => result.maskingContext!.mapping[p] === SECRET,
    )!;
    const response: OpenAIResponse = {
      id: "r1",
      object: "chat.completion",
      created: 1,
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: `here it is: ${placeholder}` },
          finish_reason: "stop",
        },
      ],
    };
    const unmasked = openaiExtractor.unmaskResponse(response, result.maskingContext!);
    expect(unmasked.choices[0].message.content).toBe(`here it is: ${SECRET}`);
  });

  test('action "route_local" detects but does not block or mask (baseline)', () => {
    const request = createRequest([{ role: "user", content: `my key is ${SECRET}` }]);
    const result = processSecretsRequest(request, baseConfig("route_local"), openaiExtractor);

    expect(result.blocked).toBe(false);
    expect(result.masked).toBe(false);
    expect(result.detection?.detected).toBe(true);
    // Body is left untouched for local routing
    expect(result.request).toBe(request);
    expect((result.request.messages[0].content as string)).toContain(SECRET);
  });
});
