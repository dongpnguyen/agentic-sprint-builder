import { RUN_LIMITS } from '@/lib/config/limits';
import type { AssetAgentOutput, AssetSearchQuery, ProductAsset } from '@/lib/types';

const OPENVERSE_IMAGES_ENDPOINT = 'https://api.openverse.engineering/v1/images/';
const DOWNLOAD_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 20_000;
const MAX_RESULTS_PER_QUERY = 12;
const SUPPORTED_MIME_TYPES: ProductAsset['mimeType'][] = ['image/jpeg', 'image/png', 'image/webp'];

interface OpenverseImageResult {
  id?: string;
  title?: string;
  creator?: string;
  provider?: string;
  source?: string;
  license?: string;
  license_url?: string;
  foreign_landing_url?: string;
  url?: string;
  thumbnail?: string;
  filesize?: number | null;
  filetype?: string | null;
  width?: number | null;
  height?: number | null;
  mature?: boolean;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
}

function extensionForMimeType(mimeType: ProductAsset['mimeType']) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  return 'webp';
}

function dataUrlFromBuffer(buffer: Buffer, mimeType: ProductAsset['mimeType']) {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function normalizeMimeType(value: string | null): ProductAsset['mimeType'] | null {
  const normalized = value?.split(';')[0].trim().toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  return SUPPORTED_MIME_TYPES.includes(normalized as ProductAsset['mimeType'])
    ? (normalized as ProductAsset['mimeType'])
    : null;
}

function inferMimeTypeFromUrl(url: string): ProductAsset['mimeType'] | null {
  const cleanUrl = url.split('?')[0].toLowerCase();
  if (/\.(jpe?g)$/.test(cleanUrl)) return 'image/jpeg';
  if (/\.png$/.test(cleanUrl)) return 'image/png';
  if (/\.webp$/.test(cleanUrl)) return 'image/webp';
  return null;
}

function withTimeout<T>(promiseFactory: (signal: AbortSignal) => Promise<T>, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return promiseFactory(controller.signal).finally(() => clearTimeout(timeout));
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  return withTimeout(async (signal) => {
    const response = await fetch(url, {
      signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'agentic-sprint-builder/1.0'
      }
    });
    if (!response.ok) throw new Error(`Openverse search failed ${response.status}: ${await response.text()}`);
    return (await response.json()) as T;
  }, timeoutMs);
}

function buildOpenverseSearchUrl(query: AssetSearchQuery) {
  const params = new URLSearchParams({
    q: query.searchTerm,
    page_size: String(MAX_RESULTS_PER_QUERY),
    license_type: 'commercial,modification',
    mature: 'false'
  });

  if (query.aspectRatio && query.aspectRatio !== 'any') {
    params.set('aspect_ratio', query.aspectRatio);
  }

  return `${OPENVERSE_IMAGES_ENDPOINT}?${params.toString()}`;
}

function scoreResult(result: OpenverseImageResult) {
  let score = 0;
  if (result.thumbnail) score += 4;
  if (result.url) score += 4;
  if (result.foreign_landing_url) score += 2;
  if (result.license_url) score += 2;
  if (result.creator) score += 1;
  if (result.filesize && result.filesize <= RUN_LIMITS.productAssetBytes) score += 2;
  if (result.width && result.height && result.width >= 500 && result.height >= 500) score += 2;
  if (result.mature) score -= 100;
  if (/logo|brand|store|sign|billboard/i.test(result.title || '')) score -= 3;
  return score;
}

async function searchOpenverse(query: AssetSearchQuery) {
  const data = await fetchJson<{ results?: OpenverseImageResult[] }>(buildOpenverseSearchUrl(query), SEARCH_TIMEOUT_MS);
  return (data.results ?? [])
    .filter((result) => !result.mature && (result.thumbnail || result.url))
    .sort((left, right) => scoreResult(right) - scoreResult(left));
}

async function downloadImage(url: string): Promise<{ buffer: Buffer; mimeType: ProductAsset['mimeType'] } | null> {
  return withTimeout(async (signal) => {
    const response = await fetch(url, {
      signal,
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8',
        'User-Agent': 'agentic-sprint-builder/1.0'
      }
    });
    if (!response.ok) return null;

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > RUN_LIMITS.productAssetBytes) return null;

    const mimeType = normalizeMimeType(response.headers.get('content-type')) || inferMimeTypeFromUrl(url);
    if (!mimeType) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > RUN_LIMITS.productAssetBytes) return null;
    return { buffer, mimeType };
  }, DOWNLOAD_TIMEOUT_MS).catch(() => null);
}

async function downloadResult(result: OpenverseImageResult) {
  const sourceUrls = [
    result.filesize && result.filesize <= RUN_LIMITS.productAssetBytes ? result.url : undefined,
    result.thumbnail,
    result.url
  ].filter((url): url is string => Boolean(url));

  for (const url of sourceUrls) {
    const downloaded = await downloadImage(url);
    if (downloaded) return downloaded;
  }

  return null;
}

function createAssetName(params: {
  query: AssetSearchQuery;
  result: OpenverseImageResult;
  index: number;
  mimeType: ProductAsset['mimeType'];
}) {
  const title = params.result.title || params.query.searchTerm;
  const label = slugify(params.query.label || params.query.searchTerm) || 'asset';
  const titleSlug = slugify(title) || `image-${params.index + 1}`;
  return `${label}-${String(params.index + 1).padStart(2, '0')}-${titleSlug}.${extensionForMimeType(params.mimeType)}`;
}

export async function downloadAutoProductAssets(assetOutput: AssetAgentOutput) {
  const assets: ProductAsset[] = [];
  const findings: string[] = [];
  const usedIds = new Set<string>();
  const usedUrls = new Set<string>();

  for (const query of assetOutput.queries) {
    if (assets.length >= RUN_LIMITS.productAssets) break;

    let results: OpenverseImageResult[] = [];
    try {
      results = await searchOpenverse(query);
    } catch (error) {
      findings.push(`Openverse search failed for "${query.searchTerm}": ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    let queryCount = 0;
    for (const result of results) {
      if (queryCount >= query.count || assets.length >= RUN_LIMITS.productAssets) break;

      const stableKey = result.id || result.foreign_landing_url || result.url || result.thumbnail;
      if (!stableKey || usedIds.has(stableKey) || (result.url && usedUrls.has(result.url))) continue;

      const downloaded = await downloadResult(result);
      if (!downloaded) continue;

      usedIds.add(stableKey);
      if (result.url) usedUrls.add(result.url);

      const assetName = createAssetName({
        query,
        result,
        index: queryCount,
        mimeType: downloaded.mimeType
      });
      assets.push({
        name: assetName,
        mimeType: downloaded.mimeType,
        sizeBytes: downloaded.buffer.length,
        dataUrl: dataUrlFromBuffer(downloaded.buffer, downloaded.mimeType),
        originalName: result.title || assetName,
        originalSizeBytes: result.filesize || undefined,
        relativePath: `auto-assets/${slugify(query.label || query.searchTerm)}/${assetName}`,
        sourceUrl: result.foreign_landing_url || result.url || result.thumbnail,
        license: result.license,
        licenseUrl: result.license_url,
        creator: result.creator,
        provider: result.provider || result.source
      });
      queryCount += 1;
    }

    if (queryCount === 0) {
      findings.push(`No downloadable lightweight image found for "${query.searchTerm}".`);
    }
  }

  return { assets, findings };
}
