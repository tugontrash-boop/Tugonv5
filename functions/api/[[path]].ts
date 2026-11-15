/**
 * Cloudflare Pages Functions Edge Bridge (/functions/api/[[path]].ts)
 *
 * Automatically deployed on Cloudflare Pages (and mirrored by /cloudflare-worker.js on Cloudflare Workers).
 * Bridges /api/* requests server-to-server from Cloudflare's edge directly to ANY valid
 * Raspberry Pi Cloud Server link (ngrok-free.dev, ngrok.dev, ngrok-free.app, trycloudflare.com,
 * Tailscale Funnel, custom HTTPS domain, or VPS), bypassing browser CORS & ngrok interstitial pages
 * while strictly rejecting offline, unreachable, or invalid URLs.
 */

import {
  verifyTugonCredentials,
  isAuthorizedAdminPassword,
} from '../../src/utils/authConfig.ts';
import {
  resolveLockedCloudServerState,
  isUrlAllowedUnderLock,
} from '../../src/utils/cloudServerConfig.ts';
import {
  buildTelegramReplyKeyboard,
  buildNewConcernInlineKeyboard,
  buildNewConcernMessage1Html,
  buildNewConcernPhotoCaptionHtml,
  buildActiveUnresolvedConcernsMessage2Html,
  buildResolvedConcernMessage1Html,
  detectTelegramLanguage,
  generateBotChatReply,
  htmlToPlainTelegramText,
  parseTelegramCloudBubblePayload,
} from '../../src/utils/telegramBotEngine.ts';
import {
  AUTO_PURGE_TTL_DAYS,
  computeUnifiedPurgeInfo,
} from '../../src/utils/purgeConfig.ts';

export interface EdgeEnv {
  PI_SERVER_URL?: string;
  VITE_PI_SERVER_URL?: string;
  PI_SERVER_LOCKED?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
}

export interface PagesContext {
  request: Request;
  env: EdgeEnv;
}

interface PersistedEdgeConfig {
  piServerUrl?: string;
  piServerLocked?: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramSetupComplete?: boolean;
  telegramWebhookUrl?: string;
  kagawadCustomPassword?: string;
  lastBroadcastMessage?: string;
  lastBroadcastTime?: string;
  broadcastHistory?: string[];
  telegramUpdateOffset?: number;
  telegramChatHistory?: any[];
  knownTelegramChats?: { id: string; title: string; type: string }[];
  deletedReportIds?: string[];
}

let memoryConfig: PersistedEdgeConfig = {};
let memoryReports: any[] = [];
let memoryLogbooks: any[] = [];

const EDGE_CONFIG_CACHE_KEY = 'https://tugon-edge-cache.internal/v2/system-config';
const EDGE_REPORTS_CACHE_KEY = 'https://tugon-edge-cache.internal/v2/reports';
const EDGE_LOGBOOKS_CACHE_KEY = 'https://tugon-edge-cache.internal/v2/logbooks';

const BARE_TUNNEL_ROOTS = new Set([
  'ngrok.dev',
  'www.ngrok.dev',
  'ngrok.com',
  'www.ngrok.com',
  'ngrok.app',
  'ngrok-free.app',
  'ngrok-free.dev',
  'ngrok.io',
  'trycloudflare.com',
  'cloudflare.com',
  'www.cloudflare.com',
  'loca.lt',
  'ts.net',
  'pages.dev',
  'workers.dev',
]);

const PI_EDGE_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'ngrok-skip-browser-warning': 'true',
  'Bypass-Tunnel-Reminder': 'true',
  'User-Agent': 'TUGON-Cloudflare-Edge-Bridge/2.1',
};

function isPrivateHost(urlOrHost: string): boolean {
  try {
    const parsed = new URL(urlOrHost.includes('://') ? urlOrHost : `http://${urlOrHost}`);
    const h = parsed.hostname.toLowerCase();
    return (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '0.0.0.0' ||
      h.endsWith('.local') ||
      h.startsWith('192.168.') ||
      h.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)
    );
  } catch {
    return false;
  }
}

function isPublicTunnelHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h.endsWith('.ngrok-free.dev') ||
    h.endsWith('.ngrok-free.app') ||
    h.endsWith('.ngrok.dev') ||
    h.endsWith('.ngrok.app') ||
    h.endsWith('.ngrok.io') ||
    h.endsWith('.trycloudflare.com') ||
    h.endsWith('.ts.net') ||
    h.endsWith('.loca.lt')
  );
}

function isBareTunnelRoot(raw: string): boolean {
  try {
    const cleaned = String(raw || '').trim().replace(/^["'`|]+|["'`|]+$/g, '').trim();
    if (!cleaned) return false;
    const withProto = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
    const parsed = new URL(withProto);
    return BARE_TUNNEL_ROOTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isValidUrlSyntax(cleanUrl: string, selfOrigin?: string): boolean {
  if (!cleanUrl || isBareTunnelRoot(cleanUrl)) return false;
  try {
    const parsed = new URL(cleanUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const h = parsed.hostname.toLowerCase();
    if (!h) return false;
    if (selfOrigin) {
      try {
        const selfParsed = new URL(selfOrigin);
        if (parsed.origin.toLowerCase() === selfParsed.origin.toLowerCase()) {
          return false;
        }
      } catch {}
    }
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(h) || h.includes(':');
    const isLocal = h === 'localhost' || h.endsWith('.local');
    const hasValidDomain = h.includes('.') && /\.[a-z]{2,}$/i.test(h) && !h.startsWith('.') && !h.endsWith('.');
    return isIp || isLocal || hasValidDomain;
  } catch {
    return false;
  }
}

function normalizeEdgePiUrl(raw: string): string {
  if (!raw) return '';
  let u = String(raw).trim().replace(/^["'`|]+|["'`|]+$/g, '').trim();
  if (!u || /\s/.test(u) && !/https?:\/\//i.test(u)) return '';

  const embeddedMatches = u.match(/https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?(?:\/[^\s|"'<>]*)?/gi);
  if (embeddedMatches && (u.includes(' ') || u.includes('->') || u.includes('|'))) {
    const publicTunnel = embeddedMatches.find((m) => !isPrivateHost(m));
    u = publicTunnel || embeddedMatches[0];
  }

  if (!/^https?:\/\//i.test(u)) {
    if (isPrivateHost(u)) {
      const hasPort = /:\d+(\/|$)/.test(u);
      u = `http://${hasPort ? u : `${u.replace(/\/+$/, '')}:8000`}`;
    } else {
      u = `https://${u}`;
    }
  } else if (/^http:\/\//i.test(u) && !isPrivateHost(u)) {
    try {
      const parsedCheck = new URL(u);
      if (isPublicTunnelHost(parsedCheck.hostname)) {
        u = u.replace(/^http:\/\//i, 'https://');
      }
    } catch {}
  }

  try {
    const parsed = new URL(u);
    // Public tunnel domains always terminate HTTPS on port 443 and forward to local port 3000/8000 on Pi
    if (isPublicTunnelHost(parsed.hostname) && (parsed.port === '3000' || parsed.port === '8000')) {
      parsed.port = '';
      u = parsed.toString();
    }
  } catch {
    return '';
  }

  return u
    .replace(/\/api\/(health|storage|reports|logbooks|config|pi-status)\/?$/i, '')
    .replace(/\/test\.txt$/i, '')
    .replace(/\/+$/, '');
}

function detectMethod(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('ngrok')) return 'ngrok Tunnel';
  if (lower.includes('trycloudflare') || lower.includes('cloudflare')) return 'Cloudflare Tunnel';
  if (lower.includes('.ts.net') || lower.includes('tailscale')) return 'Tailscale Funnel';
  if (isPrivateHost(lower)) return 'Local Wi-Fi / LAN';
  return 'HTTPS Cloud Domain';
}

function isValidPiHealthJson(parsed: any): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (parsed.online === false || parsed.ok === false || parsed.healthy === false) return false;
  const statusStr = String(parsed.status ?? parsed.state ?? '').trim().toLowerCase();
  if (['offline', 'error', 'down', 'dead', 'disconnected', 'fail', 'failed'].includes(statusStr)) {
    return false;
  }
  if (parsed.error && !statusStr && parsed.online !== true && parsed.ok !== true) {
    return false;
  }
  const positiveStatuses = [
    'online',
    'active',
    'ok',
    'healthy',
    'running',
    'up',
    'ready',
    'connected',
    'live',
    'success',
  ];
  if (positiveStatuses.includes(statusStr)) return true;
  if (parsed.online === true || parsed.ok === true || parsed.healthy === true || parsed.active === true) {
    return true;
  }
  if (
    parsed.storage_folder ||
    parsed.hardware ||
    parsed.system ||
    parsed.disk_total ||
    parsed.cpu_temp ||
    typeof parsed.reports_count === 'number'
  ) {
    return true;
  }
  return false;
}

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, Authorization, X-Pi-Endpoint, ngrok-skip-browser-warning, Accept',
      'Access-Control-Expose-Headers': 'X-Pi-Online, Content-Disposition',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

async function readEdgeCacheJson<T>(cacheKey: string, fallback: T): Promise<T> {
  try {
    const cacheStorage = (globalThis as any).caches;
    const defaultCache = cacheStorage?.default;
    if (!defaultCache) return fallback;
    const hit = await defaultCache.match(cacheKey);
    if (!hit) return fallback;
    const parsed = await hit.json();
    return (parsed as T) ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeEdgeCacheJson(cacheKey: string, payload: unknown): Promise<void> {
  try {
    const cacheStorage = (globalThis as any).caches;
    const defaultCache = cacheStorage?.default;
    if (!defaultCache) return;
    await defaultCache.put(
      cacheKey,
      new Response(JSON.stringify(payload), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=2592000',
        },
      })
    );
  } catch {}
}

async function getEdgeConfig(): Promise<PersistedEdgeConfig> {
  const cached = await readEdgeCacheJson<PersistedEdgeConfig>(EDGE_CONFIG_CACHE_KEY, {});
  memoryConfig = { ...cached, ...memoryConfig };
  return memoryConfig;
}

async function saveEdgeConfig(patch: Partial<PersistedEdgeConfig>): Promise<PersistedEdgeConfig> {
  const existing = await getEdgeConfig();
  const next = { ...existing, ...patch };
  memoryConfig = next;
  await writeEdgeCacheJson(EDGE_CONFIG_CACHE_KEY, next);
  return next;
}

function extractEdgeKeys(r: any): string[] {
  const keys: string[] = [];
  if (typeof r === 'string') {
    const raw = r.trim();
    if (!raw) return keys;
    if (raw.startsWith('id:') || raw.startsWith('tk:')) {
      keys.push(raw);
    } else {
      keys.push(`id:${raw}`);
      const tk = formatEdgeTicket(raw).toUpperCase();
      if (tk) keys.push(`tk:${tk}`);
    }
    return keys;
  }
  const rid = String(r?.id || '').trim();
  if (rid) keys.push(`id:${rid}`);
  const tk = formatEdgeTicket(r?.ticketNumber).toUpperCase();
  if (tk) keys.push(`tk:${tk}`);
  return keys;
}

function isEdgeReportTombstoned(item: any, tombstones: Set<string>): boolean {
  if (tombstones.size === 0) return false;
  return extractEdgeKeys(item).some((k) => tombstones.has(k));
}

async function recordEdgeDeletedKeys(keys: string[]): Promise<string[]> {
  const cfg = await getEdgeConfig();
  const set = new Set(Array.isArray(cfg.deletedReportIds) ? cfg.deletedReportIds : []);
  for (const k of keys) {
    for (const expanded of extractEdgeKeys(k)) {
      if (expanded) set.add(expanded);
    }
  }
  const next = Array.from(set).slice(-2500);
  await saveEdgeConfig({ deletedReportIds: next });
  return next;
}

async function getEdgeReports(): Promise<any[]> {
  const cfg = await getEdgeConfig();
  const tombstones = new Set(Array.isArray(cfg.deletedReportIds) ? cfg.deletedReportIds : []);
  const cached = await readEdgeCacheJson<any[]>(EDGE_REPORTS_CACHE_KEY, []);
  if (Array.isArray(cached) && cached.length > 0) {
    memoryReports = mergeReportsLists(memoryReports, cached, Array.from(tombstones));
  } else if (tombstones.size > 0 && memoryReports.length > 0) {
    memoryReports = memoryReports.filter((r) => !isEdgeReportTombstoned(r, tombstones));
  }
  return memoryReports;
}

async function saveEdgeReports(nextList: any[]): Promise<void> {
  memoryReports = Array.isArray(nextList) ? nextList : [];
  await writeEdgeCacheJson(EDGE_REPORTS_CACHE_KEY, memoryReports);
}

async function getEdgeLogbooks(): Promise<any[]> {
  const cached = await readEdgeCacheJson<any[]>(EDGE_LOGBOOKS_CACHE_KEY, []);
  if (Array.isArray(cached) && cached.length > 0 && memoryLogbooks.length === 0) {
    memoryLogbooks = cached;
  }
  return memoryLogbooks;
}

async function saveEdgeLogbooks(nextLogs: any[]): Promise<void> {
  memoryLogbooks = Array.isArray(nextLogs) ? nextLogs : [];
  await writeEdgeCacheJson(EDGE_LOGBOOKS_CACHE_KEY, memoryLogbooks);
}

function formatEdgeTicket(raw?: unknown): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^#+/, '');
  if (!cleaned) return '';
  return cleaned
    .replace(/^(PULSE|TRASH|DRAW)-CAV-/i, 'TUGON-CAV-')
    .replace(/^TUGON-CAV-/i, 'TUGON-CAV-');
}

function isValidEdgePhotoSrc(src?: unknown): src is string {
  if (typeof src !== 'string') return false;
  const trimmed = src.trim();
  if (!trimmed || trimmed === 'data:,' || trimmed === 'data:' || trimmed === 'about:blank') return false;
  if (trimmed.startsWith('blob:')) return false;
  if (trimmed.startsWith('data:image/')) return trimmed.length >= 100;
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) return true;
  if (trimmed.length >= 100 && /^[A-Za-z0-9+/=\s]+$/.test(trimmed.slice(0, 120))) return true;
  return false;
}

function pickBestEdgePhotos(primary?: any[], secondary?: any[]): string[] {
  const validPrimary = Array.isArray(primary) ? primary.filter(isValidEdgePhotoSrc) : [];
  const validSecondary = Array.isArray(secondary) ? secondary.filter(isValidEdgePhotoSrc) : [];
  if (validPrimary.length >= validSecondary.length && validPrimary.length > 0) return validPrimary;
  if (validSecondary.length > 0) return validSecondary;
  if (Array.isArray(primary) && primary.length > 0) return primary;
  if (Array.isArray(secondary) && secondary.length > 0) return secondary;
  return [];
}

function mergeReportsLists(listA: any[], listB: any[], deletedIds?: string[]): any[] {
  const tombstones = new Set(deletedIds || memoryConfig.deletedReportIds || []);
  const byId = new Map<string, any>();
  const ticketToKey = new Map<string, string>();
  const score = (r: any) => {
    const st = r?.status;
    const base = st === 'RESOLVED' ? 4 : st === 'CANCELLED' ? 3 : st === 'DISPATCHED' ? 2 : 1;
    const validProofCount = Array.isArray(r?.proofPhotos)
      ? r.proofPhotos.filter(isValidEdgePhotoSrc).length
      : 0;
    return base * 10 + validProofCount;
  };

  for (const item of [...(Array.isArray(listA) ? listA : []), ...(Array.isArray(listB) ? listB : [])]) {
    if (!item || (!item.id && !item.ticketNumber)) continue;
    if (isEdgeReportTombstoned(item, tombstones)) continue;

    const tk = formatEdgeTicket(item.ticketNumber).toUpperCase();
    const mappedKey = tk ? ticketToKey.get(tk) : undefined;
    const key = mappedKey || String(item.id || (tk ? `tk:${tk}` : ''));
    if (!key) continue;
    if (tk && !ticketToKey.has(tk)) ticketToKey.set(tk, key);

    const prev = byId.get(key);
    if (!prev) {
      byId.set(key, {
        ...item,
        ticketNumber: formatEdgeTicket(item.ticketNumber) || item.ticketNumber,
      });
    } else {
      const winner = score(item) >= score(prev) ? item : prev;
      const runnerUp = score(item) >= score(prev) ? prev : item;
      byId.set(key, {
        ...runnerUp,
        ...winner,
        id: winner.id || runnerUp.id,
        ticketNumber:
          formatEdgeTicket(winner.ticketNumber || runnerUp.ticketNumber) || winner.ticketNumber,
        residentName: winner.residentName || runnerUp.residentName || '',
        residentPhone: winner.residentPhone || runnerUp.residentPhone,
        streetAddress: winner.streetAddress || runnerUp.streetAddress,
        houseNumber: winner.houseNumber || runnerUp.houseNumber,
        landmark: winner.landmark || runnerUp.landmark,
        notes: winner.notes || runnerUp.notes,
        extraMessage: winner.extraMessage || runnerUp.extraMessage,
        dispatchedAt: winner.dispatchedAt || runnerUp.dispatchedAt,
        dispatchedKagawad: winner.dispatchedKagawad || runnerUp.dispatchedKagawad,
        resolvedAt: winner.resolvedAt || runnerUp.resolvedAt,
        resolvedBy: winner.resolvedBy || runnerUp.resolvedBy,
        resolutionNotes: winner.resolutionNotes || runnerUp.resolutionNotes,
        proofSubmittedAt: winner.proofSubmittedAt || runnerUp.proofSubmittedAt,
        proofKagawadName: winner.proofKagawadName || runnerUp.proofKagawadName,
        cancelledAt: winner.cancelledAt || runnerUp.cancelledAt,
        cancellationReason: winner.cancellationReason || runnerUp.cancellationReason,
        photos: pickBestEdgePhotos(winner.photos, runnerUp.photos),
        proofPhotos: pickBestEdgePhotos(winner.proofPhotos, runnerUp.proofPhotos),
      });
    }
  }

  return Array.from(byId.values()).sort(
    (a, b) => new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime()
  );
}

function getPhilippineDateTime(): string {
  try {
    return new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

async function getEdgeCloudLockState(env: EdgeEnv) {
  const cfg = await getEdgeConfig();
  return resolveLockedCloudServerState({
    envUrl: env?.PI_SERVER_URL || env?.VITE_PI_SERVER_URL || '',
    envLocked: env?.PI_SERVER_LOCKED,
    persistedUrl: cfg.piServerUrl || '',
    persistedLocked: Boolean(cfg.piServerLocked),
  });
}

async function resolveActivePiUrl(request: Request, env: EdgeEnv): Promise<string> {
  const reqUrl = new URL(request.url);
  const lockState = await getEdgeCloudLockState(env);
  if (lockState.locked && lockState.lockedUrl) {
    const cleanLocked = normalizeEdgePiUrl(lockState.lockedUrl);
    if (cleanLocked && isValidUrlSyntax(cleanLocked, reqUrl.origin)) {
      return cleanLocked;
    }
  }

  const headerUrl = normalizeEdgePiUrl(request.headers.get('X-Pi-Endpoint') || '');
  if (headerUrl && isValidUrlSyntax(headerUrl, reqUrl.origin)) {
    return headerUrl;
  }
  const queryUrl = normalizeEdgePiUrl(reqUrl.searchParams.get('endpoint') || '');
  if (queryUrl && isValidUrlSyntax(queryUrl, reqUrl.origin)) {
    return queryUrl;
  }
  const cfg = await getEdgeConfig();
  if (cfg.piServerUrl) {
    const clean = normalizeEdgePiUrl(cfg.piServerUrl);
    if (clean && isValidUrlSyntax(clean, reqUrl.origin)) {
      return clean;
    }
  }
  const envCandidate = normalizeEdgePiUrl(env?.PI_SERVER_URL || env?.VITE_PI_SERVER_URL || '');
  return isValidUrlSyntax(envCandidate, reqUrl.origin) ? envCandidate : '';
}

function classifyTunnelFailure(
  res: Response,
  text: string,
  isEn: boolean
): string | null {
  const ngrokErr = (res.headers.get('ngrok-error-code') || '').toUpperCase();
  if (
    ngrokErr.includes('ERR_NGROK_3200') ||
    text.includes('ERR_NGROK_3200') ||
    (text.includes('endpoint') && text.includes('is offline'))
  ) {
    return isEn
      ? 'The ngrok tunnel is offline (ERR_NGROK_3200). Make sure your Pi server and ngrok tunnel (e.g. ngrok http 3000 or 8000) are running.'
      : 'Naka-offline ang ngrok tunnel (ERR_NGROK_3200). Pakisiguradong tumatakbo ang iyong Pi server at ngrok tunnel (hal. ngrok http 3000 o 8000).';
  }
  if (
    ngrokErr.includes('ERR_NGROK_8012') ||
    text.includes('ERR_NGROK_8012') ||
    text.toLowerCase().includes('connection refused')
  ) {
    return isEn
      ? 'ngrok tunnel is open, but no server is responding on the forwarded port (e.g. port 3000 or 8000) on your Raspberry Pi (ERR_NGROK_8012).'
      : 'Bukas ang ngrok tunnel ngunit walang sumasagot na server sa port (hal. port 3000 o 8000) ng iyong Raspberry Pi (ERR_NGROK_8012).';
  }
  if (ngrokErr.startsWith('ERR_NGROK_')) {
    return isEn
      ? `ngrok returned tunnel error ${ngrokErr}. Verify your Forwarding URL.`
      : `Nagbalik ng tunnel error (${ngrokErr}) ang ngrok. Pakisuri ang iyong Forwarding URL.`;
  }
  if (
    res.status === 502 ||
    res.status === 503 ||
    res.status === 504 ||
    res.status === 530 ||
    text.includes('Argo Tunnel error') ||
    text.includes('Origin DNS error')
  ) {
    return isEn
      ? `Tunnel gateway error (HTTP ${res.status}). Check that your Raspberry Pi server (port 3000 or 8000) and tunnel are running.`
      : `Hindi maabot ng tunnel ang server sa Raspberry Pi (HTTP ${res.status}). Siguraduhing tumatakbo ang server (port 3000 o 8000) at tunnel.`;
  }
  return null;
}

async function probeRemotePi(
  cleanEndpoint: string,
  isEn = false,
  selfOrigin?: string
): Promise<{
  isLive: boolean;
  data: any;
  latencyMs: number;
  mode?: string;
  errorDetail?: string;
}> {
  if (!cleanEndpoint || !isValidUrlSyntax(cleanEndpoint, selfOrigin)) {
    return {
      isLive: false,
      data: null,
      latencyMs: 0,
      errorDetail: isEn
        ? 'Invalid Cloud Server link format. Please enter a valid URL (e.g. https://pi.tugon-brgy40-41.org).'
        : 'Hindi valid ang inilagay na Cloud Server link. Pakilagay ang tamang URL (hal. https://pi.tugon-brgy40-41.org).',
    };
  }

  if (isPrivateHost(cleanEndpoint)) {
    return {
      isLive: false,
      data: null,
      latencyMs: 0,
      errorDetail: isEn
        ? 'Private LAN IP cannot be reached from the public cloud unless tunneled or accessed on the same Wi-Fi.'
        : 'Pribadong Local Wi-Fi IP ito. Kailangan ng tunnel (ngrok / cloudflared) kung binubuksan mula sa internet, o buksan sa parehong Wi-Fi.',
    };
  }

  const start = Date.now();
  try {
    // 1. Primary check: /api/health
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6500);
    const res = await fetch(`${cleanEndpoint}/api/health`, {
      signal: ctrl.signal,
      headers: PI_EDGE_HEADERS,
    }).catch(() => null);
    clearTimeout(timer);

    if (res) {
      const text = await res.text().catch(() => '');
      const tunnelErr = classifyTunnelFailure(res, text, isEn);
      if (tunnelErr) {
        return { isLive: false, data: null, latencyMs: 0, errorDetail: tunnelErr };
      }

      if (res.ok) {
        let parsed: any = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }

        if (isValidPiHealthJson(parsed)) {
          return {
            isLive: true,
            data: {
              status: 'ONLINE',
              system: parsed.system || 'T.U.G.O.N. Raspberry Pi 4B Server',
              hardware: parsed.hardware || 'Raspberry Pi 4 Model B',
              storage_folder: parsed.storage_folder || '/media/pi/Vherrsie Back-up/RESEARCH TRASH',
              disk_total: parsed.disk_total || '500.0 GB',
              disk_used: parsed.disk_used || '20.0 GB',
              disk_free: parsed.disk_free || '480.0 GB',
              ram: parsed.ram || 'Active (Healthy)',
              cpu_temp: parsed.cpu_temp || '42.0\u00B0C',
              cpuTempCelsius: parsed.cpuTempCelsius || parseFloat(parsed.cpu_temp) || 42.0,
              ...parsed,
            },
            latencyMs: Math.max(1, Date.now() - start),
            mode: 'PULSE_SERVER',
          };
        }
      }
    }

    // 2. Secondary check: Root '/' (for custom Python BaseHTTP/SimpleHTTP servers or root health JSON)
    const rootCtrl = new AbortController();
    const rootTimer = setTimeout(() => rootCtrl.abort(), 4500);
    const rootRes = await fetch(`${cleanEndpoint}/`, {
      signal: rootCtrl.signal,
      headers: PI_EDGE_HEADERS,
    }).catch(() => null);
    clearTimeout(rootTimer);

    if (rootRes) {
      const rootText = await rootRes.text().catch(() => '');
      const rootTunnelErr = classifyTunnelFailure(rootRes, rootText, isEn);
      if (rootTunnelErr) {
        return { isLive: false, data: null, latencyMs: 0, errorDetail: rootTunnelErr };
      }

      if (rootRes.ok) {
        let rootJson: any = null;
        try {
          rootJson = JSON.parse(rootText);
        } catch {
          rootJson = null;
        }

        if (isValidPiHealthJson(rootJson)) {
          return {
            isLive: true,
            data: {
              status: 'ONLINE',
              system: rootJson.system || 'T.U.G.O.N. Raspberry Pi 4B Server',
              hardware: rootJson.hardware || 'Raspberry Pi 4 Model B',
              storage_folder: rootJson.storage_folder || '/media/pi/Vherrsie Back-up/RESEARCH TRASH',
              disk_total: rootJson.disk_total || '500.0 GB',
              disk_used: rootJson.disk_used || '20.0 GB',
              disk_free: rootJson.disk_free || '480.0 GB',
              ram: rootJson.ram || 'Active (Healthy)',
              cpu_temp: rootJson.cpu_temp || '42.0\u00B0C',
              ...rootJson,
            },
            latencyMs: Math.max(1, Date.now() - start),
            mode: 'PULSE_SERVER',
          };
        }

        const serverHeader = (rootRes.headers.get('server') || '').toLowerCase();
        const isPythonStorageListing =
          rootText.includes('Directory listing for') ||
          rootText.includes('pulse_reports.json') ||
          rootText.includes('saved_logbooks') ||
          ((serverHeader.includes('python') ||
            serverHeader.includes('basehttp') ||
            serverHeader.includes('simplehttp')) &&
            !rootText.toLowerCase().includes('<script'));

        if (isPythonStorageListing) {
          return {
            isLive: true,
            data: {
              status: 'ONLINE',
              system: 'Raspberry Pi 4B (Python HTTP Server)',
              hardware: 'Raspberry Pi 4 Model B',
              storage_folder: '/media/pi/Vherrsie Back-up/RESEARCH TRASH',
              disk_total: '500.0 GB',
              disk_used: '20.0 GB',
              disk_free: '480.0 GB',
              ram: 'Active (Healthy)',
              cpu_temp: '42.0\u00B0C',
            },
            latencyMs: Math.max(1, Date.now() - start),
            mode: 'SIMPLE_HTTP',
          };
        }
      }
    }
  } catch (e: any) {
    return {
      isLive: false,
      data: null,
      latencyMs: 0,
      errorDetail: isEn
        ? `Cannot reach ${cleanEndpoint}. Please verify the URL and make sure your Pi server (port 3000 or 8000) and tunnel are running.`
        : `Hindi maabot ang ${cleanEndpoint}. Pakisuri kung tama ang link at tumatakbo ang iyong Pi server (port 3000 o 8000) at tunnel.`,
    };
  }

  return {
    isLive: false,
    data: null,
    latencyMs: 0,
    errorDetail: isEn
      ? `${cleanEndpoint} is not a valid or active Raspberry Pi Cloud Server.`
      : `Ang ${cleanEndpoint} ay hindi valid o hindi aktibong Raspberry Pi Cloud Server.`,
  };
}

async function syncTombstonesFromPi(activePi: string): Promise<string[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const cfgRes = await fetch(`${activePi}/api/config`, {
      signal: ctrl.signal,
      headers: PI_EDGE_HEADERS,
    }).catch(() => null);
    clearTimeout(timer);
    if (cfgRes && cfgRes.ok) {
      const parsed: any = await cfgRes.json().catch(() => null);
      if (Array.isArray(parsed?.deletedReportIds) && parsed.deletedReportIds.length > 0) {
        return await recordEdgeDeletedKeys(parsed.deletedReportIds);
      }
    }
  } catch {}
  const cfg = await getEdgeConfig();
  return Array.isArray(cfg.deletedReportIds) ? cfg.deletedReportIds : [];
}

async function fetchPiReportsArray(activePi: string): Promise<{ ok: boolean; isArray: boolean; list: any[] }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5500);
    const piRes = await fetch(`${activePi}/api/reports`, {
      signal: ctrl.signal,
      headers: PI_EDGE_HEADERS,
    });
    clearTimeout(timer);
    if (!piRes.ok) return { ok: false, isArray: false, list: [] };
    const parsed = await piRes.json().catch(() => null);
    if (Array.isArray(parsed)) {
      return { ok: true, isArray: true, list: parsed };
    }
    if (isValidPiHealthJson(parsed)) {
      // Lightweight custom Python server on Pi (e.g. {"status": "active"})
      return { ok: true, isArray: false, list: [] };
    }
    return { ok: false, isArray: false, list: [] };
  } catch {
    return { ok: false, isArray: false, list: [] };
  }
}

async function pushReportsToRemotePi(activePi: string, mergedReports: any[], singleReport?: any): Promise<boolean> {
  try {
    // Prefer small, atomic single-report POST when submitting a single concern so large photo history never times out Worker execution
    if (singleReport) {
      const ctrl1 = new AbortController();
      const timer1 = setTimeout(() => ctrl1.abort(), 14000);
      const postRes = await fetch(`${activePi}/api/reports`, {
        method: 'POST',
        signal: ctrl1.signal,
        headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(singleReport),
      }).catch(() => null);
      clearTimeout(timer1);
      if (postRes && postRes.ok) return true;
    }

    const ctrl2 = new AbortController();
    const timer2 = setTimeout(() => ctrl2.abort(), 15000);
    const syncRes = await fetch(`${activePi}/api/reports/sync`, {
      method: 'POST',
      signal: ctrl2.signal,
      headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(mergedReports),
    }).catch(() => null);
    clearTimeout(timer2);

    if (syncRes && syncRes.ok) {
      const syncJson: any = await syncRes.json().catch(() => null);
      if (Array.isArray(syncJson?.deletedReportIds)) {
        await recordEdgeDeletedKeys(syncJson.deletedReportIds);
      }
      return true;
    }
  } catch {}
  return false;
}

async function resolveEdgeTelegramCreds(
  request: Request,
  env: EdgeEnv,
  cfg: PersistedEdgeConfig,
  activePi: string,
  body?: any
): Promise<{ token: string; chatId: string }> {
  let token = String(
    body?.telegramBotToken ||
      request.headers.get('X-Telegram-Token') ||
      cfg.telegramBotToken ||
      env?.TELEGRAM_BOT_TOKEN ||
      ''
  ).trim();
  let chatId = String(
    body?.telegramChatId ||
      request.headers.get('X-Telegram-Chat-Id') ||
      cfg.telegramChatId ||
      env?.TELEGRAM_CHAT_ID ||
      ''
  ).trim();

  // Cold-isolate fallback: check connected Pi /api/config so resident phones work across workers
  if ((!token || !chatId) && activePi && !isPrivateHost(activePi)) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const piCfgRes = await fetch(`${activePi}/api/config`, {
        signal: ctrl.signal,
        headers: PI_EDGE_HEADERS,
      }).catch(() => null);
      clearTimeout(t);
      if (piCfgRes && piCfgRes.ok) {
        const piCfg: any = await piCfgRes.json().catch(() => null);
        if (!token && piCfg?.telegramBotToken) token = String(piCfg.telegramBotToken).trim();
        if (!chatId && piCfg?.telegramChatId) chatId = String(piCfg.telegramChatId).trim();
      }
    } catch {}
  }

  if (token && chatId && (cfg.telegramBotToken !== token || cfg.telegramChatId !== chatId)) {
    await saveEdgeConfig({
      telegramBotToken: token,
      telegramChatId: chatId,
      telegramSetupComplete: true,
    });
  }

  return { token, chatId };
}

async function sendEdgeTelegramMessage(
  botToken: string,
  chatId: string,
  htmlText: string,
  replyMarkup?: any
): Promise<{ ok: boolean; description?: string }> {
  if (!botToken || !chatId) return { ok: false, description: 'Not configured' };
  try {
    const payload: Record<string, any> = {
      chat_id: chatId,
      text: htmlText,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data: any = await res.json().catch(() => ({}));
    if (res.ok && data?.ok) {
      return { ok: true };
    }
    if (String(data?.description || '').toLowerCase().includes('parse')) {
      const retryPayload: Record<string, any> = {
        chat_id: chatId,
        text: htmlToPlainTelegramText(htmlText),
      };
      if (replyMarkup) retryPayload.reply_markup = replyMarkup;
      const retryRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(retryPayload),
      });
      const retryData: any = await retryRes.json().catch(() => ({}));
      if (retryRes.ok && retryData?.ok) return { ok: true };
    }
    return { ok: false, description: data?.description };
  } catch (e: any) {
    return { ok: false, description: e?.message };
  }
}

async function sendEdgeTelegramPhoto(
  botToken: string,
  chatId: string,
  dataUrl: string,
  captionText: string,
  replyMarkup?: any,
  useHtml = false
): Promise<{ ok: boolean }> {
  if (!botToken || !chatId || !dataUrl || !dataUrl.startsWith('data:image/')) {
    return { ok: false };
  }
  try {
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return { ok: false };
    const header = dataUrl.slice(0, commaIdx);
    const base64Data = dataUrl.slice(commaIdx + 1);
    const mimeMatch = header.match(/data:(image\/[a-zA-Z0-9.+-]+);base64/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    const binaryStr = atob(base64Data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('caption', captionText.slice(0, 950));
    if (useHtml) formData.append('parse_mode', 'HTML');
    if (replyMarkup) formData.append('reply_markup', JSON.stringify(replyMarkup));
    formData.append('photo', new Blob([bytes], { type: mimeType }), `tugon_report.${ext}`);

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST',
      body: formData,
    });
    const parsed: any = await res.json().catch(() => ({ ok: false }));
    return { ok: Boolean(res.ok && parsed?.ok) };
  } catch {
    return { ok: false };
  }
}

async function dispatchEdgeNewConcern2Messages(
  token: string,
  chatId: string,
  report: any,
  allReports: any[],
  lang: 'tl' | 'en',
  cfg: PersistedEdgeConfig
): Promise<{ notified: boolean; count: number }> {
  if (!token || !chatId) return { notified: false, count: 0 };
  const phTime = getPhilippineDateTime();
  const msg1Html = buildNewConcernMessage1Html(report, lang, phTime);
  const inlineKb = buildNewConcernInlineKeyboard(report, lang);

  let m1Ok = false;
  if (Array.isArray(report.photos) && typeof report.photos[0] === 'string' && report.photos[0].startsWith('data:image/')) {
    const captionHtml = buildNewConcernPhotoCaptionHtml(report, lang, phTime);
    const photoRes = await sendEdgeTelegramPhoto(token, chatId, report.photos[0], captionHtml, inlineKb, true);
    m1Ok = photoRes.ok;
  }
  if (!m1Ok) {
    const txtRes = await sendEdgeTelegramMessage(token, chatId, msg1Html, inlineKb);
    m1Ok = txtRes.ok;
  }

  const msg2Html = buildActiveUnresolvedConcernsMessage2Html(allReports, lang, 'ACTIVE');
  const m2Res = await sendEdgeTelegramMessage(token, chatId, msg2Html, buildTelegramReplyKeyboard(lang));
  const m2Ok = m2Res.ok;

  if (m1Ok || m2Ok) {
    const prevHist = Array.isArray(cfg.broadcastHistory) ? cfg.broadcastHistory : [];
    const newEntries = [
      m2Ok ? `[${phTime}] ${htmlToPlainTelegramText(msg2Html).replace(/\n+/g, ' • ')}` : '',
      m1Ok ? `[${phTime}] ${htmlToPlainTelegramText(msg1Html).replace(/\n+/g, ' • ')}` : '',
    ].filter(Boolean);
    await saveEdgeConfig({
      lastBroadcastMessage: htmlToPlainTelegramText(msg1Html),
      lastBroadcastTime: phTime,
      broadcastHistory: [...newEntries, ...prevHist].slice(0, 20),
    });
  }

  return { notified: m1Ok || m2Ok, count: (m1Ok ? 1 : 0) + (m2Ok ? 1 : 0) };
}

async function getLiveReportsForTelegramBot(activePi: string): Promise<any[]> {
  const cached = await getEdgeReports();
  if (activePi && !isPrivateHost(activePi)) {
    const piRes = await fetchPiReportsArray(activePi);
    if (piRes.ok && piRes.isArray) {
      await saveEdgeReports(piRes.list);
      return piRes.list;
    }
  }
  return cached;
}

async function registerEdgeTelegramWebhook(
  token: string,
  reqOrigin: string
): Promise<{ ok: boolean; webhookUrl?: string }> {
  if (!token || !reqOrigin || !reqOrigin.startsWith('https://') || isPrivateHost(reqOrigin)) {
    return { ok: false };
  }
  const cleanOrigin = reqOrigin.replace(/\/+$/, '');
  const webhookUrl = `${cleanOrigin}/api/telegram/webhook`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['message', 'edited_message', 'callback_query', 'channel_post'],
        drop_pending_updates: false,
      }),
    });
    const parsed: any = await res.json().catch(() => null);
    if (res.ok && parsed?.ok) {
      return { ok: true, webhookUrl };
    }
  } catch {}
  return { ok: false };
}

async function processEdgeTelegramUpdate(
  u: any,
  token: string,
  defaultChatId: string,
  allReports: any[],
  existingHistory: any[],
  knownChats: { id: string; title: string; type: string }[],
  allowReply: boolean
): Promise<boolean> {
  let mutated = false;

  const chat =
    u?.message?.chat ||
    u?.edited_message?.chat ||
    u?.callback_query?.message?.chat ||
    u?.my_chat_member?.chat ||
    u?.chat_member?.chat ||
    u?.channel_post?.chat;
  if (chat && chat.id !== undefined) {
    const idStr = String(chat.id);
    if (!knownChats.some((c) => c.id === idStr)) {
      const title =
        chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || idStr;
      knownChats.unshift({ id: idStr, title, type: chat.type || 'private' });
      mutated = true;
    }
  }

  if (!allowReply) return mutated;

  const phTime = getPhilippineDateTime();

  // 1. Handle Inline Cloud Bubble callback_query (e.g. tg_cmd:active, tg_cmd:summary, cloud_bubble:*, JSON payloads)
  const cbQuery = u?.callback_query;
  if (cbQuery?.id) {
    const rawCbData = String(cbQuery.data || '').trim();
    const parsedBubble = parseTelegramCloudBubblePayload(rawCbData);
    const bubbleLang: 'tl' | 'en' =
      parsedBubble.detectedLang || detectTelegramLanguage(parsedBubble.normalizedCommand, 'tl');

    // Acknowledge Telegram cloud bubble press immediately so loading spinner clears
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: cbQuery.id,
        text: bubbleLang === 'en' ? 'Fetching live T.U.G.O.N. records...' : 'Kinukuha ang live records...',
      }),
    }).catch(() => null);

    const cbChat = cbQuery.message?.chat?.id !== undefined ? String(cbQuery.message.chat.id) : defaultChatId;
    if (cbChat && rawCbData) {
      const reply = generateBotChatReply(rawCbData, allReports, bubbleLang);
      existingHistory.push({
        id: `tg-u-${u.update_id || Date.now()}`,
        sender: 'user',
        text: parsedBubble.displayLabel || '📋 Check Active Concerns / Unresolved',
        timestamp: phTime,
        source: 'telegram',
      });
      await sendEdgeTelegramMessage(token, cbChat, reply.textHtml, buildTelegramReplyKeyboard(bubbleLang));
      existingHistory.push({
        id: `tg-b-${u.update_id || Date.now()}`,
        sender: 'bot',
        text: reply.textPlain,
        timestamp: phTime,
        source: 'telegram',
        matchedIntent: reply.matchedIntent,
      });
      mutated = true;
    }
    return mutated;
  }

  // 2. Handle Persistent Reply Keyboard bubble taps, slash commands, JSON cloud bubble payloads, or chat text
  const rawIncomingText =
    u?.message?.text ||
    u?.edited_message?.text ||
    u?.channel_post?.text ||
    '';
  const msgText = String(rawIncomingText || '').trim();
  const msgChat =
    u?.message?.chat?.id !== undefined
      ? String(u.message.chat.id)
      : u?.edited_message?.chat?.id !== undefined
        ? String(u.edited_message.chat.id)
        : u?.channel_post?.chat?.id !== undefined
          ? String(u.channel_post.chat.id)
          : '';
  const isFromBot = Boolean(u?.message?.from?.is_bot);

  if (msgText && msgChat && !isFromBot) {
    const parsedBubble = parseTelegramCloudBubblePayload(msgText);
    const lang: 'tl' | 'en' =
      parsedBubble.detectedLang || detectTelegramLanguage(parsedBubble.normalizedCommand, 'tl');
    const reply = generateBotChatReply(msgText, allReports, lang);

    existingHistory.push({
      id: `tg-u-${u.update_id || Date.now()}`,
      sender: 'user',
      text: parsedBubble.displayLabel || msgText,
      timestamp: phTime,
      source: 'telegram',
    });
    await sendEdgeTelegramMessage(token, msgChat, reply.textHtml, buildTelegramReplyKeyboard(lang));
    existingHistory.push({
      id: `tg-b-${u.update_id || Date.now()}`,
      sender: 'bot',
      text: reply.textPlain,
      timestamp: phTime,
      source: 'telegram',
      matchedIntent: reply.matchedIntent,
    });
    mutated = true;
  }

  return mutated;
}

async function pollEdgeTelegramUpdatesOnce(
  token: string,
  defaultChatId: string,
  allReports: any[],
  cfg: PersistedEdgeConfig
): Promise<{ history: any[]; knownChats: { id: string; title: string; type: string }[] }> {
  const existingHistory = Array.isArray(cfg.telegramChatHistory) ? [...cfg.telegramChatHistory] : [];
  const knownChats = Array.isArray(cfg.knownTelegramChats) ? [...cfg.knownTelegramChats] : [];
  let offset = typeof cfg.telegramUpdateOffset === 'number' ? cfg.telegramUpdateOffset : 0;

  if (!token) return { history: existingHistory, knownChats };

  // If Telegram webhook is actively registered, do NOT call getUpdates (which returns 409)
  // or delete the webhook — webhook pushes updates in real time to POST /api/telegram/webhook.
  if (cfg.telegramWebhookUrl && cfg.telegramWebhookUrl.startsWith('https://')) {
    return { history: existingHistory, knownChats };
  }

  try {
    const offsetParam = offset > 0 ? `&offset=${offset}` : '';
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=25&timeout=0${offsetParam}`).catch(() => null);
    const data: any = res ? await res.json().catch(() => null) : null;

    if (res && (res.status === 409 || String(data?.description || '').toLowerCase().includes('webhook'))) {
      // Respect active Telegram webhook instead of tearing it down
      return { history: existingHistory, knownChats };
    }

    if (!res || !res.ok || !data?.ok || !Array.isArray(data.result) || data.result.length === 0) {
      return { history: existingHistory, knownChats };
    }

    const isBootstrap = offset === 0;
    const nowEpochSec = Math.floor(Date.now() / 1000);
    let mutated = false;

    for (const u of data.result) {
      if (typeof u?.update_id === 'number' && u.update_id >= offset) {
        offset = u.update_id + 1;
        mutated = true;
      }

      // On cold isolate restart (offset === 0), ALWAYS process inline cloud bubble callback_query
      // or recent messages (< 15 mins old), only skipping stale pre-existing backlog!
      const msgUnix = Number(u?.message?.date || u?.edited_message?.date || u?.callback_query?.message?.date || 0);
      const isRecentOrCallback = Boolean(u?.callback_query) || (msgUnix > 0 && nowEpochSec - msgUnix <= 900);
      const allowReply = !isBootstrap || isRecentOrCallback;

      const didMutate = await processEdgeTelegramUpdate(
        u,
        token,
        defaultChatId,
        allReports,
        existingHistory,
        knownChats,
        allowReply
      );
      if (didMutate) mutated = true;
    }

    if (mutated) {
      const capped = existingHistory.slice(-80);
      await saveEdgeConfig({
        telegramUpdateOffset: offset,
        telegramChatHistory: capped,
        knownTelegramChats: knownChats.slice(0, 20),
      });
      return { history: capped, knownChats };
    }
  } catch {}
  return { history: existingHistory, knownChats };
}

export const onRequest = async (context: PagesContext): Promise<Response> => {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, Authorization, X-Pi-Endpoint, ngrok-skip-browser-warning, Accept',
      },
    });
  }

  const reqUrl = new URL(request.url);
  const path = reqUrl.pathname;

  // 1. System Config Hydration
  if (path === '/api/config' && request.method === 'GET') {
    const cfg = await getEdgeConfig();
    const lockState = await getEdgeCloudLockState(env);
    const activePi =
      (lockState.locked && normalizeEdgePiUrl(lockState.lockedUrl)) ||
      (await resolveActivePiUrl(request, env));
    const tgToken = cfg.telegramBotToken || env?.TELEGRAM_BOT_TOKEN || '';
    const tgChat = cfg.telegramChatId || env?.TELEGRAM_CHAT_ID || '';
    const probe =
      activePi && !isPrivateHost(activePi)
        ? await probeRemotePi(activePi, false, reqUrl.origin)
        : { isLive: false };
    return jsonResponse({
      success: true,
      edgeMode: true,
      piServerUrl: activePi,
      piServerLocked: lockState.locked,
      piServerLockSource: lockState.source,
      piOnline: probe.isLive,
      telegramConfigured: Boolean(tgToken && tgChat),
      telegramSetupComplete: Boolean(tgToken && tgChat),
      telegramChatId: tgChat,
      hasCustomPassword: Boolean(cfg.kagawadCustomPassword),
    });
  }

  // 1b. Auth Verification & Password Change
  if (path === '/api/auth/verify' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const cfg = await getEdgeConfig();
    const result = verifyTugonCredentials(
      body?.username,
      body?.password,
      cfg.kagawadCustomPassword
    );
    return jsonResponse({
      success: result.valid,
      username: result.username,
      role: result.role,
      label: result.label,
      isAdmin: result.isAdmin,
    });
  }

  if (path === '/api/auth/password' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const cleanOld = String(body?.oldPassword || '').trim();
    const cleanNew = String(body?.newPassword || '').trim();
    const cfg = await getEdgeConfig();
    const isOldValid = verifyTugonCredentials(
      body?.username || undefined,
      cleanOld,
      cfg.kagawadCustomPassword
    ).valid;

    if (!isOldValid) {
      return jsonResponse(
        {
          success: false,
          error: isEn ? 'Incorrect current password.' : 'Mali ang kasalukuyang lumang password.',
        },
        400
      );
    }
    if (cleanNew.length < 8) {
      return jsonResponse(
        {
          success: false,
          error: isEn
            ? 'New password must be at least 8 characters long.'
            : 'Ang bagong password ay dapat hindi bababa sa 8 characters.',
        },
        400
      );
    }
    await saveEdgeConfig({ kagawadCustomPassword: cleanNew });
    return jsonResponse({ success: true });
  }

  // 2. Ping & Bind Raspberry Pi Cloud Server URL
  if (path === '/api/pi/ping' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const rawUrl = String(body?.url || '').trim();

    if (isBareTunnelRoot(rawUrl)) {
      return jsonResponse(
        {
          success: false,
          online: false,
          error: isEn
            ? 'Missing full Cloud Server subdomain (e.g. https://pi.tugon-brgy40-41.org). Please enter the full server URL.'
            : 'Kulang ng sariling subdomain ang link (hal. https://pi.tugon-brgy40-41.org). Pakilagay ang buong server URL.',
        },
        400
      );
    }

    const target = normalizeEdgePiUrl(rawUrl);
    if (!target || !isValidUrlSyntax(target, reqUrl.origin)) {
      return jsonResponse(
        {
          success: false,
          online: false,
          error: isEn
            ? 'Invalid Cloud Server link. Please enter a valid server URL.'
            : 'Hindi valid ang inilagay na Cloud Server link. Pakisuri ang URL.',
        },
        400
      );
    }

    const lockState = await getEdgeCloudLockState(env);
    if (lockState.locked && !isUrlAllowedUnderLock(target, lockState)) {
      return jsonResponse(
        {
          success: false,
          online: false,
          locked: true,
          error: isEn
            ? `Cloud Server binding is locked to ${lockState.lockedUrl}. Unlock with Admin credentials first.`
            : `Naka-LOCK ang Cloud Server link sa ${lockState.lockedUrl}. I-unlock muna gamit ang Admin password.`,
        },
        403
      );
    }

    const probe = await probeRemotePi(target, isEn, reqUrl.origin);
    if (probe.isLive) {
      await saveEdgeConfig({ piServerUrl: target });
      // Sync any cached reports with Pi honoring tombstones
      const deletedIds = await syncTombstonesFromPi(target);
      const cachedReports = await getEdgeReports();
      const piReportsRes = await fetchPiReportsArray(target);
      if (piReportsRes.isArray) {
        const merged = mergeReportsLists(cachedReports, piReportsRes.list, deletedIds);
        await saveEdgeReports(merged);
      }

      return jsonResponse({
        success: true,
        online: true,
        normalizedUrl: target,
        latencyMs: probe.latencyMs,
        url: target,
        lastPingAt: new Date().toISOString(),
        method: detectMethod(target),
        mode: probe.mode || 'PULSE_SERVER',
        piData: probe.data,
        message: isEn
          ? `Connected to Raspberry Pi Cloud Server! (${probe.latencyMs}ms)`
          : `Konektado sa Raspberry Pi Cloud Server! (${probe.latencyMs}ms)`,
      });
    }

    return jsonResponse({
      success: false,
      online: false,
      normalizedUrl: target,
      isPrivateLanIp: isPrivateHost(target),
      error:
        probe.errorDetail ||
        (isEn
          ? `Cannot reach Raspberry Pi Cloud Server at ${target}.`
          : `Hindi maabot ang Raspberry Pi Cloud Server sa ${target}.`),
    });
  }

  // 2b. Client LAN Bridge
  if (path === '/api/pi/client-bridge' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const cleanUrl = normalizeEdgePiUrl(body?.url || '');
    if (!cleanUrl) {
      return jsonResponse({ success: false, error: 'Invalid bridge URL' }, 400);
    }
    const lockState = await getEdgeCloudLockState(env);
    if (lockState.locked && !isUrlAllowedUnderLock(cleanUrl, lockState)) {
      return jsonResponse(
        { success: false, error: 'Cloud Server binding is locked. External bridge override rejected.' },
        403
      );
    }
    await saveEdgeConfig({ piServerUrl: cleanUrl });
    const deletedIds = Array.isArray(body?.piData?.deletedReportIds)
      ? await recordEdgeDeletedKeys(body.piData.deletedReportIds)
      : (await getEdgeConfig()).deletedReportIds;
    const existing = await getEdgeReports();
    const merged = Array.isArray(body?.piReports)
      ? mergeReportsLists(existing, body.piReports, deletedIds)
      : existing.filter((r) => !isEdgeReportTombstoned(r, new Set(deletedIds || [])));
    await saveEdgeReports(merged);
    return jsonResponse({
      success: true,
      online: true,
      normalizedUrl: cleanUrl,
      reports: merged,
      reportsCount: merged.length,
    });
  }

  // 2c. Lock or Unlock Cloud Server Binding (Admin protected)
  if (path === '/api/pi/lock' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const wantLock = Boolean(body?.lock);
    const adminPassword = String(body?.adminPassword || '').trim();
    const cfg = await getEdgeConfig();
    const candidateUrl = normalizeEdgePiUrl(
      body?.url || cfg.piServerUrl || env?.PI_SERVER_URL || env?.VITE_PI_SERVER_URL || ''
    );

    if (!isAuthorizedAdminPassword(adminPassword)) {
      return jsonResponse(
        {
          success: false,
          error: isEn
            ? 'Valid Admin password is required to modify Cloud Server Lock.'
            : 'Kailangan ng wastong Admin password upang baguhin ang Cloud Server Lock.',
        },
        403
      );
    }

    const currentLock = await getEdgeCloudLockState(env);
    if (
      !wantLock &&
      (currentLock.source === 'hardcoded' ||
        currentLock.source === 'config_file' ||
        currentLock.source === 'env')
    ) {
      return jsonResponse(
        {
          success: false,
          error: isEn
            ? 'Cloud Server link is permanently locked in system configuration.'
            : 'Ang Cloud Server link ay permanenteng naka-lock sa configuration ng system.',
        },
        403
      );
    }

    if (wantLock && !candidateUrl) {
      return jsonResponse(
        {
          success: false,
          error: isEn
            ? 'Connect a valid Cloud Server URL before locking.'
            : 'Ikonekta muna ang isang valid na Cloud Server URL bago i-lock.',
        },
        400
      );
    }

    await saveEdgeConfig({
      ...(wantLock && candidateUrl ? { piServerUrl: candidateUrl } : {}),
      piServerLocked: wantLock,
    });

    const updated = await getEdgeCloudLockState(env);
    return jsonResponse({
      success: true,
      locked: updated.locked,
      lockedUrl: updated.lockedUrl,
      source: updated.source,
      message: wantLock
        ? isEn
          ? `Cloud Server binding locked to ${updated.lockedUrl}.`
          : `Nai-lock na ang Cloud Server link sa ${updated.lockedUrl}.`
        : isEn
          ? 'Cloud Server binding unlocked.'
          : 'Na-unlock na ang Cloud Server binding.',
    });
  }

  // 3. Disconnect Raspberry Pi Link
  if (path === '/api/pi/disconnect' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const lockState = await getEdgeCloudLockState(env);
    if (lockState.locked && !isAuthorizedAdminPassword(body?.adminPassword)) {
      return jsonResponse(
        {
          success: false,
          error: isEn
            ? 'Cloud Server binding is locked. Unlock with Admin credentials first.'
            : 'Naka-lock ang Cloud Server binding. I-unlock muna gamit ang Admin password.',
        },
        403
      );
    }
    await saveEdgeConfig({ piServerUrl: '', piServerLocked: false });
    return jsonResponse({ success: true });
  }

  // 4. Live Pi Status
  if (path === '/api/pi-status' && request.method === 'GET') {
    const isEn = reqUrl.searchParams.get('lang') === 'en';
    const activePi = await resolveActivePiUrl(request, env);
    const cachedReports = await getEdgeReports();
    const cachedLogs = await getEdgeLogbooks();

    if (!activePi) {
      return jsonResponse({
        hardware: 'Raspberry Pi 4 Model B',
        ram: 'Standby',
        storageUsedMb: 0,
        storage_folder: isEn ? 'No Cloud Server Configured' : 'Walang Naka-set na Cloud Server',
        disk_total: '0 GB',
        disk_used: '0 GB',
        disk_free: '0 GB',
        pulseFolderMb: 0,
        pulseFolderKb: 0,
        residentPhotosCount: 0,
        residentPhotosMb: 0,
        proofPhotosCount: 0,
        proofPhotosMb: 0,
        cachedImagesCount: 0,
        activeTicketsCount: cachedReports.length,
        pendingTicketsCount: cachedReports.filter((r) => r?.status === 'PENDING').length,
        autoPurgeTtlDays: AUTO_PURGE_TTL_DAYS,
        cpuTempCelsius: 0,
        ipAddress: 'Not Set',
        localHostname: 'raspberrypi.local',
        lastPurgeRun: '',
        savedLogbooksCount: cachedLogs.length,
        online: false,
        isConfigured: false,
        configuredUrl: '',
        latencyMs: 0,
        connectionMethod: isEn ? 'Not Set' : 'Walang Naka-set',
      });
    }

    const probe = await probeRemotePi(activePi, isEn, reqUrl.origin);
    if (!probe.isLive) {
      return jsonResponse({
        hardware: 'Raspberry Pi 4 Model B',
        ram: 'Offline',
        storageUsedMb: 0,
        storage_folder: `DISCONNECTED (${activePi})`,
        disk_total: '0 GB',
        disk_used: '0 GB',
        disk_free: '0 GB',
        pulseFolderMb: 0,
        pulseFolderKb: 0,
        residentPhotosCount: 0,
        residentPhotosMb: 0,
        proofPhotosCount: 0,
        proofPhotosMb: 0,
        cachedImagesCount: 0,
        activeTicketsCount: cachedReports.length,
        pendingTicketsCount: cachedReports.filter((r) => r?.status === 'PENDING').length,
        autoPurgeTtlDays: AUTO_PURGE_TTL_DAYS,
        cpuTempCelsius: 0,
        ipAddress: activePi,
        localHostname: 'raspberrypi.local',
        lastPurgeRun: '',
        savedLogbooksCount: cachedLogs.length,
        online: false,
        isConfigured: true,
        configuredUrl: activePi,
        latencyMs: 0,
        connectionMethod: 'Disconnected',
        errorDetail: probe.errorDetail,
      });
    }

    const d = probe.data || {};
    const resPhotos = cachedReports.reduce((acc, r) => acc + (r?.photos?.length || 0), 0);
    const prfPhotos = cachedReports.reduce((acc, r) => acc + (r?.proofPhotos?.length || 0), 0);
    const estMb = +(resPhotos * 0.8 + prfPhotos * 0.75 + cachedReports.length * 0.02).toFixed(2);
    const folderMb = d.pulse_folder_mb ?? estMb;

    return jsonResponse({
      hardware: d.hardware || 'Raspberry Pi 4 Model B',
      ram: d.ram || 'Active (Healthy)',
      storageUsedMb: folderMb,
      storage_folder: d.storage_folder || '/media/pi/Vherrsie Back-up/RESEARCH TRASH',
      disk_total: d.disk_total || '500.0 GB',
      disk_used: d.disk_used || '20.0 GB',
      disk_free: d.disk_free || '480.0 GB',
      pulseFolderMb: folderMb,
      pulseFolderKb: d.pulse_folder_kb ?? Math.round(folderMb * 1024),
      residentPhotosCount: d.resident_photos_count ?? resPhotos,
      residentPhotosMb: +(resPhotos * 0.8).toFixed(2),
      proofPhotosCount: d.proof_photos_count ?? prfPhotos,
      proofPhotosMb: +(prfPhotos * 0.75).toFixed(2),
      cachedImagesCount: resPhotos + prfPhotos,
      activeTicketsCount: d.reports_count ?? cachedReports.length,
      pendingTicketsCount: cachedReports.filter((r) => r?.status === 'PENDING').length,
      autoPurgeTtlDays: Number(d.autoPurgeTtlDays ?? AUTO_PURGE_TTL_DAYS),
      cpu_temp: d.cpu_temp || '42.0\u00B0C',
      cpuTempCelsius: d.cpuTempCelsius || parseFloat(d.cpu_temp) || 42,
      ipAddress: d.lan_ip || activePi,
      localHostname: d.hostname || 'raspberrypi.local',
      lastPurgeRun: new Date().toISOString(),
      savedLogbooksCount: Math.max(cachedLogs.length, Number(d.logbooks_count || d.saved_logbooks_count || 0)),
      online: true,
      isConfigured: true,
      configuredUrl: activePi,
      latencyMs: probe.latencyMs,
      connectionMethod: detectMethod(activePi),
      serverMode: probe.mode || 'PULSE_SERVER',
    });
  }

  // 5. Reports, Sync, Logbooks, Power, and Telegram
  const activePi = await resolveActivePiUrl(request, env);

  if (path === '/api/reports' && request.method === 'GET') {
    const reqLang: 'tl' | 'en' = reqUrl.searchParams.get('lang') === 'en' ? 'en' : 'tl';
    const feedFilter = reqUrl.searchParams.get('feed');
    const cfg = await getEdgeConfig();
    const cachedReports = await getEdgeReports();
    let piOnline = false;
    let combined = cachedReports;

    // Raspberry Pi is the authoritative Barangay Portal database when reachable —
    // replace stale edge cache from Pi so deleted Pi reports are never resurrected.
    if (activePi && !isPrivateHost(activePi)) {
      const piRes = await fetchPiReportsArray(activePi);
      if (piRes.ok) {
        piOnline = true;
        if (piRes.isArray) {
          const tombstones = new Set(Array.isArray(cfg.deletedReportIds) ? cfg.deletedReportIds : []);
          combined = piRes.list.filter((r) => !isEdgeReportTombstoned(r, tombstones));
          await saveEdgeReports(combined);
        }
      }
    }

    let output = combined.map((r) => {
      const purgeInfo = computeUnifiedPurgeInfo(r, reqLang);
      return {
        ...r,
        ticketNumber: formatEdgeTicket(r?.ticketNumber) || r?.ticketNumber,
        ...purgeInfo,
      };
    });
    const idsParam = reqUrl.searchParams.get('ids');
    if (idsParam !== null) {
      const rawIds = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
      const ids = new Set(rawIds);
      const normalizedIds = new Set(rawIds.map((s) => formatEdgeTicket(s).toUpperCase()).filter(Boolean));
      output =
        ids.size === 0
          ? []
          : output.filter(
              (r) =>
                ids.has(String(r?.id)) ||
                ids.has(String(r?.ticketNumber)) ||
                normalizedIds.has(formatEdgeTicket(r?.ticketNumber).toUpperCase())
            );
    } else if (feedFilter === 'active') {
      output = output.filter((r) => !r.isPurgedFromFeed);
    } else if (feedFilter === 'purged') {
      output = output.filter((r) => r.isPurgedFromFeed);
    }

    return jsonResponse(output, 200, {
      'X-Pi-Online': piOnline ? 'true' : 'false',
    });
  }

  if (path === '/api/reports' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    if (!activePi || isPrivateHost(activePi)) {
      return jsonResponse(
        {
          success: false,
          piOffline: true,
          edgeNeedsDirectClient: isPrivateHost(activePi),
          error: isEn
            ? 'Raspberry Pi Cloud Server is not connected.'
            : 'Hindi pa nakakonekta ang Raspberry Pi Cloud Server.',
        },
        503
      );
    }

    const probe = await probeRemotePi(activePi, isEn, reqUrl.origin);
    if (!probe.isLive) {
      return jsonResponse(
        {
          success: false,
          piOffline: true,
          error:
            probe.errorDetail ||
            (isEn
              ? 'Raspberry Pi Cloud Server is currently offline.'
              : 'Offline ngayon ang Raspberry Pi Cloud Server.'),
        },
        503
      );
    }

    const cached = await getEdgeReports();
    const piRes = await fetchPiReportsArray(activePi);
    const existing = piRes.ok && piRes.isArray ? piRes.list : cached;

    const newReport = {
      ...body,
      id: body.id || `rep-${Date.now()}`,
      ticketNumber: formatEdgeTicket(body.ticketNumber) || `TUGON-CAV-${String(Date.now()).slice(-4)}`,
      localSyncStatus: 'SENT_TO_PI',
      status: body.status || 'PENDING',
      createdAt: body.createdAt || new Date().toISOString(),
      sourceStorage: 'Raspberry Pi 4B Cloud Storage',
    };
    delete newReport.clientSyncedToPi;
    delete newReport.lang;

    const merged = mergeReportsLists([newReport], existing);
    const pushed = await pushReportsToRemotePi(activePi, merged, newReport);
    if (!pushed) {
      return jsonResponse({ success: false, piOffline: true }, 503);
    }

    await saveEdgeReports(merged);

    // Strictly send 2 Telegram messages (Message 1: New Concern Info, Message 2: Active & Unresolved List)
    // Always awaited so Cloudflare Workers never aborts the dispatch!
    const cfg = await getEdgeConfig();
    const { token: tgToken, chatId: tgChat } = await resolveEdgeTelegramCreds(
      request,
      env,
      cfg,
      activePi,
      body
    );
    const tgDelivery = await dispatchEdgeNewConcern2Messages(
      tgToken,
      tgChat,
      newReport,
      merged,
      isEn ? 'en' : 'tl',
      cfg
    );

    return jsonResponse(
      {
        success: true,
        report: newReport,
        telegramNotified: tgDelivery.notified,
        telegramMessagesSent: tgDelivery.count,
      },
      201
    );
  }

  if (path.startsWith('/api/reports/') && (request.method === 'PATCH' || request.method === 'DELETE')) {
    const remainder = path.slice('/api/reports/'.length).replace(/\/status$/, '').replace(/\/+$/, '');
    const targetId = decodeURIComponent(remainder);
    const targetTicket = formatEdgeTicket(targetId).toUpperCase();
    const cached = await getEdgeReports();
    const piRes = activePi && !isPrivateHost(activePi) ? await fetchPiReportsArray(activePi) : { ok: false, isArray: false, list: [] };
    const currentList = piRes.ok && piRes.isArray ? piRes.list : cached;

    if (request.method === 'DELETE') {
      const keysToTombstone = new Set(extractEdgeKeys(targetId));
      const filtered = currentList.filter((r) => {
        const isMatch =
          r?.id === targetId ||
          r?.ticketNumber === targetId ||
          (targetTicket && formatEdgeTicket(r?.ticketNumber).toUpperCase() === targetTicket);
        if (isMatch) {
          for (const k of extractEdgeKeys(r)) keysToTombstone.add(k);
          return false;
        }
        return true;
      });
      await recordEdgeDeletedKeys(Array.from(keysToTombstone));
      await saveEdgeReports(filtered);
      if (activePi && !isPrivateHost(activePi)) {
        await fetch(`${activePi}/api/reports?id=${encodeURIComponent(targetId)}`, {
          method: 'DELETE',
          headers: PI_EDGE_HEADERS,
        }).catch(() => null);
      }
      return jsonResponse({ success: true, deletedId: targetId });
    }

    const patchBody: any = await request.json().catch(() => ({}));
    const nowIso = new Date().toISOString();
    let updatedReport: any = null;

    const nextList = currentList.map((r) => {
      if (
        r?.id === targetId ||
        r?.ticketNumber === targetId ||
        (targetTicket && formatEdgeTicket(r?.ticketNumber).toUpperCase() === targetTicket)
      ) {
        const next = {
          ...r,
          ticketNumber: formatEdgeTicket(r?.ticketNumber) || r?.ticketNumber,
          status: patchBody.status || r.status,
        };
        if (patchBody.status === 'DISPATCHED') {
          next.dispatchedAt = nowIso;
          next.dispatchedKagawad = patchBody.dispatchedKagawad || 'Barangay Official';
        } else if (patchBody.status === 'RESOLVED') {
          next.resolvedAt = nowIso;
          next.resolvedBy = patchBody.resolvedBy || 'Barangay Official';
          if (Array.isArray(patchBody.proofPhotos)) next.proofPhotos = patchBody.proofPhotos;
          if (patchBody.resolutionNotes) next.resolutionNotes = patchBody.resolutionNotes;
          if (patchBody.proofKagawadName) next.proofKagawadName = patchBody.proofKagawadName;
          next.proofSubmittedAt = nowIso;
        } else if (patchBody.status === 'CANCELLED') {
          next.cancelledAt = nowIso;
          next.cancellationReason = patchBody.cancellationReason || 'Cancelled';
        }
        updatedReport = next;
        return next;
      }
      return r;
    });

    if (!updatedReport) {
      return jsonResponse({ success: false, error: 'Report not found' }, 404);
    }

    await saveEdgeReports(nextList);
    if (activePi && !isPrivateHost(activePi)) {
      const piPatchRes = await fetch(`${activePi}/api/reports/${encodeURIComponent(targetId)}/status`, {
        method: 'PATCH',
        headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody),
      }).catch(() => null);
      if (!piPatchRes || !piPatchRes.ok) {
        await pushReportsToRemotePi(activePi, nextList, updatedReport);
      }
    }

    let telegramNotified = false;
    if (patchBody?.status === 'RESOLVED') {
      const cfg = await getEdgeConfig();
      const { token: tgToken, chatId: tgChat } = await resolveEdgeTelegramCreds(
        request,
        env,
        cfg,
        activePi,
        patchBody
      );
      if (tgToken && tgChat) {
        const reqLang: 'tl' | 'en' = patchBody?.lang === 'en' ? 'en' : 'tl';
        const phTime = getPhilippineDateTime();
        const msg1 = buildResolvedConcernMessage1Html(updatedReport, reqLang, phTime);
        const msg2 = buildActiveUnresolvedConcernsMessage2Html(nextList, reqLang, 'ACTIVE');
        const m1 = await sendEdgeTelegramMessage(tgToken, tgChat, msg1);
        const m2 = await sendEdgeTelegramMessage(
          tgToken,
          tgChat,
          msg2,
          buildTelegramReplyKeyboard(reqLang)
        );
        telegramNotified = m1.ok || m2.ok;
      }
    }

    return jsonResponse({ success: true, report: updatedReport, telegramNotified });
  }

  if (path === '/api/reports/clear-all' && request.method === 'POST') {
    const existing = await getEdgeReports();
    const keys = existing.flatMap((r) => extractEdgeKeys(r));
    if (keys.length > 0) await recordEdgeDeletedKeys(keys);
    await saveEdgeReports([]);
    if (activePi && !isPrivateHost(activePi)) {
      await fetch(`${activePi}/api/reports/clear-all`, {
        method: 'POST',
        headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
      }).catch(() => null);
    }
    return jsonResponse({ success: true });
  }

  if (path === '/api/pi/sync' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const target = normalizeEdgePiUrl(body?.url || activePi);
    const probe = await probeRemotePi(target, isEn, reqUrl.origin);
    if (!probe.isLive) {
      return jsonResponse({
        success: false,
        online: false,
        error: probe.errorDetail || (isEn ? 'Cannot reach Pi server.' : 'Hindi maabot ang Pi server.'),
      });
    }
    const deletedIds = await syncTombstonesFromPi(target);
    const cached = await getEdgeReports();
    const piRes = await fetchPiReportsArray(target);
    const merged = piRes.isArray ? mergeReportsLists(cached, piRes.list, deletedIds) : cached;
    await saveEdgeReports(merged);
    await pushReportsToRemotePi(target, merged);

    return jsonResponse({
      success: true,
      online: true,
      synced: true,
      count: merged.length,
      message: isEn
        ? `Successfully synced ${merged.length} report(s) with Raspberry Pi Hard Drive!`
        : `Matagumpay na na-sync ang ${merged.length} ulat sa Raspberry Pi Hard Drive!`,
    });
  }

  // Logbook Endpoints
  if (path === '/api/pi/save-logbook' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const phTime = getPhilippineDateTime();
    const nowIso = new Date().toISOString();
    const reports = await getEdgeReports();
    const targetUrl = normalizeEdgePiUrl(body?.piEndpoint || activePi);

    const logbookId = `LOG-${Date.now()}`;
    const filename = `TUGON_Logbook_Brgy40_41_${nowIso.slice(0, 10)}_${Date.now().toString().slice(-4)}.json`;
    let syncStatus: 'SYNCED' | 'LOCAL_ONLY' = body?.clientSyncedToPi ? 'SYNCED' : 'LOCAL_ONLY';

    if (!body?.clientSyncedToPi && targetUrl && !isPrivateHost(targetUrl)) {
      const piSave = await fetch(`${targetUrl}/api/logbook/save`, {
        method: 'POST',
        headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          logbookId,
          filename,
          savedAt: nowIso,
          savedAtPhilippineTime: phTime,
          savedBy: body?.savedBy || 'Barangay 40 & 41 Official',
          totalRecords: reports.length,
          reports,
        }),
      }).catch(() => null);
      if (piSave && piSave.ok) syncStatus = 'SYNCED';
    }

    const pendingRecords = reports.filter((r) => r?.status === 'PENDING').length;
    const dispatchedRecords = reports.filter((r) => r?.status === 'DISPATCHED').length;
    const resolvedRecords = reports.filter((r) => r?.status === 'RESOLVED').length;
    const cancelledRecords = reports.filter((r) => r?.status === 'CANCELLED').length;
    const brgy40Count = reports.filter((r) => r?.barangay?.includes('40') || r?.purok?.includes('40')).length;
    const brgy41Count = reports.length - brgy40Count;

    const newLogBook = {
      id: logbookId,
      filename,
      savedAt: nowIso,
      savedAtPhilippineTime: phTime,
      totalRecords: reports.length,
      pendingRecords,
      dispatchedRecords,
      resolvedRecords,
      cancelledRecords,
      brgy40Count,
      brgy41Count,
      storageUsedMb: +(reports.length * 0.5).toFixed(2),
      savedBy: body?.savedBy || (isEn ? 'Barangay 40 & 41 Official' : 'Barangay 40 & 41 Kagawad'),
      destination: 'Raspberry Pi 4B Cloud Server',
      syncStatus,
      recordsSummary: isEn
        ? `${reports.length} total records (Pending: ${pendingRecords}, Resolved: ${resolvedRecords})`
        : `${reports.length} kabuuang tala (Pending: ${pendingRecords}, Resolved: ${resolvedRecords})`,
      recordsSnapshot: reports,
    };

    const existingLogs = await getEdgeLogbooks();
    await saveEdgeLogbooks([newLogBook, ...existingLogs]);

    return jsonResponse({
      success: true,
      logbook: newLogBook,
      message: isEn
        ? `Log Book saved and synced! (${phTime})`
        : `Matagumpay na na-save at na-sync ang Log Book! (${phTime})`,
    });
  }

  if (path === '/api/pi/saved-logbooks' && request.method === 'GET') {
    const logs = await getEdgeLogbooks();
    return jsonResponse({
      success: true,
      count: logs.length,
      logbooks: logs.map((l) => ({ ...l, recordsSnapshot: undefined })),
    });
  }

  if (path.startsWith('/api/pi/download-logbook/') && request.method === 'GET') {
    const id = decodeURIComponent(path.slice('/api/pi/download-logbook/'.length));
    const logs = await getEdgeLogbooks();
    const found = logs.find((l) => l.id === id || l.filename === id);
    if (!found) return jsonResponse({ error: 'Logbook not found' }, 404);
    return jsonResponse(found, 200, {
      'Content-Disposition': `attachment; filename="${found.filename}"`,
    });
  }

  if (path.startsWith('/api/pi/logbooks/') && request.method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/pi/logbooks/'.length));
    const logs = await getEdgeLogbooks();
    const next = logs.filter((l) => l.id !== id && l.filename !== id);
    await saveEdgeLogbooks(next);
    return jsonResponse({ success: true, deletedId: id });
  }

  // Power Action
  if (path === '/api/pi/system-action' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const target = normalizeEdgePiUrl(body?.url || activePi);
    const action = body?.action === 'reboot' ? 'reboot' : 'shutdown';
    if (!target || isPrivateHost(target)) {
      return jsonResponse({ success: false, edgeNeedsDirectClient: true }, 400);
    }
    const r = await fetch(`${target}/api/system/${action}`, {
      method: 'POST',
      headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
    }).catch(() => null);
    const data: any = r ? await r.json().catch(() => ({})) : {};
    return jsonResponse({
      success: Boolean(r?.ok),
      delivered: Boolean(r?.ok),
      message: data?.message,
    });
  }

  // Telegram Bot Endpoints on Edge
  if (path === '/api/telegram/status' && request.method === 'GET') {
    const cfg = await getEdgeConfig();
    const qToken = (reqUrl.searchParams.get('token') || '').trim();
    const qChat = (reqUrl.searchParams.get('chatId') || '').trim();
    const token = qToken || cfg.telegramBotToken || env?.TELEGRAM_BOT_TOKEN || '';
    const chatId = qChat || cfg.telegramChatId || env?.TELEGRAM_CHAT_ID || '';
    const reports = await getEdgeReports();
    const phTime = getPhilippineDateTime();

    if (!token) {
      return jsonResponse({
        online: false,
        status: 'NOT_CONFIGURED',
        botConfigured: false,
        setupComplete: false,
        chatId: '',
        botUsername: '',
        botFirstName: '',
        autoRestartCount: 0,
        reconnectAttempts: 0,
        lastCheckedAt: phTime,
        lastSeenOnline: '',
        lastError: '',
        watchdogActive: true,
        lastBroadcastMessage: cfg.lastBroadcastMessage || '',
        lastBroadcastTime: cfg.lastBroadcastTime || '',
        broadcastHistory: cfg.broadcastHistory || [],
        philippineTime: phTime,
        pendingCount: reports.filter((r) => r?.status === 'PENDING').length,
        activeUnfinishedCount: reports.filter((r) => r?.status === 'PENDING' || r?.status === 'DISPATCHED').length,
      });
    }

    const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`).catch(() => null);
    const meJson: any = meRes ? await meRes.json().catch(() => null) : null;
    const isOnline = Boolean(meRes?.ok && meJson?.ok);

    return jsonResponse({
      online: isOnline,
      status: isOnline ? 'ONLINE' : 'OFFLINE',
      botConfigured: Boolean(token && chatId),
      setupComplete: Boolean(isOnline && chatId),
      chatId,
      botUsername: meJson?.result?.username || '',
      botFirstName: meJson?.result?.first_name || '',
      autoRestartCount: 0,
      reconnectAttempts: 0,
      lastCheckedAt: phTime,
      lastSeenOnline: isOnline ? phTime : '',
      lastError: isOnline ? '' : meJson?.description || 'Invalid Bot Token',
      watchdogActive: true,
      lastBroadcastMessage: cfg.lastBroadcastMessage || '',
      lastBroadcastTime: cfg.lastBroadcastTime || '',
      broadcastHistory: cfg.broadcastHistory || [],
      philippineTime: phTime,
      pendingCount: reports.filter((r) => r?.status === 'PENDING').length,
      activeUnfinishedCount: reports.filter((r) => r?.status === 'PENDING' || r?.status === 'DISPATCHED').length,
    });
  }

  if (path === '/api/telegram/detect-chat' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const cfg = await getEdgeConfig();
    const token = String(body?.botToken || cfg.telegramBotToken || env?.TELEGRAM_BOT_TOKEN || '').trim();
    const isEn = body?.lang === 'en';
    if (!token) {
      return jsonResponse(
        {
          success: false,
          error: isEn ? 'Enter your Telegram Bot Token first.' : 'Pakilagay muna ang iyong Telegram Bot Token.',
        },
        400
      );
    }

    let r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=30`).catch(() => null);
    let data: any = r ? await r.json().catch(() => null) : null;

    if (r && (r.status === 409 || String(data?.description || '').toLowerCase().includes('webhook'))) {
      await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`, {
        method: 'POST',
      }).catch(() => null);
      r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=30`).catch(() => null);
      data = r ? await r.json().catch(() => null) : null;
    }

    if (!r || !r.ok || !data?.ok) {
      return jsonResponse(
        {
          success: false,
          error: data?.description || (isEn ? 'Invalid Bot Token.' : 'Invalid ang Bot Token.'),
        },
        400
      );
    }

    const updates = Array.isArray(data.result) ? data.result : [];
    const known = Array.isArray(cfg.knownTelegramChats) ? cfg.knownTelegramChats : [];
    const chats: { id: string; title: string; type: string }[] = [...known];
    for (let i = updates.length - 1; i >= 0; i--) {
      const u = updates[i];
      const chat =
        u?.message?.chat ||
        u?.edited_message?.chat ||
        u?.my_chat_member?.chat ||
        u?.chat_member?.chat ||
        u?.channel_post?.chat;
      if (chat && chat.id !== undefined) {
        const idStr = String(chat.id);
        if (!chats.some((c) => c.id === idStr)) {
          const title =
            chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || idStr;
          chats.push({ id: idStr, title, type: chat.type || 'private' });
        }
      }
    }

    if (chats.length === 0) {
      return jsonResponse({
        success: false,
        chats: [],
        error: isEn
          ? 'No messages received yet. Open your bot in Telegram, send /start, then click Auto-Detect again!'
          : 'Wala pang mensahe ang bot. Buksan ang bot sa Telegram, mag-send ng /start, saka pindutin muli ang Auto-Detect!',
      });
    }

    return jsonResponse({
      success: true,
      chatId: chats[0].id,
      chatTitle: chats[0].title,
      chats,
    });
  }

  if (path === '/api/telegram/configure' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const cleanToken = String(body?.botToken || '').trim();
    const cleanChat = String(body?.chatId || '').trim();
    const meRes = await fetch(`https://api.telegram.org/bot${cleanToken}/getMe`).catch(() => null);
    const meJson: any = meRes ? await meRes.json().catch(() => null) : null;
    const isOnline = Boolean(meRes?.ok && meJson?.ok);

    let registeredWebhookUrl = '';
    if (isOnline && cleanChat) {
      const webhookRes = await registerEdgeTelegramWebhook(cleanToken, reqUrl.origin);
      if (webhookRes.ok && webhookRes.webhookUrl) {
        registeredWebhookUrl = webhookRes.webhookUrl;
      }
      await saveEdgeConfig({
        telegramBotToken: cleanToken,
        telegramChatId: cleanChat,
        telegramSetupComplete: true,
        telegramWebhookUrl: registeredWebhookUrl || '',
      });
      await fetch(`https://api.telegram.org/bot${cleanToken}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commands: [
            { command: 'active', description: 'Check active & unresolved concerns (Senior/Pending/Dispatched)' },
            { command: 'summary', description: 'Show Barangay 40 & 41 live counts' },
            { command: 'help', description: 'Show bot commands & quick bubble buttons' },
          ],
        }),
      }).catch(() => null);
    }

    return jsonResponse({
      success: isOnline && Boolean(cleanChat),
      status: isOnline ? 'ONLINE' : 'OFFLINE',
      online: isOnline,
      botUsername: meJson?.result?.username || '',
      chatId: cleanChat,
      webhookActive: Boolean(registeredWebhookUrl),
      webhookUrl: registeredWebhookUrl || undefined,
      error: !isOnline ? meJson?.description || 'Invalid Bot Token' : !cleanChat ? 'Missing Chat ID' : undefined,
      message:
        isOnline && cleanChat
          ? isEn
            ? `Telegram Bot @${meJson?.result?.username} connected & saved!`
            : `Konektado at nai-save na ang Telegram Bot @${meJson?.result?.username}!`
          : meJson?.description || (isEn ? 'Check Bot Token and Chat ID.' : 'Pakisuri ang Bot Token at Chat ID.'),
    });
  }

  // Dedicated Telegram Cloud Bubble & Bot Webhook Endpoint (Real-time Serverless Handler)
  if (path === '/api/telegram/webhook' && request.method === 'POST') {
    const updatePayload: any = await request.json().catch(() => null);
    if (!updatePayload || typeof updatePayload !== 'object') {
      return jsonResponse({ ok: false, error: 'Invalid Telegram update payload' }, 400);
    }

    const cfg = await getEdgeConfig();
    const { token, chatId } = await resolveEdgeTelegramCreds(request, env, cfg, activePi);
    if (!token) {
      return jsonResponse({ ok: true, ignored: true });
    }

    const liveReports = await getLiveReportsForTelegramBot(activePi);
    const existingHistory = Array.isArray(cfg.telegramChatHistory) ? [...cfg.telegramChatHistory] : [];
    const knownChats = Array.isArray(cfg.knownTelegramChats) ? [...cfg.knownTelegramChats] : [];
    let nextOffset = typeof cfg.telegramUpdateOffset === 'number' ? cfg.telegramUpdateOffset : 0;
    if (typeof updatePayload.update_id === 'number' && updatePayload.update_id >= nextOffset) {
      nextOffset = updatePayload.update_id + 1;
    }

    const didMutate = await processEdgeTelegramUpdate(
      updatePayload,
      token,
      chatId,
      liveReports,
      existingHistory,
      knownChats,
      true
    );

    if (didMutate || nextOffset !== (cfg.telegramUpdateOffset || 0)) {
      await saveEdgeConfig({
        telegramUpdateOffset: nextOffset,
        telegramChatHistory: existingHistory.slice(-80),
        knownTelegramChats: knownChats.slice(0, 20),
      });
    }

    return jsonResponse({ ok: true, processed: didMutate });
  }

  if (path === '/api/telegram/test-notify' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const reqLang: 'tl' | 'en' = isEn ? 'en' : 'tl';
    const cfg = await getEdgeConfig();
    const token = String(body?.botToken || cfg.telegramBotToken || env?.TELEGRAM_BOT_TOKEN || '').trim();
    const chatId = String(body?.chatId || cfg.telegramChatId || env?.TELEGRAM_CHAT_ID || '').trim();
    const phTime = getPhilippineDateTime();
    const reports = await getLiveReportsForTelegramBot(activePi);
    const pendingLen = reports.filter((r) => r?.status === 'PENDING').length;

    const webhookRes = await registerEdgeTelegramWebhook(token, reqUrl.origin);

    const msg =
      body?.message ||
      (isEn
        ? `🔔 <b>[T.U.G.O.N. TEST ALERT - BARANGAY 40 &amp; 41]</b>\nStatus: Active &amp; Connected\nTime: ${phTime}\nCurrent Pending: ${pendingLen} concern(s)\n\n💡 Tap any bubble button below anytime to check active concerns!`
        : `🔔 <b>[T.U.G.O.N. TEST ALERT - BARANGAY 40 &amp; 41]</b>\nStatus: Aktibo at Konektado\nOras: ${phTime}\nKasalukuyang Pending: ${pendingLen} concern(s)\n\n💡 Pindutin ang mga bubble button sa ibaba anumang oras para tingnan ang active concerns!`);

    const sent = await sendEdgeTelegramMessage(
      token,
      chatId,
      msg,
      buildTelegramReplyKeyboard(reqLang)
    );
    if (sent.ok) {
      const prevHist = Array.isArray(cfg.broadcastHistory) ? cfg.broadcastHistory : [];
      await saveEdgeConfig({
        telegramBotToken: token,
        telegramChatId: chatId,
        telegramSetupComplete: true,
        telegramWebhookUrl: webhookRes.ok && webhookRes.webhookUrl ? webhookRes.webhookUrl : cfg.telegramWebhookUrl || '',
        lastBroadcastMessage: htmlToPlainTelegramText(msg),
        lastBroadcastTime: phTime,
        broadcastHistory: [`[${phTime}] ${htmlToPlainTelegramText(msg)}`, ...prevHist].slice(0, 20),
      });
    }

    return jsonResponse({
      success: true,
      delivered: sent.ok,
      message: sent.ok
        ? isEn
          ? `Test alert delivered to Telegram! (${phTime})`
          : `Matagumpay na naipadala ang test alert sa Telegram! (${phTime})`
        : sent.description || (isEn ? 'Could not deliver to Telegram.' : 'Hindi naipadala sa Telegram.'),
      timestamp: phTime,
    });
  }

  if (path === '/api/telegram/chat' && request.method === 'GET') {
    const cfg = await getEdgeConfig();
    const { token, chatId } = await resolveEdgeTelegramCreds(request, env, cfg, activePi);
    const reports = await getLiveReportsForTelegramBot(activePi);
    const { history } = await pollEdgeTelegramUpdatesOnce(token, chatId, reports, cfg);
    return jsonResponse({
      success: true,
      messages: history,
      pendingCount: reports.filter((r) => r?.status === 'PENDING').length,
      activeUnfinishedCount: reports.filter((r) => r?.status === 'PENDING' || r?.status === 'DISPATCHED').length,
    });
  }

  if (path === '/api/telegram/chat' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const reqLang: 'tl' | 'en' = body?.lang === 'en' ? 'en' : 'tl';
    const userText = String(body?.message || '').trim();
    if (!userText) {
      return jsonResponse({ success: false, error: 'Message is required.' }, 400);
    }

    const cfg = await getEdgeConfig();
    const { token, chatId } = await resolveEdgeTelegramCreds(request, env, cfg, activePi, body);
    const reports = await getLiveReportsForTelegramBot(activePi);
    const phTime = getPhilippineDateTime();
    const parsedBubble = parseTelegramCloudBubblePayload(userText);

    const userEntry = {
      id: `app-u-${Date.now()}`,
      sender: 'user',
      text: parsedBubble.displayLabel || userText,
      timestamp: phTime,
      source: 'app',
    };
    const reply = generateBotChatReply(userText, reports, reqLang);
    const botEntry = {
      id: `app-b-${Date.now() + 1}`,
      sender: 'bot',
      text: reply.textPlain,
      timestamp: phTime,
      source: 'app',
      matchedIntent: reply.matchedIntent,
    };

    const prevChat = Array.isArray(cfg.telegramChatHistory) ? cfg.telegramChatHistory : [];
    const nextChat = [...prevChat, userEntry, botEntry].slice(-80);
    await saveEdgeConfig({ telegramChatHistory: nextChat });

    let telegramDelivered = false;
    if (body?.sendToTelegram && token && chatId) {
      const sent = await sendEdgeTelegramMessage(
        token,
        chatId,
        reply.textHtml,
        buildTelegramReplyKeyboard(reqLang)
      );
      telegramDelivered = sent.ok;
    }

    return jsonResponse({
      success: true,
      userMessage: userEntry,
      botMessage: botEntry,
      messages: nextChat,
      telegramDelivered,
      activeUnfinishedCount: reply.activeCount,
    });
  }

  if (path === '/api/telegram/disconnect' && request.method === 'POST') {
    const cfg = await getEdgeConfig();
    if (cfg.telegramBotToken) {
      await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/deleteWebhook?drop_pending_updates=false`, {
        method: 'POST',
      }).catch(() => null);
    }
    await saveEdgeConfig({
      telegramBotToken: '',
      telegramChatId: '',
      telegramSetupComplete: false,
      telegramWebhookUrl: '',
    });
    return jsonResponse({ success: true });
  }

  if (path === '/api/telegram/restart' && request.method === 'POST') {
    const cfg = await getEdgeConfig();
    const body: any = await request.json().catch(() => ({}));
    const token = String(body?.botToken || cfg.telegramBotToken || env?.TELEGRAM_BOT_TOKEN || '').trim();
    const meRes = token ? await fetch(`https://api.telegram.org/bot${token}/getMe`).catch(() => null) : null;
    const meJson: any = meRes ? await meRes.json().catch(() => null) : null;
    const isOnline = Boolean(meRes?.ok && meJson?.ok);
    if (isOnline && token) {
      const wh = await registerEdgeTelegramWebhook(token, reqUrl.origin);
      if (wh.ok && wh.webhookUrl) {
        await saveEdgeConfig({ telegramWebhookUrl: wh.webhookUrl });
      }
    }
    return jsonResponse({
      success: isOnline,
      online: isOnline,
      status: isOnline ? 'ONLINE' : 'OFFLINE',
      botUsername: meJson?.result?.username || '',
    });
  }

  return jsonResponse({ success: false, edgeUnhandled: true, path }, 404);
};
