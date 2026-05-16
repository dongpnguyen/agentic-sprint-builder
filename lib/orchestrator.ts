import { emitDashboardEvent } from '@/lib/dashboard';
import { runAssetAgent } from '@/lib/agents/asset-agent';
import { runBAAgent } from '@/lib/agents/ba-agent';
import { runDevAgent } from '@/lib/agents/dev-agent';
import { runQAAgent } from '@/lib/agents/qa-agent';
import { runDeployAgent } from '@/lib/agents/deploy-agent';
import { buildCoordinatorRunSummary } from '@/lib/summary/run-summary';
import { clearGeneratedCode, listRunResults, readGeneratedCodeSnapshot, saveRunResult, writeGeneratedFiles } from '@/lib/storage/file-writer';
import { downloadAutoProductAssets } from '@/lib/storage/auto-product-assets';
import { writeProductAssetManifest, writeProductAssets } from '@/lib/storage/product-assets';
import { validateDeploymentProject } from '@/lib/validation/deployment-project';
import { normalizeGeneratedAssets } from '@/lib/validation/generated-assets';
import { deployGeneratedProjectContainers, validateGeneratedProjectBuildGuard } from '@/lib/validation/generated-execution';
import { validateGeneratedProject } from '@/lib/validation/generated-project';
import { createBlockingIssueFromExecution, createBlockingIssueFromReview, formatBlockingIssue } from '@/lib/validation/blocking-issues';
import { formatRepairScope, inferQaRepairScope, inferStaticRepairScope } from '@/lib/validation/repair-scope';
import type { AgentEvent, AssetAgentOutput, BlockingIssue, DeploymentOutput, DevOutput, GeneratedExecutionValidationResult, GeneratedFile, ProductAssetMetadata, QAReviewOutput, RepairScope, RunRequest, RunResult } from '@/lib/types';

const MAX_QA_FIX_ITERATIONS = 3;
const MAX_BUILD_READINESS_FIX_ITERATIONS = 3;
const MAX_DEPLOYMENT_FIX_ITERATIONS = 3;

function withGeneratedCodeSnapshot(output: DevOutput, files: GeneratedFile[]): DevOutput {
  return {
    ...output,
    files
  };
}

function prepareDevOutput(output: DevOutput) {
  return normalizeGeneratedAssets(output);
}

function isComposeFilePath(filePath: string) {
  return /(^|\/)(compose|docker-compose)\.ya?ml$/i.test(filePath);
}

function stripObsoleteComposeVersion(content: string) {
  return content.replace(/^\s*version\s*:\s*['"][^'"]+['"]\s*\r?\n(?:\s*\r?\n)?/i, '');
}

function prepareDeploymentOutput(output: DeploymentOutput): DeploymentOutput {
  return {
    ...output,
    files: output.files.map((file) =>
      isComposeFilePath(file.path)
        ? {
            ...file,
            content: stripObsoleteComposeVersion(file.content)
          }
        : file
    )
  };
}

function withCoordinatorSummary(result: RunResult): RunResult {
  return {
    ...result,
    runSummary: buildCoordinatorRunSummary(result)
  };
}

function isAutoProductAssetDownloadEnabled() {
  return process.env.ENABLE_AUTO_PRODUCT_ASSET_DOWNLOAD !== 'false';
}

async function writeGeneratedFilesAndProductAssetManifest(files: GeneratedFile[], productAssets: ProductAssetMetadata[]) {
  const codeOutputDir = await writeGeneratedFiles(files);
  await writeProductAssetManifest(productAssets);
  return codeOutputDir;
}

function createBuildReadinessReview(findings: string[], fixInstructions: string): QAReviewOutput {
  return {
    status: 'NEEDS_FIX',
    findings,
    fixInstructions,
    report: [
      '# QA Summary',
      'Automated run/build readiness checks still found blockers in the final generated-code workspace.',
      '',
      '# Code Review Findings',
      ...findings.map((finding, index) => `${index + 1}. ${finding}`),
      '',
      '# Test Report',
      '- **Status**: NEEDS_FIX',
      `- **Findings**: ${findings.join('; ')}`,
      '',
      '# Recommendation',
      fixInstructions
    ].join('\n')
  };
}

function createDeploymentReadinessReview(findings: string[], fixInstructions: string): QAReviewOutput {
  return {
    status: 'NEEDS_FIX',
    findings,
    fixInstructions,
    report: [
      '# QA Summary',
      'Automated deployment readiness checks still found blockers in the final generated-code workspace.',
      '',
      '# Deployment Findings',
      ...findings.map((finding, index) => `${index + 1}. ${finding}`),
      '',
      '# Test Report',
      '- **Status**: NEEDS_FIX',
      `- **Findings**: ${findings.join('; ')}`,
      '',
      '# Recommendation',
      fixInstructions
    ].join('\n')
  };
}

function createContainerExecutionReview(executionValidation: GeneratedExecutionValidationResult): QAReviewOutput {
  const findings =
    executionValidation.findings.length > 0
      ? executionValidation.findings
      : [`Container deployment did not pass. Status: ${executionValidation.status}.`];

  return createDeploymentReadinessReview(
    findings,
    executionValidation.fixInstructions || `Fix container deployment blockers:\n${findings.map((finding) => `- ${finding}`).join('\n')}`
  );
}

function createStandardGuardReview(validation: GeneratedExecutionValidationResult): QAReviewOutput {
  const failedSteps = validation.steps.filter((step) => step.status === 'FAIL');
  const findings =
    validation.findings.length > 0
      ? validation.findings
      : [`Standard Guard Mode did not pass. Status: ${validation.status}.`];

  return {
    status: 'NEEDS_FIX',
    findings,
    fixInstructions:
      validation.fixInstructions || `Fix Standard Guard Mode blockers:\n${findings.map((finding) => `- ${finding}`).join('\n')}`,
    report: [
      '# QA Summary',
      'Standard Guard Mode found deterministic pre-deployment blockers in the generated-code workspace.',
      '',
      '# Guard Findings',
      ...findings.map((finding, index) => `${index + 1}. ${finding}`),
      '',
      '# Failed Steps',
      ...(failedSteps.length
        ? failedSteps.map((step) =>
            [
              `- **${step.name}**`,
              step.command ? `  - Command: \`${step.command}\`` : '',
              `  - Message: ${step.message}`,
              step.logFile ? `  - Log: ${step.logFile}` : ''
            ]
              .filter(Boolean)
              .join('\n')
          )
        : ['- No failed command step was recorded.']),
      '',
      '# Recommendation',
      validation.fixInstructions || 'Fix the failed guard step and rerun Standard Guard Mode before QA/deploy.'
    ].join('\n')
  };
}

function createMissingContainerExecution(workspace: string): GeneratedExecutionValidationResult {
  return {
    status: 'NEEDS_FIX',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    workspace,
    findings: ['Container deployment did not run before post-deployment QA.'],
    fixInstructions: 'Run the generated container deployment before post-deployment QA.',
    steps: []
  };
}

function isDevRepairScope(scope?: RepairScope) {
  return Boolean(scope && ['frontend', 'backend', 'database', 'tests'].includes(scope.kind));
}

function formatScopedRepairFeedback(baseFeedback: string, scope?: RepairScope) {
  const feedback = baseFeedback.trim();
  return scope ? `${feedback}\n\n${formatRepairScope(scope)}` : feedback;
}

function getPostDeploymentRepairScope(params: {
  deploymentReadinessStatus: 'PASS' | 'NEEDS_FIX';
  executionValidation?: GeneratedExecutionValidationResult;
  qaReview: QAReviewOutput;
  files: GeneratedFile[];
}) {
  const qaFeedback = `${params.qaReview.fixInstructions}\n\nFindings:\n${params.qaReview.findings.join('\n')}\n\nReport:\n${params.qaReview.report}`;
  if (params.deploymentReadinessStatus === 'NEEDS_FIX') {
    return inferQaRepairScope(qaFeedback, params.files);
  }

  if (params.executionValidation?.status === 'NEEDS_FIX' && params.executionValidation.repairScope) {
    return params.executionValidation.repairScope;
  }

  return inferQaRepairScope(qaFeedback, params.files);
}

function hasGeneratedFile(files: GeneratedFile[], filePath: string) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return files.some((file) => file.path.replace(/\\/g, '/').toLowerCase() === normalized);
}

function isContradictedQaFinding(finding: string, devOutput: DevOutput) {
  const normalized = finding.toLowerCase();

  if (
    /requirements\.txt|requirements file/.test(normalized) &&
    /missing|not present|not found/.test(normalized) &&
    hasGeneratedFile(devOutput.files, 'backend/requirements.txt')
  ) {
    return true;
  }

  if (
    /seed/.test(normalized) &&
    /setup|instruction|usage|unclear|not mentioned/.test(normalized) &&
    /seed|sample data|initial data/i.test(devOutput.setupInstructions)
  ) {
    return true;
  }

  return false;
}

function isDeploymentOnlyCodeReviewFinding(finding: string) {
  const normalized = finding.toLowerCase();
  return (
    /docker|compose|dockerfile|container|service health|health\s*check|healthcheck|rancher|nerdctl|deployment packaging|deployment readiness/.test(normalized) &&
    !/cors|api base|api url|frontend\/backend|runtime error|build error|package\.json|requirements\.txt|entrypoint/.test(normalized)
  );
}

function getGeneratedFile(files: GeneratedFile[], filePath: string) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return files.find((file) => file.path.replace(/\\/g, '/').toLowerCase() === normalized);
}

function getComposeFile(files: GeneratedFile[]) {
  return files.find((file) => /(^|\/)(compose|docker-compose)\.ya?ml$/i.test(file.path));
}

function getLeadingSpaces(value: string) {
  return value.match(/^\s*/)?.[0].length ?? 0;
}

function getYamlBlock(content: string, key: string) {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim().toLowerCase() === `${key.toLowerCase()}:`);
  if (startIndex < 0) return '';

  const startIndent = getLeadingSpaces(lines[startIndex]);
  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim() && getLeadingSpaces(lines[index]) <= startIndent) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n');
}

function hasServiceHealthcheck(files: GeneratedFile[], serviceName: string) {
  const compose = getComposeFile(files);
  return compose ? /healthcheck\s*:/i.test(getYamlBlock(compose.content, serviceName)) : false;
}

function deploymentDocumentationText(params: {
  deploymentOutput: DeploymentOutput;
  devOutput: DevOutput;
  files: GeneratedFile[];
}) {
  return [
    params.deploymentOutput.summary,
    params.deploymentOutput.instructions,
    params.devOutput.setupInstructions,
    getGeneratedFile(params.files, 'README.md')?.content ?? ''
  ].join('\n');
}

function isContradictedPostDeploymentFinding(params: {
  finding: string;
  deploymentOutput: DeploymentOutput;
  devOutput: DevOutput;
  files: GeneratedFile[];
}) {
  const normalized = params.finding.toLowerCase();

  if (/health\s*check|healthcheck/.test(normalized) && /missing|does not include|not include|not present/.test(normalized)) {
    if (/frontend/.test(normalized)) return hasServiceHealthcheck(params.files, 'frontend');
    if (/backend/.test(normalized)) return hasServiceHealthcheck(params.files, 'backend');
    return hasServiceHealthcheck(params.files, 'frontend') && hasServiceHealthcheck(params.files, 'backend');
  }

  if (
    /seed/.test(normalized) &&
    /setup|instruction|usage|unclear|not mentioned|populate|initial data/.test(normalized) &&
    /seed|sample data|initial data/i.test(deploymentDocumentationText(params))
  ) {
    return true;
  }

  return false;
}

function reconcileCodeReviewWithWorkspace(qaReview: QAReviewOutput, devOutput: DevOutput): QAReviewOutput {
  if (qaReview.status !== 'NEEDS_FIX') return qaReview;

  const findings = qaReview.findings.filter(
    (finding) => !isContradictedQaFinding(finding, devOutput) && !isDeploymentOnlyCodeReviewFinding(finding)
  );
  if (findings.length === qaReview.findings.length) return qaReview;

  if (findings.length > 0) {
    return {
      ...qaReview,
      findings,
      fixInstructions: `Fix the remaining code review blockers:\n${findings.map((finding) => `- ${finding}`).join('\n')}`
    };
  }

  return {
    status: 'PASS',
    findings: [],
    fixInstructions: '',
    report: [
      '# QA Summary',
      'Code review passed after reconciling QA findings against the final generated-code workspace.',
      '',
      '# Notes',
      'The QA model reported stale or deployment-only findings that should not block the DEV code-review gate.'
    ].join('\n')
  };
}

function reconcilePostDeploymentReviewWithWorkspace(params: {
  qaReview: QAReviewOutput;
  deploymentOutput: DeploymentOutput;
  devOutput: DevOutput;
  files: GeneratedFile[];
}): QAReviewOutput {
  if (params.qaReview.status !== 'NEEDS_FIX') return params.qaReview;

  const findings = params.qaReview.findings.filter(
    (finding) => !isContradictedPostDeploymentFinding({ ...params, finding })
  );
  if (findings.length === params.qaReview.findings.length) return params.qaReview;

  if (findings.length > 0) {
    return {
      ...params.qaReview,
      findings,
      fixInstructions: `Fix the remaining post-deployment blockers:\n${findings.map((finding) => `- ${finding}`).join('\n')}`
    };
  }

  return {
    status: 'PASS',
    findings: [],
    fixInstructions: '',
    report: [
      '# QA Summary',
      'Post-deployment readiness passed after reconciling QA findings against the final generated-code workspace.',
      '',
      '# Notes',
      'The QA model reported stale findings that were contradicted by deployment files and setup instructions.'
    ].join('\n')
  };
}

function createTimestampRunId(date = new Date()) {
  const pad = (value: number) => value.toString().padStart(2, '0');

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('-');
}

export async function runSprintBuilder(input: RunRequest): Promise<RunResult> {
  const runId = createTimestampRunId();
  const events: AgentEvent[] = [];
  const topic = input.topic || 'Simple Shopping Cart App';
  const inputRequirementImages = input.requirementImages?.length
    ? input.requirementImages
    : input.requirementImage
      ? [input.requirementImage]
      : [];
  const requirementImages = inputRequirementImages.map((image) => ({
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes
  }));
  const requirementImage = requirementImages[0];

  async function emit(params: Parameters<typeof emitDashboardEvent>[0]) {
    const event = await emitDashboardEvent(params);
    events.push(event);
  }

  if (input.cleanGeneratedCode) {
    await clearGeneratedCode();
  }

  let productAssets = await writeProductAssets(input.productAssets ?? []);
  let assetOutput: AssetAgentOutput | undefined;
  let assetFindings: string[] = [];
  const blockingIssues: BlockingIssue[] = [];
  let existingFiles = await readGeneratedCodeSnapshot();
  const recentRuns = await listRunResults();

  await emit({ agentId: 'ba', eventType: 'THINKING', task: 'Analyze requirements and scope', artifact: 'BA_ARTIFACTS.md' });
  const baOutput = await runBAAgent({
    requirements: input.requirements,
    techSpec: input.techSpec,
    requirementImages: inputRequirementImages,
    productAssets,
    existingFiles,
    recentRuns
  });
  await emit({
    agentId: 'ba',
    eventType: 'WORK_COMPLETE',
    task: 'BA artifacts completed',
    toAgent: input.autoDownloadProductAssets && productAssets.length === 0 ? 'asset' : 'dev',
    artifact: 'BA_ARTIFACTS.md'
  });

  if (input.autoDownloadProductAssets && productAssets.length === 0) {
    if (!isAutoProductAssetDownloadEnabled()) {
      assetFindings = ['Automatic product asset download is disabled by ENABLE_AUTO_PRODUCT_ASSET_DOWNLOAD=false.'];
      await emit({
        agentId: 'asset',
        eventType: 'IDLE',
        task: 'Auto product asset download skipped because it is disabled',
        toAgent: 'dev',
        artifact: 'PRODUCT_ASSETS.md'
      });
    } else {
      try {
        await emit({
          agentId: 'asset',
          eventType: 'THINKING',
          task: 'Infer product image searches from BA artifacts and mockups',
          artifact: 'PRODUCT_ASSETS.md'
        });
        assetOutput = await runAssetAgent({
          requirements: input.requirements,
          techSpec: input.techSpec,
          baOutput,
          requirementImages: inputRequirementImages,
          recentRuns
        });
        await emit({
          agentId: 'asset',
          eventType: 'WORKING',
          task: `Search and download product assets from ${assetOutput.queries.length} inferred query(s)`,
          artifact: 'PRODUCT_ASSETS.md'
        });
        const downloaded = await downloadAutoProductAssets(assetOutput);
        assetFindings = downloaded.findings;
        productAssets = await writeProductAssets(downloaded.assets);
        existingFiles = await readGeneratedCodeSnapshot();
        await emit({
          agentId: 'asset',
          eventType: downloaded.assets.length > 0 ? 'WORK_COMPLETE' : 'ERROR',
          task:
            downloaded.assets.length > 0
              ? `Downloaded ${downloaded.assets.length} product asset(s)`
              : 'No downloadable product assets were found; DEV will use fallback imagery',
          toAgent: 'dev',
          artifact: 'PRODUCT_ASSETS.md'
        });
      } catch (error) {
        assetFindings = [error instanceof Error ? error.message : String(error)];
        await emit({
          agentId: 'asset',
          eventType: 'ERROR',
          task: 'Auto product asset download failed; DEV will use fallback imagery',
          toAgent: 'dev',
          artifact: 'PRODUCT_ASSETS.md'
        });
      }
    }
  }

  await emit({ agentId: 'dev', eventType: 'CODING', task: 'Generate implementation files', artifact: 'generated-files' });
  let devOutput = prepareDevOutput(await runDevAgent({
    requirements: input.requirements,
    techSpec: input.techSpec,
    baOutput,
    existingFiles,
    requirementImages: inputRequirementImages,
    productAssets,
    recentRuns,
    apiSpec: input.apiSpec
  }));
  let codeOutputDir = await writeGeneratedFilesAndProductAssetManifest(devOutput.files, productAssets);
  existingFiles = await readGeneratedCodeSnapshot();
  devOutput = withGeneratedCodeSnapshot(devOutput, existingFiles);
  await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: 'Implementation files generated', toAgent: 'qa', artifact: 'generated-files' });

  let buildReadinessFixIterations = 0;
  const validationContext = {
    requirements: input.requirements,
    baOutput
  };
  let buildReadiness = validateGeneratedProject(devOutput, validationContext);
  let preDeploymentGuardValidation: GeneratedExecutionValidationResult | undefined;
  let preDeploymentGateReview: QAReviewOutput | undefined;
  let preDeploymentGateRepairScope: RepairScope | undefined;

  async function evaluatePreDeploymentGate() {
    buildReadiness = validateGeneratedProject(devOutput, validationContext);
    preDeploymentGuardValidation = undefined;

    if (buildReadiness.status === 'NEEDS_FIX') {
      preDeploymentGateReview = createBuildReadinessReview(buildReadiness.findings, buildReadiness.fixInstructions);
      existingFiles = await readGeneratedCodeSnapshot();
      preDeploymentGateRepairScope = inferStaticRepairScope(buildReadiness, existingFiles);
      return;
    }

    await emit({
      agentId: 'qa',
      eventType: 'REVIEWING',
      task: 'Run Standard Guard Mode pre-deployment checks',
      artifact: 'STANDARD_GUARD.md'
    });
    preDeploymentGuardValidation = await validateGeneratedProjectBuildGuard();
    await emit({
      agentId: 'qa',
      eventType: preDeploymentGuardValidation.status === 'NEEDS_FIX' ? 'ERROR' : 'WORK_COMPLETE',
      task: `Standard Guard Mode ${preDeploymentGuardValidation.status}`,
      toAgent: preDeploymentGuardValidation.status === 'NEEDS_FIX' ? 'dev' : undefined,
      artifact: 'STANDARD_GUARD.md'
    });

    if (preDeploymentGuardValidation.status === 'NEEDS_FIX') {
      preDeploymentGateReview = createStandardGuardReview(preDeploymentGuardValidation);
      existingFiles = await readGeneratedCodeSnapshot();
      preDeploymentGateRepairScope = preDeploymentGuardValidation.repairScope;
      return;
    }

    preDeploymentGateReview = undefined;
    preDeploymentGateRepairScope = undefined;
  }

  await evaluatePreDeploymentGate();
  while (preDeploymentGateReview && buildReadinessFixIterations < MAX_BUILD_READINESS_FIX_ITERATIONS) {
    buildReadinessFixIterations += 1;

    await emit({
      agentId: 'qa',
      eventType: 'REVIEW_REQUEST',
      task: `Pre-deployment guard found blockers; sending fix request ${buildReadinessFixIterations} to DEV`,
      toAgent: 'dev',
      artifact: 'STANDARD_GUARD.md'
    });

    existingFiles = await readGeneratedCodeSnapshot();
    const buildIssue = createBlockingIssueFromReview({
      phaseDetected: 'build_readiness',
      review: preDeploymentGateReview,
      files: existingFiles,
      repairScope: preDeploymentGateRepairScope,
      owner: 'dev'
    });
    blockingIssues.push(buildIssue);
    await emit({ agentId: 'dev', eventType: 'CODING', task: `Fix pre-deployment guard blockers iteration ${buildReadinessFixIterations}`, artifact: 'generated-files' });
    devOutput = prepareDevOutput(await runDevAgent({
      requirements: input.requirements,
      techSpec: input.techSpec,
      baOutput,
      existingFiles,
      requirementImages: inputRequirementImages,
      productAssets,
      recentRuns,
      previousDevOutput: devOutput,
      qaFeedback: formatScopedRepairFeedback(
        `${preDeploymentGateReview.fixInstructions}\n\nFindings:\n${preDeploymentGateReview.findings.join('\n')}\n\nReport:\n${preDeploymentGateReview.report}\n\nSTRUCTURED BLOCKER HANDOFF:\n${formatBlockingIssue(buildIssue)}`,
        preDeploymentGateRepairScope
      ),
      apiSpec: input.apiSpec
    }));
    codeOutputDir = await writeGeneratedFilesAndProductAssetManifest(devOutput.files, productAssets);
    existingFiles = await readGeneratedCodeSnapshot();
    devOutput = withGeneratedCodeSnapshot(devOutput, existingFiles);
    await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: `Pre-deployment guard fixes generated iteration ${buildReadinessFixIterations}`, toAgent: 'qa', artifact: 'generated-files' });
    await evaluatePreDeploymentGate();
  }

  await emit({ agentId: 'qa', eventType: 'REVIEWING', task: 'Review DEV implementation before deployment', artifact: 'QA_REPORT.md' });
  let qaReview: QAReviewOutput =
    preDeploymentGateReview
      ? preDeploymentGateReview
      : reconcileCodeReviewWithWorkspace(
          await runQAAgent({
            requirements: input.requirements,
            techSpec: input.techSpec,
            baOutput,
            devOutput,
            reviewStage: 'code_review',
            existingFiles,
            requirementImages: inputRequirementImages,
            productAssets,
            recentRuns
          }),
          devOutput
        );

  let qaFixIterations = 0;
  while (qaReview.status === 'NEEDS_FIX' && qaFixIterations < MAX_QA_FIX_ITERATIONS) {
    qaFixIterations += 1;

    await emit({
      agentId: 'qa',
      eventType: 'REVIEW_REQUEST',
      task: `Code review found blocking issues; sending fix request ${qaFixIterations} to DEV`,
      toAgent: 'dev',
      artifact: 'QA_REPORT.md'
    });

    existingFiles = await readGeneratedCodeSnapshot();
    const qaFeedbackText = `${qaReview.fixInstructions}\n\nFindings:\n${qaReview.findings.join('\n')}\n\nReport:\n${qaReview.report}`;
    const qaRepairScope = inferQaRepairScope(qaFeedbackText, existingFiles);
    const qaIssue = createBlockingIssueFromReview({
      phaseDetected: 'code_review',
      review: qaReview,
      files: existingFiles,
      repairScope: qaRepairScope,
      owner: 'dev'
    });
    blockingIssues.push(qaIssue);
    await emit({ agentId: 'dev', eventType: 'CODING', task: `Fix code review findings iteration ${qaFixIterations}`, artifact: 'generated-files' });
    devOutput = prepareDevOutput(await runDevAgent({
      requirements: input.requirements,
      techSpec: input.techSpec,
      baOutput,
      existingFiles,
      requirementImages: inputRequirementImages,
      productAssets,
      recentRuns,
      previousDevOutput: devOutput,
      qaFeedback: formatScopedRepairFeedback(
        `${qaFeedbackText}\n\nSTRUCTURED BLOCKER HANDOFF:\n${formatBlockingIssue(qaIssue)}`,
        qaRepairScope
      ),
      apiSpec: input.apiSpec
    }));
    codeOutputDir = await writeGeneratedFilesAndProductAssetManifest(devOutput.files, productAssets);
    existingFiles = await readGeneratedCodeSnapshot();
    devOutput = withGeneratedCodeSnapshot(devOutput, existingFiles);
    await emit({ agentId: 'dev', eventType: 'WORK_COMPLETE', task: `Code review fixes generated iteration ${qaFixIterations}`, toAgent: 'qa', artifact: 'generated-files' });

    await evaluatePreDeploymentGate();
    await emit({ agentId: 'qa', eventType: 'REVIEWING', task: `Re-review DEV implementation iteration ${qaFixIterations}`, artifact: 'QA_REPORT.md' });
    qaReview =
      preDeploymentGateReview
        ? preDeploymentGateReview
        : reconcileCodeReviewWithWorkspace(
            await runQAAgent({
              requirements: input.requirements,
              techSpec: input.techSpec,
              baOutput,
              devOutput,
              reviewStage: 'code_review',
              existingFiles,
              requirementImages: inputRequirementImages,
              productAssets,
              recentRuns
            }),
            devOutput
          );
  }

  const codeReviewPassed = qaReview.status === 'PASS' && buildReadiness.status === 'PASS';
  if (!codeReviewPassed) {
    await emit({
      agentId: 'qa',
      eventType: 'TASK_COMPLETE',
      task: `Code review completed with status ${qaReview.status}; deployment skipped until blockers are fixed`,
      artifact: 'QA_REPORT.md'
    });
    await emit({
      agentId: 'deploy',
      eventType: 'IDLE',
      task: 'Deployment skipped because code review did not pass',
      artifact: 'DEPLOYMENT.md'
    });

    const result: RunResult = {
      runId,
      createdAt: new Date().toISOString(),
      topic,
      cleanGeneratedCode: input.cleanGeneratedCode,
      requirementImages,
      requirementImage,
      productAssets,
      autoDownloadProductAssets: input.autoDownloadProductAssets,
      assetOutput,
      assetFindings,
      baOutput,
      devOutput,
      qaOutput: qaReview.report,
      qaStatus: qaReview.status,
      qaFindings: qaReview.findings,
      qaFixIterations,
      buildReadinessFixIterations,
      preDeploymentGuardValidation,
      deploymentFixIterations: 0,
      blockingIssues,
      postDeploymentQaFixIterations: 0,
      events,
      outputDir: '',
      codeOutputDir
    };

    const resultWithSummary = withCoordinatorSummary(result);
    const outputDir = await saveRunResult(resultWithSummary);
    return { ...resultWithSummary, outputDir };
  }

  await emit({ agentId: 'qa', eventType: 'WORK_COMPLETE', task: 'Code review passed; hand off to DEPLOY', toAgent: 'deploy', artifact: 'QA_REPORT.md' });

  await emit({
    agentId: 'deploy',
    eventType: 'WORKING',
    task: 'Package local container deployment',
    artifact: 'DEPLOYMENT.md'
  });
  let deploymentOutput: DeploymentOutput = prepareDeploymentOutput(await runDeployAgent({
    requirements: input.requirements,
    techSpec: input.techSpec,
    baOutput,
    devOutput,
    qaReview,
    existingFiles,
    productAssets,
    recentRuns
  }));
  codeOutputDir = await writeGeneratedFilesAndProductAssetManifest(deploymentOutput.files, productAssets);
  existingFiles = await readGeneratedCodeSnapshot();
  let deploymentReadiness = validateDeploymentProject({ deploymentOutput, devOutput, files: existingFiles });
  let executionValidation: GeneratedExecutionValidationResult | undefined;
  await emit({
    agentId: 'deploy',
    eventType: 'WORK_COMPLETE',
    task: 'Deployment artifacts generated',
    toAgent: 'qa',
    artifact: 'DEPLOYMENT.md'
  });

  if (deploymentReadiness.status === 'PASS') {
    await emit({
      agentId: 'deploy',
      eventType: 'WORKING',
      task: 'Build and run local container deployment',
      artifact: 'DEPLOYMENT.md'
    });
    executionValidation = await deployGeneratedProjectContainers();
    await emit({
      agentId: 'deploy',
      eventType: executionValidation.status === 'PASS' ? 'WORK_COMPLETE' : 'ERROR',
      task: `Local container deployment ${executionValidation.status}`,
      toAgent: 'qa',
      artifact: 'DEPLOYMENT.md'
    });
  }

  await emit({
    agentId: 'qa',
    eventType: 'REVIEWING',
    task: 'Run post-deployment E2E readiness review',
    artifact: 'POST_DEPLOY_QA_REPORT.md'
  });
  let postDeploymentQaReview =
    deploymentReadiness.status === 'NEEDS_FIX'
      ? createDeploymentReadinessReview(deploymentReadiness.findings, deploymentReadiness.fixInstructions)
      : executionValidation?.status !== 'PASS'
        ? createContainerExecutionReview(executionValidation ?? createMissingContainerExecution(codeOutputDir))
      : reconcilePostDeploymentReviewWithWorkspace({
          qaReview: await runQAAgent({
            requirements: input.requirements,
            techSpec: input.techSpec,
            baOutput,
            devOutput,
            deploymentOutput,
            executionValidation,
            reviewStage: 'post_deploy',
            existingFiles,
            requirementImages: inputRequirementImages,
            productAssets,
            recentRuns
          }),
          deploymentOutput,
          devOutput,
          files: existingFiles
        });
  let deploymentFixIterations = 0;
  while (
    postDeploymentQaReview.status === 'NEEDS_FIX' &&
    deploymentFixIterations < MAX_DEPLOYMENT_FIX_ITERATIONS
  ) {
    deploymentFixIterations += 1;
    const repairScope = getPostDeploymentRepairScope({
      deploymentReadinessStatus: deploymentReadiness.status,
      executionValidation,
      qaReview: postDeploymentQaReview,
      files: existingFiles
    });
    const blockingIssue =
      deploymentReadiness.status === 'PASS' && executionValidation?.status === 'NEEDS_FIX'
        ? createBlockingIssueFromExecution({
            validation: executionValidation,
            files: existingFiles
          })
        : createBlockingIssueFromReview({
            phaseDetected: deploymentReadiness.status === 'NEEDS_FIX' ? 'deployment_readiness' : 'post_deploy_qa',
            review: postDeploymentQaReview,
            files: existingFiles,
            repairScope
          });
    blockingIssues.push(blockingIssue);
    const routeToDev = blockingIssue.owner === 'dev' || (deploymentReadiness.status === 'PASS' && isDevRepairScope(repairScope));
    const repairAgentId = routeToDev ? 'dev' : 'deploy';
    const postDeploymentFeedback = formatScopedRepairFeedback(
      `${postDeploymentQaReview.fixInstructions}\n\nFindings:\n${postDeploymentQaReview.findings.join('\n')}\n\nReport:\n${postDeploymentQaReview.report}\n\nSTRUCTURED BLOCKER HANDOFF:\n${formatBlockingIssue(blockingIssue)}`,
      repairScope
    );

    await emit({
      agentId: 'qa',
      eventType: 'REVIEW_REQUEST',
      task: `Post-deployment blocker ${blockingIssue.id} assigned to ${repairAgentId.toUpperCase()}; fix request ${deploymentFixIterations}`,
      toAgent: repairAgentId,
      artifact: 'POST_DEPLOY_QA_REPORT.md'
    });

    if (routeToDev) {
      existingFiles = await readGeneratedCodeSnapshot();
      await emit({
        agentId: 'dev',
        eventType: 'CODING',
        task: `Fix post-deployment app blockers iteration ${deploymentFixIterations}`,
        artifact: 'generated-files'
      });
      devOutput = prepareDevOutput(await runDevAgent({
        requirements: input.requirements,
        techSpec: input.techSpec,
        baOutput,
        existingFiles,
        requirementImages: inputRequirementImages,
        productAssets,
        recentRuns,
        previousDevOutput: devOutput,
        qaFeedback: postDeploymentFeedback,
        apiSpec: input.apiSpec
      }));
      codeOutputDir = await writeGeneratedFilesAndProductAssetManifest(devOutput.files, productAssets);
      existingFiles = await readGeneratedCodeSnapshot();
      devOutput = withGeneratedCodeSnapshot(devOutput, existingFiles);
      buildReadiness = validateGeneratedProject(devOutput, validationContext);
      await emit({
        agentId: 'dev',
        eventType: 'WORK_COMPLETE',
        task: `Post-deployment app fixes generated iteration ${deploymentFixIterations}`,
        toAgent: 'deploy',
        artifact: 'generated-files'
      });

      if (buildReadiness.status === 'NEEDS_FIX') {
        postDeploymentQaReview = createBuildReadinessReview(buildReadiness.findings, buildReadiness.fixInstructions);
        continue;
      }
    }

    await emit({
      agentId: 'deploy',
      eventType: 'WORKING',
      task: routeToDev
        ? `Refresh local container deployment after DEV fixes iteration ${deploymentFixIterations}`
        : `Fix local container and E2E blockers iteration ${deploymentFixIterations}`,
      artifact: 'DEPLOYMENT.md'
    });
    deploymentOutput = prepareDeploymentOutput(await runDeployAgent({
      requirements: input.requirements,
      techSpec: input.techSpec,
      baOutput,
      devOutput,
      qaReview,
      existingFiles,
      productAssets,
      recentRuns,
      previousDeploymentOutput: deploymentOutput,
      qaFeedback: routeToDev
        ? `DEV changed application files after post-deployment QA. Refresh deployment files if needed, preserving the fixed app code.\n\n${postDeploymentFeedback}`
        : postDeploymentFeedback,
    }));
    codeOutputDir = await writeGeneratedFilesAndProductAssetManifest(deploymentOutput.files, productAssets);
    existingFiles = await readGeneratedCodeSnapshot();
    deploymentReadiness = validateDeploymentProject({ deploymentOutput, devOutput, files: existingFiles });
    await emit({
      agentId: 'deploy',
      eventType: 'WORK_COMPLETE',
      task: `Local container and E2E fixes generated iteration ${deploymentFixIterations}`,
      toAgent: 'qa',
      artifact: 'DEPLOYMENT.md'
    });

    if (deploymentReadiness.status === 'PASS') {
      await emit({
        agentId: 'deploy',
        eventType: 'WORKING',
        task: `Build and run local container deployment iteration ${deploymentFixIterations}`,
        artifact: 'DEPLOYMENT.md'
      });
      executionValidation = await deployGeneratedProjectContainers();
      await emit({
        agentId: 'deploy',
        eventType: executionValidation.status === 'PASS' ? 'WORK_COMPLETE' : 'ERROR',
        task: `Local container deployment ${executionValidation.status} iteration ${deploymentFixIterations}`,
        toAgent: 'qa',
        artifact: 'DEPLOYMENT.md'
      });
    }

    await emit({
      agentId: 'qa',
      eventType: 'REVIEWING',
      task: `Re-run post-deployment E2E readiness review iteration ${deploymentFixIterations}`,
      artifact: 'POST_DEPLOY_QA_REPORT.md'
    });
    postDeploymentQaReview =
      deploymentReadiness.status === 'NEEDS_FIX'
        ? createDeploymentReadinessReview(deploymentReadiness.findings, deploymentReadiness.fixInstructions)
        : executionValidation?.status !== 'PASS'
          ? createContainerExecutionReview(executionValidation ?? createMissingContainerExecution(codeOutputDir))
        : reconcilePostDeploymentReviewWithWorkspace({
            qaReview: await runQAAgent({
              requirements: input.requirements,
              techSpec: input.techSpec,
              baOutput,
              devOutput,
              deploymentOutput,
              executionValidation,
              reviewStage: 'post_deploy',
              existingFiles,
              requirementImages: inputRequirementImages,
              productAssets,
              recentRuns
            }),
            deploymentOutput,
            devOutput,
            files: existingFiles
          });
  }

  if (postDeploymentQaReview.status === 'NEEDS_FIX') {
    const finalRepairScope = getPostDeploymentRepairScope({
      deploymentReadinessStatus: deploymentReadiness.status,
      executionValidation,
      qaReview: postDeploymentQaReview,
      files: existingFiles
    });
    const finalIssue =
      deploymentReadiness.status === 'PASS' && executionValidation?.status === 'NEEDS_FIX'
        ? createBlockingIssueFromExecution({
            validation: executionValidation,
            files: existingFiles
          })
        : createBlockingIssueFromReview({
            phaseDetected: deploymentReadiness.status === 'NEEDS_FIX' ? 'deployment_readiness' : 'post_deploy_qa',
            review: postDeploymentQaReview,
            files: existingFiles,
            repairScope: finalRepairScope
          });
    blockingIssues.push(finalIssue);
  }

  await emit({
    agentId: 'qa',
    eventType: 'TASK_COMPLETE',
    task: `Post-deployment E2E QA completed with status ${postDeploymentQaReview.status}`,
    artifact: 'POST_DEPLOY_QA_REPORT.md'
  });

  const result: RunResult = {
    runId,
    createdAt: new Date().toISOString(),
    topic,
    cleanGeneratedCode: input.cleanGeneratedCode,
    requirementImages,
    requirementImage,
    productAssets,
    autoDownloadProductAssets: input.autoDownloadProductAssets,
    assetOutput,
    assetFindings,
    baOutput,
    devOutput,
    qaOutput: qaReview.report,
    qaStatus: qaReview.status,
    qaFindings: qaReview.findings,
    qaFixIterations,
    buildReadinessFixIterations,
    preDeploymentGuardValidation,
    deploymentOutput,
    deploymentFixIterations,
    blockingIssues,
    executionValidation,
    postDeploymentQaOutput: postDeploymentQaReview.report,
    postDeploymentQaStatus: postDeploymentQaReview.status,
    postDeploymentQaFindings: postDeploymentQaReview.findings,
    postDeploymentQaFixIterations: deploymentFixIterations,
    events,
    outputDir: '',
    codeOutputDir
  };

  const resultWithSummary = withCoordinatorSummary(result);
  const outputDir = await saveRunResult(resultWithSummary);
  return { ...resultWithSummary, outputDir };
}
