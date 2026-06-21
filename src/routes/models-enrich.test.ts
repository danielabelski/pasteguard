import { describe, expect, test } from "bun:test";
import { enrichModelsResponse, parseContextOverridesEnv } from "./models-enrich";

function model(id: string, extra: Record<string, unknown> = {}) {
  return { id, object: "model", owned_by: "9router", ...extra };
}

describe("enrichModelsResponse", () => {
  test("injects context_length for mapped ids", () => {
    const body = {
      object: "list",
      data: [model("minimax/MiniMax-M3"), model("cx/gpt-5.4")],
    };
    const out = enrichModelsResponse(body, {
      "minimax/MiniMax-M3": 1000000,
      "cx/gpt-5.4": 1000000,
    }) as { data: Array<Record<string, unknown>> };
    expect(out.data[0].context_length).toBe(1000000);
    expect(out.data[1].context_length).toBe(1000000);
  });

  test("leaves non-mapped ids untouched (no context_length)", () => {
    const body = {
      object: "list",
      data: [model("minimax/MiniMax-M3"), model("some-unknown/model")],
    };
    const out = enrichModelsResponse(body, { "minimax/MiniMax-M3": 1000000 }) as {
      data: Array<Record<string, unknown>>;
    };
    expect(out.data[0].context_length).toBe(1000000);
    expect(out.data[1]).not.toHaveProperty("context_length");
    expect(out.data[1]).toEqual(model("some-unknown/model"));
  });

  test("handles ids containing spaces and slashes", () => {
    const body = {
      object: "list",
      data: [model("ide2llm/MiniMax M3"), model("minimax/MiniMax-M3")],
    };
    const out = enrichModelsResponse(body, {
      "ide2llm/MiniMax M3": 1000000,
      "minimax/MiniMax-M3": 1000000,
    }) as { data: Array<Record<string, unknown>> };
    expect(out.data[0].context_length).toBe(1000000);
    expect(out.data[1].context_length).toBe(1000000);
  });

  test("empty map -> body unchanged", () => {
    const body = { object: "list", data: [model("minimax/MiniMax-M3")] };
    const out = enrichModelsResponse(body, {});
    expect(out).toBe(body);
  });

  test("non-`.data` body -> unchanged", () => {
    const noData = { object: "thing", foo: "bar" };
    expect(enrichModelsResponse(noData, { "minimax/MiniMax-M3": 1000000 })).toBe(noData);
    const dataNotArray = { object: "list", data: { id: "m/x" } };
    expect(enrichModelsResponse(dataNotArray, { "m/x": 5 })).toBe(dataNotArray);
  });

  test("returns non-object bodies unchanged", () => {
    expect(enrichModelsResponse(null, { a: 1 })).toBeNull();
    expect(enrichModelsResponse("string", { a: 1 })).toBe("string");
  });

  test("preserves upstream-provided non-null context_length", () => {
    const body = {
      object: "list",
      data: [model("minimax/MiniMax-M3", { context_length: 42 })],
    };
    const out = enrichModelsResponse(body, { "minimax/MiniMax-M3": 1000000 }) as {
      data: Array<Record<string, unknown>>;
    };
    expect(out.data[0].context_length).toBe(42);
  });

  test("injects when upstream context_length is null", () => {
    const body = {
      object: "list",
      data: [model("minimax/MiniMax-M3", { context_length: null })],
    };
    const out = enrichModelsResponse(body, { "minimax/MiniMax-M3": 1000000 }) as {
      data: Array<Record<string, unknown>>;
    };
    expect(out.data[0].context_length).toBe(1000000);
  });

  test("preserves order and other fields, does not mutate input", () => {
    const body = {
      object: "list",
      data: [model("a/keep-me", { custom: 1 }), model("minimax/MiniMax-M3"), model("b/other")],
    };
    const out = enrichModelsResponse(body, { "minimax/MiniMax-M3": 1000000 }) as {
      data: Array<Record<string, unknown>>;
    };
    expect(out.data.map((m) => m.id)).toEqual(["a/keep-me", "minimax/MiniMax-M3", "b/other"]);
    expect(out.data[0]).toEqual(model("a/keep-me", { custom: 1 }));
    expect(out.data[2]).toEqual(model("b/other"));
    // input untouched
    expect(body.data[1]).not.toHaveProperty("context_length");
  });

  test("leaves models without a string id untouched", () => {
    const body = {
      object: "list",
      data: [{ object: "model" }, model("minimax/MiniMax-M3")],
    };
    const out = enrichModelsResponse(body, { "minimax/MiniMax-M3": 1000000 }) as {
      data: Array<Record<string, unknown>>;
    };
    expect(out.data[0]).toEqual({ object: "model" });
    expect(out.data[1].context_length).toBe(1000000);
  });
});

describe("parseContextOverridesEnv", () => {
  test("parses 'a=1,b=2'", () => {
    expect(parseContextOverridesEnv("a=1,b=2")).toEqual({ a: 1, b: 2 });
  });

  test("ignores malformed / empty pairs and non-numeric values", () => {
    expect(parseContextOverridesEnv("a=1,garbage,b=,=3,c=x,d=4")).toEqual({ a: 1, d: 4 });
  });

  test("trims surrounding whitespace around ids and numbers", () => {
    expect(parseContextOverridesEnv("  a = 1 ,  b/c = 2  ")).toEqual({ a: 1, "b/c": 2 });
  });

  test("empty / undefined input yields {}", () => {
    expect(parseContextOverridesEnv("")).toEqual({});
    expect(parseContextOverridesEnv("   ")).toEqual({});
    expect(parseContextOverridesEnv(undefined)).toEqual({});
  });

  test("ids with spaces and slashes, split on first '=' only", () => {
    expect(
      parseContextOverridesEnv(
        "minimax/MiniMax-M3=1000000,ide2llm/MiniMax M3=1000000,cx/gpt-5.4=1000000",
      ),
    ).toEqual({
      "minimax/MiniMax-M3": 1000000,
      "ide2llm/MiniMax M3": 1000000,
      "cx/gpt-5.4": 1000000,
    });
  });
});
