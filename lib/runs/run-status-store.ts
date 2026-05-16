import type { RunProgressStep, RunProgressUpdate, RunResult, RunStatusSnapshot } from '@/lib/types';

const MAX_LOGS = 500;

const DEFAULT_STEPS: RunProgressStep[] = [
  { id: 'ba', label: 'BA analysis', status: 'PENDING' },
  { id: 'asset', label: 'Asset preparation', status: 'PENDING' },
  { id: 'dev', label: 'DEV generation', status: 'PENDING' },
  { id: 'static-validation', label: 'Static readiness', status: 'PENDING' },
  { id: 'standard-guard', label: 'Standard Guard Mode', status: 'PENDING' },
  { id: 'execution-validation', label: 'Build/run/test validation', status: 'PENDING' },
  { id: 'qa', label: 'Code review', status: 'PENDING' },
  { id: 'deploy', label: 'Deployment packaging', status: 'PENDING' },
  { id: 'runtime', label: 'Local runtime', status: 'PENDING' },
  { id: 'complete', label: 'Done', status: 'PENDING' }
];

const globalForRuns = globalThis as typeof globalThis & {
  __agenticSprintRuns?: Map<string, RunStatusSnapshot>;
};

const runs = globalForRuns.__agenticSprintRuns ?? new Map<string, RunStatusSnapshot>();
globalForRuns.__agenticSprintRuns = runs;

function now() {
  return new Date().toISOString();
}

function cloneSteps() {
  return DEFAULT_STEPS.map((step) => ({ ...step }));
}

function ensureStep(snapshot: RunStatusSnapshot, stepId: string, label?: string) {
  let step = snapshot.steps.find((item) => item.id === stepId);
  if (!step) {
    step = { id: stepId, label: label || stepId, status: 'PENDING' };
    snapshot.steps.push(step);
  }

  if (label) step.label = label;
  return step;
}

function appendLog(snapshot: RunStatusSnapshot, update: RunProgressUpdate) {
  snapshot.logs.push({
    timestamp: now(),
    level: update.level || 'info',
    message: update.message
  });

  if (snapshot.logs.length > MAX_LOGS) {
    snapshot.logs.splice(0, snapshot.logs.length - MAX_LOGS);
  }
}

export function createRunStatus(runId: string, topic: string) {
  const timestamp = now();
  const snapshot: RunStatusSnapshot = {
    runId,
    status: 'QUEUED',
    createdAt: timestamp,
    updatedAt: timestamp,
    topic,
    steps: cloneSteps(),
    logs: [
      {
        timestamp,
        level: 'info',
        message: 'Run queued.'
      }
    ]
  };

  runs.set(runId, snapshot);
  return snapshot;
}

export function updateRunProgress(runId: string, update: RunProgressUpdate) {
  const snapshot = runs.get(runId);
  if (!snapshot) return null;

  snapshot.status = snapshot.status === 'QUEUED' ? 'RUNNING' : snapshot.status;
  snapshot.updatedAt = now();

  if (update.stepId) {
    const step = ensureStep(snapshot, update.stepId, update.stepLabel);
    if (update.stepStatus === 'RUNNING') {
      for (const item of snapshot.steps) {
        if (item.id !== update.stepId && item.status === 'RUNNING') {
          item.status = 'PASS';
        }
      }
    }
    if (update.stepStatus) step.status = update.stepStatus;
    snapshot.currentStepId = update.stepId;
  }

  appendLog(snapshot, update);
  return snapshot;
}

export function completeRunStatus(runId: string, result: RunResult) {
  const snapshot = runs.get(runId) ?? createRunStatus(runId, result.topic);
  const hasRuntimeFailures = result.runtime?.services.some((service) => service.status === 'FAILED') ?? false;
  const hasBlockingIssues =
    result.preDeploymentGuardValidation?.status === 'NEEDS_FIX' ||
    result.executionValidation?.status === 'NEEDS_FIX' ||
    result.qaStatus === 'NEEDS_FIX' ||
    result.postDeploymentQaStatus === 'NEEDS_FIX' ||
    hasRuntimeFailures;

  snapshot.status = 'COMPLETED';
  snapshot.updatedAt = now();
  snapshot.result = result;
  snapshot.currentStepId = 'complete';
  for (const step of snapshot.steps) {
    if (step.id !== 'complete' && (step.status === 'RUNNING' || step.status === 'PENDING')) {
      step.status = step.status === 'RUNNING' ? 'PASS' : 'SKIPPED';
    }
  }
  ensureStep(snapshot, 'complete').status = hasBlockingIssues ? 'FAIL' : 'PASS';
  appendLog(snapshot, {
    stepId: 'complete',
    stepStatus: hasBlockingIssues ? 'FAIL' : 'PASS',
    level: hasBlockingIssues ? 'warn' : 'success',
    message: hasBlockingIssues ? 'Run finished with blocking issues. Check failed steps above.' : 'Run completed.'
  });
  return snapshot;
}

export function failRunStatus(runId: string, error: unknown) {
  const snapshot = runs.get(runId);
  if (!snapshot) return null;

  const message = error instanceof Error ? error.message : String(error);
  snapshot.status = 'FAILED';
  snapshot.updatedAt = now();
  snapshot.error = message;

  if (snapshot.currentStepId) {
    ensureStep(snapshot, snapshot.currentStepId).status = 'FAIL';
  }

  appendLog(snapshot, {
    stepId: snapshot.currentStepId,
    stepStatus: 'FAIL',
    level: 'error',
    message
  });

  return snapshot;
}

export function getRunStatus(runId: string) {
  return runs.get(runId) ?? null;
}
