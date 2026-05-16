import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { readGeneratedCodeSnapshot } from '@/lib/storage/file-writer';
import { inferExecutionRepairScope } from './repair-scope';
import type { GeneratedExecutionValidationResult, GeneratedValidationStep, RunProgressReporter } from '@/lib/types';

const COMMAND_TIMEOUT_MS = 180_000;
const HEALTH_TIMEOUT_MS = 45_000;
const LOG_TAIL_CHARS = 8_000;
const COMPOSE_PROJECT_NAME = 'agentic-sprint-builder-generated';

interface CommandResult {
  ok: boolean;
  output: string;
  error?: string;
}

interface ComposeEngine {
  name: 'docker compose' | 'nerdctl compose';
  command: string;
  baseArgs: string[];
}

const COMPOSE_ENGINES: ComposeEngine[] = [
  { name: 'docker compose', command: 'docker', baseArgs: ['compose'] },
  { name: 'nerdctl compose', command: 'nerdctl', baseArgs: ['compose'] }
];

function getGeneratedCodeDir() {
  return path.resolve(process.cwd(), 'generated-code');
}

function createValidationWorkspacePath() {
  return path.resolve(process.cwd(), 'generated-runs', '.validation-workspaces', Date.now().toString());
}

function commandName(name: string) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function quoteWindowsShellArg(value: string) {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function shouldRunThroughWindowsShell(command: string) {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
}

function getPythonCommandCandidates() {
  const configured = process.env.PYTHON?.trim();
  if (configured) return [configured];
  return process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
}

async function resolvePythonCommand(cwd: string) {
  for (const candidate of getPythonCommandCandidates()) {
    const version = await runCommand(candidate, ['--version'], cwd, 15_000);
    if (version.ok && !/python was not found|not recognized/i.test(version.output)) {
      return candidate;
    }
  }

  return null;
}

function getBackendPort() {
  return Number(process.env.GENERATED_BACKEND_PORT || 8000);
}

function getFrontendPort() {
  return Number(process.env.GENERATED_FRONTEND_PORT || 3000);
}

function shouldValidateExecution() {
  return process.env.VALIDATE_GENERATED_EXECUTION !== 'false';
}

function shouldRunStandardGuardMode() {
  return process.env.ENABLE_STANDARD_GUARD_MODE !== 'false';
}

function allowDockerValidation() {
  return process.env.ALLOW_GENERATED_DOCKER !== 'false';
}

function requireDeployedContainers() {
  return process.env.REQUIRE_DEPLOYED_CONTAINERS !== 'false';
}

function getPreferredComposeEngine() {
  const raw = process.env.GENERATED_COMPOSE_ENGINE?.trim().toLowerCase();
  if (raw === 'docker') return 'docker compose';
  if (raw === 'nerdctl') return 'nerdctl compose';
  return 'auto';
}

function maskSecrets(value: string) {
  return value
    .replace(/(api[_-]?key|token|secret|password)(["'\s:=]+)([^"'\s]+)/gi, '$1$2[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]');
}

function truncate(value: string, maxChars = LOG_TAIL_CHARS) {
  if (value.length <= maxChars) return value;
  return value.slice(value.length - maxChars);
}

async function pathExists(target: string) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function shouldSkipWorkspaceEntry(entryName: string) {
  return [
    'node_modules',
    '.next',
    '.git',
    '.venv',
    '.runtime-logs',
    '.validation-logs',
    '.deployment-logs',
    '.env',
    '__pycache__',
    '.pytest_cache'
  ].includes(entryName);
}

async function copyDirectoryForValidation(source: string, destination: string) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    if (shouldSkipWorkspaceEntry(entry.name)) continue;

    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryForValidation(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }
}

async function readJsonFile<T>(target: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(target, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function findFilesByName(dir: string, names: string[], ignored = new Set(['node_modules', '.next', '.git', '.venv', '.runtime-logs', '.validation-logs', '.deployment-logs', '__pycache__', '.pytest_cache'])): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const matches: string[] = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      matches.push(...(await findFilesByName(fullPath, names, ignored)));
    } else if (entry.isFile() && names.includes(entry.name.toLowerCase())) {
      matches.push(fullPath);
    }
  }

  return matches;
}

async function findNearestManifestDir(codeDir: string, names: string[], contentPattern?: RegExp) {
  const manifests = await findFilesByName(codeDir, names.map((name) => name.toLowerCase()));
  for (const manifest of manifests) {
    if (!contentPattern) return path.dirname(manifest);
    const content = await fs.readFile(manifest, 'utf-8');
    if (contentPattern.test(content)) return path.dirname(manifest);
  }

  return null;
}

async function writeLog(logDir: string, name: string, content: string) {
  await fs.mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `${name}.log`);
  await fs.writeFile(logFile, maskSecrets(content || '(no output)'), 'utf-8');
  return logFile;
}

async function removeDirectoryIfExists(target: string) {
  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory() && !stat.isFile()) return false;
    await fs.rm(target, { recursive: stat.isDirectory(), force: true });
    return true;
  } catch {
    return false;
  }
}

async function findRuntimeArtifactDirectories(dir: string, ignored = new Set(['node_modules', '.next', '.git', '.venv', '.runtime-logs', '.validation-logs', '.deployment-logs', '__pycache__', '.pytest_cache'])): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const matches: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && /\.(?:db|sqlite|sqlite3)$/i.test(entry.name)) {
      matches.push(fullPath);
      continue;
    }

    if (entry.isDirectory() && /\.(?:db|sqlite|sqlite3)$/i.test(entry.name)) {
      matches.push(fullPath);
      continue;
    }

    if (entry.isDirectory() && !ignored.has(entry.name)) {
      matches.push(...(await findRuntimeArtifactDirectories(fullPath, ignored)));
    }
  }

  return matches;
}

async function prepareContainerBuildWorkspace(codeDir: string, logDir: string): Promise<GeneratedValidationStep> {
  const removed: string[] = [];
  for (const artifactDir of await findRuntimeArtifactDirectories(codeDir)) {
    if (await removeDirectoryIfExists(artifactDir)) {
      removed.push(path.relative(codeDir, artifactDir).replace(/\\/g, '/'));
    }
  }

  const message = removed.length
    ? `Removed stale runtime artifacts before container build: ${removed.join(', ')}.`
    : 'No stale runtime artifacts were found.';
  const logFile = await writeLog(logDir, 'prepare-container-workspace', message);

  return {
    name: 'prepare container workspace',
    status: 'PASS',
    command: 'remove stale *.db/*.sqlite artifacts from generated build context',
    logFile,
    message
  };
}

function runCommand(command: string, args: string[], cwd: string, timeout = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve) => {
    const executable = shouldRunThroughWindowsShell(command) ? process.env.ComSpec || 'cmd.exe' : command;
    const executableArgs = shouldRunThroughWindowsShell(command)
      ? ['/d', '/s', '/c', [command, ...args].map(quoteWindowsShellArg).join(' ')]
      : args;

    try {
      execFile(executable, executableArgs, { cwd, timeout, windowsHide: true }, (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n');
        resolve({
          ok: !error,
          output,
          error: error instanceof Error ? error.message : undefined
        });
      });
    } catch (error) {
      resolve({
        ok: false,
        output: '',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

async function commandStep(params: {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  logDir: string;
  timeout?: number;
  onProgress?: RunProgressReporter;
}): Promise<GeneratedValidationStep> {
  const commandText = [params.command, ...params.args].join(' ');
  await params.onProgress?.({
    stepId: 'execution-validation',
    stepStatus: 'RUNNING',
    message: `Running: ${commandText}`
  });

  const result = await runCommand(params.command, params.args, params.cwd, params.timeout);
  const logFile = await writeLog(params.logDir, params.name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase(), result.output);
  await params.onProgress?.({
    stepId: 'execution-validation',
    stepStatus: result.ok ? 'RUNNING' : 'FAIL',
    level: result.ok ? 'success' : 'error',
    message: result.ok ? `${params.name} completed.` : `${params.name} failed. See ${logFile}.`
  });

  return {
    name: params.name,
    status: result.ok ? 'PASS' : 'FAIL',
    command: commandText,
    logFile,
    message: result.ok ? 'Command completed successfully.' : `${result.error || 'Command failed.'}\n${truncate(maskSecrets(result.output), 1200)}`
  };
}

function skippedStep(name: string, message: string, command?: string): GeneratedValidationStep {
  return {
    name,
    status: 'SKIPPED',
    command,
    message
  };
}

async function resolveComposeFile(codeDir: string) {
  for (const fileName of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    if (await pathExists(path.join(codeDir, fileName))) return fileName;
  }

  return null;
}

async function copyEnvExampleIfSafe(codeDir: string): Promise<GeneratedValidationStep> {
  const envExample = path.join(codeDir, '.env.example');
  const envFile = path.join(codeDir, '.env');

  if (!(await pathExists(envExample))) {
    return skippedStep('prepare env', 'No root .env.example file was generated.');
  }

  if (await pathExists(envFile)) {
    return skippedStep('prepare env', 'Root .env already exists; validation did not overwrite it.');
  }

  const content = await fs.readFile(envExample, 'utf-8');
  await fs.writeFile(envFile, content, 'utf-8');

  return {
    name: 'prepare env',
    status: 'PASS',
    command: 'copy .env.example .env',
    message: 'Created generated-code/.env from .env.example for local validation.'
  };
}

async function waitForHttp(name: string, urls: string[], timeoutMs = HEALTH_TIMEOUT_MS, onProgress?: RunProgressReporter): Promise<GeneratedValidationStep> {
  const startedAt = Date.now();
  let lastMessage = '';
  await onProgress?.({
    stepId: 'execution-validation',
    stepStatus: 'RUNNING',
    message: `Checking ${name}: ${urls.join(' or ')}`
  });

  while (Date.now() - startedAt < timeoutMs) {
    for (const url of urls) {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        const body = await response.text();
        if (response.ok) {
          await onProgress?.({
            stepId: 'execution-validation',
            stepStatus: 'RUNNING',
            level: 'success',
            message: `${name} passed at ${url}.`
          });
          return {
            name,
            status: 'PASS',
            command: `GET ${url}`,
            message: `${url} returned ${response.status}${body ? `: ${truncate(body, 500)}` : ''}`
          };
        }

        lastMessage = `${url} returned ${response.status}: ${truncate(body, 500)}`;
      } catch (error) {
        lastMessage = error instanceof Error ? error.message : String(error);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return {
    name,
    status: 'FAIL',
    command: urls.map((url) => `GET ${url}`).join(' || '),
    message: lastMessage || `Health check did not pass within ${timeoutMs}ms.`
  };
}

async function verifyCorsPreflight(onProgress?: RunProgressReporter): Promise<GeneratedValidationStep> {
  const origin = `http://localhost:${getFrontendPort()}`;
  const urls = [
    `http://127.0.0.1:${getBackendPort()}/health`,
    `http://localhost:${getBackendPort()}/health`
  ];

  await onProgress?.({
    stepId: 'execution-validation',
    stepStatus: 'RUNNING',
    message: `Checking backend CORS preflight for browser origin ${origin}.`
  });

  let lastMessage = '';
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'GET'
        }
      });
      const allowOrigin = response.headers.get('access-control-allow-origin');
      const vary = response.headers.get('vary');

      if (response.ok && (allowOrigin === origin || allowOrigin === '*')) {
        return {
          name: 'backend CORS preflight',
          status: 'PASS',
          command: `OPTIONS ${url} Origin: ${origin}`,
          message: `${url} allowed browser origin ${origin} with Access-Control-Allow-Origin: ${allowOrigin}${vary ? `; Vary: ${vary}` : ''}.`
        };
      }

      lastMessage = `${url} returned ${response.status}; Access-Control-Allow-Origin was ${allowOrigin || '(missing)'}.`;
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    name: 'backend CORS preflight',
    status: 'FAIL',
    command: urls.map((url) => `OPTIONS ${url} Origin: ${origin}`).join(' || '),
    message:
      lastMessage ||
      `Backend did not allow browser origin ${origin}. Configure CORS middleware for localhost/127.0.0.1 frontend origins.`
  };
}

function getBrowserCandidates() {
  const configured = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, process.env.BROWSER].filter(Boolean) as string[];
  const platformCandidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'msedge',
          'chrome'
        ]
      : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'];

  return [...configured, ...platformCandidates];
}

function isPathLikeCommand(command: string) {
  return path.isAbsolute(command) || /[\\/]/.test(command);
}

async function findHeadlessBrowser() {
  for (const browser of getBrowserCandidates()) {
    if (isPathLikeCommand(browser) && !(await pathExists(browser))) continue;

    const version = await runCommand(browser, ['--version'], process.cwd(), 15_000);
    if (version.ok) return browser;
  }

  return null;
}

function getScreenshotTargets() {
  const frontendPort = getFrontendPort();
  return [
    { name: 'home', url: `http://127.0.0.1:${frontendPort}/` },
    { name: 'product-1', url: `http://127.0.0.1:${frontendPort}/product/1` }
  ];
}

async function runScreenshotCommand(browser: string, screenshotPath: string, url: string) {
  const baseArgs = [
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,1000',
    `--screenshot=${screenshotPath}`,
    url
  ];

  const primary = await runCommand(browser, ['--headless=new', ...baseArgs], process.cwd(), 60_000);
  if (primary.ok && (await pathExists(screenshotPath))) return primary;

  const fallback = await runCommand(browser, ['--headless', ...baseArgs], process.cwd(), 60_000);
  if (fallback.ok && (await pathExists(screenshotPath))) return fallback;

  return {
    ok: false,
    output: [primary.output, fallback.output].filter(Boolean).join('\n'),
    error: primary.error || fallback.error
  };
}

async function captureDeploymentScreenshots(logDir: string, onProgress?: RunProgressReporter): Promise<GeneratedValidationStep> {
  await onProgress?.({
    stepId: 'execution-validation',
    stepStatus: 'RUNNING',
    message: 'Capturing browser screenshots for post-deployment QA evidence.'
  });

  const browser = await findHeadlessBrowser();
  if (!browser) {
    await onProgress?.({
      stepId: 'execution-validation',
      stepStatus: 'RUNNING',
      level: 'warn',
      message: 'No Chrome or Edge executable was found for screenshot capture.'
    });
    return skippedStep('deployment screenshots', 'No Chrome or Edge executable was found. Screenshot capture is optional evidence, so deployment was not blocked.');
  }

  const screenshotDir = path.join(logDir, 'screenshots');
  await fs.mkdir(screenshotDir, { recursive: true });

  const captured: string[] = [];
  const failures: string[] = [];
  for (const target of getScreenshotTargets()) {
    const screenshotPath = path.join(screenshotDir, `${target.name}.png`);
    await fs.rm(screenshotPath, { force: true }).catch(() => undefined);
    const result = await runScreenshotCommand(browser, screenshotPath, target.url);
    if (result.ok && (await pathExists(screenshotPath))) {
      captured.push(`${target.name}: ${screenshotPath}`);
    } else {
      failures.push(`${target.url}: ${result.error || truncate(maskSecrets(result.output), 500) || 'screenshot command failed'}`);
    }
  }

  const logFile = await writeLog(
    logDir,
    'deployment-screenshots',
    [`Browser: ${browser}`, 'Captured:', ...(captured.length ? captured : ['(none)']), 'Failures:', ...(failures.length ? failures : ['(none)'])].join('\n')
  );

  if (captured.length > 0) {
    await onProgress?.({
      stepId: 'execution-validation',
      stepStatus: 'RUNNING',
      level: 'success',
      message: `Captured ${captured.length} deployment screenshot(s).`
    });
    return {
      name: 'deployment screenshots',
      status: 'PASS',
      command: `${browser} --headless --screenshot`,
      logFile,
      message: `Captured browser screenshot evidence:\n${captured.join('\n')}${failures.length ? `\nNon-blocking capture failures:\n${failures.join('\n')}` : ''}`
    };
  }

  return {
    name: 'deployment screenshots',
    status: 'SKIPPED',
    command: `${browser} --headless --screenshot`,
    logFile,
    message: `Screenshot capture did not succeed, but this is optional QA evidence and does not block deployment.\n${failures.join('\n')}`
  };
}

async function collectComposeLogsForEngine(engine: ComposeEngine, codeDir: string, composeFile: string, logDir: string) {
  const args = [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'logs', '--tail=150'];
  if (engine.name === 'docker compose') args.splice(args.length - 1, 0, '--no-color');
  const result = await runCommand(engine.command, args, codeDir);
  const logFile = await writeLog(logDir, `${engine.name.replace(/\s+/g, '-')}-logs`, result.output);
  return { logFile, output: result.output };
}

async function composeLogsStep(engine: ComposeEngine, codeDir: string, composeFile: string, logDir: string): Promise<GeneratedValidationStep> {
  const logs = await collectComposeLogsForEngine(engine, codeDir, composeFile, logDir);
  return {
    name: `${engine.name} logs`,
    status: 'FAIL',
    command: `${engine.command} ${[...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'logs', '--tail=150'].join(' ')}`,
    logFile: logs.logFile,
    message: `Captured container logs after deployment failure.\n${truncate(maskSecrets(logs.output), 1200)}`
  };
}

async function verifySeededProducts(onProgress?: RunProgressReporter): Promise<GeneratedValidationStep> {
  const urls = [
    `http://127.0.0.1:${getBackendPort()}/products`,
    `http://localhost:${getBackendPort()}/products`
  ];
  await onProgress?.({
    stepId: 'execution-validation',
    stepStatus: 'RUNNING',
    message: `Verifying seeded product data: ${urls.join(' or ')}`
  });

  let lastMessage = '';
  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      const text = await response.text();
      if (!response.ok) {
        lastMessage = `${url} returned ${response.status}: ${truncate(text, 500)}`;
        continue;
      }

      const data = JSON.parse(text);
      if (Array.isArray(data) && data.length > 0) {
        return {
          name: 'seeded product data',
          status: 'PASS',
          command: `GET ${url}`,
          message: `${url} returned ${data.length} product(s).`
        };
      }

      lastMessage = `${url} returned no products: ${truncate(text, 500)}`;
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    name: 'seeded product data',
    status: 'FAIL',
    command: urls.map((url) => `GET ${url}`).join(' || '),
    message: lastMessage || 'Seeded product verification failed.'
  };
}

async function composeServiceStatusStep(engine: ComposeEngine, codeDir: string, composeFile: string, logDir: string): Promise<GeneratedValidationStep> {
  const args = [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'ps', '-a'];
  const result = await runCommand(engine.command, args, codeDir);
  const output = maskSecrets(result.output);
  const logFile = await writeLog(logDir, `${engine.name.replace(/\s+/g, '-')}-ps`, output);
  const hasExitedService = /\b(?:exited|dead|removing)\b/i.test(output);
  const status = result.ok && !hasExitedService ? 'PASS' : 'FAIL';

  return {
    name: `${engine.name} service status`,
    status,
    command: `${engine.command} ${args.join(' ')}`,
    logFile,
    message:
      status === 'PASS'
        ? `Compose services are running.\n${truncate(output, 1200)}`
        : `One or more Compose services are not running.\n${truncate(output || result.error || 'No service status output.', 1200)}`
  };
}

function getComposeEnginesToTry() {
  const preferred = getPreferredComposeEngine();
  if (preferred === 'auto') return COMPOSE_ENGINES;
  return COMPOSE_ENGINES.filter((engine) => engine.name === preferred);
}

async function validateWithDockerCompose(codeDir: string, composeFile: string, logDir: string, onProgress?: RunProgressReporter): Promise<GeneratedValidationStep[]> {
  const steps: GeneratedValidationStep[] = [];

  if (!allowDockerValidation()) {
    steps.push(skippedStep('docker compose validation', 'ALLOW_GENERATED_DOCKER=false; Docker Compose execution was skipped.'));
    return steps;
  }

  const engines = getComposeEnginesToTry();
  if (engines.length === 0) {
    steps.push(skippedStep('compose validation', `Unsupported GENERATED_COMPOSE_ENGINE=${process.env.GENERATED_COMPOSE_ENGINE}. Use auto, docker, or nerdctl.`));
    return steps;
  }

  for (const engine of engines) {
    const version = await commandStep({
      name: `${engine.name} version`,
      command: engine.command,
      args: [...engine.baseArgs, 'version'],
      cwd: codeDir,
      logDir,
      onProgress
    });

    if (version.status === 'FAIL') {
      steps.push({
        ...version,
        status: 'SKIPPED',
        message: `${engine.name} is not available for execution validation on this machine. ${version.message}`
      });
      continue;
    }
    steps.push(version);

    steps.push(await prepareContainerBuildWorkspace(codeDir, logDir));

    const config = await commandStep({
      name: `${engine.name} config`,
      command: engine.command,
      args: [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'config'],
      cwd: codeDir,
      logDir,
      onProgress
    });
    steps.push(config);
    if (config.status === 'FAIL') return steps;

    const down = await commandStep({
      name: `${engine.name} clear existing containers`,
      command: engine.command,
      args: [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'down', '--remove-orphans', '--volumes'],
      cwd: codeDir,
      logDir,
      timeout: 120_000,
      onProgress
    });
    steps.push(down);
    if (down.status === 'FAIL') return steps;

    const up = await commandStep({
      name: `${engine.name} up`,
      command: engine.command,
      args: [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'up', '-d', '--build'],
      cwd: codeDir,
      logDir,
      timeout: 300_000,
      onProgress
    });
    steps.push(up);

    if (up.status === 'FAIL') {
      steps.push(await composeLogsStep(engine, codeDir, composeFile, logDir));
      return steps;
    }

    const serviceStatus = await composeServiceStatusStep(engine, codeDir, composeFile, logDir);
    steps.push(serviceStatus);
    if (serviceStatus.status === 'FAIL') {
      steps.push(await composeLogsStep(engine, codeDir, composeFile, logDir));
      return steps;
    }

    const backendHealth = await waitForHttp('backend health', [
        `http://127.0.0.1:${getBackendPort()}/health`,
        `http://localhost:${getBackendPort()}/health`
      ], HEALTH_TIMEOUT_MS, onProgress);
    steps.push(backendHealth);
    if (backendHealth.status === 'FAIL') {
      steps.push(await composeLogsStep(engine, codeDir, composeFile, logDir));
      return steps;
    }

    const backendCors = await verifyCorsPreflight(onProgress);
    steps.push(backendCors);
    if (backendCors.status === 'FAIL') {
      steps.push(await composeLogsStep(engine, codeDir, composeFile, logDir));
      return steps;
    }

    if (await pathExists(path.join(codeDir, 'backend', 'seed_data.py'))) {
      const seedData = await commandStep({
          name: `${engine.name} seed data`,
          command: engine.command,
          args: [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'exec', '-T', 'backend', 'python', 'seed_data.py'],
          cwd: codeDir,
          logDir,
          timeout: 120_000,
          onProgress
        });
      steps.push(seedData);
      if (seedData.status === 'FAIL') {
        steps.push(await composeLogsStep(engine, codeDir, composeFile, logDir));
        return steps;
      }

      const seededProducts = await verifySeededProducts(onProgress);
      steps.push(seededProducts);
      if (seededProducts.status === 'FAIL') {
        steps.push(await composeLogsStep(engine, codeDir, composeFile, logDir));
        return steps;
      }
    } else {
      steps.push(skippedStep('seed data', 'No backend/seed_data.py script was generated.'));
    }

    const frontendHealth = await waitForHttp('frontend health', [`http://127.0.0.1:${getFrontendPort()}/`, `http://localhost:${getFrontendPort()}/`], HEALTH_TIMEOUT_MS, onProgress);
    steps.push(frontendHealth);
    if (frontendHealth.status === 'FAIL') {
      steps.push(await composeLogsStep(engine, codeDir, composeFile, logDir));
      return steps;
    }

    steps.push(await captureDeploymentScreenshots(logDir, onProgress));

    const backendTestsExist = (await pathExists(path.join(codeDir, 'backend', 'tests'))) || (await pathExists(path.join(codeDir, 'backend', 'app', 'tests')));
    if (backendTestsExist) {
      steps.push(
        await commandStep({
          name: 'backend tests',
          command: engine.command,
          args: [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'exec', '-T', 'backend', 'pytest'],
          cwd: codeDir,
          logDir,
          timeout: 180_000,
          onProgress
        })
      );
    } else {
      steps.push(skippedStep('backend tests', 'No backend tests directory was generated.'));
    }

    const packageJson = await readJsonFile<{ scripts?: Record<string, string> }>(path.join(codeDir, 'frontend', 'package.json'));
    if (packageJson?.scripts?.test) {
      steps.push(
        await commandStep({
          name: 'frontend tests',
          command: engine.command,
          args: [...engine.baseArgs, '-f', composeFile, '-p', COMPOSE_PROJECT_NAME, 'exec', '-T', 'frontend', 'npm', 'test'],
          cwd: codeDir,
          logDir,
          timeout: 180_000,
          onProgress
        })
      );
    } else {
      steps.push(skippedStep('frontend tests', 'No frontend test script was generated.'));
    }

    return steps;
  }

  return steps;
}

async function validateLocalNode(codeDir: string, logDir: string, onProgress?: RunProgressReporter): Promise<GeneratedValidationStep[]> {
  const frontendDir = await findNearestManifestDir(codeDir, ['package.json'], /next|react|vite/i);
  if (!frontendDir) return [skippedStep('frontend local validation', 'No generated frontend package manifest was found.')];
  const packageJson = await readJsonFile<{ scripts?: Record<string, string> }>(path.join(frontendDir, 'package.json'));
  if (!packageJson) return [skippedStep('frontend local validation', 'Generated frontend package manifest could not be parsed.')];

  const steps: GeneratedValidationStep[] = [];
  const npm = commandName('npm');
  steps.push(await commandStep({ name: 'frontend install', command: npm, args: ['install'], cwd: frontendDir, logDir, timeout: 300_000, onProgress }));
  if (steps[steps.length - 1].status === 'FAIL') return steps;

  for (const script of ['lint', 'test', 'build']) {
    if (packageJson.scripts?.[script]) {
      steps.push(await commandStep({ name: `frontend ${script}`, command: npm, args: ['run', script], cwd: frontendDir, logDir, onProgress }));
    } else {
      steps.push(skippedStep(`frontend ${script}`, `Generated frontend package manifest has no ${script} script.`));
    }
  }

  return steps;
}

async function validateLocalPython(codeDir: string, logDir: string, onProgress?: RunProgressReporter): Promise<GeneratedValidationStep[]> {
  const backendDir = await findNearestManifestDir(codeDir, ['requirements.txt', 'pyproject.toml'], /fastapi|uvicorn|sqlmodel|pytest/i);
  if (!backendDir) return [skippedStep('backend local validation', 'No generated backend dependency manifest was found.')];
  const requirements = path.join(backendDir, 'requirements.txt');
  if (!(await pathExists(requirements))) return [skippedStep('backend local validation', 'Generated backend does not use requirements.txt; Python local validation currently supports requirements.txt only.')];

  const python = await resolvePythonCommand(backendDir);
  if (!python) {
    return validatePythonWithContainer(backendDir, logDir, onProgress);
  }

  const venvDir = path.join(backendDir, '.venv');
  const venvPython = process.platform === 'win32' ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
  const steps: GeneratedValidationStep[] = [];

  if (!(await pathExists(venvPython))) {
    steps.push(await commandStep({ name: 'backend venv', command: python, args: ['-m', 'venv', '.venv'], cwd: backendDir, logDir, onProgress }));
    if (steps[steps.length - 1].status === 'FAIL') return steps;
  }

  steps.push(await commandStep({ name: 'backend install', command: venvPython, args: ['-m', 'pip', 'install', '-r', 'requirements.txt'], cwd: backendDir, logDir, timeout: 300_000, onProgress }));
  if (steps[steps.length - 1].status === 'FAIL') return steps;

  steps.push(await commandStep({ name: 'backend compile', command: venvPython, args: ['-m', 'compileall', '-q', '-x', '.*\\.venv.*', '.'], cwd: backendDir, logDir, onProgress }));
  if (steps[steps.length - 1].status === 'FAIL') return steps;

  const entrypoint = await findBackendImportTarget(backendDir);
  if (entrypoint) {
    steps.push(
      await commandStep({
        name: 'backend import',
        command: venvPython,
        args: ['-c', `__import__('importlib').import_module('${entrypoint}')`],
        cwd: backendDir,
        logDir,
        onProgress
      })
    );
    if (steps[steps.length - 1].status === 'FAIL') return steps;
  } else {
    steps.push(skippedStep('backend import', 'No common backend entrypoint was found for import validation.'));
  }

  const seedScript = await findBackendSeedScript(backendDir);
  if (seedScript && (await backendUsesLocalSqlite(backendDir))) {
    steps.push(
      await commandStep({
        name: 'backend seed data',
        command: venvPython,
        args: [path.relative(backendDir, seedScript)],
        cwd: backendDir,
        logDir,
        timeout: 120_000,
        onProgress
      })
    );
    if (steps[steps.length - 1].status === 'FAIL') return steps;
  } else if (seedScript) {
    steps.push(skippedStep('backend seed data', 'Seed script exists, but local guard skipped it because no SQLite/local database default was detected.'));
  } else {
    steps.push(skippedStep('backend seed data', 'No backend seed script was generated.'));
  }

  const testsExist = (await pathExists(path.join(backendDir, 'tests'))) || (await pathExists(path.join(backendDir, 'app', 'tests')));
  if (testsExist) {
    steps.push(await commandStep({ name: 'backend tests', command: venvPython, args: ['-m', 'pytest'], cwd: backendDir, logDir, onProgress }));
  } else {
    steps.push(skippedStep('backend tests', 'No backend tests directory was generated.'));
  }

  return steps;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function dockerMountPath(value: string) {
  return value.replace(/\\/g, '/');
}

async function validatePythonWithContainer(backendDir: string, logDir: string, onProgress?: RunProgressReporter): Promise<GeneratedValidationStep[]> {
  if (!allowDockerValidation()) {
    return [skippedStep('backend local validation', 'No usable local Python command was found and ALLOW_GENERATED_DOCKER=false, so backend local guard was skipped.')];
  }

  const dockerVersion = await runCommand('docker', ['version'], backendDir, 30_000);
  if (!dockerVersion.ok) {
    return [skippedStep('backend local validation', 'No usable local Python command or Docker engine was found, so backend local guard was skipped.')];
  }

  const commands = ['python -m pip install -r requirements.txt', 'python -m compileall -q .'];
  const entrypoint = await findBackendImportTarget(backendDir);
  if (entrypoint) {
    commands.push(`python -c "__import__('importlib').import_module('${entrypoint}')"`);
  }

  const seedScript = await findBackendSeedScript(backendDir);
  if (seedScript && (await backendUsesLocalSqlite(backendDir))) {
    commands.push(`python ${shellQuote(dockerMountPath(path.relative(backendDir, seedScript)))}`);
  }

  const testsExist = (await pathExists(path.join(backendDir, 'tests'))) || (await pathExists(path.join(backendDir, 'app', 'tests')));
  if (testsExist) {
    commands.push('python -m pytest');
  }

  return [
    await commandStep({
      name: 'backend containerized guard',
      command: 'docker',
      args: ['run', '--rm', '-v', `${dockerMountPath(backendDir)}:/app`, '-w', '/app', 'python:3.11-slim-bullseye', 'sh', '-c', commands.join(' && ')],
      cwd: backendDir,
      logDir,
      timeout: 300_000,
      onProgress
    })
  ];
}

async function findBackendImportTarget(backendDir: string) {
  const candidates = [
    { file: path.join(backendDir, 'main.py'), module: 'main' },
    { file: path.join(backendDir, 'app.py'), module: 'app' },
    { file: path.join(backendDir, 'app', 'main.py'), module: 'app.main' }
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate.file)) return candidate.module;
  }

  return null;
}

async function findBackendSeedScript(backendDir: string) {
  const candidates = await findFilesByName(backendDir, ['seed_data.py', 'seed.py']);
  return candidates[0] ?? null;
}

async function collectPythonFiles(dir: string, ignored = new Set(['.venv', '__pycache__', '.pytest_cache'])): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectPythonFiles(fullPath, ignored)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.py')) {
      files.push(fullPath);
    }
  }

  return files;
}

async function backendUsesLocalSqlite(backendDir: string) {
  const pythonFiles = await collectPythonFiles(backendDir);
  const chunks: string[] = [];

  for (const file of pythonFiles.slice(0, 50)) {
    try {
      chunks.push(await fs.readFile(file, 'utf-8'));
    } catch {
      // Ignore unreadable generated files; the compile/import guard will surface real syntax/runtime failures.
    }
  }

  return /sqlite:\/\/|sqlite3|database\.db|\.sqlite|\.sqlite3/i.test(chunks.join('\n'));
}

function buildResult(params: {
  startedAt: string;
  workspace: string;
  steps: GeneratedValidationStep[];
  skipped?: boolean;
}): GeneratedExecutionValidationResult {
  const failedSteps = params.steps.filter((step) => step.status === 'FAIL');
  const executionSteps = params.steps.filter((step) => step.name !== 'prepare env');
  const allExecutionSkipped = executionSteps.length > 0 && executionSteps.every((step) => step.status === 'SKIPPED');
  const findings = failedSteps.map((step) => `${step.name}: ${step.message}`);
  const status = params.skipped || allExecutionSkipped ? 'SKIPPED' : failedSteps.length > 0 ? 'NEEDS_FIX' : 'PASS';

  return {
    status,
    startedAt: params.startedAt,
    finishedAt: new Date().toISOString(),
    workspace: params.workspace,
    findings,
    fixInstructions:
      findings.length > 0
        ? `Fix generated project validation failures:\n${findings.map((finding) => `- ${finding}`).join('\n')}`
        : '',
    steps: params.steps
  };
}

async function addRepairScope(result: GeneratedExecutionValidationResult) {
  if (result.status !== 'NEEDS_FIX') return result;
  const files = await readGeneratedCodeSnapshot();
  return {
    ...result,
    repairScope: inferExecutionRepairScope(result, files)
  };
}

function enforceRequiredContainerDeployment(result: GeneratedExecutionValidationResult): GeneratedExecutionValidationResult {
  if (result.status !== 'SKIPPED' || !requireDeployedContainers()) return result;

  const findings = [
    'Container deployment was not executed. Rancher Desktop, Docker Compose, or nerdctl compose must be available before post-deployment QA can run.'
  ];

  return {
    ...result,
    status: 'NEEDS_FIX',
    findings,
    fixInstructions: `Enable and run local container deployment before post-deployment QA:\n${findings.map((finding) => `- ${finding}`).join('\n')}`
  };
}

export async function validateGeneratedProjectExecution(onProgress?: RunProgressReporter): Promise<GeneratedExecutionValidationResult> {
  const startedAt = new Date().toISOString();
  const generatedCodeDir = getGeneratedCodeDir();
  const codeDir = createValidationWorkspacePath();
  const logDir = path.join(codeDir, '.validation-logs');

  if (!shouldValidateExecution()) {
    return buildResult({
      startedAt,
      workspace: generatedCodeDir,
      skipped: true,
      steps: [skippedStep('execution validation', 'VALIDATE_GENERATED_EXECUTION=false.')]
    });
  }

  await copyDirectoryForValidation(generatedCodeDir, codeDir);
  await fs.mkdir(logDir, { recursive: true });
  await onProgress?.({
    stepId: 'execution-validation',
    stepStatus: 'RUNNING',
    message: `Validation workspace created at ${codeDir}.`
  });

  const steps: GeneratedValidationStep[] = [await copyEnvExampleIfSafe(codeDir)];
  const composeFile = await resolveComposeFile(codeDir);

  if (composeFile) {
    await onProgress?.({
      stepId: 'execution-validation',
      stepStatus: 'RUNNING',
      message: `Compose file detected: ${composeFile}.`
    });
    steps.push(...(await validateWithDockerCompose(codeDir, composeFile, logDir, onProgress)));
    return addRepairScope(buildResult({ startedAt, workspace: codeDir, steps }));
  }

  steps.push(...(await validateLocalNode(codeDir, logDir, onProgress)));
  steps.push(...(await validateLocalPython(codeDir, logDir, onProgress)));

  return addRepairScope(buildResult({ startedAt, workspace: codeDir, steps }));
}

export async function validateGeneratedProjectBuildGuard(onProgress?: RunProgressReporter): Promise<GeneratedExecutionValidationResult> {
  const startedAt = new Date().toISOString();
  const generatedCodeDir = getGeneratedCodeDir();
  const codeDir = createValidationWorkspacePath();
  const logDir = path.join(codeDir, '.validation-logs');

  if (!shouldValidateExecution() || !shouldRunStandardGuardMode()) {
    return buildResult({
      startedAt,
      workspace: generatedCodeDir,
      skipped: true,
      steps: [skippedStep('standard guard mode', 'Standard Guard Mode was disabled by environment configuration.')]
    });
  }

  await copyDirectoryForValidation(generatedCodeDir, codeDir);
  await fs.mkdir(logDir, { recursive: true });
  await onProgress?.({
    stepId: 'standard-guard',
    stepStatus: 'RUNNING',
    message: `Standard Guard Mode workspace created at ${codeDir}.`
  });

  const steps: GeneratedValidationStep[] = [await copyEnvExampleIfSafe(codeDir)];
  steps.push(...(await validateLocalNode(codeDir, logDir, onProgress)));
  steps.push(...(await validateLocalPython(codeDir, logDir, onProgress)));

  return addRepairScope(buildResult({ startedAt, workspace: codeDir, steps }));
}

export async function deployGeneratedProjectContainers(onProgress?: RunProgressReporter): Promise<GeneratedExecutionValidationResult> {
  const startedAt = new Date().toISOString();
  const codeDir = getGeneratedCodeDir();
  const logDir = path.join(codeDir, '.deployment-logs');

  if (!shouldValidateExecution()) {
    return enforceRequiredContainerDeployment(
      buildResult({
        startedAt,
        workspace: codeDir,
        skipped: true,
        steps: [skippedStep('container deployment', 'VALIDATE_GENERATED_EXECUTION=false.')]
      })
    );
  }

  await fs.mkdir(logDir, { recursive: true });
  await onProgress?.({
    stepId: 'runtime',
    stepStatus: 'RUNNING',
    message: `Deploying generated containers from ${codeDir}.`
  });

  const composeFile = await resolveComposeFile(codeDir);
  if (!composeFile) {
    return buildResult({
      startedAt,
      workspace: codeDir,
      steps: [
        {
          name: 'compose file',
          status: 'FAIL',
          message: 'No compose.yaml, compose.yml, docker-compose.yaml, or docker-compose.yml file was found.'
        }
      ]
    });
  }

  const steps: GeneratedValidationStep[] = [await copyEnvExampleIfSafe(codeDir)];
  steps.push(...(await validateWithDockerCompose(codeDir, composeFile, logDir, onProgress)));

  return addRepairScope(enforceRequiredContainerDeployment(buildResult({ startedAt, workspace: codeDir, steps })));
}
