import type { AppConfig, ScrubberLike } from '../types.js';

const REDACTED = '[REDACTED_SECRET]';

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /(Authorization:\s*(?:Bearer|Basic)\s+)[^\s"'`]+/gi,
  /(https?:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi,
];

export class SecretScrubber implements ScrubberLike {
  private readonly literals: string[];

  constructor(config?: Partial<AppConfig>, extraSecrets: string[] = []) {
    const candidates = [
      config?.bearerToken,
      config?.oauthSigningSecret,
      config?.adminPasswordHash,
      config?.oauthStaticClientSecret,
      config?.ghToken,
      config?.openaiApiKey,
      config?.codexApiKey,
      config?.anthropicApiKey,
      ...extraSecrets,
    ];

    const unique = new Set<string>();
    for (const item of candidates) {
      if (typeof item === 'string' && item.trim().length >= 8) {
        unique.add(item.trim());
      }
    }
    // Longest first to avoid partial replacements
    this.literals = Array.from(unique).sort((a, b) => b.length - a.length);
  }

  scrub(input: string): string {
    if (!input) return '';
    let result = input;

    for (const secret of this.literals) {
      if (result.includes(secret)) {
        result = result.split(secret).join(REDACTED);
      }
    }

    for (const pattern of SECRET_PATTERNS) {
      if (pattern.source.startsWith('(Authorization:')) {
        result = result.replace(pattern, `$1${REDACTED}`);
      } else if (pattern.source.startsWith('(https?:')) {
        result = result.replace(pattern, `$1${REDACTED}$3`);
      } else {
        result = result.replace(pattern, REDACTED);
      }
    }

    return result;
  }

  containsLikelySecret(input: string): boolean {
    return this.scrub(input) !== input;
  }
}
