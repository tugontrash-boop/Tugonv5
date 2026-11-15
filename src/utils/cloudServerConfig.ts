/**
 * Hardcoded & Locked Cloud Server Binding Configuration for T.U.G.O.N.
 *
 * When `LOCK_CLOUD_SERVER_BINDING` is true (either hardcoded below, configured in
 * `/public/pi-config.json` with `"locked": true`, enabled via `PI_SERVER_LOCKED=true`,
 * or locked by an Admin in the Portal), external URL overrides via `?pi=`, `X-Pi-Endpoint`,
 * or unauthorized ping/disconnect requests are strictly rejected.
 */

export const HARDCODED_PI_SERVER_URL = '';
export const LOCK_TO_HARDCODED_PI_SERVER = false;

export interface CloudServerLockState {
  locked: boolean;
  lockedUrl: string;
  source: 'hardcoded' | 'config_file' | 'env' | 'server_lock' | 'unlocked';
}

export function stripTrailingSlashAndApi(rawUrl: string): string {
  const cleaned = String(rawUrl || '')
    .trim()
    .replace(/^["'`|]+|["'`|]+$/g, '')
    .trim();
  if (!cleaned) return '';
  return cleaned
    .replace(/\/api\/(health|storage|reports|logbooks|config|pi-status)\/?$/i, '')
    .replace(/\/test\.txt$/i, '')
    .replace(/\/+$/, '');
}

export function extractOriginHost(url: string): string {
  try {
    const parsed = new URL(url.includes('://') ? url : `https://${url}`);
    return parsed.origin.toLowerCase();
  } catch {
    return stripTrailingSlashAndApi(url).toLowerCase();
  }
}

export function resolveLockedCloudServerState(params: {
  envUrl?: string;
  envLocked?: boolean | string;
  staticConfigUrl?: string;
  staticConfigLocked?: boolean;
  persistedUrl?: string;
  persistedLocked?: boolean;
}): CloudServerLockState {
  const hardcoded = stripTrailingSlashAndApi(HARDCODED_PI_SERVER_URL);
  if (LOCK_TO_HARDCODED_PI_SERVER && hardcoded) {
    return { locked: true, lockedUrl: hardcoded, source: 'hardcoded' };
  }

  const staticUrl = stripTrailingSlashAndApi(params.staticConfigUrl || '');
  if (params.staticConfigLocked && staticUrl) {
    return { locked: true, lockedUrl: staticUrl, source: 'config_file' };
  }

  const envUrl = stripTrailingSlashAndApi(params.envUrl || '');
  const envLocked = params.envLocked === true || String(params.envLocked || '').toLowerCase() === 'true';
  if (envLocked && envUrl) {
    return { locked: true, lockedUrl: envUrl, source: 'env' };
  }

  const persistedUrl = stripTrailingSlashAndApi(params.persistedUrl || '');
  if (params.persistedLocked && (persistedUrl || hardcoded || envUrl || staticUrl)) {
    return {
      locked: true,
      lockedUrl: persistedUrl || hardcoded || envUrl || staticUrl,
      source: 'server_lock',
    };
  }

  return {
    locked: false,
    lockedUrl: persistedUrl || staticUrl || envUrl || hardcoded || '',
    source: 'unlocked',
  };
}

export function isUrlAllowedUnderLock(candidateUrl: string, lockState: CloudServerLockState): boolean {
  if (!lockState.locked || !lockState.lockedUrl) return true;
  const cleanCandidate = extractOriginHost(candidateUrl);
  const cleanLocked = extractOriginHost(lockState.lockedUrl);
  return Boolean(cleanCandidate) && cleanCandidate === cleanLocked;
}
