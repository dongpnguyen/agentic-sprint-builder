function readPositiveIntEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const RUN_LIMITS = {
  requirementsChars: readPositiveIntEnv('MAX_REQUIREMENTS_CHARS', 20_000),
  techSpecChars: readPositiveIntEnv('MAX_TECH_SPEC_CHARS', 20_000),
  apiSpecChars: readPositiveIntEnv('MAX_API_SPEC_CHARS', 20_000),
  topicChars: readPositiveIntEnv('MAX_TOPIC_CHARS', 200),
  requirementImages: readPositiveIntEnv('MAX_REQUIREMENT_IMAGES', 8),
  requirementImageBytes: readPositiveIntEnv('MAX_REQUIREMENT_IMAGE_BYTES', 5 * 1024 * 1024),
  productAssets: readPositiveIntEnv('MAX_PRODUCT_ASSETS', 30),
  productAssetBytes: readPositiveIntEnv('MAX_PRODUCT_ASSET_BYTES', 2 * 1024 * 1024),
  productAssetTotalBytes: readPositiveIntEnv('MAX_PRODUCT_ASSET_TOTAL_BYTES', 20 * 1024 * 1024),
  generatedFiles: readPositiveIntEnv('MAX_GENERATED_FILES', 50),
  generatedFileBytes: readPositiveIntEnv('MAX_GENERATED_FILE_BYTES', 256 * 1024),
  generatedTotalBytes: readPositiveIntEnv('MAX_GENERATED_TOTAL_BYTES', 2 * 1024 * 1024)
};
