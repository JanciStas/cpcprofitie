// Validates a `next=` query param against open-redirect attacks. We accept
// only same-origin paths starting with a single `/` and not `//host`. Also
// strips ASCII control characters to prevent CR/LF header splitting in any
// downstream `Location:` redirect — keep both checks; removing either reopens
// a real exploit class.

const SAFE_PREFIX = /^\/(?!\/)/;

export function safeNextPath(input: string | null | undefined, fallback = '/app/overview'): string {
  if (!input) return fallback;
  // Reject protocol-relative (`//evil.com`) and absolute (`https://evil.com`) URLs.
  if (!SAFE_PREFIX.test(input)) return fallback;
  // Reject any backslash. Browsers normalise `/\evil.com` to `//evil.com`, so
  // the single-slash check above let `?next=/%5Cevil.com` send a freshly
  // logged-in user straight off-site.
  if (input.includes(String.fromCharCode(92))) return fallback;
  // Reject control characters and CR/LF that could split headers.
  if (/[\x00-\x1f\x7f]/.test(input)) return fallback;
  return input;
}
