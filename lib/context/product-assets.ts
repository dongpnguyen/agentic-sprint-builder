import type { ProductAssetMetadata } from '@/lib/types';

export function formatProductAssetSummary(productAssets: ProductAssetMetadata[]) {
  if (!productAssets.length) {
    return 'No product image assets were provided for this run.';
  }

  return productAssets
    .map((asset, index) => {
      const source = asset.relativePath || asset.originalName || asset.name;
      return [
        `${index + 1}. ${source}`,
        `publicPath=${asset.publicPath}`,
        `outputPath=${asset.outputPath}`,
        `mimeType=${asset.mimeType}`,
        `optimizedSize=${asset.sizeBytes} bytes`,
        asset.originalSizeBytes ? `originalSize=${asset.originalSizeBytes} bytes` : '',
        asset.sourceUrl ? `source=${asset.sourceUrl}` : '',
        asset.license ? `license=${asset.license}` : ''
      ]
        .filter(Boolean)
        .join('; ');
    })
    .join('\n');
}

export function formatProductAssetInstruction(productAssets: ProductAssetMetadata[]) {
  if (!productAssets.length) {
    return 'No product image assets are available. If product imagery is required, use valid SVG assets, safe external demo URLs, or CSS/inline visuals.';
  }

  return [
    'Product image assets have already been optimized and copied into the generated frontend public folder.',
    'Use the provided publicPath values directly in product seed data and UI image fields.',
    'Prefer these product assets over generated placeholder SVGs or external stock URLs.',
    'Do not generate raster image files as text placeholders and do not rewrite the copied asset files.',
    'Preserve image aspect ratio in product cards, detail pages, and galleries.',
    'If there are more products than assets, reuse assets intentionally and document the mapping in the architecture/setup notes.'
  ].join(' ');
}
