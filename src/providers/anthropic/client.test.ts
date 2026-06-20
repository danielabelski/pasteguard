import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AnthropicProviderConfig } from "../../config";
import type { AnthropicRequest } from "./types";

// config.ts тянет пакет `yaml` и загружает YAML с диска. В оффлайн unit-тестах
// мокаем модуль конфигурации, чтобы импорт client.ts не требовал реальный конфиг.
// Паттерн (mock.module + динамический import) повторяет routes/api.test.ts.
mock.module("../../config", () => ({
  getConfig: () => ({ server: { request_timeout: 0 } }),
}));

// Импортируем ПОСЛЕ установки мока.
const { callAnthropic } = await import("./client");

const providerConfig: AnthropicProviderConfig = {
  base_url: "https://api.anthropic.com",
  api_key: "test-key",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Перехватывает тело апстрим-запроса и отдаёт JSON-ответ Anthropic. */
function stubFetchCapturing(captured: { body?: Record<string, unknown> }): void {
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.body) {
      captured.body = JSON.parse(init.body as string) as Record<string, unknown>;
    }
    const jsonResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "claude-3-sonnet-20240229",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    return new Response(JSON.stringify(jsonResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function createRequest(stream: boolean | undefined): AnthropicRequest {
  const req: AnthropicRequest = {
    model: "sonnet",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
  };
  if (stream !== undefined) {
    req.stream = stream;
  }
  return req;
}

// =============================================================================
// EXPLORATION-ТЕСТЫ ВОСПРОИЗВЕДЕНИЯ БАГА (Task 1, ДО фикса)
// Эти тесты ДОЛЖНЫ ПАДАТЬ на неисправленном коде — падение подтверждает баг.
// Кодируют ожидаемое (исправленное) поведение из Correctness Property 3.
// =============================================================================
describe("BUG EXPLORATION — Anthropic callAnthropic forced streaming (Case E)", () => {
  // Cause 3, ветвь streamForced: callAnthropic жёстко выставляет isStreaming=true и
  // отправляет апстриму stream:true независимо от запроса клиента, поэтому
  // JSON-ожидающий клиент (например, sonnet/hindsight) получает text/event-stream.
  test("returns isStreaming:false when client requested stream:false", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    stubFetchCapturing(captured);

    const result = await callAnthropic(createRequest(false), providerConfig);

    // Ожидаемое (исправленное) поведение: режим ответа совпадает с request.stream.
    // На неисправленном коде result.isStreaming === true → проверки ПАДАЮТ.
    expect(result.isStreaming).toBe(false);
    // И апстриму уходит stream:false, а не принудительный stream:true.
    expect(captured.body?.stream).toBe(false);
  });

  test("returns isStreaming:false when stream field is absent", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    stubFetchCapturing(captured);

    const result = await callAnthropic(createRequest(undefined), providerConfig);

    // Отсутствие поля stream трактуется как непотоковый запрос (stream ?? false).
    // На неисправленном коде result.isStreaming === true → проверки ПАДАЮТ.
    expect(result.isStreaming).toBe(false);
    expect(captured.body?.stream).toBe(false);
  });

  test("CONTROL: returns isStreaming:true when client requested stream:true", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    stubFetchCapturing(captured);

    const result = await callAnthropic(createRequest(true), providerConfig);

    // Контроль (Preservation, Property 5): потоковый запрос остаётся потоковым.
    // Проходит и на неисправленном, и на исправленном коде.
    expect(result.isStreaming).toBe(true);
    expect(captured.body?.stream).toBe(true);
  });
});
