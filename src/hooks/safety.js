const UNSAFE_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+push\s+--force\b/i,
  /\b(drop|truncate)\s+table\b/i
];

const SECRET_PATTERNS = [
  /api[_-]?key\s*=\s*["']?[a-z0-9_\-]{16,}/i,
  /service_role[_-]?key/i,
  /password\s*=\s*["'][^"']+["']/i,
  /bearer\s+[a-z0-9_\-.]{20,}/i
];

export function inspectToolUse({ command = "", content = "" }) {
  const inspected = `${command}\n${content}`;
  const unsafeMatch = UNSAFE_COMMAND_PATTERNS.find((pattern) => pattern.test(inspected));
  if (unsafeMatch) {
    return {
      allowed: false,
      reason: "Unsafe destructive operation detected",
      pattern: unsafeMatch.toString()
    };
  }

  const secretMatch = SECRET_PATTERNS.find((pattern) => pattern.test(inspected));
  if (secretMatch) {
    return {
      allowed: false,
      reason: "Potential secret exposure detected",
      pattern: secretMatch.toString()
    };
  }

  return { allowed: true, reason: "No hook policy violations detected" };
}

export function sanitizeMemoryText(input) {
  return String(input ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g, "[ssn]")
    .replace(/\b(?:\d[ -]*?){13,16}\b/g, "[card]");
}
