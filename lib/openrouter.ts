type LlmProvider = 'openrouter' | 'openai';

interface OpenRouterInput {
  system: string;
  user: string;
  images?: Array<{
    dataUrl: string;
  }>;
  model?: string;
  temperature?: number;
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
  };
  maxTokens?: number;
}

function readPositiveIntEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function getProvider(): LlmProvider {
  const configured = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (configured === 'openai' || configured === 'codex') return 'openai';
  if (configured === 'openrouter') return 'openrouter';

  if ((process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) && !process.env.OPENROUTER_API_KEY) {
    return 'openai';
  }

  return 'openrouter';
}

function getApiKey(provider: LlmProvider) {
  if (provider === 'openai') {
    return process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY;
  }

  return process.env.OPENROUTER_API_KEY;
}

function getMaxTokens(provider: LlmProvider, requested?: number) {
  return (
    requested ??
    readPositiveIntEnv('LLM_MAX_TOKENS') ??
    (provider === 'openai' ? readPositiveIntEnv('OPENAI_MAX_TOKENS') : readPositiveIntEnv('OPENROUTER_MAX_TOKENS'))
  );
}

function normalizeModel(provider: LlmProvider, model?: string) {
  const fallback = provider === 'openai' ? 'gpt-4.1-mini' : 'openai/gpt-4.1-mini';
  const selected = model || (provider === 'openai' ? process.env.OPENAI_MODEL : process.env.OPENROUTER_MODEL) || process.env.LLM_MODEL || fallback;

  if (provider === 'openai') {
    return selected.replace(/^openai\//i, '');
  }

  return selected;
}

function getEndpoint(provider: LlmProvider) {
  return provider === 'openai'
    ? 'https://api.openai.com/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';
}

function getHeaders(provider: LlmProvider, apiKey: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };

  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL || 'http://localhost:3000';
    headers['X-Title'] = process.env.OPENROUTER_APP_NAME || 'Agentic Sprint Builder';
  }

  return headers;
}

export async function callOpenRouter(input: OpenRouterInput): Promise<string> {
  const provider = getProvider();
  const apiKey = getApiKey(provider);
  if (!apiKey) {
    throw new Error(
      provider === 'openai'
        ? 'Missing OPENAI_API_KEY. Add it to .env or .env.local, or switch LLM_PROVIDER=openrouter.'
        : 'Missing OPENROUTER_API_KEY. Add it to .env or .env.local, or switch LLM_PROVIDER=openai.'
    );
  }

  const userContent = input.images?.length
    ? [
        { type: 'text', text: input.user },
        ...input.images.map((image) => ({
          type: 'image_url',
          image_url: { url: image.dataUrl }
        }))
      ]
    : input.user;

  const model = normalizeModel(provider, input.model);
  const requestBody: Record<string, unknown> = {
    model,
    temperature: input.temperature ?? 0.2,
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: userContent }
    ]
  };
  const maxTokens = getMaxTokens(provider, input.maxTokens);
  if (maxTokens) {
    requestBody.max_tokens = maxTokens;
  }

  if (input.jsonSchema) {
    requestBody.response_format = {
      type: 'json_schema',
      json_schema: {
        name: input.jsonSchema.name,
        strict: true,
        schema: input.jsonSchema.schema
      }
    };
    if (provider === 'openrouter') {
      requestBody.provider = {
        require_parameters: true
      };
    }
  }

  const response = await fetch(getEndpoint(provider), {
    method: 'POST',
    headers: getHeaders(provider, apiKey),
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${provider === 'openai' ? 'OpenAI' : 'OpenRouter'} error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const choice = data?.choices?.[0];
  const finishReason = choice?.finish_reason;
  if (finishReason === 'length') {
    throw new Error(
      `${provider === 'openai' ? 'OpenAI' : 'OpenRouter'} response was truncated before the agent could finish valid JSON. Increase LLM_MAX_TOKENS or use a model with a larger output limit.`
    );
  }

  const content = choice?.message?.content;
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const text = content.map((part) => part?.text).filter(Boolean).join('\n');
    if (text) return text;
  }

  throw new Error('OpenRouter response did not include content');
}
