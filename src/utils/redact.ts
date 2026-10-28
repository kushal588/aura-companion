/**
 * Redaction for diagnostics and logs (PLAN §12.1).
 *
 * Anything that leaves the app for diagnostics passes through here first. The
 * app must never log message text, microphone audio, API keys or absolute file
 * paths.
 */

const SECRET_PATTERNS: RegExp[] = [
  // Google API keys and ephemeral tokens
  /AQ\.[A-Za-z0-9_\-.]{10,}/g,
  /AIza[0-9A-Za-z\-_]{20,}/g,
  // Bearer / query-string credentials
  /(key|api[-_]?key|access_token|authorization|bearer)\s*[=:]\s*["']?[A-Za-z0-9._-]{8,}/gi,
  // Absolute unix + windows paths (may contain user names)
  /\/(?:Users|home)\/[^\s"']+/g,
  /[A-Za-z]:\\Users\\[^\s"']+/g,
];

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/g;

export function redactSecrets(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, '[redacted]');
  }
  return output;
}

export function redactEmails(input: string): string {
  return input.replace(EMAIL, '[email]');
}

/** Full diagnostic redaction: secrets, personal paths and emails. */
export function redactForDiagnostics(input: string): string {
  return redactEmails(redactSecrets(input));
}

/**
 * Redacted form of an error for logs. Keeps the error class and a bounded,
 * scrubbed message so support can still reason about the failure.
 */
export function redactError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: redactForDiagnostics(error.message).slice(0, 500) };
  }
  return { name: 'NonError', message: redactForDiagnostics(String(error)).slice(0, 500) };
}
