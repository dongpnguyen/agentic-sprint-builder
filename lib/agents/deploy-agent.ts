import { z } from 'zod';
import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedCodeContext, formatRunHistoryContext } from '@/lib/context/agent-context';
import { formatProductAssetInstruction, formatProductAssetSummary } from '@/lib/context/product-assets';
import { RUN_LIMITS } from '@/lib/config/limits';
import { extractJsonObject } from '@/lib/utils/json';
import type { DeploymentOutput, DevOutput, GeneratedFile, ProductAssetMetadata, QAReviewOutput, RunResult } from '@/lib/types';

const DeploymentFileSchema = z.object({
  path: z.string().min(1).max(240),
  content: z.string()
});

const DeploymentOutputSchema = z
  .object({
    summary: z.string().max(20_000),
    files: z.array(DeploymentFileSchema).max(RUN_LIMITS.generatedFiles),
    instructions: z.string().max(20_000)
  })
  .superRefine((output, context) => {
    let totalBytes = 0;

    output.files.forEach((file, index) => {
      const fileBytes = Buffer.byteLength(file.content, 'utf8');
      totalBytes += fileBytes;

      if (fileBytes > RUN_LIMITS.generatedFileBytes) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'content'],
          message: `Generated deployment file exceeds ${RUN_LIMITS.generatedFileBytes} bytes.`
        });
      }
    });

    if (totalBytes > RUN_LIMITS.generatedTotalBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files'],
        message: `Deployment output exceeds ${RUN_LIMITS.generatedTotalBytes} total bytes.`
      });
    }
  });

const DeploymentOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'files', 'instructions'],
  properties: {
    summary: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        }
      }
    },
    instructions: { type: 'string' }
  }
};

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function summarizeDevOutput(devOutput: DevOutput) {
  return JSON.stringify(
    {
      architecture: truncate(devOutput.architecture, 3_000),
      setupInstructions: truncate(devOutput.setupInstructions, 4_000),
      files: devOutput.files.map((file) => ({
        path: file.path,
        bytes: Buffer.byteLength(file.content, 'utf8')
      }))
    },
    null,
    2
  );
}

function summarizeDeploymentOutput(output?: DeploymentOutput) {
  if (!output) return 'No previous deployment output.';

  return JSON.stringify(
    {
      summary: truncate(output.summary, 2_000),
      instructions: truncate(output.instructions, 4_000),
      files: output.files.map((file) => ({
        path: file.path,
        bytes: Buffer.byteLength(file.content, 'utf8')
      }))
    },
    null,
    2
  );
}

function summarizeQaReview(qaReview?: QAReviewOutput) {
  if (!qaReview) return 'No QA review provided yet.';

  return JSON.stringify(
    {
      status: qaReview.status,
      findings: qaReview.findings,
      fixInstructions: truncate(qaReview.fixInstructions, 4_000),
      report: truncate(qaReview.report, 4_000)
    },
    null,
    2
  );
}

export async function runDeployAgent(input: {
  requirements: string;
  techSpec?: string | null;
  baOutput: string;
  devOutput: DevOutput;
  qaReview?: QAReviewOutput;
  existingFiles?: GeneratedFile[];
  productAssets?: ProductAssetMetadata[];
  recentRuns?: RunResult[];
  previousDeploymentOutput?: DeploymentOutput;
  qaFeedback?: string;
}): Promise<DeploymentOutput> {
  const techSpec = input.techSpec?.trim() || 'Not provided';
  const existingCode = formatGeneratedCodeContext(input.existingFiles ?? []);
  const runHistoryContext = formatRunHistoryContext(input.recentRuns ?? []);
  const previousDeploymentOutput = summarizeDeploymentOutput(input.previousDeploymentOutput);
  const qaReview = summarizeQaReview(input.qaReview);
  const qaFeedback = input.qaFeedback?.trim() || 'No post-deployment QA feedback yet.';
  const productAssets = input.productAssets ?? [];
  const productAssetSummary = formatProductAssetSummary(productAssets);
  const productAssetInstruction = formatProductAssetInstruction(productAssets);

  const raw = await runMarkdownSkillAgent({
    agentId: 'deploy',
    fallbackTemperature: 0.1,
    maxTokens: 16_000,
    jsonSchema: {
      name: 'deployment_output',
      schema: DeploymentOutputJsonSchema
    },
    userPrompt: `
Package the Phase 1 generated application for local container deployment. Return JSON only.

Return only deployment files that should be created or overwritten in the fixed generated-code workspace.
Target Rancher Desktop as the primary local container runtime.
Prefer a Docker Compose-compatible compose.yaml or docker-compose.yml as the local container entry point.
The Compose file must work with Rancher Desktop Docker-compatible mode via docker compose and Rancher Desktop containerd mode via nerdctl compose.
Avoid Docker Desktop-only features, cloud registry dependencies, absolute host paths, and host.docker.internal unless the generated app truly requires it.
Use service DNS names such as backend for container-to-container traffic, and localhost only for browser-facing instructions.
For browser-executed frontend variables such as NEXT_PUBLIC_API_BASE_URL, use localhost with the published backend port, not the backend service DNS name.
Make app servers bind to 0.0.0.0 inside containers.
Include Dockerfiles, .dockerignore files, compose config, env examples, health checks for every long-running service, and exact local run commands as needed.
Deployment must be clean and repeatable: before building or starting, instructions must clear any existing generated stack containers, networks, and stale volumes with docker compose down --remove-orphans --volumes and nerdctl compose down --remove-orphans --volumes.
Prefer runtime-native healthchecks that do not require package-manager installs: use node -e with the http module for Node services and python -c with urllib.request for Python services. Avoid curl/wget healthchecks unless the base image already includes the tool.
For Next.js production containers that run npm start / next start, run npm run build during the image build before CMD. Use a current Node LTS base image such as node:20-bookworm-slim or node:20-alpine.
Do not create a separate Compose database service for SQLite apps. SQLite is an app-owned file; never bind mount ./backend/database.db or another missing *.db/*.sqlite host path.
Backend Docker build contexts must ignore runtime database/cache artifacts such as *.db, *.sqlite, *.sqlite3, __pycache__, .pytest_cache, and .venv.
Do not bind mount ./frontend:/app or ./backend:/app in runtime Compose services. Those mounts hide image-built node_modules, .next, and copied app files. Use named volumes only for runtime data that must persist.
If a healthcheck targets /health, verify the generated service implements /health. For a stock Next.js frontend without a health page/API route, healthcheck / instead.
If post-deployment feedback cites a Dockerfile, Compose file, mount, healthcheck, port, or build-context failure, return the affected file with full corrected content.
Instructions must include both command sets:
- docker compose down --remove-orphans --volumes before deploy
- docker compose build / up -d / ps / logs / down
- nerdctl compose down --remove-orphans --volumes before deploy
- nerdctl compose build / up -d / ps / logs / down
Instructions must include health check URLs, app URLs, expected ports, and smoke-test commands for Rancher Desktop.
If seed scripts or seed data exist, deployment instructions and README must explain exactly how to create initial data, including host and container commands where applicable.
If product image assets are provided under frontend/public/images/products, make sure Docker build context, .dockerignore, and Dockerfile copy rules include frontend public assets in the final image.
Do not rewrite application source files unless a small deployment config file is required.
If QA feedback is provided, preserve the existing project layout and return corrected deployment files that address every blocking issue.
If POST-DEPLOYMENT QA FEEDBACK TO FIX includes a STRUCTURED BLOCKER HANDOFF assigned to DEPLOY, treat its requiredFix, suspectedFiles, evidence, and verifyWith steps as the deployment repair contract. Fix Compose, Dockerfiles, .dockerignore files, ports, health checks, runtime volumes, and deployment instructions as needed.
If POST-DEPLOYMENT QA FEEDBACK TO FIX says DEV changed application files, refresh deployment artifacts and rebuild/run instructions so the fixed app is redeployed before QA verifies it.
If POST-DEPLOYMENT QA FEEDBACK TO FIX includes a Repair scope, treat it as a scoped deployment repair. Prefer editing the candidate files listed in the scope, stay inside allowed directories, avoid unrelated rewrites, and return the smallest complete set of deployment files needed to fix the blocker.

REQUIREMENTS:
${truncate(input.requirements, 8_000)}

TECH SPEC:
${truncate(techSpec, 4_000)}

BA OUTPUT:
${truncate(input.baOutput, 8_000)}

PRODUCT ASSET POLICY:
${productAssetInstruction}

PRODUCT IMAGE ASSETS:
${productAssetSummary}

DEV OUTPUT SUMMARY:
${summarizeDevOutput(input.devOutput)}

PRE-DEPLOY QA REVIEW:
${qaReview}

EXISTING GENERATED CODE:
${existingCode}

PREVIOUS DEPLOYMENT OUTPUT:
${previousDeploymentOutput}

RECENT RUN HISTORY:
${runHistoryContext}

POST-DEPLOYMENT QA FEEDBACK TO FIX:
${qaFeedback}
`
  });

  try {
    return DeploymentOutputSchema.parse(extractJsonObject(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[deploy-agent] Could not parse structured output: ${message}. Raw prefix: ${raw.slice(0, 500)}`);
    throw new Error(`DEPLOY agent returned invalid structured output: ${message}`);
  }
}
