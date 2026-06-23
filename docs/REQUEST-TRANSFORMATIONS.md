# Request Transformations Applied by PasteGuard

PasteGuard applies the following transformations to requests before forwarding them upstream. All transforms are stateless, deterministic, and applied in the order listed.

## Anthropic endpoint (`/anthropic/v1/messages`)

| # | Transform | What it does | Why | File |
|---|-----------|-------------|-----|------|
| 1 | Hoist system messages | Moves `role:"system"` messages from `messages[]` into top-level `system` field | Anthropic API rejects `role:system` in messages | `src/routes/normalize.ts` |
| 2 | Sanitize tool_use IDs | Replaces chars not matching `^[a-zA-Z0-9_-]+$` with `_` in `tool_use.id` and `tool_result.tool_use_id` | Anthropic rejects invalid chars (from non-Claude fallback providers) | `src/routes/normalize.ts` |
| 3 | Strip thinking blocks | Removes ALL `thinking` and `redacted_thinking` content blocks from messages | Prevents 400 "Invalid signature in thinking block" from replayed combo-fallback history | `src/routes/normalize.ts` |
| 4 | Strip lookaround patterns | Removes `pattern` fields containing regex lookaround (`(?=`, `(?!`, `(?<=`, `(?<!`) from tool `input_schema` | OpenAI/Codex rejects schemas with lookaround; pattern is optional | `src/routes/normalize.ts` |
| 5 | Mask PII | Replaces detected PII (emails, phones, IBAN, credit cards, IP addresses, locations, person names) with placeholders `[[TYPE_N]]` | Privacy protection; restored in response | `src/services/pii.ts` + `src/pii/` |
| 6 | Mask secrets | Replaces detected secrets (API keys, passwords, tokens, SSH keys, connection strings) with placeholders | Privacy protection; restored in response | `src/services/secrets.ts` + `src/secrets/` |

## Response transformations (upstream → client)

| # | Transform | What it does | File |
|---|-----------|-------------|------|
| 1 | Unmask PII | Restores `[[TYPE_N]]` placeholders to original values in text blocks AND `tool_use.input` (recursive deep unmask) | `src/pii/mask.ts` + `src/masking/extractors/anthropic.ts` |
| 2 | Unmask secrets | Same as PII but for secret placeholders | `src/secrets/mask.ts` + extractors |
| 3 | Handle OpenAI-shaped body on /anthropic | If upstream returns OpenAI format (combo aliases via 9router), delegates unmasking to OpenAI extractor instead of crashing | `src/masking/extractors/anthropic.ts` |

## OpenAI endpoint (`/openai/v1/chat/completions`)

| # | Transform | What it does | File |
|---|-----------|-------------|------|
| 1 | Mask PII | Same as Anthropic path — detects and replaces PII entities with placeholders | `src/services/pii.ts` |
| 2 | Mask secrets | Same as Anthropic path — detects and replaces secrets with placeholders | `src/services/secrets.ts` |
| 3 | Unmask PII in response | Restores placeholders in `message.content` + `tool_calls[].function.arguments` (JSON + streaming) | `src/masking/extractors/openai.ts` + `src/providers/openai/stream-transformer.ts` |
| 4 | Unmask secrets in response | Same for secrets | `src/secrets/mask.ts` + `src/masking/extractors/openai.ts` |

## Codex endpoint (`/codex/responses`)

| # | Transform | What it does | File |
|---|-----------|-------------|------|
| 1 | Mask PII | Detects and replaces PII in instructions + input spans | `src/services/pii.ts` + `src/masking/extractors/codex.ts` |
| 2 | Mask secrets | Detects and replaces secrets in instructions + input spans | `src/services/secrets.ts` + `src/masking/extractors/codex.ts` |
| 3 | Unmask PII in response | Restores placeholders in response output text (JSON + SSE streaming) | `src/routes/codex.ts` (inline stream transformer) |
| 4 | Unmask secrets in response | Same for secrets | `src/routes/codex.ts` |

## `/v1/models` enrichment

| Transform | What it does | File |
|-----------|-------------|------|
| Inject context_length | Adds `context_length` field to model objects from configured map (only when upstream doesn't provide it) | `src/routes/models-enrich.ts` |

## Configuration affecting transforms

| Key | Effect | Default |
|-----|--------|---------|
| `mode` | `mask` = mask+forward+unmask; `route` = route sensitive to local provider | `route` |
| `pii_detection.enabled` | Enables/disables PII detection and masking | `true` |
| `pii_detection.scan_roles` | Which message roles get scanned for PII (e.g. `[user, tool]`) | all roles |
| `pii_detection.score_threshold` | Minimum confidence score for PII entity detection | `0.7` |
| `pii_detection.entities` | Which PII entity types to detect (PERSON, EMAIL_ADDRESS, etc.) | 7 types |
| `pii_detection.languages` | Languages for Presidio NLP model to scan | `[en]` |
| `secrets_detection.enabled` | Enables/disables secrets detection | `true` |
| `secrets_detection.action` | `block` / `mask` / `route_local` — what to do when secrets found | `mask` |
| `secrets_detection.entities` | Which secret types to detect (API keys, SSH keys, tokens, etc.) | SSH + PEM keys |
| `secrets_detection.scan_roles` | Which message roles get scanned for secrets | all roles |
| `masking.whitelist` | Strings that suppress detection when found in matched text | Claude Code prompt |
| `masking.show_markers` | Show `[protected]` marker instead of placeholder in response | `false` |
| `logging.debug` | When true, logs original+masked content to stdout for every request | `false` |
| `model_context_windows` | Per-model context length map for `/v1/models` enrichment | `{}` |

## Transform order (per endpoint)

```
Anthropic:  normalize → secrets → PII detect → mask → forward → unmask response
OpenAI:     secrets → PII detect → mask → forward → unmask response
Codex:      secrets → PII detect → mask → forward → unmask response
```

Normalization transforms (1–4) are Anthropic-only because they fix protocol-specific
incompatibilities. PII/secrets masking is shared across all endpoints via the same
generic `RequestExtractor` interface.
