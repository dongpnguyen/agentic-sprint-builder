'use client';

import { useState } from 'react';
import type { ChangeEvent } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { getRunTimelineEvents } from '@/lib/timeline';
import { formatBlockingIssueList } from '@/lib/validation/blocking-issues';
import type { ProductAsset, RequirementImage, RunResult } from '@/lib/types';

const MAX_REQUIREMENT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REQUIREMENT_IMAGES = 8;
const MAX_PRODUCT_ASSET_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_PRODUCT_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_PRODUCT_ASSET_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_PRODUCT_ASSETS = 30;
const PRODUCT_ASSET_MAX_DIMENSION = 1200;
const PRODUCT_ASSET_QUALITIES = [0.84, 0.76, 0.68, 0.6];
const GENERATED_PRODUCT_URL = 'http://127.0.0.1:3000';
const SUPPORTED_REQUIREMENT_IMAGE_TYPES: RequirementImage['mimeType'][] = ['image/png', 'image/jpeg', 'image/webp'];
const SUPPORTED_PRODUCT_ASSET_TYPES: ProductAsset['mimeType'][] = ['image/png', 'image/jpeg', 'image/webp'];

const DEFAULT_REQUIREMENTS = `# Simple Shopping Cart App

## Overview
Build a full-stack Watch shopping cart app.

## In Scope
Only implement features defined below.

### Features
Only implement 2 pages:
1. Home Page – Product list page.
2. Product Detail Page – View details of a product.

Mockup files are provided for UI/UX, layout, header, footer, navigation bar, and menu.

## Out of Scope
- NFRs
- Implementing all features shown in mockups`;

const DEFAULT_TECH_SPEC = `# Simple Shopping Cart App

## Overview
Build a full-stack shopping cart app.

### Technical Stack
| Layer | Technology |
|---|---|
| Frontend | Next.js + Tailwind CSS |
| Backend | FastAPI + SQLModel |
| Database | SQLite |`;

export default function HomePage() {
  const [requirements, setRequirements] = useState(DEFAULT_REQUIREMENTS);
  const [techSpec, setTechSpec] = useState(DEFAULT_TECH_SPEC);
  const [requirementImages, setRequirementImages] = useState<RequirementImage[]>([]);
  const [productAssets, setProductAssets] = useState<ProductAsset[]>([]);
  const [autoDownloadProductAssets, setAutoDownloadProductAssets] = useState(false);
  const [cleanGeneratedCode, setCleanGeneratedCode] = useState(true);
  const [result, setResult] = useState<RunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showCompletionDialog, setShowCompletionDialog] = useState(false);

  async function loadRequirementImages(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;

    setError('');

    if (requirementImages.length + files.length > MAX_REQUIREMENT_IMAGES) {
      setError(`You can upload up to ${MAX_REQUIREMENT_IMAGES} requirement images.`);
      return;
    }

    for (const file of files) {
      if (!SUPPORTED_REQUIREMENT_IMAGE_TYPES.includes(file.type as RequirementImage['mimeType'])) {
        setError('Requirement images must be PNG, JPG, or WebP.');
        return;
      }

      if (file.size > MAX_REQUIREMENT_IMAGE_BYTES) {
        setError('Each requirement image must be 5 MB or smaller.');
        return;
      }
    }

    try {
      const loadedImages = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          mimeType: file.type as RequirementImage['mimeType'],
          sizeBytes: file.size,
          dataUrl: await readFileAsDataUrl(file)
        }))
      );
      setRequirementImages((current) => [...current, ...loadedImages]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load requirement images.');
    }
  }

  async function loadProductAssetFolder(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).filter((file) =>
      SUPPORTED_PRODUCT_ASSET_TYPES.includes(file.type as ProductAsset['mimeType'])
    );
    event.target.value = '';
    if (files.length === 0) {
      setError('Selected folder does not contain PNG, JPG, or WebP product images.');
      return;
    }

    setError('');

    if (files.length > MAX_PRODUCT_ASSETS) {
      setError(`Select a folder with ${MAX_PRODUCT_ASSETS} product images or fewer.`);
      return;
    }

    for (const file of files) {
      if (file.size > MAX_PRODUCT_ASSET_SOURCE_BYTES) {
        setError(`Product image ${file.name} is larger than ${(MAX_PRODUCT_ASSET_SOURCE_BYTES / 1024 / 1024).toFixed(0)} MB.`);
        return;
      }
    }

    try {
      const optimizedAssets = await Promise.all(files.map(optimizeProductAsset));
      const totalBytes = optimizedAssets.reduce((sum, asset) => sum + asset.sizeBytes, 0);
      if (totalBytes > MAX_PRODUCT_ASSET_TOTAL_BYTES) {
        setError(`Optimized product images are larger than ${(MAX_PRODUCT_ASSET_TOTAL_BYTES / 1024 / 1024).toFixed(0)} MB in total.`);
        return;
      }

      setProductAssets(optimizedAssets);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load product image assets.');
    }
  }

  async function runAgents() {
    setLoading(true);
    setError('');
    setResult(null);
    setShowCompletionDialog(false);
    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requirements,
          techSpec: techSpec.trim() ? techSpec : null,
          requirementImages,
          productAssets,
          autoDownloadProductAssets,
          cleanGeneratedCode,
          topic: 'Simple Shopping Cart App'
        })
      });
      const data = await response.json();
      if (!response.ok) {
        const issueText = Array.isArray(data.issues)
          ? data.issues
              .map((issue: { path?: string; message?: string }) =>
                `${issue.path || 'request'}: ${issue.message || 'Invalid value'}`
              )
              .join('\n')
          : '';
        throw new Error([data.error || 'Run failed', issueText].filter(Boolean).join('\n'));
      }
      setResult(data);
      setShowCompletionDialog(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function registerDashboard() {
    setError('');
    try {
      const response = await fetch('/api/dashboard/register', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Dashboard registration failed');
      alert(`Company created: ${data.company_id}\nCopy it into DASHBOARD_COMPANY_ID in .env.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }

  return (
    <main className="min-h-screen p-6">
      {loading && <ExecutingOverlay />}
      {showCompletionDialog && result && (
        <CompletionDialog
          result={result}
          productUrl={GENERATED_PRODUCT_URL}
          onClose={() => setShowCompletionDialog(false)}
        />
      )}
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="rounded-3xl bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">AI Tech Contest Phase 1</p>
              <h1 className="mt-2 text-4xl font-bold">Agentic Sprint Builder</h1>
              <p className="mt-3 max-w-3xl text-slate-600">
                Markdown-skill BA, DEV, QA, and DEPLOY agents read requirements, generate artifacts, write implementation files,
                and emit dashboard events through an orchestrated SDLC flow.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link href="/runs" className="rounded-2xl border border-slate-200 px-5 py-3 font-semibold hover:bg-slate-50">
                View Runs
              </Link>
              <button onClick={registerDashboard} className="rounded-2xl border border-slate-200 px-5 py-3 font-semibold hover:bg-slate-50">
                Register Dashboard Company
              </button>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <Editor title="requirements.md" value={requirements} onChange={setRequirements} />
          <Editor title="tech-spec.md optional" value={techSpec} onChange={setTechSpec} />
        </section>

        <RequirementImageInput
          images={requirementImages}
          disabled={loading}
          onLoad={loadRequirementImages}
          onRemove={(index) => setRequirementImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}
          onClear={() => setRequirementImages([])}
        />

        <ProductAssetFolderInput
          assets={productAssets}
          disabled={loading}
          autoDownload={autoDownloadProductAssets}
          onLoadFolder={loadProductAssetFolder}
          onClear={() => setProductAssets([])}
          onAutoDownloadChange={setAutoDownloadProductAssets}
        />

        <RunOptions
          cleanGeneratedCode={cleanGeneratedCode}
          disabled={loading}
          onCleanGeneratedCodeChange={setCleanGeneratedCode}
        />

        <div className="flex items-center gap-3">
          <button disabled={loading} onClick={runAgents} className="rounded-2xl bg-blue-600 px-6 py-3 font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-60">
            {loading ? 'Running AI Team...' : 'Run AI Team'}
          </button>
          {error && <p className="text-sm font-medium text-red-600">{error}</p>}
        </div>

        {result && <RunResultView result={result} />}
      </div>
    </main>
  );
}

function ExecutingOverlay() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm">
      <div className="w-[min(90vw,28rem)] rounded-2xl bg-white p-8 text-center shadow-2xl">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-slate-200 border-t-blue-600" />
        <p className="mt-6 text-2xl font-bold text-slate-950">Executing ...</p>
        <p className="mt-2 text-sm text-slate-500">The AI team is generating, reviewing, deploying, and testing the app.</p>
      </div>
    </div>
  );
}

function CompletionDialog(props: {
  result: RunResult;
  productUrl: string;
  onClose: () => void;
}) {
  const runtimeStatus = props.result.executionValidation?.status || 'Not run';
  const postDeployStatus = props.result.postDeploymentQaStatus || 'Not recorded';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="completion-dialog-title"
        className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="completion-dialog-title" className="text-2xl font-bold text-slate-950">Run Finished</h2>
            <p className="mt-2 text-sm text-slate-500">Run ID: {props.result.runId}</p>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-full border border-slate-200 px-3 py-1 text-sm font-semibold text-slate-600 hover:bg-slate-50"
            aria-label="Close completion dialog"
          >
            Close
          </button>
        </div>

        <div className="mt-5 grid gap-3 text-sm text-slate-700 sm:grid-cols-2">
          <div className="rounded-xl bg-slate-50 p-3">
            <p className="font-semibold text-slate-950">Container Runtime</p>
            <p className="mt-1">{runtimeStatus}</p>
          </div>
          <div className="rounded-xl bg-slate-50 p-3">
            <p className="font-semibold text-slate-950">Post-Deploy QA</p>
            <p className="mt-1">{postDeployStatus}</p>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <a
            href={props.productUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex justify-center rounded-2xl bg-blue-600 px-5 py-3 font-semibold text-white shadow-sm hover:bg-blue-700"
          >
            Open Generated Product
          </a>
          <Link
            href={`/runs/${props.result.runId}`}
            className="inline-flex justify-center rounded-2xl border border-slate-200 px-5 py-3 font-semibold hover:bg-slate-50"
            onClick={props.onClose}
          >
            View Run Output
          </Link>
        </div>
      </div>
    </div>
  );
}

function Editor(props: { title: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="block rounded-3xl bg-white p-5 shadow-sm">
      <span className="font-semibold">{props.title}</span>
      <textarea
        className="mt-3 h-80 w-full resize-y rounded-2xl border border-slate-200 bg-slate-50 p-4 font-mono text-sm"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function RunResultView({ result }: { result: RunResult }) {
  return (
    <section className="space-y-6">
      <div className="rounded-3xl bg-white p-6 shadow-sm">
        <h2 className="text-2xl font-bold">Run completed</h2>
        <p className="mt-1 text-sm text-slate-500">Run ID: {result.runId}</p>
        <p className="mt-1 text-sm text-slate-500">Cleaned generated code before run: {result.cleanGeneratedCode ? 'Yes' : 'No'}</p>
        <p className="mt-1 text-sm text-slate-500">Requirement images: {formatRequirementImageNames(result)}</p>
        <p className="mt-1 text-sm text-slate-500">Product assets: {formatProductAssetNames(result)}</p>
        <p className="mt-1 text-sm text-slate-500">Auto-download product assets: {result.autoDownloadProductAssets ? 'Yes' : 'No'}</p>
        <p className="mt-1 text-sm font-semibold text-slate-700">Code Review Status: {result.qaStatus || 'Not recorded'}</p>
        <p className="mt-1 text-sm font-semibold text-slate-700">Standard Guard Mode: {result.preDeploymentGuardValidation?.status || 'Not run'}</p>
        <p className="mt-1 text-sm text-slate-500">Build readiness fix iterations: {result.buildReadinessFixIterations ?? 0}</p>
        <p className="mt-1 text-sm text-slate-500">Code review fix iterations: {result.qaFixIterations ?? 0}</p>
        <p className="mt-1 text-sm font-semibold text-slate-700">Deployment: {result.deploymentOutput ? 'Completed' : 'Skipped until code review passes'}</p>
        <p className="mt-1 text-sm font-semibold text-slate-700">Container Runtime: {result.executionValidation?.status || 'Not run'}</p>
        <p className="mt-1 text-sm text-slate-500">Deployment fix iterations: {result.deploymentFixIterations ?? 0}</p>
        <p className="mt-1 text-sm text-slate-500">Post-deploy QA fix iterations: {result.postDeploymentQaFixIterations ?? 0}</p>
        <p className="mt-1 text-sm text-slate-500">Structured blockers: {result.blockingIssues?.length ?? 0}</p>
        <p className="mt-1 text-sm font-semibold text-slate-700">Post-Deploy QA Status: {result.postDeploymentQaStatus || 'Not recorded'}</p>
        <p className="mt-1 text-sm text-slate-500">Artifacts: {result.outputDir}</p>
        <p className="mt-1 text-sm text-slate-500">Generated code: {result.codeOutputDir}</p>
        <Link href={`/runs/${result.runId}`} className="mt-4 inline-flex rounded-2xl bg-slate-900 px-5 py-3 font-semibold text-white hover:bg-slate-800">
          Open run output
        </Link>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {getRunTimelineEvents(result).map((event, index) => (
            <div key={`${event.timestamp}-${index}`} className="rounded-2xl border border-slate-200 p-4">
              <p className="text-sm font-bold uppercase text-blue-600">{event.agentId} · {event.eventType}</p>
              <p className="mt-2 text-sm text-slate-700">{event.task}</p>
              <p className="mt-2 text-xs text-slate-400">Dashboard: {event.dashboardAccepted ? 'accepted' : 'local only'}</p>
            </div>
          ))}
        </div>
      </div>

      {result.runSummary && <Artifact title="Coordinator Summary" content={result.runSummary} />}
      <Artifact title="BA Artifacts" content={result.baOutput} />
      {(result.assetOutput || result.assetFindings?.length) && <Artifact title="Asset Agent" content={formatAssetAgentArtifact(result)} />}
      {result.productAssets?.length && <Artifact title="Product Image Assets" content={formatProductAssetArtifact(result)} />}
      <Artifact title="Architecture" content={result.devOutput.architecture} />
      <Artifact title="Generated Files" content={result.devOutput.files.map((file) => `### ${file.path}\n\n\`\`\`\n${file.content}\n\`\`\``).join('\n\n')} />
      <Artifact title="Setup Instructions" content={result.devOutput.setupInstructions} />
      {result.preDeploymentGuardValidation && (
        <Artifact
          title="Standard Guard Mode"
          content={formatExecutionValidation(result.preDeploymentGuardValidation)}
        />
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
        <Artifact
          title="Container Deployment Execution"
          content={formatExecutionValidation(result.executionValidation)}
        />
      )}
      {result.blockingIssues?.length ? <Artifact title="Structured Blocking Issues" content={formatBlockingIssueList(result.blockingIssues)} /> : null}
      <Artifact title="Code Review Report" content={result.qaOutput} />
      {result.postDeploymentQaOutput && <Artifact title="Post-Deployment E2E QA Report" content={result.postDeploymentQaOutput} />}
    </section>
  );
}

function RequirementImageInput(props: {
  images: RequirementImage[];
  disabled: boolean;
  onLoad: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
}) {
  return (
    <section className="rounded-3xl bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="font-semibold">Requirement images</h2>
          <p className="mt-1 text-sm text-slate-500">
            Upload PNG, JPG, or WebP mockups/screenshots. BA turns each image into a visual contract, DEV implements it, and QA tests against it.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="inline-flex cursor-pointer rounded-2xl border border-slate-200 px-5 py-3 font-semibold hover:bg-slate-50">
            Load Images
            <input
              className="sr-only"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              disabled={props.disabled}
              onChange={props.onLoad}
            />
          </label>
          {props.images.length > 0 && (
            <button
              type="button"
              disabled={props.disabled}
              onClick={props.onClear}
              className="rounded-2xl border border-slate-200 px-5 py-3 font-semibold hover:bg-slate-50 disabled:opacity-60"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {props.images.length > 0 && (
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {props.images.map((image, index) => (
            <div key={`${image.name}-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="overflow-hidden rounded-xl bg-white">
                <Image
                  src={image.dataUrl}
                  alt={`Requirement preview ${index + 1}`}
                  width={280}
                  height={224}
                  unoptimized
                  className="h-48 w-full object-contain"
                />
              </div>
              <div className="mt-3 text-sm text-slate-600">
                <p className="font-semibold text-slate-800">Page image {index + 1}</p>
                <p className="mt-1 truncate" title={image.name}>{image.name}</p>
                <p>Type: {image.mimeType}</p>
                <p>Size: {(image.sizeBytes / 1024).toFixed(1)} KB</p>
                <button
                  type="button"
                  disabled={props.disabled}
                  onClick={() => props.onRemove(index)}
                  className="mt-3 rounded-xl border border-slate-200 px-3 py-2 font-semibold hover:bg-white disabled:opacity-60"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <div className="rounded-2xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">
            {props.images.length} of {MAX_REQUIREMENT_IMAGES} images loaded. Image order is preserved through BA, DEV, and QA.
          </div>
        </div>
      )}
    </section>
  );
}

function ProductAssetFolderInput(props: {
  assets: ProductAsset[];
  disabled: boolean;
  autoDownload: boolean;
  onLoadFolder: (event: ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
  onAutoDownloadChange: (value: boolean) => void;
}) {
  const folderName = getProductAssetFolderName(props.assets);
  const totalBytes = props.assets.reduce((sum, asset) => sum + asset.sizeBytes, 0);

  return (
    <section className="rounded-3xl bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="font-semibold">Product image assets</h2>
          <p className="mt-1 text-sm text-slate-500">
            Browse a folder of PNG, JPG, or WebP product photos. Images are optimized to WebP and copied into the generated app as product catalog assets.
          </p>
          {folderName && <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Folder: {folderName}</p>}
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="inline-flex cursor-pointer rounded-2xl border border-slate-200 px-5 py-3 font-semibold hover:bg-slate-50">
            Browse Asset Folder
            <input
              className="sr-only"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              disabled={props.disabled}
              onChange={props.onLoadFolder}
              {...{ webkitdirectory: 'true', directory: 'true' }}
            />
          </label>
          {props.assets.length > 0 && (
            <button
              type="button"
              disabled={props.disabled}
              onClick={props.onClear}
              className="rounded-2xl border border-slate-200 px-5 py-3 font-semibold hover:bg-slate-50 disabled:opacity-60"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <label className="mt-4 flex items-start gap-3 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={props.autoDownload}
          disabled={props.disabled}
          onChange={(event) => props.onAutoDownloadChange(event.target.checked)}
          className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600 disabled:opacity-60"
        />
        <span>
          <span className="font-semibold text-slate-900">Auto-download similar product assets when this folder is empty</span>
          <span className="mt-1 block text-slate-500">
            An Asset Agent will infer needed product photos from the mockups, search openly licensed sources, and download lightweight images for DEV.
          </span>
        </span>
      </label>

      {props.assets.length > 0 && (
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {props.assets.slice(0, 10).map((asset, index) => (
            <div key={`${asset.relativePath || asset.name}-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="overflow-hidden rounded-xl bg-white">
                <Image
                  src={asset.dataUrl}
                  alt={`Product asset preview ${index + 1}`}
                  width={220}
                  height={176}
                  unoptimized
                  className="h-36 w-full object-contain"
                />
              </div>
              <div className="mt-3 text-xs text-slate-600">
                <p className="font-semibold text-slate-800">Asset {index + 1}</p>
                <p className="mt-1 truncate" title={asset.relativePath || asset.originalName || asset.name}>
                  {asset.relativePath || asset.originalName || asset.name}
                </p>
                <p>Optimized: {(asset.sizeBytes / 1024).toFixed(1)} KB</p>
                {asset.originalSizeBytes && <p>Original: {(asset.originalSizeBytes / 1024).toFixed(1)} KB</p>}
              </div>
            </div>
          ))}
          <div className="rounded-2xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">
            {props.assets.length} of {MAX_PRODUCT_ASSETS} assets loaded.
            <span className="mt-1 block">Optimized total: {(totalBytes / 1024 / 1024).toFixed(2)} MB.</span>
            {props.assets.length > 10 && <span className="mt-1 block">Showing first 10 previews.</span>}
          </div>
        </div>
      )}
    </section>
  );
}

function RunOptions(props: {
  cleanGeneratedCode: boolean;
  disabled: boolean;
  onCleanGeneratedCodeChange: (value: boolean) => void;
}) {
  return (
    <section className="rounded-3xl bg-white p-5 shadow-sm">
      <h2 className="font-semibold">Run options</h2>
      <label className="mt-4 flex items-start gap-3 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={props.cleanGeneratedCode}
          disabled={props.disabled}
          onChange={(event) => props.onCleanGeneratedCodeChange(event.target.checked)}
          className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600 disabled:opacity-60"
        />
        <span>
          <span className="font-semibold text-slate-900">Clean generated code before run</span>
          <span className="mt-1 block text-slate-500">
            Start from an empty generated-code workspace for new requirements. Turn this off when you want agents to patch the current generated app.
          </span>
        </span>
      </label>
    </section>
  );
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }

      reject(new Error('Could not read requirement image.'));
    };
    reader.onerror = () => reject(new Error('Could not read requirement image.'));
    reader.readAsDataURL(file);
  });
}

async function optimizeProductAsset(file: File): Promise<ProductAsset> {
  const image = await loadImageElement(file);
  const scale = Math.min(1, PRODUCT_ASSET_MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(`Could not optimize ${file.name}; canvas is unavailable.`);

  context.drawImage(image, 0, 0, width, height);

  let optimizedBlob: Blob | null = null;
  for (const quality of PRODUCT_ASSET_QUALITIES) {
    const blob = await canvasToBlob(canvas, 'image/webp', quality);
    if (!optimizedBlob || blob.size < optimizedBlob.size) optimizedBlob = blob;
    if (blob.size <= MAX_PRODUCT_ASSET_BYTES) {
      optimizedBlob = blob;
      break;
    }
  }

  if (!optimizedBlob) throw new Error(`Could not optimize ${file.name}.`);
  if (optimizedBlob.size > MAX_PRODUCT_ASSET_BYTES) {
    throw new Error(`${file.name} is still larger than ${(MAX_PRODUCT_ASSET_BYTES / 1024 / 1024).toFixed(0)} MB after optimization.`);
  }

  return {
    name: replaceFileExtension(file.name, 'webp'),
    originalName: file.name,
    originalSizeBytes: file.size,
    relativePath: file.webkitRelativePath || file.name,
    mimeType: 'image/webp',
    sizeBytes: optimizedBlob.size,
    dataUrl: await readBlobAsDataUrl(optimizedBlob)
  };
}

function loadImageElement(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new window.Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not decode product image ${file.name}.`));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }

        reject(new Error('Could not encode optimized product image.'));
      },
      type,
      quality
    );
  });
}

function readBlobAsDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }

      reject(new Error('Could not read optimized product asset.'));
    };
    reader.onerror = () => reject(new Error('Could not read optimized product asset.'));
    reader.readAsDataURL(blob);
  });
}

function replaceFileExtension(fileName: string, extension: string) {
  return `${fileName.replace(/\.[a-z0-9]+$/i, '')}.${extension}`;
}

function getProductAssetFolderName(assets: ProductAsset[]) {
  const firstRelativePath = assets[0]?.relativePath;
  if (!firstRelativePath?.includes('/')) return '';
  return firstRelativePath.split('/')[0];
}

function formatRequirementImageNames(result: RunResult) {
  if (result.requirementImages?.length) {
    return result.requirementImages.map((image, index) => `${index + 1}. ${image.name}`).join(', ');
  }

  return result.requirementImage ? result.requirementImage.name : 'None';
}

function formatProductAssetNames(result: RunResult) {
  if (!result.productAssets?.length) return 'None';
  return result.productAssets.map((asset, index) => `${index + 1}. ${asset.publicPath}`).join(', ');
}

function formatProductAssetArtifact(result: RunResult) {
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

function formatAssetAgentArtifact(result: RunResult) {
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

function formatExecutionValidation(executionValidation: NonNullable<RunResult['executionValidation']>) {
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
      <pre className="mt-4 max-h-[600px] overflow-auto whitespace-pre-wrap rounded-2xl bg-slate-950 p-4 text-sm text-slate-100">{content}</pre>
    </details>
  );
}
