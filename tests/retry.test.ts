import { describe, expect, it, vi } from 'vitest';
import { isNotFoundError, isRetryableError, withRetry } from '../src/retry';

describe('isRetryableError', () => {
  it('GAS Advanced Service の "Empty response" をリトライ対象にする', () => {
    expect(
      isRetryableError(new Error('API call to calendar.events.get failed with error: Empty response')),
    ).toBe(true);
  });

  it('rateLimit / 5xx / backendError をリトライ対象にする', () => {
    expect(isRetryableError(new Error('Rate Limit Exceeded'))).toBe(true);
    expect(isRetryableError(new Error('Backend Error'))).toBe(true);
    expect(isRetryableError(new Error('Returned code 503'))).toBe(true);
  });

  it('Not Found / Bad Request はリトライしない', () => {
    expect(isRetryableError(new Error('API call to calendar.events.get failed with error: Not Found'))).toBe(false);
    expect(isRetryableError(new Error('Bad Request'))).toBe(false);
    expect(isNotFoundError(new Error('Not Found'))).toBe(true);
  });
});

describe('withRetry', () => {
  it('Empty response を再試行し、成功したら値を返す', () => {
    const sleep = vi.fn();
    let calls = 0;
    const result = withRetry(
      () => {
        calls += 1;
        if (calls < 2) throw new Error('API call to calendar.events.get failed with error: Empty response');
        return 'ok';
      },
      { sleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('リトライ対象外のエラーは 1 回で throw する', () => {
    const sleep = vi.fn();
    let calls = 0;
    expect(() =>
      withRetry(
        () => {
          calls += 1;
          throw new Error('Not Found');
        },
        { sleep },
      ),
    ).toThrow('Not Found');
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('maxAttempts まで失敗し続けたら最後のエラーを throw する', () => {
    const sleep = vi.fn();
    let calls = 0;
    expect(() =>
      withRetry(
        () => {
          calls += 1;
          throw new Error('Empty response');
        },
        { sleep, maxAttempts: 3 },
      ),
    ).toThrow('Empty response');
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
