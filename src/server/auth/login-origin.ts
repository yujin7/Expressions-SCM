type Authority = { hostname: string; port: string | null };
type LoginRequest = { url: string; headers: Pick<Headers, "get"> };

/** Strict HTTP authority, not a URL or a proxy's comma-separated host list. */
function authorityOf(value: string): Authority | null {
  if (!value || value.length > 260) return null;
  const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/.exec(value);
  if (!match || match[0] !== value) return null;
  const hostname = match[1].toLowerCase();
  const port = match[2] ?? null;
  if (port !== null && Number(port) > 65535) return null;
  if (!hostname.startsWith("[")) {
    if (hostname.length > 253 || !hostname.split(".").every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  }
  try {
    const parsed = new URL(`http://${value}`);
    // Reject alternate numeric IP spellings and implicit URL normalization.
    // In particular, the built-in loopback exception is only the three exact
    // names below, not 127/8, numeric IPv4, mapped IPv6, or localhost suffixes.
    if (parsed.hostname !== hostname) return null;
  } catch { return null; }
  return { hostname, port };
}

function absoluteHttpUrl(value: string | undefined): { authority: Authority; protocol: "http:" | "https:"; origin: string } | null {
  if (!value || /\s/.test(value)) return null;
  const match = /^(https?):\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value);
  if (!match) return null;
  const authority = authorityOf(match[2]);
  if (!authority) return null;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return null;
    return { authority, protocol: parsed.protocol as "http:" | "https:", origin: parsed.origin };
  } catch { return null; }
}

function effectivePort(authority: Authority, protocol: "http:" | "https:"): string {
  return authority.port ?? (protocol === "https:" ? "443" : "80");
}

/**
 * Pure, Edge-safe login redirect origin policy. Host-only cookies must stay on
 * the browser's entry host, not Next's normalized or container-bound hostname.
 * AUTH_URL explicitly permits one configured origin (including LAN HTTP).
 * The only additional origins are exact loopback names over HTTP. Forwarded
 * host/protocol headers never expand this allowlist or choose the scheme.
 */
export function loginOriginForRequest(request: LoginRequest, configuredAuthUrl?: string): string | null {
  const rawHost = request.headers.get("host");
  // A present-but-invalid Host must not fall back to an unrelated safe URL.
  const requested = rawHost === null ? absoluteHttpUrl(request.url)?.authority ?? null : authorityOf(rawHost);
  if (!requested) return null;

  const configured = absoluteHttpUrl(configuredAuthUrl);
  if (configured && requested.hostname === configured.authority.hostname &&
    effectivePort(requested, configured.protocol) === effectivePort(configured.authority, configured.protocol)) {
    return configured.origin;
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(requested.hostname)) return null;
  return new URL(`http://${requested.hostname}${requested.port === null ? "" : `:${requested.port}`}`).origin;
}
