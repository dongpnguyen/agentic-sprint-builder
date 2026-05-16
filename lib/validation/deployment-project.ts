import type { DeploymentOutput, DevOutput, GeneratedFile } from '@/lib/types';

export interface DeploymentProjectValidation {
  status: 'PASS' | 'NEEDS_FIX';
  findings: string[];
  fixInstructions: string;
}

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

function getFile(files: GeneratedFile[], filePath: string) {
  const normalized = normalizePath(filePath);
  return files.find((file) => normalizePath(file.path) === normalized);
}

function hasAnyPath(files: GeneratedFile[], prefix: string) {
  const normalizedPrefix = normalizePath(prefix);
  return files.some((file) => normalizePath(file.path).startsWith(normalizedPrefix));
}

function getComposeFile(files: GeneratedFile[]) {
  return files.find((file) => /(^|\/)(compose|docker-compose)\.ya?ml$/i.test(file.path));
}

function getLeadingSpaces(value: string) {
  return value.match(/^\s*/)?.[0].length ?? 0;
}

function getYamlBlock(content: string, key: string) {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim().toLowerCase() === `${key.toLowerCase()}:`);
  if (startIndex < 0) return '';

  const startIndent = getLeadingSpaces(lines[startIndex]);
  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim() && getLeadingSpaces(lines[index]) <= startIndent) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n');
}

function hasServiceHealthcheck(composeContent: string, serviceName: string) {
  const serviceBlock = getYamlBlock(composeContent, serviceName);
  return /healthcheck\s*:/i.test(serviceBlock);
}

function hasService(composeContent: string, serviceName: string) {
  return Boolean(getYamlBlock(composeContent, serviceName).trim());
}

function serviceHealthcheckUsesCurl(composeContent: string, serviceName: string) {
  const serviceBlock = getYamlBlock(composeContent, serviceName);
  return /healthcheck\s*:[\s\S]*\bcurl\b/i.test(serviceBlock);
}

function serviceHealthcheckUsesPath(composeContent: string, serviceName: string, path: string) {
  const serviceBlock = getYamlBlock(composeContent, serviceName);
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`localhost:\\d+${escapedPath}\\b|127\\.0\\.0\\.1:\\d+${escapedPath}\\b`, 'i').test(serviceBlock);
}

function serviceBindMountsSourceOverApp(composeContent: string, serviceName: string) {
  const serviceBlock = getYamlBlock(composeContent, serviceName);
  return new RegExp(`\\.\\/${serviceName}\\s*:\\s*/app(?:\\b|:)`, 'i').test(serviceBlock);
}

function dockerfileInstallsCurl(content: string) {
  return /\b(apt-get|apk|yum|dnf)\s+.*\binstall\b[\s\S]*\bcurl\b/i.test(content);
}

function dockerfileUsesNpmStart(content: string) {
  return /CMD\s+\[\s*["']npm["']\s*,\s*["']start["']\s*\]|\bnpm\s+start\b/i.test(content);
}

function dockerfileBuildsNextApp(content: string) {
  return /\bnpm\s+run\s+build\b|\byarn\s+build\b|\bpnpm\s+build\b/i.test(content);
}

function dockerfileUsesOutdatedNode(content: string) {
  return /^FROM\s+node:(?:1[0-8]|16)(?:\b|[-:])/im.test(content);
}

function hasSeedData(files: GeneratedFile[]) {
  return files.some((file) => /(^|\/)seed[-_a-z0-9]*\.(py|js|ts|sql)$/i.test(normalizePath(file.path)));
}

function backendUsesSqlite(files: GeneratedFile[]) {
  return files.some((file) => {
    const normalized = normalizePath(file.path);
    return normalized.startsWith('backend/') && /\.(py|toml|txt|env|ya?ml)$/i.test(normalized) && /sqlite:\/\/|sqlite3|\.db\b|\.sqlite\b/i.test(file.content);
  });
}

function composeHasSqliteService(composeContent: string) {
  return /image\s*:\s*["']?(?:[^"'\s/]+\/)?sqlite/i.test(composeContent) || hasService(composeContent, 'sqlite');
}

function composeBindMountsSqliteFile(composeContent: string) {
  return /(?:\.\/|~\/|[A-Za-z]:\\)[^\s'"]*\.(?:db|sqlite|sqlite3)\s*:/i.test(composeContent);
}

function dockerignoreExcludesSqliteRuntimeFiles(content: string) {
  return /(^|\n)\s*(?:\*\.db|database\.db|\*\.sqlite|\*\.sqlite3)\s*(?:\n|$)/i.test(content);
}

function hasFrontendHealthRoute(files: GeneratedFile[]) {
  return files.some((file) => {
    const normalized = normalizePath(file.path);
    return (
      /^frontend\/pages\/health\.(js|jsx|ts|tsx)$/.test(normalized) ||
      /^frontend\/pages\/api\/health\.(js|jsx|ts|tsx)$/.test(normalized) ||
      /^frontend\/app\/health\/(?:page|route)\.(js|jsx|ts|tsx)$/.test(normalized) ||
      /^frontend\/app\/api\/health\/route\.(js|jsx|ts|tsx)$/.test(normalized)
    );
  });
}

function backendHasHealthRoute(files: GeneratedFile[]) {
  return files.some((file) => {
    const normalized = normalizePath(file.path);
    return normalized.startsWith('backend/') && /\.(py|js|ts)$/i.test(normalized) && /["']\/health["']/.test(file.content);
  });
}

function deploymentText(params: {
  deploymentOutput: DeploymentOutput;
  devOutput: DevOutput;
  files: GeneratedFile[];
}) {
  const readme = getFile(params.files, 'README.md')?.content ?? '';
  return [
    params.deploymentOutput.summary,
    params.deploymentOutput.instructions,
    params.devOutput.setupInstructions,
    readme
  ].join('\n');
}

function containsCommand(text: string, command: string) {
  const normalizedText = text.replace(/\s+/g, ' ').toLowerCase();
  return normalizedText.includes(command.toLowerCase());
}

function containsContainerClearCommand(text: string, commandPrefix: 'docker compose' | 'nerdctl compose') {
  return text
    .split(/\r?\n/)
    .some((line) => {
      const normalized = line.replace(/\s+/g, ' ').toLowerCase();
      return (
        normalized.includes(commandPrefix) &&
        /\bdown\b/.test(normalized) &&
        normalized.includes('--remove-orphans') &&
        (normalized.includes('--volumes') || /\s-v(\s|$)/.test(normalized))
      );
    });
}

function hasClientSidePublicApiUsage(files: GeneratedFile[]) {
  return files.some((file) => {
    const normalized = normalizePath(file.path);
    return normalized.startsWith('frontend/') && /\.(js|jsx|ts|tsx)$/.test(normalized) && /NEXT_PUBLIC_API_BASE_URL/.test(file.content);
  });
}

export function validateDeploymentProject(params: {
  deploymentOutput: DeploymentOutput;
  devOutput: DevOutput;
  files: GeneratedFile[];
}): DeploymentProjectValidation {
  const findings: string[] = [];
  const compose = getComposeFile(params.files);
  const text = deploymentText(params);
  const hasFrontend = hasAnyPath(params.files, 'frontend/');
  const hasBackend = hasAnyPath(params.files, 'backend/');

  if (!compose) {
    findings.push('Deployment must include compose.yaml, compose.yml, docker-compose.yaml, or docker-compose.yml.');
  } else {
    if (/^\s*version\s*:/im.test(compose.content)) {
      findings.push('Compose file should omit the obsolete top-level version field.');
    }

    if (hasFrontend && !hasServiceHealthcheck(compose.content, 'frontend')) {
      findings.push('Docker Compose frontend service must include a healthcheck.');
    }

    if (hasBackend && !hasServiceHealthcheck(compose.content, 'backend')) {
      findings.push('Docker Compose backend service must include a healthcheck.');
    }

    if (hasFrontend && serviceHealthcheckUsesPath(compose.content, 'frontend', '/health') && !hasFrontendHealthRoute(params.files)) {
      findings.push('Frontend healthcheck targets /health, but the generated frontend does not define a /health route; add the route or healthcheck /.');
    }

    if (hasBackend && serviceHealthcheckUsesPath(compose.content, 'backend', '/health') && !backendHasHealthRoute(params.files)) {
      findings.push('Backend healthcheck targets /health, but the generated backend does not define a /health endpoint.');
    }

    if (hasFrontend && serviceBindMountsSourceOverApp(compose.content, 'frontend')) {
      findings.push('Frontend service must not bind mount ./frontend over /app in the runtime container because it masks image-built node_modules and .next output.');
    }

    if (hasBackend && serviceBindMountsSourceOverApp(compose.content, 'backend')) {
      findings.push('Backend service should not bind mount ./backend over /app in the runtime container; copy source during image build and use named volumes only for runtime data.');
    }

    if (hasClientSidePublicApiUsage(params.files) && /NEXT_PUBLIC_API_BASE_URL\s*=\s*http:\/\/backend\b/i.test(compose.content)) {
      findings.push('Browser-facing NEXT_PUBLIC_API_BASE_URL must use localhost, not the backend service DNS name.');
    }

    if (hasBackend && backendUsesSqlite(params.files)) {
      if (composeHasSqliteService(compose.content) || hasService(compose.content, 'db')) {
        findings.push('SQLite apps should not define a separate Compose database service; keep SQLite as an app-owned file or named volume.');
      }

      if (composeBindMountsSqliteFile(compose.content)) {
        findings.push('Compose must not bind mount missing SQLite files such as ./backend/database.db because Docker can create them as directories.');
      }
    }

    for (const serviceName of ['frontend', 'backend']) {
      const dockerfile = getFile(params.files, `${serviceName}/Dockerfile`);
      if (dockerfile && serviceHealthcheckUsesCurl(compose.content, serviceName) && !dockerfileInstallsCurl(dockerfile.content)) {
        findings.push(`${serviceName} healthcheck uses curl, but ${serviceName}/Dockerfile does not install curl.`);
      }

      if (dockerfile && serviceHealthcheckUsesCurl(compose.content, serviceName)) {
        findings.push(`${serviceName} healthcheck should use a runtime-native command instead of curl to avoid package-manager installs during image build.`);
      }
    }
  }

  if (hasFrontend && !getFile(params.files, 'frontend/Dockerfile')) {
    findings.push('Frontend deployment requires frontend/Dockerfile.');
  } else if (hasFrontend) {
    const frontendDockerfile = getFile(params.files, 'frontend/Dockerfile');
    if (frontendDockerfile && dockerfileUsesNpmStart(frontendDockerfile.content) && !dockerfileBuildsNextApp(frontendDockerfile.content)) {
      findings.push('Frontend Dockerfile runs npm start, so it must run npm run build during image build first.');
    }

    if (frontendDockerfile && dockerfileUsesOutdatedNode(frontendDockerfile.content)) {
      findings.push('Frontend Dockerfile should use a current Node LTS image such as node:20-bookworm-slim or node:20-alpine, not an outdated Node image.');
    }
  }

  if (hasBackend && !getFile(params.files, 'backend/Dockerfile')) {
    findings.push('Backend deployment requires backend/Dockerfile.');
  }

  if (hasFrontend && !getFile(params.files, 'frontend/.dockerignore')) {
    findings.push('Frontend deployment should include frontend/.dockerignore.');
  }

  if (hasBackend && !getFile(params.files, 'backend/.dockerignore')) {
    findings.push('Backend deployment should include backend/.dockerignore.');
  } else if (hasBackend && backendUsesSqlite(params.files)) {
    const backendDockerignore = getFile(params.files, 'backend/.dockerignore');
    if (backendDockerignore && !dockerignoreExcludesSqliteRuntimeFiles(backendDockerignore.content)) {
      findings.push('Backend .dockerignore should exclude SQLite runtime files such as *.db, *.sqlite, and *.sqlite3.');
    }
  }

  for (const command of [
    'docker compose build',
    'docker compose up -d',
    'docker compose ps',
    'docker compose logs',
    'docker compose down',
    'nerdctl compose build',
    'nerdctl compose up -d',
    'nerdctl compose ps',
    'nerdctl compose logs',
    'nerdctl compose down'
  ]) {
    if (!containsCommand(text, command)) {
      findings.push(`Deployment instructions should include \`${command}\`.`);
    }
  }

  if (!containsContainerClearCommand(text, 'docker compose')) {
    findings.push('Deployment instructions should clear any existing Docker Compose containers before deployment with `docker compose down --remove-orphans --volumes`.');
  }

  if (!containsContainerClearCommand(text, 'nerdctl compose')) {
    findings.push('Deployment instructions should clear any existing nerdctl Compose containers before deployment with `nerdctl compose down --remove-orphans --volumes`.');
  }

  if (hasSeedData(params.files) && !/seed|sample data|initial data/i.test(text)) {
    findings.push('Deployment/setup instructions should explain how seed data is created or when to run the seed script.');
  }

  return {
    status: findings.length > 0 ? 'NEEDS_FIX' : 'PASS',
    findings,
    fixInstructions:
      findings.length > 0
        ? `Fix these deployment readiness blockers:\n${findings.map((finding) => `- ${finding}`).join('\n')}`
        : ''
  };
}
