import { z } from 'zod';
import { runMarkdownSkillAgent } from './base-agent';
import { formatRunHistoryContext } from '@/lib/context/agent-context';
import { formatRequirementImageSummary, formatVisualContractInstruction } from '@/lib/context/visual-requirements';
import { extractJsonObject } from '@/lib/utils/json';
import type { AssetAgentOutput, RequirementImage, RunResult } from '@/lib/types';

const AssetSearchQuerySchema = z.object({
  label: z.string().min(1).max(80),
  searchTerm: z.string().min(2).max(120),
  role: z.enum(['hero', 'product', 'detail', 'background']),
  count: z.number().int().min(1).transform((count) => Math.min(count, 4)),
  aspectRatio: z.enum(['tall', 'wide', 'square', 'any'])
});

const AssetAgentOutputSchema = z.object({
  summary: z.string().max(4_000),
  queries: z.array(AssetSearchQuerySchema).max(8),
  notes: z.string().max(4_000)
});

const AssetAgentOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'queries', 'notes'],
  properties: {
    summary: { type: 'string' },
    queries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'searchTerm', 'role', 'count', 'aspectRatio'],
        properties: {
          label: { type: 'string' },
          searchTerm: { type: 'string' },
          role: { type: 'string', enum: ['hero', 'product', 'detail', 'background'] },
          count: { type: 'number' },
          aspectRatio: { type: 'string', enum: ['tall', 'wide', 'square', 'any'] }
        }
      }
    },
    notes: { type: 'string' }
  }
};

export async function runAssetAgent(input: {
  requirements: string;
  techSpec?: string | null;
  baOutput: string;
  requirementImages?: RequirementImage[];
  recentRuns?: RunResult[];
}): Promise<AssetAgentOutput> {
  const techSpec = input.techSpec?.trim() || 'Not provided';
  const requirementImages = input.requirementImages ?? [];
  const imageSummary = formatRequirementImageSummary(requirementImages);
  const visualContractInstruction = formatVisualContractInstruction(requirementImages);
  const runHistoryContext = formatRunHistoryContext(input.recentRuns ?? []);

  const raw = await runMarkdownSkillAgent({
    agentId: 'asset',
    images: requirementImages.length ? requirementImages : undefined,
    fallbackTemperature: 0.1,
    maxTokens: 4_000,
    jsonSchema: {
      name: 'asset_agent_output',
      schema: AssetAgentOutputJsonSchema
    },
    userPrompt: `
Infer product/content image search needs for this run. Return JSON only.

The user did not provide a product asset folder and enabled automatic asset download.
Analyze the requirements, BA visual contract, and attached requirement/mockup images.
Create short search queries suitable for openly licensed image search.
Prefer generic descriptive searches and avoid exact trademark/brand/logo requests.

REQUIREMENTS:
${input.requirements}

REQUIREMENT IMAGES:
${imageSummary}

VISUAL CONTRACT POLICY:
${visualContractInstruction}

TECH SPEC:
${techSpec}

BA OUTPUT:
${input.baOutput}

RECENT RUN HISTORY:
${runHistoryContext}
`
  });

  try {
    return AssetAgentOutputSchema.parse(extractJsonObject(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[asset-agent] Could not parse structured output: ${message}. Raw prefix: ${raw.slice(0, 500)}`);
    throw new Error(`ASSET agent returned invalid structured output: ${message}`);
  }
}
