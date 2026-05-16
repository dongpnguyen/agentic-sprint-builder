import { runMarkdownSkillAgent } from './base-agent';
import { formatGeneratedCodeContext, formatRunHistoryContext } from '@/lib/context/agent-context';
import { formatProductAssetInstruction, formatProductAssetSummary } from '@/lib/context/product-assets';
import { formatRequirementImageSummary, formatVisualContractInstruction } from '@/lib/context/visual-requirements';
import type { GeneratedFile, ProductAssetMetadata, RequirementImage, RunResult } from '@/lib/types';

export async function runBAAgent(input: {
  requirements: string;
  techSpec?: string | null;
  requirementImages?: RequirementImage[];
  requirementImage?: RequirementImage | null;
  productAssets?: ProductAssetMetadata[];
  existingFiles?: GeneratedFile[];
  recentRuns?: RunResult[];
}) {
  const techSpec = input.techSpec?.trim() || 'Not provided';
  const existingCodeContext = formatGeneratedCodeContext(input.existingFiles ?? []);
  const runHistoryContext = formatRunHistoryContext(input.recentRuns ?? []);
  const requirementImages = input.requirementImages?.length
    ? input.requirementImages
    : input.requirementImage
      ? [input.requirementImage]
      : [];
  const imageSummary = formatRequirementImageSummary(requirementImages);
  const visualContractInstruction = formatVisualContractInstruction(requirementImages);
  const productAssets = input.productAssets ?? [];
  const productAssetSummary = formatProductAssetSummary(productAssets);
  const productAssetInstruction = formatProductAssetInstruction(productAssets);

  return runMarkdownSkillAgent({
    agentId: 'ba',
    images: requirementImages.length ? requirementImages : undefined,
    userPrompt: `
Analyze these Phase 1 inputs and produce BA artifacts.
Keep the BA artifact concise and implementation-ready. Prefer compact bullets over long prose.
Target no more than 8 major sections and avoid exhaustive repetition across similar screens.

If requirement images are attached, inspect each image as visual requirement context.
By default, treat each image as one web page or screen to implement, in the same order as the image list.
For each image, identify a likely page name, route, purpose, components, navigation, content, states,
layout, responsive behavior, colors, spacing, and UX constraints.
If an image appears to be a component, modal, or alternate state instead of a separate page, call that out.
If images conflict with text requirements, call out the conflict and keep explicit text scope authoritative.
Create a visual implementation contract that DEV can code directly and QA can test directly.
For every attached image, include a page/screen mapping with route, viewport assumptions, layout regions, component inventory,
visible copy, visual hierarchy, color palette, spacing density, imagery/icon requirements, interaction states, and acceptance criteria.
The BA artifact should preserve the visual identity of the input image as closely as practical, not replace it with a generic page.
If product image assets are provided, treat them as real product catalog imagery available to the generated app.
Map product assets to products by filename/path and requirement context, and tell DEV which publicPath values to use in product seed data and UI.
Do not treat product assets as page mockups; requirement images are for UI/page visual contracts, product assets are for catalog content.

VISUAL CONTRACT POLICY:
${visualContractInstruction}

PRODUCT ASSET POLICY:
${productAssetInstruction}

REQUIREMENTS:
${input.requirements}

REQUIREMENT IMAGES:
${imageSummary}

PRODUCT IMAGE ASSETS:
${productAssetSummary}

TECH SPEC:
${techSpec}

EXISTING GENERATED CODE:
${existingCodeContext}

RECENT RUN HISTORY:
${runHistoryContext}
`,
    maxTokens: 8_000
  });
}
