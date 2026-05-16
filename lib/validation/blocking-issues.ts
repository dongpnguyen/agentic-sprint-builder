import type {
  BlockingIssue,
  BlockingIssueOwner,
  BlockingIssuePhase,
  GeneratedExecutionValidationResult,
  GeneratedFile,
  QAReviewOutput,
  RepairScope
} from '@/lib/types';

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function uniq(values: string[]) {
  const seen = new Set<string>();
  return values
    .map(normalizePath)
    .filter((value) => {
      const key = value.toLowerCase();
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function truncate(value: string, maxChars = 1_800) {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n...[truncated ${trimmed.length - maxChars} chars]`;
}

function phaseSlug(phase: BlockingIssuePhase) {
  return phase.replace(/_/g, '-');
}

function createIssueId(phase: BlockingIssuePhase, owner: BlockingIssueOwner) {
  return `${phaseSlug(phase)}-${owner}-${Date.now().toString(36)}`;
}

function titleFromPhase(phase: BlockingIssuePhase) {
  switch (phase) {
    case 'build_readiness':
      return 'Run/build readiness blocker';
    case 'code_review':
      return 'Code review blocker';
    case 'deployment_readiness':
      return 'Deployment packaging blocker';
    case 'container_runtime':
      return 'Container runtime blocker';
    case 'post_deploy_qa':
      return 'Post-deployment QA blocker';
  }
}

export function ownerFromRepairScope(scope: RepairScope | undefined, phase: BlockingIssuePhase): BlockingIssueOwner {
  if (!scope) return phase === 'deployment_readiness' || phase === 'container_runtime' ? 'deploy' : 'dev';
  if (['frontend', 'backend', 'database', 'tests'].includes(scope.kind)) return 'dev';
  if (['docker', 'docs', 'config'].includes(scope.kind)) return 'deploy';
  return phase === 'deployment_readiness' || phase === 'container_runtime' ? 'deploy' : 'dev';
}

function verificationSteps(owner: BlockingIssueOwner, phase: BlockingIssuePhase) {
  if (owner === 'dev') {
    return [
      'Re-run generated project static readiness checks.',
      'Rebuild and restart the local container deployment.',
      'Verify backend health, frontend health, seeded data, and affected API/UI flow.',
      'Run post-deployment QA again after deployment passes.'
    ];
  }

  if (phase === 'deployment_readiness') {
    return [
      'Re-run deployment readiness validation.',
      'Run docker compose config/build/up and health checks.',
      'Run post-deployment QA after containers pass.'
    ];
  }

  return [
    'Re-run docker compose down --remove-orphans --volumes.',
    'Rebuild and restart containers.',
    'Verify container health checks and smoke-test URLs.',
    'Run post-deployment QA again after deployment passes.'
  ];
}

function issueEvidenceFromReview(review: QAReviewOutput) {
  return truncate(
    [
      review.findings.length ? `Findings:\n${review.findings.map((finding) => `- ${finding}`).join('\n')}` : '',
      review.fixInstructions ? `Fix instructions:\n${review.fixInstructions}` : '',
      review.report ? `Report excerpt:\n${review.report}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
  );
}

function issueEvidenceFromExecution(validation: GeneratedExecutionValidationResult) {
  const failedSteps = validation.steps.filter((step) => step.status === 'FAIL');
  return truncate(
    [
      validation.findings.length ? `Findings:\n${validation.findings.map((finding) => `- ${finding}`).join('\n')}` : '',
      failedSteps.length
        ? `Failed steps:\n${failedSteps
            .map((step) =>
              [`- ${step.name}`, step.command ? `  Command: ${step.command}` : '', `  ${step.message}`].filter(Boolean).join('\n')
            )
            .join('\n')}`
        : '',
      validation.fixInstructions ? `Fix instructions:\n${validation.fixInstructions}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
  );
}

function filesFromRepairScope(scope: RepairScope | undefined, files: GeneratedFile[]) {
  const candidates = scope?.candidatePaths ?? [];
  if (candidates.length > 0) return uniq(candidates).slice(0, 12);

  return uniq(
    files
      .filter((file) => {
        const path = normalizePath(file.path).toLowerCase();
        return (
          path.endsWith('requirements.txt') ||
          path.endsWith('package.json') ||
          path.endsWith('dockerfile') ||
          path.endsWith('docker-compose.yml') ||
          path.endsWith('compose.yml') ||
          path.endsWith('.env.example') ||
          path.startsWith('backend/') ||
          path.startsWith('frontend/')
        );
      })
      .map((file) => file.path)
  ).slice(0, 12);
}

function firstFailingCommand(validation: GeneratedExecutionValidationResult) {
  return validation.steps.find((step) => step.status === 'FAIL' && step.command)?.command;
}

export function createBlockingIssueFromReview(params: {
  phaseDetected: Exclude<BlockingIssuePhase, 'container_runtime'>;
  review: QAReviewOutput;
  files: GeneratedFile[];
  repairScope?: RepairScope;
  owner?: BlockingIssueOwner;
}): BlockingIssue {
  const owner = params.owner ?? ownerFromRepairScope(params.repairScope, params.phaseDetected);
  return {
    id: createIssueId(params.phaseDetected, owner),
    createdAt: new Date().toISOString(),
    phaseDetected: params.phaseDetected,
    owner,
    severity: 'blocking',
    title: params.repairScope?.label || titleFromPhase(params.phaseDetected),
    evidence: issueEvidenceFromReview(params.review),
    suspectedFiles: filesFromRepairScope(params.repairScope, params.files),
    requiredFix: params.repairScope?.instructions || params.review.fixInstructions || 'Fix the blocker described by the findings.',
    verifyWith: verificationSteps(owner, params.phaseDetected),
    repairScope: params.repairScope
  };
}

export function createBlockingIssueFromExecution(params: {
  validation: GeneratedExecutionValidationResult;
  files: GeneratedFile[];
}): BlockingIssue {
  const phaseDetected: BlockingIssuePhase = 'container_runtime';
  const owner = ownerFromRepairScope(params.validation.repairScope, phaseDetected);
  return {
    id: createIssueId(phaseDetected, owner),
    createdAt: new Date().toISOString(),
    phaseDetected,
    owner,
    severity: 'blocking',
    title: params.validation.repairScope?.label || titleFromPhase(phaseDetected),
    evidence: issueEvidenceFromExecution(params.validation),
    failingCommand: firstFailingCommand(params.validation),
    suspectedFiles: filesFromRepairScope(params.validation.repairScope, params.files),
    requiredFix: params.validation.repairScope?.instructions || params.validation.fixInstructions || 'Fix the deployment execution failure.',
    verifyWith: verificationSteps(owner, phaseDetected),
    repairScope: params.validation.repairScope
  };
}

export function formatBlockingIssue(issue: BlockingIssue) {
  return [
    `Blocking issue: ${issue.id}`,
    `Detected phase: ${issue.phaseDetected}`,
    `Owner: ${issue.owner.toUpperCase()}`,
    `Severity: ${issue.severity}`,
    `Title: ${issue.title}`,
    issue.failingCommand ? `Failing command: ${issue.failingCommand}` : '',
    '',
    'Evidence:',
    issue.evidence || 'No evidence recorded.',
    '',
    'Suspected files:',
    ...(issue.suspectedFiles.length ? issue.suspectedFiles.map((filePath) => `- ${filePath}`) : ['- No direct file candidates detected.']),
    '',
    'Required fix:',
    issue.requiredFix,
    '',
    'Verify with:',
    ...issue.verifyWith.map((step) => `- ${step}`)
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function formatBlockingIssueList(issues: BlockingIssue[]) {
  if (issues.length === 0) return 'No blocking issues were recorded.';
  return issues.map((issue, index) => `# ${index + 1}. ${issue.title}\n\n${formatBlockingIssue(issue)}`).join('\n\n');
}
