import { timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';

const WINDOW_MS = readPositiveIntEnv('RUN_RATE_LIMIT_WINDOW_MS', 10 * 60 * 1000);
const MAX_REQUESTS = readPositiveIntEnv('RUN_RATE_LIMIT_MAX', 10);

const buckets = new Map<string, { count: number; resetAt: number }>();

export class ApiGuardError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string
  ) {
    super(message);
  }
}

function readPositiveIntEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeEquals(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function getPresentedToken(request: NextRequest) {
  const authorization = request.headers.get('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice('bearer '.length).trim();
  }

  return request.headers.get('x-api-key')?.trim() || '';
}

function getClientKey(request: NextRequest) {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip') || 'local';
}

function enforceRateLimit(request: NextRequest) {
  const now = Date.now();
  const key = getClientKey(request);
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }

  current.count += 1;
  if (current.count > MAX_REQUESTS) {
    throw new ApiGuardError('Too many run requests. Please wait before trying again.', 429, 'RATE_LIMITED');
  }
}

function enforceProductionAccess(request: NextRequest) {
  const configuredToken = process.env.RUN_API_TOKEN;
  const explicitlyPublic = process.env.ALLOW_UNAUTHENTICATED_RUNS === 'true';

  if (!configuredToken) {
    if (process.env.NODE_ENV === 'production' && !explicitlyPublic) {
      throw new ApiGuardError(
        'RUN_API_TOKEN must be configured in production, or ALLOW_UNAUTHENTICATED_RUNS=true must be set explicitly.',
        503,
        'RUN_API_TOKEN_REQUIRED'
      );
    }
    return;
  }

  const presentedToken = getPresentedToken(request);
  if (!presentedToken || !safeEquals(presentedToken, configuredToken)) {
    throw new ApiGuardError('Unauthorized run request.', 401, 'UNAUTHORIZED');
  }
}

export function assertRunApiAccess(request: NextRequest) {
  enforceRateLimit(request);
  enforceProductionAccess(request);
}

export function assertRunStatusApiAccess(request: NextRequest) {
  enforceProductionAccess(request);
}
