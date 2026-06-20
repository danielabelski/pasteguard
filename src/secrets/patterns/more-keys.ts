import type { PatternDetector, SecretLocation, SecretsMatch } from "./types";
import { detectPattern } from "./utils";

/**
 * Additional API keys and tokens detector
 *
 * Detects:
 * - SLACK_TOKEN: Slack bot/user/app tokens (xoxb-, xapp-)
 * - HF_TOKEN: HuggingFace access tokens (hf_...)
 * - GITLAB_TOKEN: GitLab Personal Access Tokens (glpat-...)
 * - GOOGLE_API_KEY: Google API keys (AIza...)
 * - GENERIC_API_KEY: Generic key=value or "key":"value" patterns
 */
export const moreKeysDetector: PatternDetector = {
  patterns: ["SLACK_TOKEN", "HF_TOKEN", "GITLAB_TOKEN", "GOOGLE_API_KEY", "GENERIC_API_KEY"],

  detect(text: string, enabledTypes: Set<string>) {
    const matches: SecretsMatch[] = [];
    const locations: SecretLocation[] = [];

    // Slack bot tokens: xoxb-<numbers>-<numbers><suffix>
    if (enabledTypes.has("SLACK_TOKEN")) {
      const slackBotPattern = /xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/g;
      detectPattern(text, slackBotPattern, "SLACK_TOKEN", matches, locations);

      // Slack app-level tokens: xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+
      const slackAppPattern = /xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+/g;
      detectPattern(text, slackAppPattern, "SLACK_TOKEN", matches, locations);
    }

    // HuggingFace tokens: hf_<random chars, case-insensitive>
    if (enabledTypes.has("HF_TOKEN")) {
      const hfPattern = /hf_(?i:[a-z]{34})/g;
      detectPattern(text, hfPattern, "HF_TOKEN", matches, locations);
    }

    // GitLab Personal Access Tokens: glpat-<20+ chars>
    if (enabledTypes.has("GITLAB_TOKEN")) {
      const gitlabPattern = /glpat-[\w-]{20,}/g;
      detectPattern(text, gitlabPattern, "GITLAB_TOKEN", matches, locations);
    }

    // Google API keys: AIza followed by 35+ alphanumeric chars
    if (enabledTypes.has("GOOGLE_API_KEY")) {
      const googlePattern = /AIza[0-9A-Za-z\-_]{35,}/g;
      detectPattern(text, googlePattern, "GOOGLE_API_KEY", matches, locations);
    }

    // Generic API key assignment: api_key/access_token/client_secret = "value"
    // Also matches "key is ...", "api key ...", "secret key = ..." etc.
    // Two-tier: quoted values always match; unquoted must contain digit/special char
    // and NOT look like a code expression (variable reference, function call, keyword)
    if (enabledTypes.has("GENERIC_API_KEY")) {
      // Tier 1: quoted values (high confidence — hardcoded literal)
      const genericQuotedPattern =
        /(?:(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|client[_-]?secret|refresh[_-]?token|token|password|secret)\s*[:=]\s*|(?:(?<=^|[\s,;])(?:api|secret|auth|access)\s+key)\s+)\s*['"][a-zA-Z0-9_\-.]{16,}['"]/gi;
      detectPattern(text, genericQuotedPattern, "GENERIC_API_KEY", matches, locations);

      // Tier 2: unquoted, must contain a digit or special char (real tokens always do),
      // and must NOT start with a pattern that looks like code (identifier+dot/paren/space+keyword)
      const genericUnquotedPattern =
        /(?:(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|client[_-]?secret|refresh[_-]?token|token|password|secret)\s*[:=]\s*|(?:(?<=^|[\s,;])(?:api|secret|auth|access)\s+key)\s+)(?![A-Za-z_]\w*[\s.(\[]|None|null|undefined|True|False|true|false|os\.|process\.|self\.|kwargs|settings\.|config\.|env\.|getenv|environ)(?=\S*[\d!@#$%^&*+\-/\\])[a-zA-Z0-9_\-.!@#$%^&*+/\\]{16,}/gi;
      detectPattern(text, genericUnquotedPattern, "GENERIC_API_KEY", matches, locations);
    }

    return {
      detected: matches.length > 0,
      matches,
      locations: locations.length > 0 ? locations : undefined,
    };
  },
};
