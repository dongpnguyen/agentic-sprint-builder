import type { GeneratedExecutionValidationResult, GeneratedFile, RepairScope, RepairScopeKind } from '@/lib/types';
import type { GeneratedProjectValidation } from './generated-project';

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function lowerPath(filePath: string) {
  return normalizePath(filePath).toLowerCase();
}

function uniq(paths: string[]) {
  const seen = new Set<string>();
  return paths
    .map(normalizePath)
    .filter((filePath) => {
      const key = filePath.toLowerCase();
      if (!filePath || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function fileName(filePath: string) {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf('/');
  return (index >= 0 ? normalized.slice(index + 1) : normalized).toLowerCase();
}

function dirName(filePath: string) {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '.';
}

function topDirectory(filePath: string) {
  const normalized = normalizePath(filePath);
  const index = normalized.indexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '.';
}

function existingPaths(files: GeneratedFile[], predicate: (file: GeneratedFile) => boolean) {
  return files.filter(predicate).map((file) => normalizePath(file.path));
}

function pathLooksLikeTooling(file: GeneratedFile) {
  const name = fileName(file.path);
  return (
    name === 'dockerfile' ||
    name === 'containerfile' ||
    /^compose\.ya?ml$/.test(name) ||
    /^docker-compose\.ya?ml$/.test(name) ||
    name === 'package.json' ||
    name === 'pyproject.toml' ||
    name === 'requirements.txt' ||
    name === 'readme.md' ||
    name.endsWith('.env.example') ||
    name === '.env.example'
  );
}

function extractPathReferences(text: string) {
  const references: string[] = [];
  const patterns = [
    /(?:^|\s|["'`(])((?:\.\/)?[a-z0-9_.\-[\]@]+(?:\/[a-z0-9_.\-[\]@]+)+\.[a-z0-9]+)/gi,
    /(?:^|\s|["'`(])([a-z0-9_.\-[\]@]+(?:\/[a-z0-9_.\-[\]@]+)+)(?::\d+)?/gi
  ];

  for (const pattern of patterns) {
    for (const match of Array.from(text.matchAll(pattern))) {
      references.push(normalizePath(match[1]));
    }
  }

  return uniq(references);
}

function filesReferencedByText(files: GeneratedFile[], text: string) {
  const references = extractPathReferences(text);
  const matched: string[] = [];

  for (const file of files) {
    const filePath = lowerPath(file.path);
    const name = fileName(file.path);
    if (text.toLowerCase().includes(filePath) || text.toLowerCase().includes(name)) {
      matched.push(file.path);
      continue;
    }

    if (references.some((reference) => filePath === lowerPath(reference) || filePath.endsWith(`/${lowerPath(reference)}`) || lowerPath(reference).endsWith(`/${filePath}`))) {
      matched.push(file.path);
    }
  }

  return uniq(matched);
}

function dynamicCandidates(files: GeneratedFile[], kind: RepairScopeKind, text: string) {
  const referenced = filesReferencedByText(files, text);
  const lowerText = text.toLowerCase();
  const candidates = [...referenced];

  if (kind === 'docker') {
    candidates.push(
      ...existingPaths(files, (file) => {
        const name = fileName(file.path);
        return name === 'dockerfile' || name === 'containerfile' || /^compose\.ya?ml$/.test(name) || /^docker-compose\.ya?ml$/.test(name);
      })
    );
  }

  if (kind === 'frontend') {
    candidates.push(
      ...existingPaths(files, (file) => {
        const content = file.content.toLowerCase();
        const name = fileName(file.path);
        return name === 'package.json' || content.includes('next') || content.includes('react') || content.includes('vite') || /\.(tsx?|jsx?)$/.test(name);
      })
    );
  }

  if (kind === 'backend' || kind === 'database') {
    candidates.push(
      ...existingPaths(files, (file) => {
        const content = file.content.toLowerCase();
        const name = fileName(file.path);
        return name === 'requirements.txt' || name === 'pyproject.toml' || content.includes('fastapi') || content.includes('uvicorn') || content.includes('sqlmodel') || content.includes('database_url');
      })
    );
  }

  if (kind === 'tests') {
    candidates.push(
      ...existingPaths(files, (file) => {
        const path = lowerPath(file.path);
        const content = file.content.toLowerCase();
        return /(^|\/)(tests?|__tests__)\//.test(path) || /(\.|_)(test|spec)\./.test(path) || (fileName(file.path) === 'package.json' && content.includes('"test"'));
      })
    );
  }

  if (kind === 'docs' || kind === 'config') {
    candidates.push(
      ...existingPaths(files, (file) => {
        const name = fileName(file.path);
        return name === 'readme.md' || name.endsWith('.env.example') || name === '.env.example' || pathLooksLikeTooling(file);
      })
    );
  }

  if (lowerText.includes('environment') || lowerText.includes('env var') || lowerText.includes('database_url')) {
    candidates.push(...existingPaths(files, (file) => fileName(file.path).includes('.env')));
  }

  return uniq(candidates);
}

function dynamicDirectories(files: GeneratedFile[], candidatePaths: string[]) {
  const candidateDirs = candidatePaths.map(dirName);
  const topDirs = files.map((file) => topDirectory(file.path));
  return uniq([...candidateDirs, ...topDirs, '.']);
}

function createScope(params: {
  kind: RepairScopeKind;
  label: string;
  instructions: string;
  text: string;
  files: GeneratedFile[];
  requiresPlanning?: boolean;
}): RepairScope {
  const candidatePaths = dynamicCandidates(params.files, params.kind, params.text);

  return {
    kind: params.kind,
    label: params.label,
    instructions: params.instructions,
    candidatePaths,
    allowedDirectories: dynamicDirectories(params.files, candidatePaths),
    requiresPlanning: params.requiresPlanning
  };
}

export function formatRepairScope(scope?: RepairScope) {
  if (!scope) return 'No scoped repair constraints.';

  return [
    `Repair scope: ${scope.label} (${scope.kind})`,
    scope.instructions,
    scope.requiresPlanning ? 'This repair may create new files inside the allowed directories.' : 'Prefer editing the candidate files. Create new files only when the failure cannot be fixed by editing candidates.',
    'Candidate files from generated-code snapshot/logs:',
    ...(scope.candidatePaths.length ? scope.candidatePaths.map((filePath) => `- ${filePath}`) : ['- No direct candidate file was detected.']),
    'Allowed generated-code directories:',
    ...scope.allowedDirectories.map((directory) => `- ${directory}`)
  ].join('\n');
}

function validationText(validation: GeneratedExecutionValidationResult) {
  const failedSteps = validation.steps.filter((step) => step.status === 'FAIL');
  return [
    validation.findings.join('\n'),
    ...failedSteps.map((step) => `${step.name}\n${step.command || ''}\n${step.message}`)
  ].join('\n');
}

export function inferExecutionRepairScope(validation: GeneratedExecutionValidationResult, files: GeneratedFile[]): RepairScope {
  const text = validationText(validation);

  if (/pip install|requirements\.txt|no matching distribution found|could not find a version that satisfies|python standard-library|sqlmodel|sqlalchemy|fastapi|uvicorn/i.test(text)) {
    return createScope({
      kind: 'backend',
      label: 'Backend dependency/runtime repair',
      instructions: 'Fix generated backend dependency manifests or Python runtime code using files discovered from the generated-code snapshot and validation logs.',
      text,
      files
    });
  }

  if (/failed to solve|dockerfile|containerfile|compose config|invalid compose|bind for|port is already allocated|pull access denied|no such service/i.test(text)) {
    return createScope({
      kind: 'docker',
      label: 'Container build/runtime repair',
      instructions: 'Fix the generated project container build or runtime wiring using files discovered from the generated-code snapshot and validation logs.',
      text,
      files
    });
  }

  if (/module not found|can't resolve|next build|npm run build|failed to compile|typescript|eslint|vite|react/i.test(text)) {
    return createScope({
      kind: 'frontend',
      label: 'Frontend build repair',
      instructions: 'Fix generated frontend build errors using files discovered from the generated-code snapshot and validation logs.',
      text,
      files
    });
  }

  if (/pytest|tests?|no tests found|playwright|smoke test|test-results|eacces/i.test(text)) {
    return createScope({
      kind: 'tests',
      label: 'Generated test repair',
      instructions: 'Fix generated test scripts or create missing smoke tests inside existing generated project directories.',
      text,
      files,
      requiresPlanning: true
    });
  }

  if (/fastapi|uvicorn|traceback|importerror|modulenotfounderror|sqlalchemy|sqlmodel|database/i.test(text)) {
    return createScope({
      kind: 'backend',
      label: 'Backend runtime repair',
      instructions: 'Fix generated backend runtime errors using files discovered from the generated-code snapshot and validation logs.',
      text,
      files
    });
  }

  if (/docker|compose|healthcheck|service_healthy|container/i.test(text)) {
    return createScope({
      kind: 'docker',
      label: 'Container build/runtime repair',
      instructions: 'Fix the generated project container build or runtime wiring using files discovered from the generated-code snapshot and validation logs.',
      text,
      files
    });
  }

  return createScope({
    kind: 'unknown',
    label: 'Focused generated-code repair',
    instructions: 'Fix only generated-code files directly related to the validation failure.',
    text,
    files,
    requiresPlanning: true
  });
}

export function inferStaticRepairScope(validation: GeneratedProjectValidation, files: GeneratedFile[]): RepairScope {
  const text = `${validation.findings.join('\n')}\n${validation.fixInstructions}`;

  if (/smoke test|test file|pytest|no tests found|test script/i.test(text)) {
    return createScope({
      kind: 'tests',
      label: 'Static test-readiness repair',
      instructions: 'Add or fix generated test files and test scripts inside existing generated project directories.',
      text,
      files,
      requiresPlanning: true
    });
  }

  if (/docker|compose|dockerfile|container|healthcheck|service name|port/i.test(text)) {
    return createScope({
      kind: 'docker',
      label: 'Static container-readiness repair',
      instructions: 'Fix generated container/readiness files discovered from the current generated-code snapshot.',
      text,
      files
    });
  }

  if (/readme|\.env|setup instructions|environment variables|connection string/i.test(text)) {
    return createScope({
      kind: 'docs',
      label: 'Generated docs/env repair',
      instructions: 'Fix generated documentation or env example files discovered from the current generated-code snapshot.',
      text,
      files
    });
  }

  if (/frontend|next|react|tailwind|postcss|vite/i.test(text)) {
    return createScope({
      kind: 'frontend',
      label: 'Static frontend repair',
      instructions: 'Fix generated frontend files discovered from the current generated-code snapshot.',
      text,
      files
    });
  }

  if (/backend|fastapi|cors|health|database|migration|seed/i.test(text)) {
    return createScope({
      kind: /database|migration|seed/i.test(text) ? 'database' : 'backend',
      label: 'Static backend/data repair',
      instructions: 'Fix generated backend or data files discovered from the current generated-code snapshot.',
      text,
      files
    });
  }

  return createScope({
    kind: 'config',
    label: 'Static generated-code repair',
    instructions: 'Fix generated files related to the static readiness findings.',
    text,
    files,
    requiresPlanning: true
  });
}

export function inferQaRepairScope(qaFeedback: string, files: GeneratedFile[]): RepairScope {
  if (/pip install|requirements\.txt|no matching distribution found|could not find a version that satisfies|python standard-library|sqlmodel|sqlalchemy|fastapi|uvicorn/i.test(qaFeedback)) {
    return createScope({
      kind: 'backend',
      label: 'QA backend dependency/runtime repair',
      instructions: 'Fix generated backend dependency manifests or Python runtime code discovered from QA feedback and the generated-code snapshot.',
      text: qaFeedback,
      files
    });
  }

  if (/docker|compose|dockerfile|container|healthcheck|port/i.test(qaFeedback)) {
    return createScope({
      kind: 'docker',
      label: 'QA container repair',
      instructions: 'Fix generated container files discovered from QA feedback and the generated-code snapshot.',
      text: qaFeedback,
      files
    });
  }

  if (/tests?|pytest|playwright|smoke/i.test(qaFeedback)) {
    return createScope({
      kind: 'tests',
      label: 'QA test repair',
      instructions: 'Fix or create generated tests inside existing generated project directories.',
      text: qaFeedback,
      files,
      requiresPlanning: true
    });
  }

  if (/frontend|next|react|ui|browser|client|vite/i.test(qaFeedback)) {
    return createScope({
      kind: 'frontend',
      label: 'QA frontend repair',
      instructions: 'Fix generated frontend files discovered from QA feedback and the generated-code snapshot.',
      text: qaFeedback,
      files
    });
  }

  if (/backend|api|fastapi|database|migration|seed|cors|health/i.test(qaFeedback)) {
    return createScope({
      kind: /database|migration|seed/i.test(qaFeedback) ? 'database' : 'backend',
      label: 'QA backend/data repair',
      instructions: 'Fix generated backend or data files discovered from QA feedback and the generated-code snapshot.',
      text: qaFeedback,
      files
    });
  }

  return createScope({
    kind: 'unknown',
    label: 'QA focused generated-code repair',
    instructions: 'Fix only generated-code files directly related to QA feedback.',
    text: qaFeedback,
    files,
    requiresPlanning: true
  });
}
