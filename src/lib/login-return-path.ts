/** Validate after URL normalization: /\host and control characters can disguise an external URL. */
export function loginReturnPath(raw: string | null): string {
  if (!raw?.startsWith("/") || raw.startsWith("//")) return "/";
  const origin = "https://login-return.invalid";
  try {
    const target = new URL(raw, origin);
    return target.origin === origin ? target.pathname + target.search + target.hash : "/";
  } catch {
    return "/";
  }
}
