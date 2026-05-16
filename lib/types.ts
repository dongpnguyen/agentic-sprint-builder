export type AgentId = 'ba' | 'asset' | 'dev' | 'qa' | 'deploy';

export type DashboardEventType =
  | 'THINKING'
  | 'WORKING'
  | 'CODING'
  | 'REVIEWING'
  | 'WORK_COMPLETE'
  | 'REVIEW_REQUEST'
  | 'TASK_COMPLETE'
  | 'ERROR'
  | 'IDLE';

export interface AgentEvent {
  agentId: AgentId;
  eventType: DashboardEventType;
  task: string;
  toAgent?: AgentId;
  timestamp: string;
  dashboardAccepted?: boolean;
}

export interface RunRequest {
  requirements: string;
  techSpec?: string | null;
  apiSpec?: string;
  topic?: string;
  cleanGeneratedCode?: boolean;
  requirementImages?: RequirementImage[] | null;
  requirementImage?: RequirementImage | null;
  productAssets?: ProductAsset[] | null;
  autoDownloadProductAssets?: boolean;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface RequirementImage {
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  sizeBytes: number;
  dataUrl: string;
}

export type RequirementImageMetadata = Omit<RequirementImage, 'dataUrl'>;

export interface ProductAsset {
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  sizeBytes: number;
  dataUrl: string;
  originalName?: string;
  originalSizeBytes?: number;
  relativePath?: string;
  sourceUrl?: string;
  license?: string;
  licenseUrl?: string;
  creator?: string;
  provider?: string;
}

export interface ProductAssetMetadata extends Omit<ProductAsset, 'dataUrl'> {
  publicPath: string;
  outputPath: string;
}

export interface DevOutput {
  architecture: string;
  files: GeneratedFile[];
  setupInstructions: string;
}

export interface DeploymentOutput {
  summary: string;
  files: GeneratedFile[];
  instructions: string;
}

export type QAStatus = 'PASS' | 'NEEDS_FIX';

export interface QAReviewOutput {
  status: QAStatus;
  findings: string[];
  fixInstructions: string;
  report: string;
}

export type BlockingIssuePhase =
  | 'build_readiness'
  | 'code_review'
  | 'deployment_readiness'
  | 'container_runtime'
  | 'post_deploy_qa';

export type BlockingIssueOwner = 'dev' | 'deploy' | 'qa';

export type BlockingIssueSeverity = 'blocking' | 'warning';

export interface BlockingIssue {
  id: string;
  createdAt: string;
  phaseDetected: BlockingIssuePhase;
  owner: BlockingIssueOwner;
  severity: BlockingIssueSeverity;
  title: string;
  evidence: string;
  failingCommand?: string;
  suspectedFiles: string[];
  requiredFix: string;
  verifyWith: string[];
  repairScope?: RepairScope;
}

export interface AssetSearchQuery {
  label: string;
  searchTerm: string;
  role: 'hero' | 'product' | 'detail' | 'background';
  count: number;
  aspectRatio?: 'tall' | 'wide' | 'square' | 'any';
}

export interface AssetAgentOutput {
  summary: string;
  queries: AssetSearchQuery[];
  notes: string;
}

export interface RunResult {
  runId: string;
  createdAt: string;
  topic: string;
  cleanGeneratedCode?: boolean;
  requirementImages?: RequirementImageMetadata[];
  requirementImage?: RequirementImageMetadata;
  productAssets?: ProductAssetMetadata[];
  autoDownloadProductAssets?: boolean;
  assetOutput?: AssetAgentOutput;
  assetFindings?: string[];
  baOutput: string;
  devOutput: DevOutput;
  qaOutput: string;
  qaStatus?: QAStatus;
  qaFindings?: string[];
  qaFixIterations?: number;
  buildReadinessFixIterations?: number;
  preDeploymentGuardValidation?: GeneratedExecutionValidationResult;
  deploymentOutput?: DeploymentOutput;
  deploymentFixIterations?: number;
  blockingIssues?: BlockingIssue[];
  postDeploymentQaOutput?: string;
  postDeploymentQaStatus?: QAStatus;
  postDeploymentQaFindings?: string[];
  postDeploymentQaFixIterations?: number;
  executionValidation?: GeneratedExecutionValidationResult;
  runtime?: GeneratedRuntimeResult;
  runSummary?: string;
  events: AgentEvent[];
  outputDir: string;
  codeOutputDir: string;
}

export type RunProgressStepStatus = 'PENDING' | 'RUNNING' | 'PASS' | 'FAIL' | 'SKIPPED';

export interface RunProgressStep {
  id: string;
  label: string;
  status: RunProgressStepStatus;
}

export type RunProgressLevel = 'info' | 'success' | 'warn' | 'error';

export interface RunProgressUpdate {
  stepId?: string;
  stepLabel?: string;
  stepStatus?: RunProgressStepStatus;
  level?: RunProgressLevel;
  message: string;
}

export type RunProgressReporter = (update: RunProgressUpdate) => void | Promise<void>;

export interface RunProgressLog {
  timestamp: string;
  level: RunProgressLevel;
  message: string;
}

export interface RunStatusSnapshot {
  runId: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  createdAt: string;
  updatedAt: string;
  topic: string;
  currentStepId?: string;
  steps: RunProgressStep[];
  logs: RunProgressLog[];
  result?: RunResult;
  error?: string;
}

export type GeneratedValidationStepStatus = 'PASS' | 'FAIL' | 'SKIPPED';

export interface GeneratedValidationStep {
  name: string;
  status: GeneratedValidationStepStatus;
  command?: string;
  logFile?: string;
  message: string;
}

export type RepairScopeKind = 'docker' | 'frontend' | 'backend' | 'database' | 'tests' | 'docs' | 'config' | 'unknown';

export interface RepairScope {
  kind: RepairScopeKind;
  label: string;
  instructions: string;
  candidatePaths: string[];
  allowedDirectories: string[];
  requiresPlanning?: boolean;
}

export interface GeneratedExecutionValidationResult {
  status: 'PASS' | 'NEEDS_FIX' | 'SKIPPED';
  startedAt: string;
  finishedAt: string;
  workspace: string;
  findings: string[];
  fixInstructions: string;
  steps: GeneratedValidationStep[];
  repairScope?: RepairScope;
}

export interface GeneratedRuntimeServiceResult {
  name: 'backend' | 'frontend';
  status: 'RUNNING' | 'FAILED' | 'SKIPPED';
  cwd: string;
  command: string;
  message: string;
  url?: string;
  port?: number;
  pid?: number;
  logFile?: string;
}

export interface GeneratedRuntimeResult {
  startedAt: string;
  services: GeneratedRuntimeServiceResult[];
}
