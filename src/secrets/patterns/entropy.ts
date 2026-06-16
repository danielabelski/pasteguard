import type { PatternDetector, SecretLocation, SecretsMatch } from "./types";

/**
 * Shannon entropy calculator — measures randomness of a string.
 * High-entropy strings are likely to be passwords, tokens, or secrets.
 * Based on Gitleaks' approach: keyword match → entropy check of the value.
 * Thresholds: 4.5+ for base64-like, 3.5+ for hex-like, lower = more false positives.
 */
function shannonEntropy(s: string): number {
  const len = s.length;
  if (len === 0) return 0;
  const freq: Record<string, number> = {};
  for (const c of s) freq[c] = (freq[c] || 0) + 1;
  return -Object.values(freq).reduce((sum, n) => {
    const p = n / len;
    return sum + p * Math.log2(p);
  }, 0);
}

/**
 * Keywords that typically precede a secret value.
 * Used in entropy detection: find keyword → grab next word → check entropy.
 */
const SECRET_KEYWORDS = [
  "password", "passwd", "pwd", "secret", "token", "api[_-]?key",
  "api[_-]?secret", "access[_-]?token", "auth[_-]?token",
  "client[_-]?secret", "refresh[_-]?token", "private[_-]?key",
  "ssh[_-]?key", "secret[_-]?key", "bearer", "jwt",
];

const KEYWORD_PATTERN = new RegExp(
  `(?:(?<=^|[\\s,;:'"=])(${SECRET_KEYWORDS.join("|")}))\\s*[:=]?\\s*['"]?([a-zA-Z0-9_\\-./+]{20,})['"]?`,
  "gi",
);

/**
 * Entropy-based secrets detector
 *
 * Detects:
 * - HIGH_ENTROPY_STRING: Strings with Shannon entropy > 4.0 that follow
 *   known secret keywords (e.g. "token = eyJhbGciOiJSUzI1NiJ9...")
 *
 * This catches secrets that specific regex patterns might miss,
 * such as unusual token formats or custom credential types.
 */
export const entropyDetector: PatternDetector = {
  patterns: ["HIGH_ENTROPY_STRING"],

  detect(text: string, enabledTypes: Set<string>) {
    const matches: SecretsMatch[] = [];
    const locations: SecretLocation[] = [];
    const matchedPositions = new Set<number>();

    if (!enabledTypes.has("HIGH_ENTROPY_STRING")) {
      return { detected: false, matches };
    }

    // Strategy: find keyword-like contexts, grab the following value,
    // compute entropy, flag if above threshold.
    for (const match of text.matchAll(KEYWORD_PATTERN)) {
      const value = match[2];
      if (!value) continue;

      const entropy = shannonEntropy(value);
      // Threshold: 4.0 catches most base64/base64url/hex secrets.
      // Lower would catch random config values; higher misses short secrets.
      if (entropy >= 4.0) {
        const start = match.index! + match[0].indexOf(value);
        const end = start + value.length;

        if (!matchedPositions.has(start)) {
          matchedPositions.add(start);
          matches.push({ type: "HIGH_ENTROPY_STRING", count: 1 });
          locations.push({ start, end, type: "HIGH_ENTROPY_STRING" });
        }
      }
    }

    return {
      detected: matches.length > 0,
      matches,
      locations: locations.length > 0 ? locations : undefined,
    };
  },
};
