import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { RUN_LIMITS } from '@/lib/config/limits';
import { runSprintBuilder } from '@/lib/orchestrator';
import { ApiGuardError, assertRunApiAccess } from '@/lib/security/api-guard';

export const runtime = 'nodejs';
export const maxDuration = 900;

const SupportedImageMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp']);

const RequirementImageSchema = z
  .object({
    name: z.string().min(1).max(180),
    mimeType: SupportedImageMimeSchema,
    sizeBytes: z.number().int().positive().max(RUN_LIMITS.requirementImageBytes),
    dataUrl: z.string().max(Math.ceil((RUN_LIMITS.requirementImageBytes * 4) / 3) + 80)
  })
  .superRefine((image, context) => {
    if (!image.dataUrl.startsWith(`data:${image.mimeType};base64,`)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dataUrl'],
        message: 'Requirement image must be a matching base64 data URL.'
      });
    }

    const base64 = image.dataUrl.split(',')[1] || '';
    const estimatedBytes = Math.floor((base64.length * 3) / 4);
    if (estimatedBytes > RUN_LIMITS.requirementImageBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dataUrl'],
        message: `Requirement image must be ${RUN_LIMITS.requirementImageBytes} bytes or smaller after encoding.`
      });
    }
  });

const ProductAssetSchema = z
  .object({
    name: z.string().min(1).max(180),
    mimeType: SupportedImageMimeSchema,
    sizeBytes: z.number().int().positive().max(RUN_LIMITS.productAssetBytes),
    dataUrl: z.string().max(Math.ceil((RUN_LIMITS.productAssetBytes * 4) / 3) + 80),
    originalName: z.string().min(1).max(180).optional(),
    originalSizeBytes: z.number().int().positive().optional(),
    relativePath: z.string().min(1).max(300).optional(),
    sourceUrl: z.string().url().max(1_000).optional(),
    license: z.string().max(80).optional(),
    licenseUrl: z.string().url().max(1_000).optional(),
    creator: z.string().max(180).optional(),
    provider: z.string().max(120).optional()
  })
  .superRefine((asset, context) => {
    if (!asset.dataUrl.startsWith(`data:${asset.mimeType};base64,`)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dataUrl'],
        message: 'Product asset must be a matching base64 data URL.'
      });
    }

    const base64 = asset.dataUrl.split(',')[1] || '';
    const estimatedBytes = Math.floor((base64.length * 3) / 4);
    if (estimatedBytes > RUN_LIMITS.productAssetBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dataUrl'],
        message: `Product asset must be ${RUN_LIMITS.productAssetBytes} bytes or smaller after optimization.`
      });
    }
  });

const RunRequestSchema = z.object({
  requirements: z.string().min(10).max(RUN_LIMITS.requirementsChars),
  techSpec: z.string().max(RUN_LIMITS.techSpecChars).nullable().optional(),
  apiSpec: z.string().max(RUN_LIMITS.apiSpecChars).optional(),
  topic: z.string().max(RUN_LIMITS.topicChars).optional(),
  cleanGeneratedCode: z.boolean().optional().default(false),
  requirementImages: z.array(RequirementImageSchema).max(RUN_LIMITS.requirementImages).nullable().optional(),
  requirementImage: RequirementImageSchema.nullable().optional(),
  productAssets: z
    .array(ProductAssetSchema)
    .max(RUN_LIMITS.productAssets)
    .nullable()
    .optional()
    .superRefine((assets, context) => {
      const totalBytes = assets?.reduce((sum, asset) => sum + asset.sizeBytes, 0) ?? 0;
      if (totalBytes > RUN_LIMITS.productAssetTotalBytes) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Product assets must be ${RUN_LIMITS.productAssetTotalBytes} bytes or smaller in total after optimization.`
        });
      }
    }),
  autoDownloadProductAssets: z.boolean().optional().default(false)
});

function errorResponse(error: unknown) {
  if (error instanceof ApiGuardError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: 'Invalid run request.',
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      },
      { status: 400 }
    );
  }

  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: 'Invalid JSON request body.' }, { status: 400 });
  }

  console.error('[runs] Request failed', error);
  return NextResponse.json(
    {
      error: error instanceof Error ? error.message : 'Run failed. Check server logs for details.'
    },
    { status: 500 }
  );
}

export async function POST(request: NextRequest) {
  try {
    assertRunApiAccess(request);
  } catch (error) {
    return errorResponse(error);
  }

  let body: z.infer<typeof RunRequestSchema>;
  try {
    body = RunRequestSchema.parse(await request.json());
  } catch (error) {
    return errorResponse(error);
  }

  try {
    const result = await runSprintBuilder(body);
    return NextResponse.json(result);
  } catch (error) {
    console.error('[runs] Run execution failed', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Run failed. Check server logs for details.'
      },
      { status: 500 }
    );
  }
}
