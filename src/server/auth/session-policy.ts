/** One lifetime for issuance and reads, including legacy middleware-issued 30-day tokens. */
export const AUTH_SESSION_MAX_AGE = 8 * 60 * 60;

export function withinSessionLifetime(
  token: { iat?: unknown; exp?: unknown } | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!token || typeof token.iat !== "number" || typeof token.exp !== "number") return false;
  if (!Number.isFinite(token.iat) || !Number.isFinite(token.exp)) return false;
  // Match Auth.js's 15-second future-clock tolerance, but never extend the eight-hour window.
  return token.iat <= nowSeconds + 15
    && nowSeconds < Math.min(token.exp, token.iat + AUTH_SESSION_MAX_AGE);
}
