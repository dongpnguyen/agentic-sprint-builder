import type { BlockingIssue, RunResult } from '@/lib/types';

function status(value: string | undefined) {
  return value || 'Not run';
}

function countByOwner(issues: BlockingIssue[]) {
  return {
    dev: issues.filter((issue) => issue.owner === 'dev').length,
    deploy: issues.filter((issue) => issue.owner === 'deploy').length,
    qa: issues.filter((issue) => issue.owner === 'qa').length
  };
}

function currentOutcome(result: RunResult) {
  if (result.qaStatus === 'NEEDS_FIX') return 'NEEDS_FIX';
  if (result.preDeploymentGuardValidation?.status === 'NEEDS_FIX') return 'NEEDS_FIX';
  if (result.executionValidation?.status === 'NEEDS_FIX') return 'NEEDS_FIX';
  if (result.postDeploymentQaStatus === 'NEEDS_FIX') return 'NEEDS_FIX';
  if (result.executionValidation?.status === 'SKIPPED') return 'NEEDS_FIX';
  if (result.qaStatus === 'PASS' && result.executionValidation?.status === 'PASS' && result.postDeploymentQaStatus === 'PASS') return 'PASS';
  if (result.qaStatus === 'PASS' && !result.deploymentOutput) return 'INCOMPLETE';
  return 'INCOMPLETE';
}

function latestRelevantIssue(result: RunResult) {
  return result.blockingIssues?.[result.blockingIssues.length - 1];
}

function nextAction(result: RunResult) {
  const latestIssue = latestRelevantIssue(result);

  if (result.qaStatus === 'NEEDS_FIX') {
    if (result.preDeploymentGuardValidation?.status === 'NEEDS_FIX') {
      return 'DEV should fix the Standard Guard Mode blocker, then QA should re-review before deployment.';
    }

    return 'DEV should fix the remaining code-review blockers, then QA should re-review before deployment.';
  }

  if (!result.deploymentOutput) {
    return 'DEPLOY should package the app after code review passes.';
  }

  if (result.executionValidation?.status === 'NEEDS_FIX') {
    const owner = latestIssue?.owner === 'dev' ? 'DEV' : 'DEPLOY';
    return `${owner} should fix the latest container runtime blocker, then DEPLOY should rebuild/redeploy and QA should verify.`;
  }

  if (result.executionValidation?.status === 'SKIPPED') {
    return 'Enable local container execution, then DEPLOY should run the generated containers before post-deployment QA.';
  }

  if (result.postDeploymentQaStatus === 'NEEDS_FIX') {
    const owner = latestIssue?.owner === 'deploy' ? 'DEPLOY' : 'DEV';
    return `${owner} should fix the latest post-deployment blocker, then DEPLOY should redeploy and QA should run E2E readiness again.`;
  }

  if (currentOutcome(result) === 'PASS') {
    return 'No repair action is required. The generated product is ready for review in the browser.';
  }

  return 'Review the run artifacts and continue from the first phase that is not PASS.';
}

function formatIssueLine(issue: BlockingIssue, index: number) {
  return `${index + 1}. ${issue.owner.toUpperCase()} - ${issue.phaseDetected} - ${issue.title}`;
}

export function buildCoordinatorRunSummary(result: RunResult) {
  const issues = result.blockingIssues ?? [];
  const ownerCounts = countByOwner(issues);
  const latestIssue = latestRelevantIssue(result);
  const recentIssues = issues.slice(-5);

  return [
    '# Coordinator Run Summary',
    '',
    `Run ID: ${result.runId}`,
    `Topic: ${result.topic}`,
    `Overall status: ${currentOutcome(result)}`,
    '',
    '## Phase Status',
    `- BA: Completed`,
    `- DEV implementation: ${result.devOutput?.files?.length ? `Generated ${result.devOutput.files.length} file(s)` : 'No generated files recorded'}`,
    `- Standard Guard Mode: ${status(result.preDeploymentGuardValidation?.status)}`,
    `- Code review QA: ${status(result.qaStatus)}`,
    `- Deployment packaging: ${result.deploymentOutput ? 'Completed' : 'Skipped or not reached'}`,
    `- Container runtime: ${status(result.executionValidation?.status)}`,
    `- Post-deployment QA: ${status(result.postDeploymentQaStatus)}`,
    '',
    '## Repair Loop',
    `- Build readiness fixes: ${result.buildReadinessFixIterations ?? 0}`,
    `- Code review fixes: ${result.qaFixIterations ?? 0}`,
    `- Deployment/runtime fixes: ${result.deploymentFixIterations ?? 0}`,
    `- Structured blockers recorded: ${issues.length}`,
    `- DEV-owned blockers: ${ownerCounts.dev}`,
    `- DEPLOY-owned blockers: ${ownerCounts.deploy}`,
    `- QA-owned blockers: ${ownerCounts.qa}`,
    '',
    '## Latest Handoff',
    latestIssue
      ? [
          `- Owner: ${latestIssue.owner.toUpperCase()}`,
          `- Phase detected: ${latestIssue.phaseDetected}`,
          `- Title: ${latestIssue.title}`,
          latestIssue.failingCommand ? `- Failing command: ${latestIssue.failingCommand}` : '',
          `- Suspected files: ${latestIssue.suspectedFiles.length ? latestIssue.suspectedFiles.join(', ') : 'None detected'}`,
          `- Required fix: ${latestIssue.requiredFix}`
        ]
          .filter(Boolean)
          .join('\n')
      : '- No blocker handoff was needed.',
    '',
    '## Recent Blockers',
    ...(recentIssues.length ? recentIssues.map(formatIssueLine) : ['- None']),
    '',
    '## Next Action',
    nextAction(result)
  ].join('\n');
}
