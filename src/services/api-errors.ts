/**
 * Typed API errors for Anthropic and Google AI services.
 * Each error type maps to a specific user-facing message.
 */

export type ApiProvider = 'anthropic' | 'google' | 'llm';

export class ApiNotConfiguredError extends Error {
  readonly provider: ApiProvider;
  constructor(provider: ApiProvider) {
    super(`${provider === 'anthropic' ? 'Anthropic' : 'Google AI'} API key is not configured`);
    this.name = 'ApiNotConfiguredError';
    this.provider = provider;
  }
}

export class ApiQuotaExhaustedError extends Error {
  readonly provider: ApiProvider;
  readonly detail: string;
  constructor(provider: ApiProvider, detail: string) {
    const label = provider === 'anthropic' ? 'Anthropic' : 'Google AI';
    super(`${label} quota exceeded: ${detail}`);
    this.name = 'ApiQuotaExhaustedError';
    this.provider = provider;
    this.detail = detail;
  }
}

export class ApiAuthError extends Error {
  readonly provider: ApiProvider;
  constructor(provider: ApiProvider, detail: string) {
    const label = provider === 'anthropic' ? 'Anthropic' : 'Google AI';
    super(`${label} authentication failed: ${detail}`);
    this.name = 'ApiAuthError';
    this.provider = provider;
  }
}

export class ApiOverloadedError extends Error {
  readonly provider: ApiProvider;
  constructor(provider: ApiProvider) {
    const label = provider === 'anthropic' ? 'Anthropic' : 'Google AI';
    super(`${label} is temporarily overloaded`);
    this.name = 'ApiOverloadedError';
    this.provider = provider;
  }
}

/**
 * Detect the specific API error type from a raw error.
 */
export function classifyApiError(provider: ApiProvider, error: unknown): Error {
  const msg = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number }).status;

  // Quota / billing / paid plan errors
  if (
    status === 429
    || msg.includes('rate_limit')
    || msg.includes('quota')
    || msg.includes('RESOURCE_EXHAUSTED')
    || msg.includes('billing')
    || msg.includes('insufficient_quota')
    || msg.includes('exceeded your current quota')
    || msg.includes('paid plan')
    || msg.includes('upgrade your account')
    || msg.includes('only available on paid')
  ) {
    return new ApiQuotaExhaustedError(provider, msg);
  }

  // Auth errors
  if (
    status === 401
    || status === 403
    || msg.includes('authentication')
    || msg.includes('invalid.*key')
    || msg.includes('API_KEY_INVALID')
    || msg.includes('permission')
    || msg.includes('invalid x-api-key')
  ) {
    return new ApiAuthError(provider, msg);
  }

  // Overloaded
  if (
    status === 529
    || status === 503
    || msg.includes('overloaded')
    || msg.includes('503')
    || msg.includes('529')
  ) {
    return new ApiOverloadedError(provider);
  }

  // Unknown — return original
  return error instanceof Error ? error : new Error(msg);
}
