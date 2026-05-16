import type { RequirementImage } from '@/lib/types';

export function formatRequirementImageSummary(requirementImages: RequirementImage[]) {
  return requirementImages.length
    ? requirementImages
        .map((image, index) => `${index + 1}. ${image.name} (${image.mimeType}, ${image.sizeBytes} bytes)`)
        .join('\n')
    : 'No requirement images attached.';
}

export function formatVisualContractInstruction(requirementImages: RequirementImage[]) {
  if (!requirementImages.length) {
    return 'No image-based visual contract is required for this run.';
  }

  return [
    'Attached requirement images are visual source-of-truth inputs.',
    'BA must convert them into a detailed visual implementation contract.',
    'DEV must implement the BA visual contract page-by-page and preserve the image order, route mapping, layout identity, content hierarchy, colors, spacing, and major component states.',
    'QA must test against the BA visual contract and attached images, not against a generic interpretation of the text requirements.',
    'If exact pixel parity is not practical, agents must keep a clearly recognizable match and call out the reason for any intentional difference.'
  ].join(' ');
}
