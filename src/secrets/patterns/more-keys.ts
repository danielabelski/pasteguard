import type { PatternDetector, SecretLocation, SecretsMatch } from "./types";
import { detectPattern } from "./utils";

/**
 * Additional API keys and tokens detector
 *
 * Detects:
 * - SLACK_TOKEN: Slack bot/user/app tokens (xoxb-, xapp-)
 * - HF_TOKEN: HuggingFace access tokens (hf_...)
 * - GENERIC_API_KEY: Generic key=value or "key":"value" patterns
 */
export const moreKeysDetector: PatternDetector = {
  patterns: ["SLACK_TOKEN", "HF_TOKEN", "GENERIC_API_KEY"],

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

    // Generic API key assignment: api_key/access_token/client_secret = "value"
    if (enabledTypes.has("GENERIC_API_KEY")) {
      const genericPattern =
        /(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|client[_-]?secret|refresh[_-]?token)\s*[:=]\s*['"]?[a-zA-Z0-9_\-.]{16,}['"]?/gi;
      detectPattern(text, genericPattern, "GENERIC_API_KEY", matches, locations);
    }

    return {
      detected: matches.length > 0,
      matches,
      locations: locations.length > 0 ? locations : undefined,
    };
  },
};
