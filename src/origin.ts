/** Exact origins only. HTTP is restricted to explicitly configured loopback development. */
export function createOriginPolicy(
  allowedOrigins: readonly string[],
): (url: unknown) => boolean {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0)
    throw new TypeError("allowedOrigins must be a non-empty array of exact origins");
  const allowed = new Set<string>();
  for (const origin of allowedOrigins) {
    if (typeof origin !== "string" || origin.length > 8_192)
      throw new TypeError("Invalid allowed origin");
    const parsed = new URL(origin);
    const local =
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (
      parsed.origin !== origin ||
      parsed.hostname.includes("*") ||
      (parsed.protocol !== "https:" && !local)
    )
      throw new TypeError(
        "Use canonical HTTPS origins without paths, credentials, or wildcards (HTTP loopback is allowed)",
      );
    allowed.add(origin);
  }
  return (url) => {
    if (typeof url !== "string" || url.length > 8_192) return false;
    for (let index = 0; index < url.length; index++) {
      const code = url.charCodeAt(index);
      if (code <= 32 || code === 127 || code === 92) return false;
    }
    try {
      const parsed = new URL(url);
      return (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        parsed.username === "" &&
        parsed.password === "" &&
        allowed.has(parsed.origin)
      );
    } catch {
      return false;
    }
  };
}
