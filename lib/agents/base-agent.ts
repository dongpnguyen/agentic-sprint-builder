import { loadSkill } from '@/lib/skills/loadSkill';
import { callOpenRouter } from '@/lib/openrouter';
import type { AgentId, RequirementImage } from '@/lib/types';

function isTruncationError(error: unknown) {
  return error instanceof Error && /response was truncated|finish_reason.*length|max_tokens/i.test(error.message);
}

export async function runMarkdownSkillAgent(params: {
  agentId: AgentId;
  userPrompt: string;
  images?: RequirementImage[];
  fallbackModel?: string;
  fallbackTemperature?: number;
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
  };
  maxTokens?: number;
}) {
  const skill = await loadSkill(params.agentId);
  const provider = process.env.LLM_PROVIDER?.trim().toLowerCase();
  const providerModel =
    provider === 'openai' || provider === 'codex'
      ? process.env.OPENAI_MODEL
      : provider === 'openrouter'
        ? process.env.OPENROUTER_MODEL
        : undefined;
  const model = providerModel || process.env.LLM_MODEL || process.env.OPENROUTER_MODEL || process.env.OPENAI_MODEL || skill.meta.model || params.fallbackModel;

  try {
    return await callOpenRouter({
      system: skill.body,
      user: params.userPrompt,
      images: params.images,
      model,
      temperature: skill.meta.temperature ?? params.fallbackTemperature,
      jsonSchema: params.jsonSchema,
      maxTokens: params.maxTokens
    });
  } catch (error) {
    if (!isTruncationError(error) || params.jsonSchema) throw error;

    return await callOpenRouter({
      system: skill.body,
      user: `${params.userPrompt}

Your previous response was too long and was truncated by the model provider.
Retry with a concise version that preserves only decision-critical requirements, constraints, risks, and acceptance criteria.
Do not include exhaustive prose, repeated sections, or implementation code.`,
      images: params.images,
      model,
      temperature: skill.meta.temperature ?? params.fallbackTemperature,
      maxTokens: Math.min(params.maxTokens ?? 8_000, 6_000)
    });
  }
}
