/** Which parent origins may hand the secure frame its port. Pure: the manifest's
 *  web_accessible_resources `matches` and the frame's own origin come in as parameters. */

interface ParsedOrigin {
  scheme: string;
  host: string;
  /** Explicit non-default port, or null for the scheme's default port. */
  port: string | null;
}

interface ParsedPattern {
  scheme: string;
  host: string;
  /** "*" = any port, a number string = that port, null = default port only. */
  port: string | null;
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  http: "80",
  https: "443",
};

// Origins carry no path; patterns must end in a path and may not wildcard the host.
const ORIGIN_RE = /^(https?):\/\/([^/:*]+)(?::(\d+))?$/;
const PATTERN_RE = /^(https?):\/\/([^/:*]+)(?::(\*|\d+))?\/.*$/;

function normalisePort(
  scheme: string,
  port: string | undefined,
): string | null {
  if (port === undefined || port === DEFAULT_PORTS[scheme]) return null;
  return port;
}

function parseOrigin(origin: string): ParsedOrigin | null {
  const match = ORIGIN_RE.exec(origin);
  if (!match) return null;
  const [, scheme, host, port] = match;
  return {
    scheme,
    host: host.toLowerCase(),
    port: normalisePort(scheme, port),
  };
}

function parsePattern(pattern: string): ParsedPattern | null {
  const match = PATTERN_RE.exec(pattern);
  if (!match) return null;
  const [, scheme, host, port] = match;
  const parsedPort = port === "*" ? "*" : normalisePort(scheme, port);
  return { scheme, host: host.toLowerCase(), port: parsedPort };
}

function patternAllows(pattern: string, origin: ParsedOrigin): boolean {
  const parsed = parsePattern(pattern);
  if (!parsed) return false;
  if (parsed.scheme !== origin.scheme || parsed.host !== origin.host) {
    return false;
  }
  return parsed.port === "*" || parsed.port === origin.port;
}

/**
 * True when `origin` may send the secure frame its handshake: it equals `selfOrigin` (an
 * extension page such as the Dialog dev page), or a manifest match pattern names its exact
 * scheme and host — no port in the pattern means the default port only, `:*` any port.
 * Wildcard hosts, `<all_urls>`, `*` and the opaque origin `null` are never allowed.
 */
export function isAllowedParentOrigin(
  origin: string,
  manifestMatches: readonly string[],
  selfOrigin: string,
): boolean {
  if (origin === "" || origin === "null" || origin === "*") return false;
  if (origin === selfOrigin) return true;
  const parsed = parseOrigin(origin);
  if (!parsed) return false;
  return manifestMatches.some((pattern) => patternAllows(pattern, parsed));
}
