/**
 * Token-bucket rate limiter per source.
 *
 * Source plugins declare `rateLimit: { rpm }`. The pipeline wraps each
 * source's fetch function in a limiter. If unset, default is 120 rpm.
 *
 * Usage:
 *   const limiter = createLimiter({ rpm: 60 });
 *   await limiter.wait(); // throttles if budget exhausted
 *   const result = await fetch(url);
 */

function createLimiter({ rpm = 120 } = {}) {
  const capacity = rpm;
  let tokens = capacity;
  let lastRefill = Date.now();

  return {
    async wait() {
      // Refill: one full capacity per minute, evenly.
      const now = Date.now();
      const elapsed = (now - lastRefill) / 60000;
      tokens = Math.min(capacity, tokens + elapsed * capacity);
      lastRefill = now;

      if (tokens >= 1) {
        tokens -= 1;
        return;
      }

      const waitMs = Math.ceil(((1 - tokens) / capacity) * 60000);
      await new Promise(r => setTimeout(r, waitMs));
      return this.wait();
    },
    get available() { return tokens; },
    get capacity() { return capacity; },
  };
}

module.exports = { createLimiter };
