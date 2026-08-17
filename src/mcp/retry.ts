import type { RetryPolicy } from "./types.js";

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 250,
  factor: 2,
  maxDelayMs: 5000,
  sleep: defaultSleep,
};

export function resolveRetryPolicy(partial?: Partial<RetryPolicy>): RetryPolicy {
  return { ...DEFAULT_RETRY, ...partial };
}

/**
 * Run `fn` with retry + exponential backoff (MCP-11).
 *
 * Only failures where `retryable(err)` is true are retried; anything else
 * propagates immediately. Returns the first successful result.
 */
export async function withRetry<T>(
  policy: RetryPolicy,
  attempt: () => Promise<T>,
  retryable: (err: unknown) => boolean,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i <= policy.maxRetries; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
      if (i === policy.maxRetries || !retryable(err)) throw err;
      const delay = Math.min(policy.baseDelayMs * policy.factor ** i, policy.maxDelayMs);
      await (policy.sleep ?? defaultSleep)(delay);
    }
  }
  throw lastError;
}
