import { z } from 'zod';
import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedCodeContext, formatRunHistoryContext } from '@/lib/context/agent-context';
import { formatProductAssetInstruction, formatProductAssetSummary } from '@/lib/context/product-assets';
import { formatRequirementImageSummary, formatVisualContractInstruction } from '@/lib/context/visual-requirements';
import { RUN_LIMITS } from '@/lib/config/limits';
import { extractJsonObject } from '@/lib/utils/json';
import type { DevOutput, GeneratedFile, ProductAssetMetadata, RequirementImage, RunResult } from '@/lib/types';

const GeneratedFileSchema = z.object({
  path: z.string().min(1).max(240),
  content: z.string()
});

const GeneratedFileBatchSchema = z.object({
  files: z.array(GeneratedFileSchema).min(1).max(RUN_LIMITS.generatedFiles)
});

const DevManifestFileSchema = z.object({
  path: z.string().min(1).max(240),
  purpose: z.string().max(2_000)
});

const DevManifestSchema = z.object({
  architecture: z.string().max(20_000),
  files: z.array(DevManifestFileSchema).min(1).max(RUN_LIMITS.generatedFiles),
  setupInstructions: z.string().max(20_000)
});

const DevOutputSchema = z
  .object({
    architecture: z.string().max(20_000),
    files: z.array(GeneratedFileSchema).max(RUN_LIMITS.generatedFiles),
    setupInstructions: z.string().max(20_000)
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
          message: `Generated file exceeds ${RUN_LIMITS.generatedFileBytes} bytes.`
        });
      }
    });

    if (totalBytes > RUN_LIMITS.generatedTotalBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files'],
        message: `Generated output exceeds ${RUN_LIMITS.generatedTotalBytes} total bytes.`
      });
    }
  });

const DevManifestJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['architecture', 'files', 'setupInstructions'],
  properties: {
    architecture: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'purpose'],
        properties: {
          path: { type: 'string' },
          purpose: { type: 'string' }
        }
      }
    },
    setupInstructions: { type: 'string' }
  }
};

const GeneratedFileBatchJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['files'],
  properties: {
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
    }
  }
};

type DevManifest = z.infer<typeof DevManifestSchema>;

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function isTruncationError(error: unknown) {
  return error instanceof Error && /truncated|finish_reason.*length|max_tokens|incomplete json|started a json object but did not finish/i.test(error.message);
}

function getDevFileBatchSize() {
  const parsed = Number.parseInt(process.env.DEV_FILE_BATCH_SIZE || process.env.GENERATED_FILE_BATCH_SIZE || '3', 10);
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(4, Math.max(1, parsed));
}

function normalizeGeneratedPath(filePath: string) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function orderedUniqueFiles(files: GeneratedFile[]) {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = normalizeGeneratedPath(file.path);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function orderedUniqueManifestFiles(files: DevManifest['files']) {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = normalizeGeneratedPath(file.path);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findExistingFile(files: GeneratedFile[] | undefined, targetPath: string) {
  return files?.find((file) => normalizeGeneratedPath(file.path) === normalizeGeneratedPath(targetPath));
}

function summarizePreviousDevOutput(output?: DevOutput) {
  if (!output) return 'No previous DEV output.';

  return JSON.stringify(
    {
      architecture: truncate(output.architecture, 2_500),
      setupInstructions: truncate(output.setupInstructions, 2_500),
      files: output.files.map((file) => ({
        path: file.path,
        bytes: Buffer.byteLength(file.content, 'utf8')
      }))
    },
    null,
    2
  );
}

function buildDevContract(input: {
  requirements: string;
  techSpec: string;
  baOutput: string;
  existingCode: string;
  previousDevOutput: string;
  runHistoryContext: string;
  qaFeedback: string;
  imageSummary: string;
  visualContractInstruction: string;
  productAssetInstruction: string;
  productAssetSummary: string;
  apiSpec?: string;
}) {
  return `
PROJECT CONTRACT:
- Generate the Phase 1 implementation for the final generated-code workspace.
- If existing generated code is provided, update that existing project instead of creating a brand-new unrelated layout.
- The generated code must be runnable locally after files are written.
- Include all required manifests, dependency files, scripts, seed data, and app configuration needed to run/build the app.
- Implement the full Phase 1 acceptance criteria from BA OUTPUT. Do not leave placeholder comments, TODOs, mock-only sections, or single-card examples where the requirement asks for a working page/flow.
- Treat BA OUTPUT as the implementation contract. Requirement images were analyzed by BA; code the pages/screens from that contract while preserving image order, route mapping, visible copy, visual hierarchy, color palette, spacing density, and major component states.
- Do not replace an image-derived UI with a generic template. The generated app must be recognizably similar to the supplied page artifact.
- For a Next.js frontend, include package.json, next config if needed, Tailwind/PostCSS config when Tailwind is used, and scripts for dev/build/start.
- For a FastAPI backend, include requirements.txt, CORS config for the frontend port, app entrypoint, and seed data when the UI needs data.
- Python requirements.txt must include only pip-installable third-party packages. Do not include Python standard-library modules such as sqlite3, json, os, typing, pathlib, datetime, logging, or unittest.
- Avoid fragile Python dependency pins. For FastAPI/SQLModel apps, prefer unpinned fastapi, uvicorn, sqlmodel, and pydantic. Do not pin SQLAlchemy separately unless it is compatible with the selected SQLModel version. Never combine sqlmodel==0.0.8 with SQLAlchemy 2.x or Pydantic 2.x.
- FastAPI apps must add CORSMiddleware before routes and allow these local frontend origins at minimum: http://localhost:3000, http://127.0.0.1:3000, http://localhost:3001, and http://127.0.0.1:3001.
- For frontend/backend integration, keep local API URLs configurable through environment variables.
- Product list pages must load and render a collection of products from the API, including image/name/price when required.
- Product detail pages must load by route id, show all required product fields, handle missing products, and wire Add to Cart to the cart API.
- Backend endpoints must return clear 404 errors for missing products and cart requests for unknown products.
- Keep frontend and backend API contracts identical.
- Do not generate .jpg, .png, .webp, or other raster image files as text placeholders. Use valid .svg assets with file content that starts with <svg, CSS/inline visuals, external demo URLs, or data URLs used directly in code/data.
- When product image assets are provided, use the supplied product asset publicPath values directly for product imageUrl/image fields in seed data and frontend UI.
- Seed scripts must use the exact same database engine/URL/path as the backend application.
- Standalone seed scripts must initialize database tables before deleting or inserting rows. For SQLModel/SQLite, call SQLModel.metadata.create_all(engine) or the app's table-init helper before opening the seed session.
- SQLModel table columns cannot use bare List/dict annotations without SQLAlchemy JSON columns or explicit serialization. Use sa_column=Column(JSON) or JSON text helpers.
- SQLAlchemy JSON columns must persist JSON-native values only. Do not assign SQLModel/Pydantic objects such as Specification(...) or CraftsmanshipFeature(...) directly into JSON columns; use plain dict/list[dict] fields or serialize with .dict()/model_dump() before saving.
- Before handing off, self-check that npm install/build, Python dependency install, backend import, seed data, API route contracts, CORS, image paths, and setup commands are internally consistent. Standard Guard Mode will execute these checks and send failures back to DEV.
- Leave Docker Compose, Dockerfiles, .dockerignore files, and container run instructions to the Deployment Agent.
- If setup depends on seed data, explain exactly how and when to run the seed command.
- If QA feedback is provided, preserve the existing project shape and return corrected files that address every blocking issue.
- If QA OR BUILD FEEDBACK TO FIX includes a STRUCTURED BLOCKER HANDOFF assigned to DEV, treat its requiredFix, suspectedFiles, evidence, and verifyWith steps as the repair contract.

REQUIREMENTS:
${truncate(input.requirements, 10_000)}

REQUIREMENT IMAGES:
${truncate(input.imageSummary, 3_000)}

VISUAL CONTRACT POLICY:
${truncate(input.visualContractInstruction, 6_000)}

PRODUCT ASSET POLICY:
${truncate(input.productAssetInstruction, 4_000)}

PRODUCT IMAGE ASSETS:
${truncate(input.productAssetSummary, 8_000)}

TECH SPEC:
${truncate(input.techSpec, 8_000)}

BA OUTPUT:
${truncate(input.baOutput, 24_000)}

EXISTING GENERATED CODE:
${input.existingCode}

PREVIOUS DEV OUTPUT:
${input.previousDevOutput}

RECENT RUN HISTORY:
${input.runHistoryContext}

QA OR BUILD FEEDBACK TO FIX:
${truncate(input.qaFeedback, 10_000)}

DASHBOARD API SPEC:
${truncate(input.apiSpec || 'Not provided', 6_000)}
`;
}

async function requestDevManifest(params: {
  contract: string;
}) {
  const raw = await runMarkdownSkillAgent({
    agentId: 'dev',
    fallbackTemperature: 0.1,
    maxTokens: 6_000,
    jsonSchema: {
      name: 'dev_manifest',
      schema: DevManifestJsonSchema
    },
    userPrompt: `
Plan the implementation. Return JSON only.

Return a compact manifest only: architecture, setupInstructions, and files with path + purpose.
Do not include file content in this response.
Keep setupInstructions complete but concise.
Keep the file list minimal but complete enough for the project to build, run, test, and pass validation.
If this is a scoped repair, list only files that need to be created or overwritten for the repair.

${params.contract}
`
  });

  const manifest = DevManifestSchema.parse(extractJsonObject(raw));
  return {
    ...manifest,
    files: orderedUniqueManifestFiles(manifest.files)
  };
}

function formatTargetExistingFiles(targets: DevManifest['files'], existingFiles?: GeneratedFile[]) {
  return targets
    .map((target) => {
      const existing = findExistingFile(existingFiles, target.path);
      return [
        `## ${target.path}`,
        `Purpose: ${target.purpose}`,
        existing ? `Existing content:\n\`\`\`\n${truncate(existing.content, 6_000)}\n\`\`\`` : 'Existing content: file does not exist yet.'
      ].join('\n');
    })
    .join('\n\n');
}

async function requestFileBatch(params: {
  contract: string;
  manifest: DevManifest;
  targets: DevManifest['files'];
  existingFiles?: GeneratedFile[];
}) {
  const raw = await runMarkdownSkillAgent({
    agentId: 'dev',
    fallbackTemperature: 0.1,
    maxTokens: params.targets.length === 1 ? 16_000 : 12_000,
    jsonSchema: {
      name: 'generated_file_batch',
      schema: GeneratedFileBatchJsonSchema
    },
    userPrompt: `
Generate complete file contents for the target files only. Return JSON only.

Return exactly this shape:
{"files":[{"path":"target/path","content":"complete file content"}]}

Rules:
- Return complete contents for each target file.
- Do not return file content for paths outside TARGET FILES.
- Do not summarize file content.
- Keep comments sparse and useful.
- Preserve existing project shape.

PROJECT MANIFEST:
${JSON.stringify(
  {
    architecture: truncate(params.manifest.architecture, 4_000),
    setupInstructions: truncate(params.manifest.setupInstructions, 4_000),
    files: params.manifest.files
  },
  null,
  2
)}

TARGET FILES:
${params.targets.map((target) => `- ${target.path}: ${target.purpose}`).join('\n')}

TARGET EXISTING FILE CONTEXT:
${formatTargetExistingFiles(params.targets, params.existingFiles)}

${params.contract}
`
  });

  return GeneratedFileBatchSchema.parse(extractJsonObject(raw)).files;
}

async function requestFiles(params: {
  contract: string;
  manifest: DevManifest;
  existingFiles?: GeneratedFile[];
}) {
  const files: GeneratedFile[] = [];
  const batchSize = getDevFileBatchSize();

  for (let index = 0; index < params.manifest.files.length; index += batchSize) {
    const targets = params.manifest.files.slice(index, index + batchSize);

    try {
      files.push(
        ...(await requestFileBatch({
          contract: params.contract,
          manifest: params.manifest,
          targets,
          existingFiles: params.existingFiles
        }))
      );
    } catch (error) {
      if (!isTruncationError(error) || targets.length === 1) throw error;

      for (const target of targets) {
        files.push(
          ...(await requestFileBatch({
            contract: params.contract,
            manifest: params.manifest,
            targets: [target],
            existingFiles: params.existingFiles
          }))
        );
      }
    }
  }

  const byPath = new Map(orderedUniqueFiles(files).map((file) => [normalizeGeneratedPath(file.path), file]));
  const ordered = params.manifest.files.map((file) => byPath.get(normalizeGeneratedPath(file.path))).filter(Boolean) as GeneratedFile[];
  const missing = params.manifest.files.filter((file) => !byPath.has(normalizeGeneratedPath(file.path)));

  for (const target of missing) {
    const single = await requestFileBatch({
      contract: params.contract,
      manifest: params.manifest,
      targets: [target],
      existingFiles: params.existingFiles
    });
    ordered.push(...single);
  }

  return orderedUniqueFiles(ordered);
}

export async function runDevAgent(input: {
  requirements: string;
  techSpec?: string | null;
  baOutput: string;
  existingFiles?: Array<{ path: string; content: string }>;
  requirementImages?: RequirementImage[];
  productAssets?: ProductAssetMetadata[];
  recentRuns?: RunResult[];
  previousDevOutput?: DevOutput;
  qaFeedback?: string;
  apiSpec?: string;
}): Promise<DevOutput> {
  const techSpec = input.techSpec?.trim() || 'Not provided';
  const existingCode = formatGeneratedCodeContext(input.existingFiles ?? []);
  const runHistoryContext = formatRunHistoryContext(input.recentRuns ?? []);
  const previousDevOutput = summarizePreviousDevOutput(input.previousDevOutput);
  const qaFeedback = input.qaFeedback?.trim() || 'No QA feedback yet.';
  const requirementImages = input.requirementImages ?? [];
  const imageSummary = formatRequirementImageSummary(requirementImages);
  const visualContractInstruction = formatVisualContractInstruction(requirementImages);
  const productAssets = input.productAssets ?? [];
  const productAssetSummary = formatProductAssetSummary(productAssets);
  const productAssetInstruction = formatProductAssetInstruction(productAssets);
  const contract = buildDevContract({
    requirements: input.requirements,
    techSpec,
    baOutput: input.baOutput,
    existingCode,
    previousDevOutput,
    runHistoryContext,
    qaFeedback,
    imageSummary,
    visualContractInstruction,
    productAssetInstruction,
    productAssetSummary,
    apiSpec: input.apiSpec
  });

  try {
    const manifest = await requestDevManifest({ contract });
    const files = await requestFiles({
      contract,
      manifest,
      existingFiles: input.existingFiles
    });

    return DevOutputSchema.parse({
      architecture: manifest.architecture,
      files,
      setupInstructions: manifest.setupInstructions
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dev-agent] Structured generation failed: ${message}`);
    throw new Error(`DEV agent returned invalid structured output: ${message}`);
  }
}
