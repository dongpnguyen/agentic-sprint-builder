import Link from 'next/link';
import { notFound } from 'next/navigation';
import { readRunResult } from '@/lib/storage/file-writer';
import { getRunTimelineEvents } from '@/lib/timeline';
import { formatBlockingIssueList } from '@/lib/validation/blocking-issues';

export const dynamic = 'force-dynamic';

export default async function RunOutputPage({ params }: { params: { runId: string } }) {
  const result = await readRunResult(params.runId);
  if (!result) notFound();

  return (
    <main className="min-h-screen p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="rounded-3xl bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Run Output</p>
              <h1 className="mt-2 text-4xl font-bold">{result.runId}</h1>
              <p className="mt-3 max-w-3xl text-slate-600">
                {result.topic} · {new Date(result.createdAt).toLocaleString()}
              </p>
              <p className="mt-2 text-sm font-semibold text-slate-700">Code Review Status: {result.qaStatus || 'Not recorded'}</p>
              <p className="mt-1 text-sm text-slate-500">Cleaned generated code before run: {result.cleanGeneratedCode ? 'Yes' : 'No'}</p>
              <p className="mt-1 text-sm text-slate-500">Requirement images: {formatRequirementImageNames(result)}</p>
              <p className="mt-1 text-sm text-slate-500">Product assets: {formatProductAssetNames(result)}</p>
              <p className="mt-1 text-sm text-slate-500">Auto-download product assets: {result.autoDownloadProductAssets ? 'Yes' : 'No'}</p>
              <p className="mt-1 text-sm font-semibold text-slate-700">Standard Guard Mode: {result.preDeploymentGuardValidation?.status || 'Not run'}</p>
              <p className="mt-1 text-sm text-slate-500">Build readiness fix iterations: {result.buildReadinessFixIterations ?? 0}</p>
              <p className="mt-1 text-sm text-slate-500">Code review fix iterations: {result.qaFixIterations ?? 0}</p>
              <p className="mt-1 text-sm font-semibold text-slate-700">Deployment: {result.deploymentOutput ? 'Completed' : 'Skipped until code review passes'}</p>
              <p className="mt-1 text-sm font-semibold text-slate-700">Container Runtime: {result.executionValidation?.status || 'Not run'}</p>
              <p className="mt-1 text-sm text-slate-500">Deployment fix iterations: {result.deploymentFixIterations ?? 0}</p>
              <p className="mt-1 text-sm text-slate-500">Post-deploy QA fix iterations: {result.postDeploymentQaFixIterations ?? 0}</p>
              <p className="mt-1 text-sm text-slate-500">Structured blockers: {result.blockingIssues?.length ?? 0}</p>
              <p className="mt-1 text-sm font-semibold text-slate-700">Post-Deploy QA Status: {result.postDeploymentQaStatus || 'Not recorded'}</p>
              <p className="mt-2 text-sm text-slate-500">Artifacts: {result.outputDir}</p>
              <p className="mt-1 text-sm text-slate-500">Generated code: {result.codeOutputDir}</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link href="/runs" className="rounded-2xl border border-slate-200 px-5 py-3 font-semibold hover:bg-slate-50">
                All Runs
              </Link>
              <Link href="/" className="rounded-2xl bg-slate-900 px-5 py-3 font-semibold text-white hover:bg-slate-800">
                New Run
              </Link>
            </div>
          </div>
        </section>

        <section className="rounded-3xl bg-white p-6 shadow-sm">
          <h2 className="text-2xl font-bold">Timeline</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {getRunTimelineEvents(result).map((event, index) => (
              <div key={`${event.timestamp}-${index}`} className="rounded-2xl border border-slate-200 p-4">
                <p className="text-sm font-bold uppercase text-blue-600">{event.agentId} · {event.eventType}</p>
                <p className="mt-2 text-sm text-slate-700">{event.task}</p>
                <p className="mt-2 text-xs text-slate-400">Dashboard: {event.dashboardAccepted ? 'accepted' : 'local only'}</p>
              </div>
            ))}
          </div>
        </section>

        {result.runSummary && <Artifact title="Coordinator Summary" content={result.runSummary} />}
        <Artifact title="BA Artifacts" content={result.baOutput} />
        {(result.assetOutput || result.assetFindings?.length) && <Artifact title="Asset Agent" content={formatAssetAgentArtifact(result)} />}
        {result.productAssets?.length && <Artifact title="Product Image Assets" content={formatProductAssetArtifact(result)} />}
        <Artifact title="Architecture" content={result.devOutput.architecture} />
        <Artifact
          title="Generated Files"
          content={result.devOutput.files.map((file) => `### ${file.path}\n\n\`\`\`\n${file.content}\n\`\`\``).join('\n\n')}
        />
        <Artifact title="Setup Instructions" content={result.devOutput.setupInstructions} />
        {result.preDeploymentGuardValidation && (
          <Artifact title="Standard Guard Mode" content={formatExecutionValidation(result.preDeploymentGuardValidation)} />
        )}
        {result.deploymentOutput && <Artifact title="Deployment Summary" content={result.deploymentOutput.summary} />}
        {result.deploymentOutput && (
          <Artifact
            title="Deployment Files"
            content={result.deploymentOutput.files.map((file) => `### ${file.path}\n\n\`\`\`\n${file.content}\n\`\`\``).join('\n\n')}
          />
        )}
        {result.deploymentOutput && <Artifact title="Deployment Instructions" content={result.deploymentOutput.instructions} />}
        {result.executionValidation && (
          <Artifact title="Container Deployment Execution" content={formatExecutionValidation(result.executionValidation)} />
        )}
        {result.blockingIssues?.length ? (
          <Artifact title="Structured Blocking Issues" content={formatBlockingIssueList(result.blockingIssues)} />
        ) : null}
        <Artifact title="Code Review Report" content={result.qaOutput} />
        {result.postDeploymentQaOutput && (
          <Artifact title="Post-Deployment E2E QA Report" content={result.postDeploymentQaOutput} />
        )}
      </div>
    </main>
  );
}

function formatRequirementImageNames(result: NonNullable<Awaited<ReturnType<typeof readRunResult>>>) {
  if (result.requirementImages?.length) {
    return result.requirementImages.map((image, index) => `${index + 1}. ${image.name}`).join(', ');
  }

  return result.requirementImage ? result.requirementImage.name : 'None';
}

function formatProductAssetNames(result: NonNullable<Awaited<ReturnType<typeof readRunResult>>>) {
  if (!result.productAssets?.length) return 'None';
  return result.productAssets.map((asset, index) => `${index + 1}. ${asset.publicPath}`).join(', ');
}

function formatProductAssetArtifact(result: NonNullable<Awaited<ReturnType<typeof readRunResult>>>) {
  return (
    result.productAssets
      ?.map((asset, index) =>
        [
          `## ${index + 1}. ${asset.originalName || asset.name}`,
          `Public path: ${asset.publicPath}`,
          `Output path: ${asset.outputPath}`,
          `Source path: ${asset.relativePath || 'Not recorded'}`,
          `Optimized size: ${asset.sizeBytes} bytes`,
          asset.originalSizeBytes ? `Original size: ${asset.originalSizeBytes} bytes` : '',
          asset.sourceUrl ? `Source URL: ${asset.sourceUrl}` : '',
          asset.license ? `License: ${asset.license}` : '',
          asset.licenseUrl ? `License URL: ${asset.licenseUrl}` : '',
          asset.creator ? `Creator: ${asset.creator}` : '',
          asset.provider ? `Provider: ${asset.provider}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      )
      .join('\n\n') || 'No product assets.'
  );
}

function formatAssetAgentArtifact(result: NonNullable<Awaited<ReturnType<typeof readRunResult>>>) {
  return [
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
  ].join('\n');
}

function formatExecutionValidation(executionValidation: NonNullable<NonNullable<Awaited<ReturnType<typeof readRunResult>>>['executionValidation']>) {
  return [
    `Status: ${executionValidation.status}`,
    `Workspace: ${executionValidation.workspace}`,
    `Started: ${executionValidation.startedAt}`,
    `Finished: ${executionValidation.finishedAt}`,
    '',
    'Findings:',
    ...(executionValidation.findings.length ? executionValidation.findings.map((finding) => `- ${finding}`) : ['- None']),
    '',
    'Steps:',
    ...executionValidation.steps.map((step) =>
      [
        `- ${step.name}: ${step.status}`,
        step.command ? `  Command: ${step.command}` : '',
        step.logFile ? `  Log: ${step.logFile}` : '',
        `  ${step.message}`
      ].filter(Boolean).join('\n')
    )
  ].join('\n');
}

function Artifact({ title, content }: { title: string; content: string }) {
  return (
    <details open className="rounded-3xl bg-white p-6 shadow-sm">
      <summary className="cursor-pointer text-xl font-bold">{title}</summary>
      <pre className="mt-4 max-h-[700px] overflow-auto whitespace-pre-wrap rounded-2xl bg-slate-950 p-4 text-sm text-slate-100">{content}</pre>
    </details>
  );
}
