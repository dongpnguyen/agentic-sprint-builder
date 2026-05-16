import type { GeneratedFile, RunResult } from '@/lib/types';

const MAX_CODE_FILES = 30;
const MAX_CODE_FILE_CHARS = 6_000;
const MAX_CODE_CONTEXT_CHARS = 70_000;
const MAX_HISTORY_RUNS = 3;
const MAX_HISTORY_SECTION_CHARS = 900;

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function formatRequirementImageMetadata(run: RunResult) {
  if (run.requirementImages?.length) {
    return run.requirementImages
      .map((image, index) => `${index + 1}. ${image.name} (${image.mimeType}, ${image.sizeBytes} bytes)`)
      .join('; ');
  }

  return run.requirementImage
    ? `${run.requirementImage.name} (${run.requirementImage.mimeType}, ${run.requirementImage.sizeBytes} bytes)`
    : 'None';
}

function formatProductAssetMetadata(run: RunResult) {
  return run.productAssets?.length
    ? run.productAssets.map((asset, index) => `${index + 1}. ${asset.publicPath} (${asset.originalName || asset.name})`).join('; ')
    : 'None';
}

export function formatGeneratedCodeContext(files: GeneratedFile[]) {
  if (files.length === 0) return 'No existing generated code.';

  const sections: string[] = [];
  let totalChars = 0;

  for (const file of files.slice(0, MAX_CODE_FILES)) {
    const content = truncate(file.content, MAX_CODE_FILE_CHARS);
    const section = `### ${file.path}\n\n\`\`\`\n${content}\n\`\`\``;

    if (totalChars + section.length > MAX_CODE_CONTEXT_CHARS) {
      sections.push('...[generated code context truncated]');
      break;
    }

    sections.push(section);
    totalChars += section.length;
  }

  return sections.join('\n\n');
}

export function formatRunHistoryContext(runs: RunResult[]) {
  if (runs.length === 0) return 'No previous runs.';

  return runs
    .slice(0, MAX_HISTORY_RUNS)
    .map((run) => {
      const files = run.devOutput?.files?.map((file) => file.path).join(', ') || 'No generated files recorded.';
      const deploymentFiles = run.deploymentOutput?.files?.map((file) => file.path).join(', ') || 'No deployment files recorded.';
      const findings = run.qaFindings?.length ? run.qaFindings.join('; ') : 'No QA findings recorded.';
      const blockers = run.blockingIssues?.length
        ? run.blockingIssues.map((issue) => `${issue.id}: ${issue.owner.toUpperCase()} ${issue.title}`).join('; ')
        : 'No structured blockers recorded.';

      return [
        `## ${run.runId}`,
        `Created: ${run.createdAt}`,
        `Topic: ${run.topic}`,
        `Requirement images: ${formatRequirementImageMetadata(run)}`,
        `Product image assets: ${formatProductAssetMetadata(run)}`,
        `Standard Guard Mode status: ${run.preDeploymentGuardValidation?.status || 'Not recorded'}`,
        `Code review status: ${run.qaStatus || 'Not recorded'}`,
        `Post-deployment QA status: ${run.postDeploymentQaStatus || 'Not recorded'}`,
        `Build readiness fix iterations: ${run.buildReadinessFixIterations ?? 0}`,
        `Code review fix iterations: ${run.qaFixIterations ?? 0}`,
        `Deployment fix iterations: ${run.deploymentFixIterations ?? 0}`,
        `Post-deployment QA fix iterations: ${run.postDeploymentQaFixIterations ?? 0}`,
        `Structured blockers: ${truncate(blockers, MAX_HISTORY_SECTION_CHARS)}`,
        `Generated files: ${files}`,
        `Deployment files: ${deploymentFiles}`,
        `QA findings: ${truncate(findings, MAX_HISTORY_SECTION_CHARS)}`,
        `BA excerpt:\n${truncate(run.baOutput || '', MAX_HISTORY_SECTION_CHARS)}`,
        `Code review report excerpt:\n${truncate(run.qaOutput || '', MAX_HISTORY_SECTION_CHARS)}`,
        `Standard Guard findings excerpt:\n${truncate(run.preDeploymentGuardValidation?.findings?.join('; ') || '', MAX_HISTORY_SECTION_CHARS)}`,
        `Coordinator summary excerpt:\n${truncate(run.runSummary || '', MAX_HISTORY_SECTION_CHARS)}`,
        `Deployment excerpt:\n${truncate(run.deploymentOutput?.instructions || '', MAX_HISTORY_SECTION_CHARS)}`,
        `Post-deployment QA excerpt:\n${truncate(run.postDeploymentQaOutput || '', MAX_HISTORY_SECTION_CHARS)}`,
        `Setup excerpt:\n${truncate(run.devOutput?.setupInstructions || '', MAX_HISTORY_SECTION_CHARS)}`
      ].join('\n');
    })
    .join('\n\n');
}
