import fs from 'fs/promises';
import path from 'path';
import { RUN_LIMITS } from '@/lib/config/limits';
import type { ProductAsset, ProductAssetMetadata } from '@/lib/types';

const PRODUCT_ASSET_OUTPUT_DIR = 'frontend/public/images/products';
const PRODUCT_ASSET_MANIFEST_PATH = `${PRODUCT_ASSET_OUTPUT_DIR}/product-assets.json`;

function getGeneratedCodeDir() {
  return path.resolve(process.cwd(), 'generated-code');
}

function assertInsideWorkspace(targetPath: string) {
  const workspace = path.resolve(process.cwd());
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(workspace, resolvedTarget);

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write product asset outside workspace: ${resolvedTarget}`);
  }
}

function extensionForMimeType(mimeType: ProductAsset['mimeType']) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  return 'webp';
}

function slugify(value: string) {
  return value
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function parseDataUrl(asset: ProductAsset) {
  const prefix = `data:${asset.mimeType};base64,`;
  if (!asset.dataUrl.startsWith(prefix)) {
    throw new Error(`Product asset ${asset.name} must be a matching base64 data URL.`);
  }

  const base64 = asset.dataUrl.slice(prefix.length);
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length !== asset.sizeBytes) {
    throw new Error(`Product asset ${asset.name} size metadata does not match encoded content.`);
  }

  if (buffer.length > RUN_LIMITS.productAssetBytes) {
    throw new Error(`Product asset ${asset.name} exceeds ${RUN_LIMITS.productAssetBytes} bytes after optimization.`);
  }

  return buffer;
}

export function getProductAssetManifestPath() {
  return PRODUCT_ASSET_MANIFEST_PATH;
}

export async function writeProductAssetManifest(productAssets: ProductAssetMetadata[]) {
  if (!productAssets.length) return;

  const generatedCodeDir = getGeneratedCodeDir();
  const manifestPath = path.join(generatedCodeDir, PRODUCT_ASSET_MANIFEST_PATH);
  assertInsideWorkspace(manifestPath);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        targetDirectory: PRODUCT_ASSET_OUTPUT_DIR,
        assets: productAssets
      },
      null,
      2
    ),
    'utf-8'
  );
}

export async function writeProductAssets(productAssets: ProductAsset[] = []): Promise<ProductAssetMetadata[]> {
  if (!productAssets.length) return [];
  if (productAssets.length > RUN_LIMITS.productAssets) {
    throw new Error(`Too many product assets. Limit is ${RUN_LIMITS.productAssets}.`);
  }

  const totalBytes = productAssets.reduce((sum, asset) => sum + asset.sizeBytes, 0);
  if (totalBytes > RUN_LIMITS.productAssetTotalBytes) {
    throw new Error(`Product assets exceed ${RUN_LIMITS.productAssetTotalBytes} total bytes after optimization.`);
  }

  const generatedCodeDir = getGeneratedCodeDir();
  const outputDir = path.join(generatedCodeDir, PRODUCT_ASSET_OUTPUT_DIR);
  assertInsideWorkspace(outputDir);
  await fs.mkdir(outputDir, { recursive: true });

  const writtenAssets: ProductAssetMetadata[] = [];
  for (let index = 0; index < productAssets.length; index += 1) {
    const asset = productAssets[index];
    const buffer = parseDataUrl(asset);
    const sourceName = asset.originalName || asset.relativePath || asset.name;
    const fileName = `product-${String(index + 1).padStart(2, '0')}-${slugify(sourceName) || 'image'}.${extensionForMimeType(asset.mimeType)}`;
    const outputPath = `${PRODUCT_ASSET_OUTPUT_DIR}/${fileName}`;
    const absoluteOutputPath = path.join(generatedCodeDir, outputPath);
    assertInsideWorkspace(absoluteOutputPath);
    await fs.writeFile(absoluteOutputPath, buffer);

    writtenAssets.push({
      name: fileName,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      originalName: asset.originalName || asset.name,
      originalSizeBytes: asset.originalSizeBytes,
      relativePath: asset.relativePath,
      sourceUrl: asset.sourceUrl,
      license: asset.license,
      licenseUrl: asset.licenseUrl,
      creator: asset.creator,
      provider: asset.provider,
      publicPath: `/images/products/${fileName}`,
      outputPath
    });
  }

  await writeProductAssetManifest(writtenAssets);
  return writtenAssets;
}
