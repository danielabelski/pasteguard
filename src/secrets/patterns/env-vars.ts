import type { PatternDetector, SecretLocation, SecretsMatch } from "./types";
import { detectPattern } from "./utils";

/**
 * Environment variables detector
 *
 * Detects:
 * - ENV_PASSWORD: Password variables (_PASSWORD, _PWD suffix with 8+ char values) and inline password=/pwd= assignments
 * - ENV_SECRET: Secret variables (_SECRET suffix with 8+ char values)
 * - CONNECTION_STRING: Database URLs with embedded passwords (user:pass@host)
 *
 * Two-tier approach to minimize false positives on source code while catching real secrets:
 *   Tier 1 (high confidence): value is in quotes — always a hardcoded literal
 *   Tier 2 (medium confidence): value unquoted, contains digit/special char, and does NOT
 *     look like a code expression (no dots, parens, keywords after identifier start)
 */
export const envVarsDetector: PatternDetector = {
  patterns: ["ENV_PASSWORD", "ENV_SECRET", "CONNECTION_STRING"],

  detect(text: string, enabledTypes: Set<string>) {
    const matches: SecretsMatch[] = [];
    const locations: SecretLocation[] = [];

    if (enabledTypes.has("ENV_PASSWORD")) {
      // Tier 1: quoted values — highest confidence (hardcoded password literal)
      const pwQuotedPattern =
        /[A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|_PWD)\s*[=:]\s*['"][^\s'"]{8,}['"]/gi;
      detectPattern(text, pwQuotedPattern, "ENV_PASSWORD", matches, locations);

      // Tier 2: unquoted values with digit/special char, excluding code expressions.
      // Negative lookahead skips: identifiers followed by dot/paren/bracket/space,
      // language keywords (None, null, undefined, True, False, true, false),
      // and common code prefixes (os., process., self., kwargs, settings., config., env.)
      const pwUnquotedPattern =
        /[A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|_PWD)\s*[=:]\s*(?![A-Za-z_]\w*[\s.(\[]|None|null|undefined|True|False|true|false|os\.|process\.|self\.|kwargs|settings\.|config\.|env\.)(?=\S*[\d!@#$%^&*+\-/\\])\S{8,}/gi;
      detectPattern(text, pwUnquotedPattern, "ENV_PASSWORD", matches, locations);

      // Inline password=... or pwd=... assignments (lowercase, not env-style)
      // Tier 1: quoted
      const pwInlineQuotedPattern =
        /(?:(?<=^|[\s,;])(?:password|passwd|pwd))\s*(?:[:=]\s*|is\s+)['"][^\s'"]{8,}['"]/gi;
      detectPattern(text, pwInlineQuotedPattern, "ENV_PASSWORD", matches, locations);

      // Tier 2: unquoted with digit/special, excluding code expressions
      const pwInlineUnquotedPattern =
        /(?:(?<=^|[\s,;])(?:password|passwd|pwd))\s*(?:[:=]\s*)(?![A-Za-z_]\w*[\s.(\[]|None|null|undefined|True|False|true|false|os\.|process\.|self\.|kwargs|settings\.|config\.|env\.)(?=\S*[\d!@#$%^&*+\-/\\])\S{8,}/gi;
      detectPattern(text, pwInlineUnquotedPattern, "ENV_PASSWORD", matches, locations);
    }

    // Environment variable secret patterns: _SECRET suffix with value (8+ chars)
    // Same two-tier approach as ENV_PASSWORD
    if (enabledTypes.has("ENV_SECRET")) {
      // Tier 1: quoted
      const secretQuotedPattern =
        /[A-Za-z_][A-Za-z0-9_]*_SECRET\s*[=:]\s*['"][^\s'"]{8,}['"]/gi;
      detectPattern(text, secretQuotedPattern, "ENV_SECRET", matches, locations);

      // Tier 2: unquoted with digit/special, excluding code expressions
      const secretUnquotedPattern =
        /[A-Za-z_][A-Za-z0-9_]*_SECRET\s*[=:]\s*(?![A-Za-z_]\w*[\s.(\[]|None|null|undefined|True|False|true|false|os\.|process\.|self\.|kwargs|settings\.|config\.|env\.)(?=\S*[\d!@#$%^&*+\-/\\])\S{8,}/gi;
      detectPattern(text, secretUnquotedPattern, "ENV_SECRET", matches, locations);
    }

    // Connection strings with embedded passwords (user:password@host format)
    // Supports: postgres, mysql, mongodb, redis, amqp + generic transports (https, sftp, ssh, ftp, smtp)
    if (enabledTypes.has("CONNECTION_STRING")) {
      const connectionPattern =
        /(?:(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqps?|https?|sftp|ssh|ftp|smtp):\/\/)[^:]+:[^@\s]+@[^\s'"]+/gi;
      detectPattern(text, connectionPattern, "CONNECTION_STRING", matches, locations);
    }

    return {
      detected: matches.length > 0,
      matches,
      locations: locations.length > 0 ? locations : undefined,
    };
  },
};
