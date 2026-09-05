export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep: (ms: number) => void;
  isRetryable?: (error: unknown) => boolean;
}

const RETRYABLE_RE = /rate ?limit|quota|backend ?error|internal ?error|timed? ?out|\b50[0234]\b|try again/i;

export function isRetryableError(error: unknown): boolean {
  return RETRYABLE_RE.test(errorMessage(error));
}

export function isNotFoundError(error: unknown): boolean {
  return /not ?found|\b404\b/i.test(errorMessage(error));
}

export function isGoneError(error: unknown): boolean {
  return /\b410\b|has been deleted|already been deleted/i.test(errorMessage(error));
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 指数バックオフ。rateLimitExceeded / 5xx を最大 5 回までリトライする。 */
export function withRetry<T>(fn: () => T, opts: RetryOptions): T {
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const isRetryable = opts.isRetryable ?? isRetryableError;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return fn();
    } catch (e) {
      if (attempt >= maxAttempts || !isRetryable(e)) throw e;
      const jitter = Math.floor(Math.random() * baseDelayMs);
      opts.sleep(baseDelayMs * 2 ** (attempt - 1) + jitter);
    }
  }
}
