import type { DevOutput, GeneratedFile } from '@/lib/types';

interface AssetRename {
  oldPath: string;
  newPath: string;
  oldPublicUrl: string;
  newPublicUrl: string;
}

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, '/');
}

function decodeSvgDataUrl(content: string) {
  const trimmed = content.trim();
  if (trimmed.startsWith('<svg')) return trimmed;

  const match = trimmed.match(/^data:image\/svg\+xml(?:;charset=[^;,]+)?(;base64)?,(.*)$/is);
  if (!match) return null;

  try {
    return match[1] === ';base64'
      ? Buffer.from(match[2], 'base64').toString('utf-8')
      : decodeURIComponent(match[2]);
  } catch {
    return null;
  }
}

function convertTextSvgAsset(file: GeneratedFile): { file: GeneratedFile; rename?: AssetRename } {
  const normalized = normalizePath(file.path);
  const match = normalized.match(/^(frontend\/public\/images\/.+)\.(?:png|jpe?g|webp|gif)$/i);
  if (!match) return { file };

  const svg = decodeSvgDataUrl(file.content);
  if (!svg?.trim().startsWith('<svg')) return { file };

  const newPath = `${match[1]}.svg`;
  return {
    file: {
      path: newPath,
      content: svg
    },
    rename: {
      oldPath: normalized,
      newPath,
      oldPublicUrl: `/${normalized.replace(/^frontend\/public\//, '')}`,
      newPublicUrl: `/${newPath.replace(/^frontend\/public\//, '')}`
    }
  };
}

function applyRenames(value: string, renames: AssetRename[]) {
  return renames.reduce(
    (current, rename) =>
      current
        .split(rename.oldPublicUrl)
        .join(rename.newPublicUrl)
        .split(rename.oldPath)
        .join(rename.newPath),
    value
  );
}

export function normalizeGeneratedAssets(output: DevOutput): DevOutput {
  const renames: AssetRename[] = [];
  const convertedFiles = output.files.map((file) => {
    const converted = convertTextSvgAsset(file);
    if (converted.rename) renames.push(converted.rename);
    return converted.file;
  });

  if (renames.length === 0) return output;

  return {
    ...output,
    architecture: applyRenames(output.architecture, renames),
    setupInstructions: applyRenames(output.setupInstructions, renames),
    files: convertedFiles.map((file) => ({
      ...file,
      content: applyRenames(file.content, renames)
    }))
  };
}
