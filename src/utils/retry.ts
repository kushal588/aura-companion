import { ProviderError, type ProviderErrorDetails } from '../types/model';

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Retry only transient failures (PLAN §7.1 step 5). Aborts and auth errors are
 * never retried: retrying them wastes the user's quota and hides the real fix.
 */
export async function withRetry<T>(
  operation: (attempt: number, signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 350;
  const maxDelayMs = options.maxDelayMs ?? 4000;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal.aborted) {
      throw new ProviderError({ kind: 'aborted', retryable: false, message: 'Request aborted' });
    }
    try {
      return await operation(attempt, signal);
    } catch (error) {
      lastError = error;
      const retryable = isRetryableError(error);
      if (!retryable || attempt === attempts) {
        throw error;
      }
      options.onRetry?.(attempt, error);
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }
  throw lastError;
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof ProviderError) {
    return error.details.retryable;
  }
  return false;
}

/** Map a fetch failure or HTTP status to a typed provider error. */
export function toProviderError(status: number | undefined, body: string): ProviderError {
  const trimmed = body.slice(0, 400);
  const base: Omit<ProviderErrorDetails, 'kind' | 'retryable'> = {
    status,
    message: trimmed || `HTTP ${status ?? 'error'}`,
  };
  if (status === undefined) {
    const corsHint =
      /failed to fetch|network error|load failed/i.test(trimmed) || trimmed === ''
        ? 'Network request failed. The request may have been blocked (offline or CORS).'
        : trimmed;
    return new ProviderError({
      ...base,
      kind: 'network',
      retryable: true,
      message: corsHint,
    });
  }
  if (status === 400) return new ProviderError({ ...base, kind: 'bad_request', retryable: false });
  if (status === 401 || status === 403)
    return new ProviderError({ ...base, kind: 'auth', retryable: false });
  if (status === 429) return new ProviderError({ ...base, kind: 'rate_limit', retryable: true });
  if (status >= 500) return new ProviderError({ ...base, kind: 'server', retryable: true });
  return new ProviderError({ ...base, kind: 'unknown', retryable: false });
}

/** Human-readable, non-alarming message for the UI status line. */
export function describeProviderError(error: unknown): string {
  if (error instanceof ProviderError) {
    switch (error.details.kind) {
      case 'auth':
        return 'The API key was rejected. Check it in Settings.';
      case 'quota':
      case 'rate_limit':
        return 'The provider is rate limiting or out of quota. Try again shortly.';
      case 'network':
        return 'No connection to the AI service. Your local chats are unaffected.';
      case 'cors':
        return 'The browser blocked the request to the AI service. Use the desktop build for Live mode.';
      case 'timeout':
        return 'The AI service did not answer in time. You can retry.';
      case 'aborted':
        return 'Cancelled.';
      case 'bad_request':
        return 'The AI service rejected the request. Check the model ID in Settings.';
      case 'server':
        return 'The AI service had a temporary problem. Retrying is safe.';
      default:
        return 'Something went wrong talking to the AI service.';
    }
  }
  return 'Something went wrong talking to the AI service.';
}

export function createTimeoutSignal(
  parent: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = (): void => controller.abort();
  if (parent.aborted) {
    controller.abort();
  } else {
    parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    },
    timedOut: () => timedOut,
  };
}
