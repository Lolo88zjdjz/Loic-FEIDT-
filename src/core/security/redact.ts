/** Masque les secrets avant journalisation ou affichage. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]{8,}/g,           // clés Anthropic
  /\bpa-[A-Za-z0-9_\-]{16,}/g,           // clés Voyage
  /\bya29\.[A-Za-z0-9_\-]+/g,            // jetons OAuth Google
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,       // jetons GitHub
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"']{6,}/gi,
];
const SECRET_KEYS = /^(api[_-]?key|token|access_token|refresh_token|secret|password|password_hash|encrypted_token|authorization)$/i;

export function redactString(s: string): string {
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, "[REDACTED]"), s);
}

export function redactSecrets(v: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  if (typeof v === "string") return redactString(v);
  if (Array.isArray(v)) return v.map((x) => redactSecrets(x, depth + 1));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) =>
      [k, SECRET_KEYS.test(k) ? "[REDACTED]" : redactSecrets(val, depth + 1)]));
  }
  return v;
}
