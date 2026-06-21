/**
 * Pure, unit-testable helpers for enriching an OpenAI-style `/v1/models`
 * response with a `context_length` (integer) field per model.
 *
 * The context length for a model id comes solely from a configurable map
 * (exact-id match). There is no built-in fallback: ids that are not present in
 * the map are left exactly as upstream returned them. This keeps the response a
 * faithful pass-through except for the explicitly configured ids.
 *
 * Everything here is defensive: unexpected shapes result in the original body
 * being returned unchanged, and an empty map is a no-op.
 */

/**
 * Parses a comma-separated `id=number` list (env form), e.g.
 * `"minimax/MiniMax-M3=204800,ide2llm/MiniMax M3=1000000"`.
 *
 * - Entries are split on `,`.
 * - Each entry is split on the FIRST `=` only (model ids may contain `=`-free
 *   text but can contain `/`, `.`, `-` and spaces, e.g. `ide2llm/MiniMax M3`).
 * - Whitespace around ids and numbers is trimmed.
 * - Malformed entries (no `=`, empty key/value, non-numeric value) are skipped.
 * - Empty / undefined input yields `{}`.
 */
export function parseContextOverridesEnv(raw: string | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  if (!raw) return result;
  const trimmed = raw.trim();
  if (trimmed === "") return result;

  for (const pair of trimmed.split(",")) {
    const idx = pair.indexOf("="); // split on the FIRST '=' only
    if (idx === -1) continue; // malformed: no '='
    const key = pair.slice(0, idx).trim();
    const numStr = pair.slice(idx + 1).trim();
    if (key === "" || numStr === "") continue; // empty key/value
    const num = Number(numStr);
    if (!Number.isFinite(num)) continue; // non-numeric
    result[key] = num;
  }
  return result;
}

/**
 * Enriches an OpenAI-style models list with a `context_length` field.
 *
 * If `body` is an object with an array `data`, each item that is an object with
 * a string `id` present in `contextMap` gets `context_length` set to the mapped
 * value. An existing non-null `context_length` from upstream is preferred and
 * never overwritten; only when it is absent or null do we inject. Existing
 * fields and array order are preserved, and a new object is returned (the input
 * is never mutated).
 *
 * If the body shape is unexpected (not an object, or no `data` array), or the
 * map is empty, the body is returned unchanged.
 */
export function enrichModelsResponse(
  body: unknown,
  contextMap: Record<string, number>,
): unknown {
  if (body === null || typeof body !== "object") return body;
  if (!contextMap || Object.keys(contextMap).length === 0) return body;

  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return body;

  const newData = data.map((item) => {
    if (item === null || typeof item !== "object") return item;
    const m = item as Record<string, unknown>;

    const id = m.id;
    if (typeof id !== "string") return item;

    if (!Object.prototype.hasOwnProperty.call(contextMap, id)) return item;

    // Prefer an existing non-null context_length from upstream; only inject when
    // upstream provides none (absent or null).
    const existing = m.context_length;
    if (existing !== undefined && existing !== null) return item;

    return { ...m, context_length: contextMap[id] };
  });

  return { ...(body as Record<string, unknown>), data: newData };
}
