/** A bounded token bucket; a clock adjustment cannot grant extra tokens. */
export function createRateLimit(perSecond: number) {
  let tokens = perSecond;
  let previous = Date.now();
  return () => {
    const now = Math.max(previous, Date.now());
    tokens = Math.min(
      perSecond,
      tokens + (Math.min(now - previous, 1_000) * perSecond) / 1_000,
    );
    previous = now;
    if (tokens < 1) return false;
    tokens--;
    return true;
  };
}
