import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedCodeContext, formatRunHistoryContext } from '@/lib/context/agent-context';
import { formatProductAssetInstruction, formatProductAssetSummary } from '@/lib/context/product-assets';
import { formatRequirementImageSummary, formatVisualContractInstruction } from '@/lib/context/visual-requirements';
import { extractJsonObject } from '@/lib/utils/json';
import { z } from 'zod';
import type { DeploymentOutput, DevOutput, GeneratedExecutionValidationResult, GeneratedFile, ProductAssetMetadata, QAReviewOutput, RequirementImage, RunResult } from '@/lib/types';

const QAReviewOutputSchema = z.object({
  status: z.enum(['PASS', 'NEEDS_FIX']),
  findings: z.array(z.string().max(500)).max(12),
  fixInstructions: z.string().max(3_000),
  report: z.string().max(6_000)
});

const QAReviewJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'findings', 'fixInstructions', 'report'],
  properties: {
    status: {
      type: 'string',
      enum: ['PASS', 'NEEDS_FIX']
    },
    findings: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string', maxLength: 500 }
    },
    fixInstructions: { type: 'string', maxLength: 3000 },
    report: { type: 'string', maxLength: 6000 }
  }
};

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function summarizeDevOutput(output: DevOutput) {
  return JSON.stringify(
    {
      architecture: truncate(output.architecture, 3_000),
      setupInstructions: truncate(output.setupInstructions, 3_000),
      files: output.files.map((file) => ({
        path: file.path,
        bytes: Buffer.byteLength(file.content, 'utf8')
      }))
    },
    null,
    2
  );
}

export async function runQAAgent(input: {
  requirements: string;
  techSpec?: string | null;
  baOutput: string;
  devOutput: DevOutput;
  deploymentOutput?: DeploymentOutput;
  executionValidation?: GeneratedExecutionValidationResult;
  reviewStage?: 'code_review' | 'post_deploy';
  existingFiles?: GeneratedFile[];
  requirementImages?: RequirementImage[];
  productAssets?: ProductAssetMetadata[];
  recentRuns?: RunResult[];
}): Promise<QAReviewOutput> {
  const techSpec = input.techSpec?.trim() || 'Not provided';
  const existingCodeContext = formatGeneratedCodeContext(input.existingFiles ?? []);
  const runHistoryContext = formatRunHistoryContext(input.recentRuns ?? []);
  const reviewStage = input.reviewStage ?? 'code_review';
  const deploymentOutput = input.deploymentOutput
    ? JSON.stringify(input.deploymentOutput, null, 2)
    : 'No deployment output provided.';
  const executionValidation = input.executionValidation
    ? JSON.stringify(input.executionValidation, null, 2)
    : 'No container deployment execution evidence provided.';
  const requirementImages = input.requirementImages ?? [];
  const imageSummary = formatRequirementImageSummary(requirementImages);
  const visualContractInstruction = formatVisualContractInstruction(requirementImages);
  const productAssets = input.productAssets ?? [];
  const productAssetSummary = formatProductAssetSummary(productAssets);
  const productAssetInstruction = formatProductAssetInstruction(productAssets);
  const stageInstructions =
    reviewStage === 'post_deploy'
      ? `This is a post-deployment E2E readiness review. Focus on the running local container deployment evidence first, then review whether the final generated-code workspace has enough Docker/local-container artifacts for Rancher Desktop. Review Docker Compose compatibility, nerdctl compose compatibility, Dockerfiles, ports, environment variables, health checks, API integration, seeded data, browser flows, visual fidelity to the BA image contract, and negative/error scenarios. If status is NEEDS_FIX, address fixInstructions to the DEPLOY agent unless the blocker is clearly application code. Do not claim tests were executed unless explicit execution evidence is present.`
      : `This is a code review of the final generated-code workspace before deployment. Focus on requirements fit, BA visual contract fidelity, generated code completeness, setup/build readiness, likely runtime blockers, integration correctness, maintainability, and whether DEV must fix anything before deployment. Do not block code review on Docker Compose, Dockerfiles, container service healthchecks, Rancher Desktop commands, or deployment packaging because those belong to the DEPLOY/post-deploy phase. If status is NEEDS_FIX, address fixInstructions to the DEV agent.`;

  const raw = await runMarkdownSkillAgent({
    agentId: 'qa',
    images: requirementImages.length ? requirementImages : undefined,
    maxTokens: 12_000,
    jsonSchema: {
      name: 'qa_review_output',
      schema: QAReviewJsonSchema
    },
    userPrompt: `
Validate the Phase 1 delivery and produce QA artifacts.

Return JSON only.
Keep report concise: maximum 6 short sections, no exhaustive test matrix unless needed to explain a blocker.
Keep findings to the top blocking issues only.

QA REVIEW STAGE:
${reviewStage}

STAGE-SPECIFIC INSTRUCTIONS:
${stageInstructions}

Use status "NEEDS_FIX" if generated files are not locally runnable/buildable, missing dependency manifests,
missing setup commands, likely fail at runtime, fail to satisfy acceptance criteria, or have blocking integration bugs.
Use status "PASS" only if the generated delivery appears complete, runnable, and aligned to scope.

When requirement images are attached, test against BA OUTPUT as the visual implementation contract and use the images as supporting evidence.
Do not accept a generic UI if BA describes an image-derived page/screen. Mark NEEDS_FIX when a page omits major image-visible sections,
route mappings, content hierarchy, layout identity, colors, spacing density, or primary states from the BA visual contract.

Treat CURRENT GENERATED CODE SNAPSHOT as the source of truth for the final merged project.
DEV OUTPUT and DEPLOYMENT OUTPUT may contain only the files changed in the latest agent turn.
Do not report a file as missing if it exists in CURRENT GENERATED CODE SNAPSHOT.

For code review/setup/build readiness, inspect whether the final generated-code workspace includes the files needed to run the generated app:
- Frontend projects need package.json and runnable scripts.
- Tailwind projects need Tailwind/PostCSS config.
- FastAPI projects need requirements.txt and an app entrypoint.
- Frontend/backend integration needs matching API URLs and CORS where applicable.
- If the frontend calls a separate backend from the browser, verify backend CORS allows http://localhost:3000, http://127.0.0.1:3000, http://localhost:3001, and http://127.0.0.1:3001, or an intentionally broader safe local origin policy.
- During code review, ignore Docker Compose files, Dockerfiles, container service healthchecks, Rancher Desktop packaging, and deployment run commands unless they directly reveal a DEV-owned application bug.
- When product image assets are provided, verify product seed data/UI uses supplied publicPath values where product imagery is required and does not invent missing raster asset files.
- If generated code references /images/products/*, verify the product asset manifest exists in CURRENT GENERATED CODE SNAPSHOT and the referenced paths match supplied product assets.

For post-deployment readiness, inspect whether the final generated-code workspace includes Docker Compose-compatible files, Dockerfiles,
.dockerignore files, environment variables, service ports, health checks, logs, shutdown commands, E2E smoke-test commands,
and Rancher Desktop command variants for both docker compose and nerdctl compose.
For post-deployment readiness, use DEPLOYMENT EXECUTION EVIDENCE to decide what actually ran. If container deployment did not PASS, status must be NEEDS_FIX.
When deployment screenshot steps are present in DEPLOYMENT EXECUTION EVIDENCE, use those screenshot paths/results as visual QA evidence. Treat missing screenshot capture as non-blocking if the container deployment otherwise passed.

If status is "NEEDS_FIX", provide concise fixInstructions addressed to the stage owner:
- DEV for code review implementation blockers.
- DEPLOY for post-deployment container/local-run blockers.

REQUIREMENTS:
${truncate(input.requirements, 8_000)}

REQUIREMENT IMAGES:
${imageSummary}

VISUAL CONTRACT POLICY:
${truncate(visualContractInstruction, 4_000)}

PRODUCT ASSET POLICY:
${productAssetInstruction}

PRODUCT IMAGE ASSETS:
${truncate(productAssetSummary, 6_000)}

TECH SPEC:
${truncate(techSpec, 6_000)}

BA OUTPUT:
${truncate(input.baOutput, 16_000)}

DEV OUTPUT:
${summarizeDevOutput(input.devOutput)}

DEPLOYMENT OUTPUT:
${truncate(deploymentOutput, 8_000)}

DEPLOYMENT EXECUTION EVIDENCE:
${truncate(executionValidation, 8_000)}

CURRENT GENERATED CODE SNAPSHOT:
${existingCodeContext}

RECENT RUN HISTORY:
${runHistoryContext}
`
  });

  try {
    return QAReviewOutputSchema.parse(extractJsonObject(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[qa-agent] Could not parse structured output: ${message}. Raw prefix: ${raw.slice(0, 500)}`);
    throw new Error(`QA agent returned invalid structured output: ${message}`);
  }
}
