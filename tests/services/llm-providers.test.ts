import { describe, it, expect } from 'vitest';
import {
  getAllProviders,
  getProvider,
  getProviderModels,
  getModel,
  getClientType,
  getBaseUrl,
  computeLlmCostCents,
  buildProviderConfig,
} from '../../src/services/llm-providers.js';

describe('provider registry', () => {
  it('should have at least 10 providers', () => {
    const providers = getAllProviders();
    expect(providers.length).toBeGreaterThanOrEqual(10);
  });

  it('should find anthropic provider', () => {
    const provider = getProvider('anthropic');
    expect(provider).toBeDefined();
    expect(provider?.name).toContain('Claude');
    expect(provider?.clientType).toBe('anthropic');
    expect(provider?.requiresBaseUrl).toBe(false);
  });

  it('should find openai provider', () => {
    const provider = getProvider('openai');
    expect(provider).toBeDefined();
    expect(provider?.clientType).toBe('openai');
  });

  it('should find openai-compatible providers', () => {
    const mistral = getProvider('mistral');
    expect(mistral).toBeDefined();
    expect(mistral?.clientType).toBe('openai_compatible');
    expect(mistral?.baseUrl).toContain('mistral.ai');

    const deepseek = getProvider('deepseek');
    expect(deepseek).toBeDefined();
    expect(deepseek?.baseUrl).toContain('deepseek.com');
  });

  it('should find gateway providers', () => {
    const openrouter = getProvider('openrouter');
    expect(openrouter).toBeDefined();
    expect(openrouter?.allowCustomModel).toBe(true);
    expect(openrouter?.baseUrl).toContain('openrouter.ai');

    const litellm = getProvider('litellm');
    expect(litellm).toBeDefined();
    expect(litellm?.requiresBaseUrl).toBe(true);
  });

  it('should have custom provider for arbitrary endpoints', () => {
    const custom = getProvider('custom');
    expect(custom).toBeDefined();
    expect(custom?.requiresBaseUrl).toBe(true);
    expect(custom?.allowCustomModel).toBe(true);
    expect(custom?.models).toHaveLength(0);
  });

  it('should return undefined for unknown provider', () => {
    expect(getProvider('nonexistent')).toBeUndefined();
  });
});

describe('model registry', () => {
  it('should list anthropic models', () => {
    const models = getProviderModels('anthropic');
    expect(models.length).toBeGreaterThanOrEqual(3);

    const sonnet = models.find((m) => m.id.includes('sonnet'));
    expect(sonnet).toBeDefined();
    expect(sonnet?.inputCostPerMillion).toBeGreaterThan(0);
  });

  it('should list openai models', () => {
    const models = getProviderModels('openai');
    expect(models.length).toBeGreaterThanOrEqual(3);
  });

  it('should get a specific model', () => {
    const model = getModel('anthropic', 'claude-sonnet-4-6');
    expect(model).toBeDefined();
    expect(model?.inputCostPerMillion).toBe(300);
    expect(model?.outputCostPerMillion).toBe(1500);
  });

  it('should return undefined for unknown model', () => {
    expect(getModel('anthropic', 'nonexistent-model')).toBeUndefined();
  });

  it('should return empty for provider with no predefined models', () => {
    const models = getProviderModels('custom');
    expect(models).toHaveLength(0);
  });
});

describe('getClientType', () => {
  it('should return anthropic for anthropic', () => {
    expect(getClientType('anthropic')).toBe('anthropic');
  });

  it('should return openai for openai', () => {
    expect(getClientType('openai')).toBe('openai');
  });

  it('should return openai_compatible for others', () => {
    expect(getClientType('mistral')).toBe('openai_compatible');
    expect(getClientType('deepseek')).toBe('openai_compatible');
    expect(getClientType('openrouter')).toBe('openai_compatible');
    expect(getClientType('unknown')).toBe('openai_compatible');
  });
});

describe('getBaseUrl', () => {
  it('should return base URL for compatible providers', () => {
    expect(getBaseUrl('mistral')).toContain('mistral.ai');
    expect(getBaseUrl('deepseek')).toContain('deepseek.com');
    expect(getBaseUrl('groq')).toContain('groq.com');
  });

  it('should return undefined for native providers', () => {
    expect(getBaseUrl('anthropic')).toBeUndefined();
    expect(getBaseUrl('openai')).toBeUndefined();
  });
});

describe('computeLlmCostCents', () => {
  it('should compute cost for known model', () => {
    // Claude Sonnet: 300 input, 1500 output per million
    const cost = computeLlmCostCents('anthropic', 'claude-sonnet-4-6', 1_000_000, 500_000);
    // Input: 300 cents + Output: 750 cents = 1050 cents
    expect(cost).toBe(1050);
  });

  it('should compute cost for cheap model', () => {
    // GPT-5 Nano: 5 input, 40 output per million
    const cost = computeLlmCostCents('openai', 'gpt-5-nano', 100_000, 50_000);
    // Input: 0.5 + Output: 2 = 2.5 → ceil = 3
    expect(cost).toBe(3);
  });

  it('should use default pricing for unknown model', () => {
    const cost = computeLlmCostCents('custom', 'unknown-model', 1_000_000, 1_000_000);
    // Default: 100 input + 500 output = 600
    expect(cost).toBe(600);
  });

  it('should return 0 for zero tokens', () => {
    const cost = computeLlmCostCents('anthropic', 'claude-sonnet-4-6', 0, 0);
    expect(cost).toBe(0);
  });
});

describe('buildProviderConfig', () => {
  it('should build config for anthropic', () => {
    const config = buildProviderConfig('anthropic', 'claude-sonnet-4-6', 'sk-ant-test');
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('claude-sonnet-4-6');
    expect(config.apiKey).toBe('sk-ant-test');
    expect(config.clientType).toBe('anthropic');
    expect(config.baseUrl).toBeUndefined();
  });

  it('should build config for openai-compatible with baseUrl', () => {
    const config = buildProviderConfig('mistral', 'mistral-large-latest', 'mist-key');
    expect(config.clientType).toBe('openai_compatible');
    expect(config.baseUrl).toContain('mistral.ai');
  });

  it('should allow custom baseUrl override', () => {
    const config = buildProviderConfig('litellm', 'my-model', 'key', 'http://localhost:8000/v1/');
    expect(config.baseUrl).toBe('http://localhost:8000/v1/');
    expect(config.clientType).toBe('openai_compatible');
  });
});
