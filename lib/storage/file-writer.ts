import fs from 'fs/promises';
import path from 'path';
import { RUN_LIMITS } from '@/lib/config/limits';
import { formatBlockingIssueList } from '@/lib/validation/blocking-issues';
import type { GeneratedFile, RunResult } from '@/lib/types';

function getGeneratedRunsDir() {
  return path.resolve(process.cwd(), 'generated-runs');
}

function getGeneratedCodeDir() {
  return path.resolve(process.cwd(), 'generated-code');
}

function assertInsideWorkspace(targetDir: string) {
  const workspace = path.resolve(process.cwd());
  const resolvedTarget = path.resolve(targetDir);
  const relative = path.relative(workspace, resolvedTarget);

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to modify path outside workspace: ${resolvedTarget}`);
  }
}

function validateRunId(runId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error('Invalid run id.');
  }
}

function getRunOutputDir(runId: string) {
  validateRunId(runId);
  return path.join(getGeneratedRunsDir(), runId);
}

function resolveGeneratedFilePath(base: string, target: string) {
  if (!target || target.includes('\0') || path.isAbsolute(target) || /^[a-zA-Z]:/.test(target)) {
    throw new Error(`Invalid generated file path: ${target}`);
  }

  const normalized = path.normalize(target);
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Generated file path escapes output directory: ${target}`);
  }

  const destination = path.resolve(base, normalized);
  const relative = path.relative(base, destination);

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Generated file path escapes output directory: ${target}`);
  }

  return destination;
}

function validateGeneratedFiles(files: GeneratedFile[]) {
  if (files.length > RUN_LIMITS.generatedFiles) {
    throw new Error(`Too many generated files. Limit is ${RUN_LIMITS.generatedFiles}.`);
  }

  let totalBytes = 0;
  for (const file of files) {
    const fileBytes = Buffer.byteLength(file.content, 'utf8');
    totalBytes += fileBytes;

    if (fileBytes > RUN_LIMITS.generatedFileBytes) {
      throw new Error(`Generated file ${file.path} exceeds ${RUN_LIMITS.generatedFileBytes} bytes.`);
    }
  }

  if (totalBytes > RUN_LIMITS.generatedTotalBytes) {
    throw new Error(`Generated files exceed ${RUN_LIMITS.generatedTotalBytes} total bytes.`);
  }
}

function shouldSkipSnapshotFile(filePath: string) {
  return /\.(?:png|jpe?g|webp|gif|ico|avif|bmp|tiff?|woff2?|ttf|otf|eot|pdf|zip|gz|tar|7z|exe|dll|db|sqlite3?|sqlite)$/i.test(filePath);
}

async function collectFiles(dir: string, baseDir = dir): Promise<GeneratedFile[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: GeneratedFile[] = [];
  for (const entry of entries) {
    if (
      entry.name === 'node_modules' ||
      entry.name === '.next' ||
      entry.name === '.git' ||
      entry.name === '.deployment-logs' ||
      entry.name === '.validation-logs' ||
      entry.name === '.runtime-logs' ||
      entry.name === '__pycache__' ||
      entry.name === '.pytest_cache'
    ) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath, baseDir)));
      continue;
    }

    if (!entry.isFile()) continue;

    const stat = await fs.stat(fullPath);
    if (stat.size > RUN_LIMITS.generatedFileBytes) continue;

    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    if (shouldSkipSnapshotFile(relativePath)) continue;

    const content = await fs.readFile(fullPath, 'utf-8');
    files.push({ path: relativePath, content });
  }

  return files;
}

export async function readGeneratedCodeSnapshot() {
  const files = await collectFiles(getGeneratedCodeDir());
  const limitedFiles: GeneratedFile[] = [];
  let totalBytes = 0;

  for (const file of files.slice(0, RUN_LIMITS.generatedFiles)) {
    const fileBytes = Buffer.byteLength(file.content, 'utf8');
    if (totalBytes + fileBytes > RUN_LIMITS.generatedTotalBytes) break;

    totalBytes += fileBytes;
    limitedFiles.push(file);
  }

  return limitedFiles;
}

export async function clearGeneratedCode() {
  const outputDir = getGeneratedCodeDir();
  assertInsideWorkspace(outputDir);
  await fs.rm(outputDir, { recursive: true, force: true });
  return outputDir;
}

export async function writeGeneratedFiles(files: GeneratedFile[]) {
  validateGeneratedFiles(files);

  const outputDir = getGeneratedCodeDir();
  await fs.mkdir(outputDir, { recursive: true });

  for (const file of files) {
    const destination = resolveGeneratedFilePath(outputDir, file.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file.content, 'utf-8');
  }

  return outputDir;
}

export async function saveRunResult(result: RunResult) {
  const outputDir = getRunOutputDir(result.runId);
  const resultWithOutputDir = { ...result, outputDir };

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'run-result.json'), JSON.stringify(resultWithOutputDir, null, 2));
  if (result.runSummary) {
    await fs.writeFile(path.join(outputDir, 'RUN_SUMMARY.md'), result.runSummary);
  }
  await fs.writeFile(path.join(outputDir, 'BA_ARTIFACTS.md'), result.baOutput);
  await fs.writeFile(path.join(outputDir, 'QA_REPORT.md'), result.qaOutput);
  if (result.assetOutput || result.assetFindings?.length) {
    await fs.writeFile(
      path.join(outputDir, 'ASSET_AGENT.md'),
      [
        '# Asset Agent',
        '',
        '## Summary',
        result.assetOutput?.summary || 'No asset agent output recorded.',
        '',
        '## Queries',
        ...(result.assetOutput?.queries.length
          ? result.assetOutput.queries.map(
              (query, index) =>
                `${index + 1}. ${query.label} - ${query.searchTerm} (${query.role}, count ${query.count}, aspect ${query.aspectRatio || 'any'})`
            )
          : ['No asset queries recorded.']),
        '',
        '## Findings',
        ...(result.assetFindings?.length ? result.assetFindings.map((finding) => `- ${finding}`) : ['- None']),
        '',
        '## Notes',
        result.assetOutput?.notes || 'None'
      ].join('\n')
    );
  }
  if (result.productAssets?.length) {
    await fs.writeFile(
      path.join(outputDir, 'PRODUCT_ASSETS.md'),
      [
        '# Product Image Assets',
        '',
        ...result.productAssets.map((asset, index) =>
          [
            `## ${index + 1}. ${asset.originalName || asset.name}`,
            '',
            `- Public path: ${asset.publicPath}`,
            `- Output path: ${asset.outputPath}`,
            `- Source path: ${asset.relativePath || 'Not recorded'}`,
            `- Optimized size: ${asset.sizeBytes} bytes`,
            asset.originalSizeBytes ? `- Original size: ${asset.originalSizeBytes} bytes` : '',
            asset.sourceUrl ? `- Source URL: ${asset.sourceUrl}` : '',
            asset.license ? `- License: ${asset.license}` : '',
            asset.licenseUrl ? `- License URL: ${asset.licenseUrl}` : '',
            asset.creator ? `- Creator: ${asset.creator}` : '',
            asset.provider ? `- Provider: ${asset.provider}` : ''
          ].filter(Boolean).join('\n')
        )
      ].join('\n')
    );
  }
  if (result.deploymentOutput) {
    await fs.writeFile(
      path.join(outputDir, 'DEPLOYMENT.md'),
      [
        '# Deployment',
        '',
        '## Summary',
        result.deploymentOutput.summary,
        '',
        '## Instructions',
        result.deploymentOutput.instructions,
        '',
        '## Files',
        ...result.deploymentOutput.files.map((file) => `### ${file.path}\n\n\`\`\`\n${file.content}\n\`\`\``)
      ].join('\n')
    );
  }
  if (result.blockingIssues?.length) {
    await fs.writeFile(path.join(outputDir, 'BLOCKING_ISSUES.md'), formatBlockingIssueList(result.blockingIssues));
  }
  if (result.postDeploymentQaOutput) {
    await fs.writeFile(path.join(outputDir, 'POST_DEPLOY_QA_REPORT.md'), result.postDeploymentQaOutput);
  }

  return outputDir;
}

export async function readRunResult(runId: string): Promise<RunResult | null> {
  try {
    const filePath = path.join(getRunOutputDir(runId), 'run-result.json');
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export async function listRunResults(): Promise<RunResult[]> {
  let entries;
  try {
    entries = await fs.readdir(getGeneratedRunsDir(), { withFileTypes: true });
  } catch {
    return [];
  }

  const results = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readRunResult(entry.name))
  );

  return results
    .filter((result): result is RunResult => result !== null)
    .sort((left, right) => right.runId.localeCompare(left.runId));
}
