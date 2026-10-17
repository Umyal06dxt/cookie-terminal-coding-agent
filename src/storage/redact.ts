/**
 * Best-effort scrubbing of key-shaped text before anything is written to disk (docs/design.md,
 * "Secrets: redact anything key-shaped from logs"). Tuned to leave ordinary code alone: file
 * paths and 40-character git hashes survive.
 */

export const REDACTED = '[REDACTED]';

const PATTERNS: RegExp[] = [
  // Provider keys: sk-…, sk-proj-…, sk-ant-…; Command Code user_… keys.
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\buser_[A-Za-z0-9]{16,}/g,
  // GitHub, Slack and AWS token shapes.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // "Bearer <token>" in headers and curl commands.
  /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g,
  // Long hex runs: longer than a git SHA-1 (40), so commit hashes stay readable.
  /\b[0-9a-fA-F]{48,}\b/g,
];

/** NAME_KEY=value, "api_key": "value", token: value — keep the name, drop the value. */
const ASSIGNED =
  /\b([A-Za-z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)([^\s"'`,;]{8,})/gi;

/**
 * A base64/base64url run of 40+ characters mixing upper case, lower case and digits. No "/" in
 * the run, so paths never match; real base64 keys with "/" still lose the part that matters.
 */
const BASE64_RUN = /[A-Za-z0-9+_=-]{40,}/g;

function looksRandom(run: string): boolean {
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run);
}

export function redact(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(
    ASSIGNED,
    (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`,
  );
  out = out.replace(BASE64_RUN, (run) => (looksRandom(run) ? REDACTED : run));
  return out;
}

/** Every string inside a JSON-shaped value, redacted. Object keys are left as they are. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactDeep(v)]),
    ) as T;
  }
  return value;
}
