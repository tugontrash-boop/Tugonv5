import express from 'express';
import type { Request, Response } from 'express';
import http from 'node:http';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import JSZip from 'jszip';
import {
  BRGY_41_HALL_COORDS,
  evaluateJurisdiction,
} from './src/utils/jurisdiction.ts';
import {
  verifyTugonCredentials,
  isAuthorizedAdminPassword,
} from './src/utils/authConfig.ts';
import {
  resolveLockedCloudServerState,
  isUrlAllowedUnderLock,
} from './src/utils/cloudServerConfig.ts';
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
} from './src/utils/telegramBotEngine.ts';
import {
  AUTO_PURGE_TTL_DAYS,
  computeUnifiedPurgeInfo,
  type PurgeTtlRule,
} from './src/utils/purgeConfig.ts';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Middleware for parsing JSON with support for photo uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

export interface WasteReport {
  id: string;
  ticketNumber: string;
  residentName: string;
  residentPhone?: string;
  isElderly: boolean;
  severityLevel: 'MILD' | 'MODERATE' | 'OVERFLOWING' | 'EMERGENCY';
  purok: string;
  barangay?: string; // 'Barangay 40' | 'Barangay 41'
  streetAddress?: string;
  houseNumber?: string;
  landmark?: string;
  coordinates: {
    lat: number;
    lng: number;
  };
  autoGpsAccurate?: boolean;
  realtimeGpsAddress?: string;
  isWithinBrgy41: boolean;
  isWithinJurisdiction?: boolean;
  needsAssistanceOutside?: boolean;
  wasteTypes: string[];
  urgency: 'NORMAL' | 'HIGH' | 'CRITICAL' | 'URGENT_ELDERLY';
  estimatedBags: string;
  photos: string[];
  notes?: string;
  extraMessage?: string;
  status: 'PENDING' | 'DISPATCHED' | 'RESOLVED' | 'CANCELLED';
  dispatchedAt?: string;
  dispatchedKagawad?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  proofPhotos?: string[];
  resolutionNotes?: string;
  cancelledAt?: string;
  cancellationReason?: string;
  createdAt: string;
  retentionDays?: number;
  expiresAt?: string;
  sourceStorage?: string;
  storageUsedMb?: number;
  residentPhotosSizeMb?: number;
  proofPhotosSizeMb?: number;
  isPurgedFromFeed?: boolean;
  feedExpiresAt?: string;
  purgeRemainingMs?: number;
  purgeCountdownText?: string;
  purgeTtlRule?: PurgeTtlRule;
  remindersSent?: number;
  lastReminderAt?: string;
  proofSubmittedAt?: string;
  proofKagawadName?: string;
  deviceId?: string;
  localSyncStatus?: 'SAVED_ON_DEVICE' | 'SENT_TO_PI';
}

export interface SavedLogBook {
  id: string;
  filename: string;
  savedAt: string;
  savedAtPhilippineTime: string;
  totalRecords: number;
  pendingRecords: number;
  dispatchedRecords: number;
  resolvedRecords: number;
  cancelledRecords: number;
  brgy40Count: number;
  brgy41Count: number;
  storageUsedMb: number;
  savedBy: string;
  destination: string;
  syncStatus: 'SYNCED' | 'LOCAL_ONLY' | 'PENDING_UPLOAD';
  recordsSummary: string;
  recordsSnapshot?: WasteReport[];
}

interface PersistedSystemConfig {
  piServerUrl: string;
  piServerLocked?: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  telegramSetupComplete: boolean;
  lastBroadcastMessage: string;
  lastBroadcastTime: string;
  broadcastHistory: string[];
  kagawadCustomPassword?: string;
  deletedReportIds?: string[];
}

// -------------------------------------------------------------
// PERSISTENT STORAGE CONTROLLER
// -------------------------------------------------------------
const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const REPORTS_FILE = path.resolve(DATA_DIR, 'pulse_reports.json');
const LOGBOOK_FILE = path.resolve(DATA_DIR, 'pulse_saved_logbooks.json');
const CONFIG_FILE = path.resolve(DATA_DIR, 'pulse_config.json');

let reports: WasteReport[] = [];
let savedLogBooks: SavedLogBook[] = [];

let persistedConfig: PersistedSystemConfig = {
  piServerUrl: process.env.PI_SERVER_URL || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  telegramSetupComplete: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  lastBroadcastMessage: '',
  lastBroadcastTime: '',
  broadcastHistory: [],
  kagawadCustomPassword: '',
  deletedReportIds: [],
};

try {
  let fileToRead = REPORTS_FILE;
  if (!fs.existsSync(fileToRead)) {
    const rootReports = path.resolve(process.cwd(), 'pulse_reports.json');
    if (fs.existsSync(rootReports)) {
      fileToRead = rootReports;
    } else {
      const legacyFile = path.resolve(DATA_DIR, 'trash_reports.json');
      if (fs.existsSync(legacyFile)) fileToRead = legacyFile;
    }
  }
  if (fs.existsSync(fileToRead)) {
    const raw = fs.readFileSync(fileToRead, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      reports = parsed;
    }
    console.log(`[T.U.G.O.N. Storage] Loaded ${reports.length} persisted reports from disk.`);
  }
} catch (e) {
  console.warn('[T.U.G.O.N. Storage] Could not read reports file, starting empty:', e);
}

try {
  let logFileToRead = LOGBOOK_FILE;
  if (!fs.existsSync(logFileToRead)) {
    const rootLogs = path.resolve(process.cwd(), 'pulse_saved_logbooks.json');
    if (fs.existsSync(rootLogs)) {
      logFileToRead = rootLogs;
    } else {
      const legacyLog = path.resolve(DATA_DIR, 'trash_saved_logbooks.json');
      if (fs.existsSync(legacyLog)) logFileToRead = legacyLog;
    }
  }
  if (fs.existsSync(logFileToRead)) {
    const raw = fs.readFileSync(logFileToRead, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      savedLogBooks = parsed;
    }
    console.log(`[T.U.G.O.N. Storage] Loaded ${savedLogBooks.length} saved logbooks from disk.`);
  }
} catch (e) {
  console.warn('[T.U.G.O.N. Storage] Could not read logbooks file:', e);
}

try {
  if (fs.existsSync(CONFIG_FILE)) {
    const rawCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    persistedConfig = {
      ...persistedConfig,
      ...rawCfg,
      piServerUrl: rawCfg.piServerUrl || process.env.PI_SERVER_URL || '',
      telegramBotToken: rawCfg.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || '',
      telegramChatId: rawCfg.telegramChatId || process.env.TELEGRAM_CHAT_ID || '',
      broadcastHistory: Array.isArray(rawCfg.broadcastHistory) ? rawCfg.broadcastHistory : [],
      deletedReportIds: Array.isArray(rawCfg.deletedReportIds) ? rawCfg.deletedReportIds : [],
    };
  }
} catch (e) {
  console.warn('[T.U.G.O.N. Storage] Could not read config file:', e);
}

function persistReports() {
  try {
    fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2), 'utf8');
  } catch (e) {
    console.error('[T.U.G.O.N. Storage] Failed to persist reports:', e);
  }
}

function persistSavedLogBooks() {
  try {
    fs.writeFileSync(LOGBOOK_FILE, JSON.stringify(savedLogBooks, null, 2), 'utf8');
  } catch (e) {
    console.error('[T.U.G.O.N. Storage] Failed to persist logbooks:', e);
  }
}

function persistSystemConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(persistedConfig, null, 2), 'utf8');
  } catch (e) {
    console.error('[T.U.G.O.N. Storage] Failed to persist config:', e);
  }
}

function getEffectiveCloudLockState() {
  let staticUrl = '';
  let staticLocked = false;
  try {
    const piCfgPath = path.resolve(process.cwd(), 'public', 'pi-config.json');
    if (fs.existsSync(piCfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(piCfgPath, 'utf8'));
      staticUrl = String(parsed?.piServerUrl || '');
      staticLocked = Boolean(parsed?.locked);
    }
  } catch {}

  return resolveLockedCloudServerState({
    envUrl: process.env.PI_SERVER_URL || process.env.VITE_PI_SERVER_URL || '',
    envLocked: process.env.PI_SERVER_LOCKED,
    staticConfigUrl: staticUrl,
    staticConfigLocked: staticLocked,
    persistedUrl: persistedConfig.piServerUrl,
    persistedLocked: Boolean(persistedConfig.piServerLocked),
  });
}

// -------------------------------------------------------------
// URL NORMALIZER & LAN DETECTION FOR RASPBERRY PI
// -------------------------------------------------------------
export function isPrivateNetworkHost(urlOrHost: string): boolean {
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

const SERVER_BARE_TUNNEL_ROOTS = new Set([
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

function isPublicTunnelDomain(hostname: string): boolean {
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

function isValidServerUrl(cleanUrl: string): boolean {
  if (!cleanUrl) return false;
  try {
    const parsed = new URL(cleanUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const h = parsed.hostname.toLowerCase();
    if (!h || SERVER_BARE_TUNNEL_ROOTS.has(h)) return false;
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(h) || h.includes(':');
    const isLocal = h === 'localhost' || h.endsWith('.local');
    const hasValidDomain =
      h.includes('.') && /\.[a-z]{2,}$/i.test(h) && !h.startsWith('.') && !h.endsWith('.');
    return isIp || isLocal || hasValidDomain;
  } catch {
    return false;
  }
}

function isValidHealthObject(data: any): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (data.online === false || data.ok === false || data.healthy === false) return false;
  const st = String(data.status ?? data.state ?? '').trim().toLowerCase();
  if (['offline', 'error', 'down', 'dead', 'disconnected', 'fail', 'failed'].includes(st)) {
    return false;
  }
  if (data.error && !st && data.online !== true && data.ok !== true) {
    return false;
  }
  if (
    ['online', 'active', 'ok', 'healthy', 'running', 'up', 'ready', 'connected', 'live', 'success'].includes(
      st
    )
  ) {
    return true;
  }
  if (data.online === true || data.ok === true || data.healthy === true || data.active === true) {
    return true;
  }
  if (
    data.storage_folder ||
    data.hardware ||
    data.system ||
    data.disk_total ||
    data.cpu_temp ||
    typeof data.reports_count === 'number'
  ) {
    return true;
  }
  return false;
}

export function normalizePiUrl(rawInput: string): string {
  if (!rawInput) return '';
  let u = String(rawInput).trim().replace(/^["'`|]+|["'`|]+$/g, '').trim();
  if (!u || (/\s/.test(u) && !/https?:\/\//i.test(u))) return '';

  // Extract clean URL if user pasted a full cloudflared or ngrok terminal log line
  const embeddedMatches = u.match(/https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?(?:\/[^\s|"'<>]*)?/gi);
  if (embeddedMatches && (u.includes(' ') || u.includes('->') || u.includes('|'))) {
    const publicTunnel = embeddedMatches.find((m) => !isPrivateNetworkHost(m));
    u = publicTunnel || embeddedMatches[0];
  }

  // Add scheme if user pasted domain or IP without http(s)://
  if (!/^https?:\/\//i.test(u)) {
    if (isPrivateNetworkHost(u)) {
      const hasPort = /:\d+(\/|$)/.test(u);
      u = `http://${hasPort ? u : `${u.replace(/\/+$/, '')}:8000`}`;
    } else {
      u = `https://${u}`;
    }
  } else if (/^http:\/\//i.test(u) && !isPrivateNetworkHost(u)) {
    try {
      const p = new URL(u);
      if (isPublicTunnelDomain(p.hostname)) {
        u = u.replace(/^http:\/\//i, 'https://');
      }
    } catch {}
  }

  try {
    const parsed = new URL(u);
    if (isPublicTunnelDomain(parsed.hostname) && (parsed.port === '3000' || parsed.port === '8000')) {
      parsed.port = '';
      u = parsed.toString();
    }
  } catch {
    return '';
  }

  // Strip accidental trailing API subpaths if user pasted full health URL
  u = u
    .replace(/\/api\/(health|storage|reports|logbooks|config|pi-status)\/?$/i, '')
    .replace(/\/test\.txt$/i, '')
    .replace(/\/+$/, '');

  return u;
}

// -------------------------------------------------------------
// TELEGRAM BOT & WATCHDOG ENGINE
// -------------------------------------------------------------
let telegramConfig = {
  botToken: persistedConfig.telegramBotToken || '',
  chatId: persistedConfig.telegramChatId || '',
  botEnabled: true,
  lastBroadcastMessage: persistedConfig.lastBroadcastMessage || '',
  lastBroadcastTime: persistedConfig.lastBroadcastTime || '',
  piServerUrl: normalizePiUrl(persistedConfig.piServerUrl || ''),
};

interface TelegramWatchdogState {
  status: 'ONLINE' | 'OFFLINE' | 'RECONNECTING' | 'NOT_CONFIGURED';
  isHealthy: boolean;
  botUsername: string;
  botFirstName: string;
  autoRestartCount: number;
  reconnectAttempts: number;
  consecutiveFailures: number;
  lastCheckedAt: string;
  lastSeenOnline: string;
  lastError: string;
  watchdogActive: boolean;
}

const telegramWatchdog: TelegramWatchdogState = {
  status: 'NOT_CONFIGURED',
  isHealthy: false,
  botUsername: '',
  botFirstName: '',
  autoRestartCount: 0,
  reconnectAttempts: 0,
  consecutiveFailures: 0,
  lastCheckedAt: '',
  lastSeenOnline: '',
  lastError: '',
  watchdogActive: true,
};

export function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function getPhilippineDateTime(): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  };
  return new Intl.DateTimeFormat('en-PH', options).format(new Date());
}

function formatServerTicket(raw?: string): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^#+/, '');
  if (!cleaned) return '';
  return cleaned
    .replace(/^(PULSE|TRASH|DRAW)-CAV-/i, 'TUGON-CAV-')
    .replace(/^TUGON-CAV-/i, 'TUGON-CAV-');
}

function isValidServerPhotoSrc(src?: unknown): src is string {
  if (typeof src !== 'string') return false;
  const trimmed = src.trim();
  if (!trimmed || trimmed === 'data:,' || trimmed === 'data:' || trimmed === 'about:blank') return false;
  if (trimmed.startsWith('blob:')) return false;
  if (trimmed.startsWith('data:image/')) return trimmed.length >= 100;
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) return true;
  if (trimmed.length >= 100 && /^[A-Za-z0-9+/=\s]+$/.test(trimmed.slice(0, 120))) return true;
  return false;
}

function pickBestServerPhotos(primary?: string[], secondary?: string[]): string[] {
  const validPrimary = Array.isArray(primary) ? primary.filter(isValidServerPhotoSrc) : [];
  const validSecondary = Array.isArray(secondary) ? secondary.filter(isValidServerPhotoSrc) : [];
  if (validPrimary.length >= validSecondary.length && validPrimary.length > 0) return validPrimary;
  if (validSecondary.length > 0) return validSecondary;
  if (Array.isArray(primary) && primary.length > 0) return primary;
  if (Array.isArray(secondary) && secondary.length > 0) return secondary;
  return [];
}

export function formatActiveUnfinishedListHtml(lang: 'tl' | 'en' = 'tl'): string {
  return buildActiveUnresolvedConcernsMessage2Html(reports, lang, 'ACTIVE');
}

function recordTelegramBroadcast(plainSummary: string, phTime: string) {
  telegramConfig.lastBroadcastMessage = plainSummary;
  telegramConfig.lastBroadcastTime = phTime;
  persistedConfig.lastBroadcastMessage = plainSummary;
  persistedConfig.lastBroadcastTime = phTime;
  const entry = `[${phTime}] ${htmlToPlainTelegramText(plainSummary).replace(/\n+/g, ' • ')}`;
  persistedConfig.broadcastHistory = [entry, ...(persistedConfig.broadcastHistory || []).slice(0, 29)];
  persistSystemConfig();
}

interface ServerTelegramChatMessage {
  id: string;
  sender: 'user' | 'bot';
  text: string;
  timestamp: string;
  source: 'app' | 'telegram';
  matchedIntent?: string;
}

const telegramChatHistory: ServerTelegramChatMessage[] = [];
const seenTelegramChats: { id: string; title: string; type: string }[] = [];
let telegramUpdateOffset = 0;
let isPollingTelegramUpdates = false;
let telegramCommandsRegisteredForToken = '';

function pushTelegramChatEntry(entry: ServerTelegramChatMessage) {
  telegramChatHistory.push(entry);
  if (telegramChatHistory.length > 80) {
    telegramChatHistory.splice(0, telegramChatHistory.length - 80);
  }
}

async function registerTelegramBotCommands(token: string) {
  if (!token || token === 'YOUR_BOT_TOKEN_HERE' || telegramCommandsRegisteredForToken === token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
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
    telegramCommandsRegisteredForToken = token;
  } catch {}
}

async function resolveServerTelegramCreds(req?: Request): Promise<{ token: string; chatId: string }> {
  const headerToken = String(req?.headers?.['x-telegram-token'] || req?.body?.telegramBotToken || '').trim();
  const headerChat = String(req?.headers?.['x-telegram-chat-id'] || req?.body?.telegramChatId || '').trim();

  let changed = false;
  if (!telegramConfig.botToken && headerToken) {
    telegramConfig.botToken = headerToken;
    persistedConfig.telegramBotToken = headerToken;
    changed = true;
  }
  if (!telegramConfig.chatId && headerChat) {
    telegramConfig.chatId = headerChat;
    persistedConfig.telegramChatId = headerChat;
    changed = true;
  }

  // Fallback: pull saved Telegram creds from connected Raspberry Pi /api/config if server cache lacked them
  if (!telegramConfig.botToken || !telegramConfig.chatId) {
    const headerPi = String(req?.headers?.['x-pi-endpoint'] || '').trim();
    const piUrl = normalizePiUrl(livePiConnection.configuredUrl || telegramConfig.piServerUrl || headerPi || '');
    if (piUrl && !isPrivateNetworkHost(piUrl)) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2500);
        const cfgRes = await fetch(`${piUrl}/api/config`, {
          signal: ctrl.signal,
          headers: PI_STANDARD_HEADERS,
        }).catch(() => null);
        clearTimeout(t);
        if (cfgRes && cfgRes.ok) {
          const cfgJson: any = await cfgRes.json().catch(() => null);
          if (!telegramConfig.botToken && cfgJson?.telegramBotToken) {
            telegramConfig.botToken = String(cfgJson.telegramBotToken).trim();
            persistedConfig.telegramBotToken = telegramConfig.botToken;
            changed = true;
          }
          if (!telegramConfig.chatId && cfgJson?.telegramChatId) {
            telegramConfig.chatId = String(cfgJson.telegramChatId).trim();
            persistedConfig.telegramChatId = telegramConfig.chatId;
            changed = true;
          }
        }
      } catch {}
    }
  }

  if (changed) {
    if (telegramConfig.botToken && telegramConfig.chatId) {
      persistedConfig.telegramSetupComplete = true;
    }
    persistSystemConfig();
  }

  return {
    token: telegramConfig.botToken?.trim() || '',
    chatId: telegramConfig.chatId?.trim() || '',
  };
}

export async function sendRealTelegramMessage(
  htmlText: string,
  replyMarkup?: any,
  chatIdOverride?: string
): Promise<{ ok: boolean; description?: string }> {
  const token = telegramConfig.botToken?.trim();
  const chatId = (chatIdOverride || telegramConfig.chatId || '').trim();
  if (!token || !chatId || token === 'YOUR_BOT_TOKEN_HERE') {
    return { ok: false, description: 'Walang nakalagay na Telegram Bot Token o Chat ID.' };
  }
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const payload: Record<string, any> = {
      chat_id: chatId,
      text: htmlText,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));

    if (data?.ok) {
      return { ok: true };
    }

    // Fallback: retry as plain text if HTML entity parsing caused an error
    if (String(data?.description || '').toLowerCase().includes('parse')) {
      const plainText = htmlToPlainTelegramText(htmlText);
      const retryPayload: Record<string, any> = { chat_id: chatId, text: plainText };
      if (replyMarkup) retryPayload.reply_markup = replyMarkup;
      const retryRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(retryPayload),
      });
      const retryData = await retryRes.json().catch(() => ({ ok: false }));
      if (retryData?.ok) return { ok: true };
    }

    return {
      ok: false,
      description: data?.description || 'Hindi naipadala sa Telegram. Suriin ang Bot Token at Chat ID (i-tap ang /start sa iyong bot).',
    };
  } catch (err: any) {
    return { ok: false, description: err?.message || 'Network error habang kumokonekta sa Telegram API.' };
  }
}

export async function sendRealTelegramPhoto(
  dataUrl: string,
  captionText: string,
  replyMarkup?: any,
  chatIdOverride?: string,
  useHtml = false
): Promise<{ ok: boolean }> {
  const token = telegramConfig.botToken?.trim();
  const chatId = (chatIdOverride || telegramConfig.chatId || '').trim();
  if (!token || !chatId || !dataUrl || !dataUrl.startsWith('data:image/')) {
    return { ok: false };
  }
  try {
    const [header, base64Data] = dataUrl.split(',');
    if (!base64Data) return { ok: false };
    const mimeMatch = header.match(/data:(image\/[a-zA-Z0-9.+-]+);base64/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    const binaryBuffer = Buffer.from(base64Data, 'base64');

    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('caption', captionText.slice(0, 950));
    if (useHtml) {
      formData.append('parse_mode', 'HTML');
    }
    if (replyMarkup) {
      formData.append('reply_markup', JSON.stringify(replyMarkup));
    }
    formData.append(
      'photo',
      new Blob([binaryBuffer], { type: mimeType }),
      `tugon_report.${ext}`
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const parsed = await res.json().catch(() => ({ ok: false }));
    return { ok: Boolean(parsed?.ok) };
  } catch {
    return { ok: false };
  }
}

/**
 * Sends STRICTLY 2 Telegram messages for every new concern:
 *  Message 1: New concern infos (with attached photo when valid, falling back to text)
 *  Message 2: List of all active and unresolved concerns + quick bubble buttons
 */
async function dispatchNewConcernTwoTelegramMessages(
  report: WasteReport,
  lang: 'tl' | 'en' = 'tl'
): Promise<{ notified: boolean; msg1Ok: boolean; msg2Ok: boolean }> {
  const phTime = getPhilippineDateTime();
  const msg1Html = buildNewConcernMessage1Html(report, lang, phTime);
  const inlineKb = buildNewConcernInlineKeyboard(report, lang);

  let m1: { ok: boolean } = { ok: false };
  if (Array.isArray(report.photos) && report.photos[0] && report.photos[0].startsWith('data:image/')) {
    const captionHtml = buildNewConcernPhotoCaptionHtml(report, lang, phTime);
    m1 = await sendRealTelegramPhoto(report.photos[0], captionHtml, inlineKb, undefined, true);
  }
  if (!m1.ok) {
    m1 = await sendRealTelegramMessage(msg1Html, inlineKb);
  }
  if (m1.ok) {
    recordTelegramBroadcast(msg1Html, phTime);
  }

  const msg2Html = buildActiveUnresolvedConcernsMessage2Html(reports, lang, 'ACTIVE');
  const m2 = await sendRealTelegramMessage(msg2Html, buildTelegramReplyKeyboard(lang));
  if (m2.ok) {
    recordTelegramBroadcast(msg2Html, phTime);
  }

  return { notified: m1.ok || m2.ok, msg1Ok: m1.ok, msg2Ok: m2.ok };
}

/**
 * Sends 2 Telegram messages when a concern is resolved:
 *  Message 1: Resolved ticket details (+ proof photo when valid)
 *  Message 2: Updated list of remaining active and unresolved concerns
 */
async function dispatchResolvedConcernTwoTelegramMessages(
  report: WasteReport,
  lang: 'tl' | 'en' = 'tl'
): Promise<{ notified: boolean }> {
  const phTime = getPhilippineDateTime();
  const msg1Html = buildResolvedConcernMessage1Html(report, lang, phTime);
  let m1: { ok: boolean } = { ok: false };
  if (Array.isArray(report.proofPhotos) && report.proofPhotos[0] && report.proofPhotos[0].startsWith('data:image/')) {
    m1 = await sendRealTelegramPhoto(
      report.proofPhotos[0],
      `✅ Katibayan ng Paglilinis • Ticket #${formatServerTicket(report.ticketNumber)} (${report.resolvedBy || 'Barangay Kagawad'})`
    );
  }
  const m1Text = await sendRealTelegramMessage(msg1Html);
  const msg1Delivered = m1.ok || m1Text.ok;
  if (msg1Delivered) {
    recordTelegramBroadcast(msg1Html, phTime);
  }

  const msg2Html = buildActiveUnresolvedConcernsMessage2Html(reports, lang, 'ACTIVE');
  const m2 = await sendRealTelegramMessage(msg2Html, buildTelegramReplyKeyboard(lang));
  if (m2.ok) {
    recordTelegramBroadcast(msg2Html, phTime);
  }

  return { notified: msg1Delivered || m2.ok };
}

async function pullAuthoritativePiReports(targetEndpoint?: string): Promise<WasteReport[]> {
  const url = normalizePiUrl(targetEndpoint || livePiConnection.configuredUrl || telegramConfig.piServerUrl || '');
  if (!url) return reports;
  try {
    const getCtrl = new AbortController();
    const getTimer = setTimeout(() => getCtrl.abort(), 3500);
    const getRes = await fetch(`${url}/api/reports`, {
      signal: getCtrl.signal,
      headers: PI_STANDARD_HEADERS,
    }).catch(() => null);
    clearTimeout(getTimer);
    if (getRes && getRes.ok) {
      const piReports = await getRes.json().catch(() => null);
      if (Array.isArray(piReports)) {
        reports = piReports.map((r: any) => ({
          ...r,
          ticketNumber: formatServerTicket(r?.ticketNumber) || r?.ticketNumber,
        }));
        persistReports();
      }
    }
  } catch {}
  return reports;
}

async function processServerTelegramUpdate(
  u: any,
  token: string,
  activeReports: WasteReport[],
  allowReply: boolean
): Promise<boolean> {
  if (!u || typeof u !== 'object') return false;
  if (typeof u?.update_id === 'number' && u.update_id >= telegramUpdateOffset) {
    telegramUpdateOffset = u.update_id + 1;
  }

  const chat =
    u?.message?.chat ||
    u?.edited_message?.chat ||
    u?.callback_query?.message?.chat ||
    u?.my_chat_member?.chat ||
    u?.chat_member?.chat ||
    u?.channel_post?.chat;

  if (chat && chat.id !== undefined) {
    const idStr = String(chat.id);
    const title =
      chat.title ||
      [chat.first_name, chat.last_name].filter(Boolean).join(' ') ||
      chat.username ||
      idStr;
    if (!seenTelegramChats.some((c) => c.id === idStr)) {
      seenTelegramChats.unshift({ id: idStr, title, type: chat.type || 'private' });
      if (seenTelegramChats.length > 20) seenTelegramChats.pop();
    }
  }

  if (!allowReply) return false;

  const phTime = getPhilippineDateTime();

  // 1. Inline Cloud Bubble callback_query handler
  const cbQuery = u?.callback_query;
  if (cbQuery && cbQuery.id) {
    const rawCbData = String(cbQuery.data || '').trim();
    const parsedBubble = parseTelegramCloudBubblePayload(rawCbData);
    const bubbleLang: 'tl' | 'en' =
      parsedBubble.detectedLang || detectTelegramLanguage(parsedBubble.normalizedCommand, 'tl');

    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: cbQuery.id,
        text: bubbleLang === 'en' ? 'Fetching live T.U.G.O.N. records...' : 'Kinukuha ang live records...',
      }),
    }).catch(() => null);

    const cbChatId =
      cbQuery.message?.chat?.id !== undefined ? String(cbQuery.message.chat.id) : telegramConfig.chatId;
    if (cbChatId && rawCbData) {
      const reply = generateBotChatReply(rawCbData, activeReports, bubbleLang);
      pushTelegramChatEntry({
        id: `tg-u-${u.update_id || Date.now()}`,
        sender: 'user',
        text: parsedBubble.displayLabel || '📋 Check Active Concerns / Unresolved',
        timestamp: phTime,
        source: 'telegram',
      });
      await sendRealTelegramMessage(reply.textHtml, buildTelegramReplyKeyboard(bubbleLang), cbChatId);
      pushTelegramChatEntry({
        id: `tg-b-${u.update_id || Date.now()}`,
        sender: 'bot',
        text: reply.textPlain,
        timestamp: phTime,
        source: 'telegram',
        matchedIntent: reply.matchedIntent,
      });
      return true;
    }
    return false;
  }

  // 2. Persistent Reply Keyboard bubble taps, JSON cloud bubble payloads, or slash commands
  const rawIncomingText =
    u?.message?.text ||
    u?.edited_message?.text ||
    u?.channel_post?.text ||
    '';
  const msgText = String(rawIncomingText || '').trim();
  const msgChatId =
    u?.message?.chat?.id !== undefined
      ? String(u.message.chat.id)
      : u?.edited_message?.chat?.id !== undefined
        ? String(u.edited_message.chat.id)
        : u?.channel_post?.chat?.id !== undefined
          ? String(u.channel_post.chat.id)
          : '';

  if (msgText && msgChatId && !u?.message?.from?.is_bot) {
    const parsedBubble = parseTelegramCloudBubblePayload(msgText);
    const lang: 'tl' | 'en' =
      parsedBubble.detectedLang || detectTelegramLanguage(parsedBubble.normalizedCommand, 'tl');
    const reply = generateBotChatReply(msgText, activeReports, lang);

    pushTelegramChatEntry({
      id: `tg-u-${u.update_id || Date.now()}`,
      sender: 'user',
      text: parsedBubble.displayLabel || msgText,
      timestamp: phTime,
      source: 'telegram',
    });
    await sendRealTelegramMessage(reply.textHtml, buildTelegramReplyKeyboard(lang), msgChatId);
    pushTelegramChatEntry({
      id: `tg-b-${u.update_id || Date.now()}`,
      sender: 'bot',
      text: reply.textPlain,
      timestamp: phTime,
      source: 'telegram',
      matchedIntent: reply.matchedIntent,
    });
    return true;
  }

  return false;
}

async function pollTelegramUpdatesOnce(): Promise<void> {
  const token = telegramConfig.botToken?.trim();
  if (!token || token === 'YOUR_BOT_TOKEN_HERE' || isPollingTelegramUpdates) return;
  isPollingTelegramUpdates = true;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    const offsetParam = telegramUpdateOffset > 0 ? `&offset=${telegramUpdateOffset}` : '';
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=25&timeout=0${offsetParam}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data: any = await res.json().catch(() => null);

    if (res.status === 409 || String(data?.description || '').toLowerCase().includes('webhook')) {
      // If webhook is registered externally (e.g. Workers), do not break webhook via deleteWebhook
      return;
    }

    if (!res.ok || !data?.ok || !Array.isArray(data.result) || data.result.length === 0) {
      return;
    }

    const activeReports = await pullAuthoritativePiReports();
    const isInitialBootstrap = telegramUpdateOffset === 0;
    const nowEpochSec = Math.floor(Date.now() / 1000);

    for (const u of data.result) {
      const msgUnix = Number(u?.message?.date || u?.edited_message?.date || u?.callback_query?.message?.date || 0);
      const isRecentOrCallback = Boolean(u?.callback_query) || (msgUnix > 0 && nowEpochSec - msgUnix <= 900);
      const allowReply = !isInitialBootstrap || isRecentOrCallback;
      await processServerTelegramUpdate(u, token, activeReports, allowReply);
    }
  } catch {
    // Non-fatal polling error
  } finally {
    isPollingTelegramUpdates = false;
  }
}

async function runTelegramWatchdogCheck(isManualRestart = false) {
  const phTime = getPhilippineDateTime();
  telegramWatchdog.lastCheckedAt = phTime;
  const token = telegramConfig.botToken?.trim();
  if (!token || token === 'YOUR_BOT_TOKEN_HERE') {
    telegramWatchdog.status = 'NOT_CONFIGURED';
    telegramWatchdog.isHealthy = false;
    telegramWatchdog.lastError = '';
    return;
  }

  const wasOffline = telegramWatchdog.status === 'OFFLINE';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await res.json().catch(() => null);
    if (res.ok && data?.ok && data?.result) {
      if (wasOffline && !isManualRestart) {
        telegramWatchdog.autoRestartCount++;
      }
      telegramWatchdog.status = 'ONLINE';
      telegramWatchdog.isHealthy = true;
      telegramWatchdog.botUsername = data.result.username || '';
      telegramWatchdog.botFirstName = data.result.first_name || 'T.U.G.O.N. Barangay Bot';
      telegramWatchdog.lastSeenOnline = phTime;
      telegramWatchdog.lastError = '';
      telegramWatchdog.consecutiveFailures = 0;
      telegramWatchdog.reconnectAttempts = 0;
      registerTelegramBotCommands(token).catch(() => null);
    } else {
      telegramWatchdog.status = 'OFFLINE';
      telegramWatchdog.isHealthy = false;
      telegramWatchdog.consecutiveFailures++;
      telegramWatchdog.lastError = data?.description || 'Invalid Telegram Bot Token.';
    }
  } catch (err: any) {
    clearTimeout(timeoutId);
    telegramWatchdog.status = 'OFFLINE';
    telegramWatchdog.isHealthy = false;
    telegramWatchdog.consecutiveFailures++;
    telegramWatchdog.lastError = err?.message || 'Telegram connection timeout.';
  }
}

// Background interactive Telegram bot polling loop (every 3.5 seconds when configured)
setInterval(() => {
  if (telegramConfig.botToken && telegramConfig.botToken !== 'YOUR_BOT_TOKEN_HERE') {
    pollTelegramUpdatesOnce().catch(() => null);
  }
}, 3500);

// Daily Reminder Background Interval (Checks every 30 minutes, fires at 8:00 AM PH Time)
let lastDailyReminderDate = '';
setInterval(async () => {
  try {
    const manilaStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' });
    const phDate = new Date(manilaStr);
    const currentDateStr = phDate.toISOString().slice(0, 10);
    const currentHour = phDate.getHours();
    if (currentHour === 8 && lastDailyReminderDate !== currentDateStr) {
      lastDailyReminderDate = currentDateStr;
      const phTime = getPhilippineDateTime();
      const dailyMsg = `🌅 <b>[T.U.G.O.N. ARAWANG PAALALA SA KAGAWAD - BARANGAY 40 &amp; 41]</b>\nMagandang umaga mga Kagawad!\nOras: ${escapeHtml(phTime)}\n\n${formatActiveUnfinishedListHtml()}`;
      const res = await sendRealTelegramMessage(dailyMsg);
      if (res.ok) recordTelegramBroadcast(dailyMsg, phTime);
    }
  } catch {}
}, 30 * 60 * 1000);

// Cavite City Jurisdiction Check (Exact Polygon Containment for Brgy 40 Gumamela & Brgy 41 Rosal)
export function checkJurisdiction(lat: number, lng: number, specifiedBarangay?: string) {
  return evaluateJurisdiction(lat, lng, specifiedBarangay, 15);
}

// Auto-purge TTL calculations (Bilingual tl / en • 7-Day TTL Retention)
export function computeReportPurgeInfo(r: WasteReport, lang: 'tl' | 'en' = 'tl') {
  return computeUnifiedPurgeInfo(r, lang);
}

// -------------------------------------------------------------
// RASPBERRY PI 4B CONNECTION, DIAGNOSTICS & TWO-WAY SYNC ENGINE
// -------------------------------------------------------------
const PI_STANDARD_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'ngrok-skip-browser-warning': 'true',
  'Bypass-Tunnel-Reminder': 'true',
  'User-Agent': 'TUGON-Pi-Bridge/2.0 (CaviteCity-Brgy40-41)',
};

const initialLockState = getEffectiveCloudLockState();

const livePiConnection = {
  configuredUrl: normalizePiUrl(
    (initialLockState.locked && initialLockState.lockedUrl) ||
      persistedConfig.piServerUrl ||
      process.env.PI_SERVER_URL ||
      ''
  ),
  isLive: false,
  lastPingAt: '',
  lastProbeAttemptMs: 0,
  latencyMs: 0,
  connectionMethod: 'Walang Naka-set',
  serverMode: '',
  lastError: '',
  cachedData: null as any,
  // Browser-bridged LAN telemetry (when user browser is on same Wi-Fi as Pi LAN IP)
  clientBridgeActiveUntil: 0,
  clientBridgeData: null as any,
};

function detectConnectionMethod(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('ngrok')) return 'ngrok Tunnel';
  if (lower.includes('trycloudflare') || lower.includes('cloudflare')) return 'Cloudflare Tunnel';
  if (lower.includes('.ts.net') || lower.includes('tailscale')) return 'Tailscale Funnel';
  if (isPrivateNetworkHost(lower)) return 'Local Wi-Fi / LAN';
  return 'HTTP/HTTPS Tunnel';
}

interface PiProbeResult {
  isLive: boolean;
  data: any;
  latencyMs: number;
  mode?: 'PULSE_SERVER' | 'SIMPLE_HTTP' | 'CLIENT_LAN_BRIDGE';
  errorDetail?: string;
  isPrivateLanIp?: boolean;
}

async function probePiServer(rawEndpoint: string, forceFresh = false): Promise<PiProbeResult> {
  const cleanEndpoint = normalizePiUrl(rawEndpoint);
  if (!cleanEndpoint) {
    return { isLive: false, data: null, latencyMs: 0, errorDetail: 'Walang nakalagay na Raspberry Pi URL.' };
  }

  // If browser LAN bridge recently reported this private LAN Pi as online (within last 20s), honor it!
  const isLan = isPrivateNetworkHost(cleanEndpoint);
  if (
    !forceFresh &&
    livePiConnection.configuredUrl === cleanEndpoint &&
    Date.now() - livePiConnection.lastProbeAttemptMs < 4000 &&
    livePiConnection.cachedData
  ) {
    return {
      isLive: livePiConnection.isLive,
      data: livePiConnection.cachedData,
      latencyMs: livePiConnection.latencyMs,
      mode: (livePiConnection.serverMode as any) || 'PULSE_SERVER',
      errorDetail: livePiConnection.lastError || undefined,
      isPrivateLanIp: isLan,
    };
  }

  if (
    isLan &&
    livePiConnection.clientBridgeActiveUntil > Date.now() &&
    livePiConnection.clientBridgeData &&
    normalizePiUrl(livePiConnection.clientBridgeData.endpoint || '') === cleanEndpoint
  ) {
    return {
      isLive: true,
      data: livePiConnection.clientBridgeData,
      latencyMs: livePiConnection.latencyMs || 12,
      mode: 'CLIENT_LAN_BRIDGE',
      isPrivateLanIp: true,
    };
  }

  const startTime = Date.now();
  livePiConnection.lastProbeAttemptMs = startTime;

  try {
    // 1. Primary check: /api/health (server.py)
    const healthController = new AbortController();
    const healthTimeout = setTimeout(() => healthController.abort(), 6500);
    const res = await fetch(`${cleanEndpoint}/api/health`, {
      signal: healthController.signal,
      headers: PI_STANDARD_HEADERS,
    }).catch(() => null);
    clearTimeout(healthTimeout);

    if (res) {
      const bodyText = await res.text().catch(() => '');

      // Immediate diagnostic check for ngrok / Cloudflare error pages so we don't waste time
      if (bodyText.includes('ERR_NGROK_3200') || (bodyText.includes('endpoint') && bodyText.includes('is offline'))) {
        return {
          isLive: false,
          data: null,
          latencyMs: 0,
          isPrivateLanIp: isLan,
          errorDetail:
            'Naka-offline ang ngrok tunnel (ERR_NGROK_3200). Patakbuhin muli ang iyong Pi server at ngrok tunnel (hal. ngrok http 3000 o 8000) sa Raspberry Pi.',
        };
      }
      if (bodyText.includes('ERR_NGROK_8012') || bodyText.includes('connection refused')) {
        return {
          isLive: false,
          data: null,
          latencyMs: 0,
          isPrivateLanIp: isLan,
          errorDetail:
            'Bukas ang ngrok tunnel ngunit walang sumasagot na server sa port (hal. port 3000 o 8000) ng iyong Raspberry Pi (ERR_NGROK_8012).',
        };
      }
      if (res.status === 502 || res.status === 530 || bodyText.includes('Argo Tunnel error') || bodyText.includes('Bad gateway')) {
        return {
          isLive: false,
          data: null,
          latencyMs: 0,
          isPrivateLanIp: isLan,
          errorDetail:
            'Hindi maabot ng tunnel ang server sa Raspberry Pi (HTTP 502/530). Siguraduhing tumatakbo ang iyong Pi server (port 3000 o 8000).',
        };
      }

      if (res.ok) {
        let data: any = null;
        try {
          data = JSON.parse(bodyText);
        } catch {
          data = null;
        }
        if (isValidHealthObject(data)) {
          const latencyMs = Math.max(1, Date.now() - startTime);
          const normalizedData = {
            status: 'ONLINE',
            system: data.system || 'T.U.G.O.N. Raspberry Pi 4B Server',
            hardware: data.hardware || 'Raspberry Pi 4 Model B',
            storage_folder: data.storage_folder || '/media/pi/Vherrsie Back-up/RESEARCH TRASH',
            disk_total: data.disk_total || '500.0 GB',
            disk_used: data.disk_used || '20.0 GB',
            disk_free: data.disk_free || '480.0 GB',
            ram: data.ram || 'Active (Healthy)',
            cpu_temp: data.cpu_temp || '42.0°C',
            cpuTempCelsius: data.cpuTempCelsius || parseFloat(data.cpu_temp) || 42.0,
            ...data,
          };
          livePiConnection.cachedData = normalizedData;
          livePiConnection.serverMode = 'PULSE_SERVER';
          return {
            isLive: true,
            data: normalizedData,
            latencyMs,
            mode: 'PULSE_SERVER',
            isPrivateLanIp: isLan,
          };
        }
      }
    }

    // 2. Secondary check: Root URL probe (supports custom Python HTTP servers)
    const rootController = new AbortController();
    const rootTimeout = setTimeout(() => rootController.abort(), 3500);
    const rootRes = await fetch(`${cleanEndpoint}/`, {
      signal: rootController.signal,
      headers: PI_STANDARD_HEADERS,
    }).catch(() => null);
    clearTimeout(rootTimeout);

    if (rootRes && rootRes.ok) {
      const text = await rootRes.text().catch(() => '');
      const serverHeader = (rootRes.headers.get('server') || '').toLowerCase();
      let jsonRoot: any = null;
      try {
        jsonRoot = JSON.parse(text);
      } catch {}

      if (isValidHealthObject(jsonRoot)) {
        const latencyMs = Math.max(1, Date.now() - startTime);
        livePiConnection.cachedData = jsonRoot;
        livePiConnection.serverMode = 'PULSE_SERVER';
        return {
          isLive: true,
          data: jsonRoot,
          latencyMs,
          mode: 'PULSE_SERVER',
          isPrivateLanIp: isLan,
        };
      }

      if (
        text.includes('Directory listing') ||
        text.includes('saved_logbooks') ||
        text.includes('pulse_reports.json') ||
        ((serverHeader.includes('python') ||
          serverHeader.includes('simplehttp') ||
          serverHeader.includes('basehttp')) &&
          !text.toLowerCase().includes('<script'))
      ) {
        const latencyMs = Math.max(1, Date.now() - startTime);
        const simpleData = {
          status: 'ONLINE',
          system: 'Raspberry Pi 4B (Python HTTP Storage)',
          hardware: 'Raspberry Pi 4 Model B',
          storage_folder: '/media/pi/Vherrsie Back-up/RESEARCH TRASH',
          disk_total: '500.0 GB',
          disk_used: '20.0 GB',
          disk_free: '480.0 GB',
          pulse_folder_mb: 1.2,
          pulse_folder_kb: 1228,
          pulse_storage_summary: 'Konektado sa Python HTTP Server',
          cpu_temp: '42.0°C',
          isSimpleHttp: true,
        };
        livePiConnection.cachedData = simpleData;
        livePiConnection.serverMode = 'SIMPLE_HTTP';
        return {
          isLive: true,
          latencyMs,
          mode: 'SIMPLE_HTTP',
          data: simpleData,
          isPrivateLanIp: isLan,
        };
      }
    }

    const lanHint = isLan
      ? 'Gumagamit ka ng Local Wi-Fi IP (hal. 192.168.x.x). Hindi maabot ng cloud server ang pribadong Wi-Fi IP maliban kung naka-tunnel (ngrok http 3000 o 8000 / cloudflared) o naka-bukas sa parehong local network.'
      : 'Hindi sumasagot o hindi valid na Raspberry Pi server ang link na ito. Tiyaking tama ang link at tumatakbo ang iyong Pi server (port 3000 o 8000) at tunnel.';

    return {
      isLive: false,
      data: null,
      latencyMs: 0,
      isPrivateLanIp: isLan,
      errorDetail: lanHint,
    };
  } catch (err: any) {
    return {
      isLive: false,
      data: null,
      latencyMs: 0,
      isPrivateLanIp: isLan,
      errorDetail: err?.message || 'Connection failed.',
    };
  }
}

function extractServerReportKeys(r: Partial<WasteReport> | string): string[] {
  const keys: string[] = [];
  if (typeof r === 'string') {
    const raw = r.trim();
    if (!raw) return keys;
    if (raw.startsWith('id:') || raw.startsWith('tk:')) {
      keys.push(raw);
    } else {
      keys.push(`id:${raw}`);
      const tk = formatServerTicket(raw).toUpperCase();
      if (tk) keys.push(`tk:${tk}`);
    }
    return keys;
  }
  const rid = String(r?.id || '').trim();
  if (rid) keys.push(`id:${rid}`);
  const tk = formatServerTicket(r?.ticketNumber).toUpperCase();
  if (tk) keys.push(`tk:${tk}`);
  return keys;
}

function recordServerDeletedKeys(newKeys: string[]) {
  const set = new Set(Array.isArray(persistedConfig.deletedReportIds) ? persistedConfig.deletedReportIds : []);
  for (const k of newKeys) {
    if (k) set.add(k);
  }
  const list = Array.from(set).slice(-2500);
  persistedConfig.deletedReportIds = list;
  persistSystemConfig();
  return list;
}

function isServerReportTombstoned(r: WasteReport, tombstones: Set<string>): boolean {
  if (tombstones.size === 0) return false;
  return extractServerReportKeys(r).some((k) => tombstones.has(k));
}

// Non-destructive two-way merge of reports between Portal and Raspberry Pi
function mergeReportsLists(
  localList: WasteReport[],
  remoteList: WasteReport[],
  deletedIds?: string[]
): WasteReport[] {
  const tombstones = new Set(deletedIds || persistedConfig.deletedReportIds || []);
  const byId = new Map<string, WasteReport>();
  const ticketToKey = new Map<string, string>();

  const scoreStatus = (r: WasteReport) => {
    if (r.status === 'RESOLVED') return 4;
    if (r.status === 'CANCELLED') return 3;
    if (r.status === 'DISPATCHED') return 2;
    return 1;
  };

  const applyMerge = (item: WasteReport) => {
    if (!item || (!item.id && !item.ticketNumber)) return;
    if (isServerReportTombstoned(item, tombstones)) return;

    const tk = formatServerTicket(item.ticketNumber).toUpperCase();
    const mapped = tk ? ticketToKey.get(tk) : undefined;
    const key = mapped || item.id || (tk ? `tk:${tk}` : '');
    if (!key) return;
    if (tk && !ticketToKey.has(tk)) ticketToKey.set(tk, key);

    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, {
        ...item,
        ticketNumber: formatServerTicket(item.ticketNumber) || item.ticketNumber,
      });
    } else {
      const itemScore = scoreStatus(item) * 10 + (item.proofPhotos?.filter(isValidServerPhotoSrc).length || 0);
      const existingScore = scoreStatus(existing) * 10 + (existing.proofPhotos?.filter(isValidServerPhotoSrc).length || 0);
      const winner = itemScore >= existingScore ? item : existing;
      const runnerUp = itemScore >= existingScore ? existing : item;
      byId.set(key, {
        ...runnerUp,
        ...winner,
        id: winner.id || runnerUp.id,
        ticketNumber:
          formatServerTicket(winner.ticketNumber || runnerUp.ticketNumber) || winner.ticketNumber,
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
        photos: pickBestServerPhotos(winner.photos, runnerUp.photos),
        proofPhotos: pickBestServerPhotos(winner.proofPhotos, runnerUp.proofPhotos),
      });
    }
  };

  for (const item of remoteList) applyMerge(item);
  for (const localItem of localList) applyMerge(localItem);

  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

async function syncReportsWithPi(targetEndpoint?: string): Promise<{ synced: boolean; count: number; mode?: string }> {
  const url = normalizePiUrl(targetEndpoint || livePiConnection.configuredUrl || telegramConfig.piServerUrl || '');
  if (!url) return { synced: false, count: reports.length };

  try {
    // 0. Pull tombstones from Pi /api/config so deleted Pi reports never resurrect from server memory
    try {
      const cfgCtrl = new AbortController();
      const cfgTimer = setTimeout(() => cfgCtrl.abort(), 3000);
      const cfgRes = await fetch(`${url}/api/config`, {
        signal: cfgCtrl.signal,
        headers: PI_STANDARD_HEADERS,
      }).catch(() => null);
      clearTimeout(cfgTimer);
      if (cfgRes && cfgRes.ok) {
        const piCfg: any = await cfgRes.json().catch(() => null);
        if (Array.isArray(piCfg?.deletedReportIds) && piCfg.deletedReportIds.length > 0) {
          const allTombstones = recordServerDeletedKeys(
            piCfg.deletedReportIds.flatMap((k: string) => extractServerReportKeys(k))
          );
          const tombstoneSet = new Set(allTombstones);
          reports = reports.filter((r) => !isServerReportTombstoned(r, tombstoneSet));
          persistReports();
        }
      }
    } catch {}

    // 1. Pull existing reports from Pi if available so we never wipe Pi-stored records
    const getCtrl = new AbortController();
    const getTimer = setTimeout(() => getCtrl.abort(), 3500);
    const getRes = await fetch(`${url}/api/reports`, {
      signal: getCtrl.signal,
      headers: PI_STANDARD_HEADERS,
    }).catch(() => null);
    clearTimeout(getTimer);

    if (getRes && getRes.ok) {
      const piReports = await getRes.json().catch(() => null);
      if (Array.isArray(piReports)) {
        reports = mergeReportsLists(reports, piReports);
        persistReports();
      }
    }

    // 2. Push merged authoritative list back to Pi hard drive
    const postCtrl = new AbortController();
    const postTimer = setTimeout(() => postCtrl.abort(), 15000);
    const postRes = await fetch(`${url}/api/reports/sync`, {
      method: 'POST',
      headers: {
        ...PI_STANDARD_HEADERS,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(reports),
      signal: postCtrl.signal,
    }).catch(() => null);
    clearTimeout(postTimer);

    if (postRes && postRes.ok) {
      const syncJson: any = await postRes.json().catch(() => null);
      if (Array.isArray(syncJson?.deletedReportIds)) {
        recordServerDeletedKeys(syncJson.deletedReportIds);
      }
      if (Array.isArray(syncJson?.reports)) {
        reports = mergeReportsLists(reports, syncJson.reports);
        persistReports();
      }
      livePiConnection.isLive = true;
      livePiConnection.lastPingAt = new Date().toISOString();
      return { synced: true, count: reports.length, mode: 'PULSE_SERVER' };
    }
  } catch (e) {
    console.warn('[Pi Sync Warning]:', e);
  }
  return { synced: false, count: reports.length };
}

// Background Watchdog for both Telegram Bot and Raspberry Pi (every 30s)
setInterval(() => {
  if (telegramConfig.botToken) {
    runTelegramWatchdogCheck(false).catch(() => {});
  }
  const activePi = livePiConnection.configuredUrl || telegramConfig.piServerUrl;
  if (activePi && !isPrivateNetworkHost(activePi)) {
    probePiServer(activePi, true)
      .then((probe) => {
        livePiConnection.isLive = probe.isLive;
        if (probe.isLive) {
          livePiConnection.latencyMs = probe.latencyMs;
          livePiConnection.lastPingAt = new Date().toISOString();
          livePiConnection.connectionMethod = detectConnectionMethod(activePi);
          livePiConnection.lastError = '';
        } else {
          livePiConnection.lastError = probe.errorDetail || 'Disconnected';
        }
      })
      .catch(() => {});
  }
}, 30000);

// Initial startup health checks
setTimeout(() => {
  if (telegramConfig.botToken) {
    runTelegramWatchdogCheck(false).catch(() => {});
  }
  if (livePiConnection.configuredUrl && !isPrivateNetworkHost(livePiConnection.configuredUrl)) {
    probePiServer(livePiConnection.configuredUrl, true)
      .then((p) => {
        livePiConnection.isLive = p.isLive;
        if (p.isLive) {
          livePiConnection.latencyMs = p.latencyMs;
          livePiConnection.lastPingAt = new Date().toISOString();
          livePiConnection.connectionMethod = detectConnectionMethod(livePiConnection.configuredUrl);
          syncReportsWithPi(livePiConnection.configuredUrl).catch(() => {});
        }
      })
      .catch(() => {});
  }
}, 800);

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// 0. Public System Config Hydration & Password Sync
app.get('/api/config', (_req: Request, res: Response) => {
  const lockState = getEffectiveCloudLockState();
  res.json({
    success: true,
    piServerUrl: (lockState.locked && lockState.lockedUrl) || livePiConnection.configuredUrl || '',
    piServerLocked: lockState.locked,
    piServerLockSource: lockState.source,
    piOnline: livePiConnection.isLive,
    telegramConfigured: Boolean(telegramConfig.botToken && telegramConfig.chatId),
    telegramSetupComplete: persistedConfig.telegramSetupComplete,
    telegramChatId: telegramConfig.chatId || '',
    hasCustomPassword: Boolean(persistedConfig.kagawadCustomPassword),
  });
});

app.post('/api/auth/verify', (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  const result = verifyTugonCredentials(
    username,
    password,
    persistedConfig.kagawadCustomPassword
  );
  res.json({
    success: result.valid,
    username: result.username,
    role: result.role,
    label: result.label,
    isAdmin: result.isAdmin,
  });
});

app.post('/api/auth/password', (req: Request, res: Response) => {
  const { username, oldPassword, newPassword, lang } = req.body || {};
  const isEn = lang === 'en';
  const cleanOld = String(oldPassword || '').trim();
  const cleanNew = String(newPassword || '').trim();
  const isOldValid = verifyTugonCredentials(
    username || undefined,
    cleanOld,
    persistedConfig.kagawadCustomPassword
  ).valid;

  if (!isOldValid) {
    return res.status(400).json({
      success: false,
      error: isEn ? 'Incorrect current password.' : 'Mali ang kasalukuyang lumang password.',
    });
  }
  if (cleanNew.length < 8) {
    return res.status(400).json({
      success: false,
      error: isEn
        ? 'New password must be at least 8 characters long.'
        : 'Ang bagong password ay dapat hindi bababa sa 8 characters.',
    });
  }
  persistedConfig.kagawadCustomPassword = cleanNew;
  persistSystemConfig();
  res.json({ success: true });
});

// 1. Get reports (Supports per-device ?ids= filter for resident privacy + ?lang=en|tl)
app.get('/api/reports', async (req: Request, res: Response) => {
  const feedFilter = req.query.feed; // 'active' | 'purged' | 'all'
  const langParam: 'tl' | 'en' = req.query.lang === 'en' ? 'en' : 'tl';
  const idsQuery = req.query.ids;

  // If resident phone requests status updates for its own private report IDs only
  let sourceList = reports;
  if (idsQuery !== undefined) {
    const rawIds = String(idsQuery || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (rawIds.length === 0) {
      res.setHeader('X-Pi-Online', livePiConnection.isLive ? 'true' : 'false');
      return res.json([]);
    }
    const idSet = new Set(rawIds);
    const normalizedIdSet = new Set(rawIds.map((id) => formatServerTicket(id).toUpperCase()).filter(Boolean));
    sourceList = reports.filter(
      (r) =>
        idSet.has(r.id) ||
        idSet.has(r.ticketNumber) ||
        normalizedIdSet.has(formatServerTicket(r.ticketNumber).toUpperCase())
    );
  }

  const safeReports = sourceList.map((r) => {
    const coords = r.coordinates || { lat: BRGY_41_HALL_COORDS[0], lng: BRGY_41_HALL_COORDS[1] };
    const juris = checkJurisdiction(coords.lat, coords.lng, r.barangay || r.purok);
    const assignedBarangay =
      r.barangay || (juris.detectedBarangay === 'Outside Jurisdiction' ? 'Barangay 41' : juris.detectedBarangay);
    const purgeInfo = computeReportPurgeInfo(r, langParam);

    const localizedWasteTypes = (Array.isArray(r.wasteTypes) ? r.wasteTypes : ['Household Trash']).map((wt) => {
      if (langParam === 'en' && wt === 'Nangangailangan ng assistance') {
        return 'Special Assistance Needed';
      }
      return wt;
    });

    return {
      ...r,
      ticketNumber: formatServerTicket(r.ticketNumber) || r.ticketNumber,
      barangay: assignedBarangay,
      purok: r.purok || `${assignedBarangay}, Cavite City`,
      coordinates: coords,
      isWithinJurisdiction: r.isWithinJurisdiction ?? juris.isWithinJurisdiction,
      isWithinBrgy41: r.isWithinBrgy41 ?? assignedBarangay.includes('41'),
      photos: Array.isArray(r.photos) ? r.photos : [],
      proofPhotos: Array.isArray(r.proofPhotos) ? r.proofPhotos : [],
      wasteTypes: localizedWasteTypes,
      severityLevel: r.severityLevel || 'MODERATE',
      isElderly: !!r.isElderly,
      extraMessage: r.extraMessage || '',
      storageUsedMb:
        r.storageUsedMb ||
        +(((r.photos?.length || 0) * 0.8) + ((r.proofPhotos?.length || 0) * 0.75)).toFixed(2),
      ...purgeInfo,
    };
  });

  res.setHeader('X-Pi-Online', livePiConnection.isLive ? 'true' : 'false');

  if (idsQuery !== undefined) {
    // Always return matching status records for the resident's own phone even if aged out of Kagawad active feed
    return res.json(safeReports);
  }

  if (feedFilter === 'active') {
    return res.json(safeReports.filter((r) => !r.isPurgedFromFeed));
  }
  if (feedFilter === 'purged') {
    return res.json(safeReports.filter((r) => r.isPurgedFromFeed));
  }

  return res.json(safeReports);
});

// 2. Create / Transmit a waste collection report through the Raspberry Pi Cloud Server
app.post('/api/reports', async (req: Request, res: Response) => {
  try {
    const {
      id: clientReportId,
      ticketNumber: clientTicketNumber,
      deviceId,
      clientSyncedToPi,
      lang,
      residentName,
      residentPhone,
      isElderly,
      severityLevel,
      purok,
      barangay,
      streetAddress,
      houseNumber,
      landmark,
      coordinates,
      autoGpsAccurate,
      wasteTypes,
      urgency,
      estimatedBags,
      photos,
      notes,
      extraMessage,
      sourceStorage,
      retentionDays,
      realtimeGpsAddress,
      needsAssistanceOutside,
    } = req.body;

    const isEn = lang === 'en';

    if (!Array.isArray(photos) || photos.length === 0) {
      return res.status(400).json({
        error: isEn ? 'At least one waste photo is required.' : 'Kinakailangan ang litrato ng basura.',
      });
    }

    // Verify Raspberry Pi Cloud Server availability BEFORE accepting photos into Kagawad queue
    const headerPi = String(req.headers['x-pi-endpoint'] || '').trim();
    const targetPi = normalizePiUrl(
      livePiConnection.configuredUrl || telegramConfig.piServerUrl || headerPi || ''
    );
    if (targetPi && !livePiConnection.configuredUrl) {
      livePiConnection.configuredUrl = targetPi;
      telegramConfig.piServerUrl = targetPi;
      persistedConfig.piServerUrl = targetPi;
      persistSystemConfig();
    }
    if (!targetPi) {
      return res.status(503).json({
        success: false,
        piOffline: true,
        error: isEn
          ? 'Raspberry Pi Cloud Server is not connected. Your report is safely saved on your phone and can be sent once the Pi Cloud Server is online.'
          : 'Hindi pa nakakonekta ang Raspberry Pi Cloud Server. Ligtas na nai-save sa iyong cellphone ang ulat at maaari itong ipasa kapag online na ang Pi Cloud Server.',
      });
    }

    const isLanPi = isPrivateNetworkHost(targetPi);
    let piProbe: PiProbeResult | null = null;
    if (!clientSyncedToPi) {
      piProbe = await probePiServer(targetPi, true);
      livePiConnection.isLive = piProbe.isLive;
      if (!piProbe.isLive) {
        return res.status(503).json({
          success: false,
          piOffline: true,
          error: isEn
            ? 'Raspberry Pi Cloud Server is currently offline. Your report and photos are safely saved on your phone—tap "Send Now" once the Pi Cloud Server is back online.'
            : 'Offline ngayon ang Raspberry Pi Cloud Server. Ligtas na naka-save sa iyong cellphone ang ulat at mga litrato—pindutin ang "Ipasa Ngayon" kapag online na ang Pi Cloud Server.',
        });
      }
    }

    // Deduplicate if resident is retrying a report that already reached the server
    if (clientReportId) {
      const existing = reports.find((r) => r.id === clientReportId);
      if (existing) {
        return res.status(200).json({ success: true, report: existing });
      }
    }

    const ticketNumber =
      clientTicketNumber && String(clientTicketNumber).trim()
        ? formatServerTicket(String(clientTicketNumber).trim())
        : `TUGON-CAV-${String(Date.now()).slice(-4)}`;
    const days = retentionDays || 30;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    const finalSeverity = severityLevel || 'MODERATE';
    let finalUrgency = urgency || 'NORMAL';
    if (isElderly) finalUrgency = 'URGENT_ELDERLY';
    else if (finalSeverity === 'EMERGENCY' || finalSeverity === 'OVERFLOWING') finalUrgency = 'HIGH';

    const coords = coordinates || { lat: BRGY_41_HALL_COORDS[0], lng: BRGY_41_HALL_COORDS[1] };
    const juris = checkJurisdiction(coords.lat, coords.lng, barangay || purok);
    const assignedBarangay =
      barangay ||
      (juris.detectedBarangay === 'Outside Jurisdiction' ? 'Barangay 41' : juris.detectedBarangay);
    const isOutsideAssistance = !!needsAssistanceOutside || !juris.isWithinJurisdiction;
    const resolvedRealtimeAddress =
      realtimeGpsAddress ||
      `${streetAddress || 'Caridad'}, ${assignedBarangay}, Cavite City`;

    const sanitizedTypes = Array.isArray(wasteTypes) && wasteTypes.length > 0 ? [...wasteTypes] : ['Household Trash'];
    if (
      isOutsideAssistance &&
      !sanitizedTypes.includes('Nangangailangan ng assistance') &&
      !sanitizedTypes.includes('Special Assistance Needed')
    ) {
      sanitizedTypes.push(isEn ? 'Special Assistance Needed' : 'Nangangailangan ng assistance');
    }

    const photoCount = Array.isArray(photos) ? photos.length : 0;
    const residentPhotosMb = +(photoCount * 0.8).toFixed(2);

    const newReport: WasteReport = {
      id: clientReportId && String(clientReportId).trim() ? String(clientReportId).trim() : `rep-${Date.now()}`,
      ticketNumber,
      deviceId: deviceId ? String(deviceId) : undefined,
      localSyncStatus: 'SENT_TO_PI',
      residentName: residentName ? String(residentName).trim() : '',
      residentPhone: residentPhone || 'N/A',
      isElderly: !!isElderly,
      severityLevel: finalSeverity,
      purok: purok || `${assignedBarangay}, Cavite City`,
      barangay: assignedBarangay,
      streetAddress: streetAddress || '',
      houseNumber: houseNumber || '',
      landmark: landmark || '',
      coordinates: coords,
      autoGpsAccurate: autoGpsAccurate ?? true,
      realtimeGpsAddress: resolvedRealtimeAddress,
      isWithinBrgy41: assignedBarangay.includes('41'),
      isWithinJurisdiction: !isOutsideAssistance,
      needsAssistanceOutside: isOutsideAssistance,
      wasteTypes: sanitizedTypes,
      urgency: finalUrgency,
      estimatedBags: estimatedBags || '1-3 bags',
      photos: Array.isArray(photos) ? photos : [],
      notes: notes || '',
      extraMessage: extraMessage ? String(extraMessage).trim() : '',
      status: 'PENDING',
      createdAt,
      proofPhotos: [],
      sourceStorage: sourceStorage || 'Raspberry Pi 4B (Local Cloud)',
      storageUsedMb: residentPhotosMb,
      residentPhotosSizeMb: residentPhotosMb,
      proofPhotosSizeMb: 0,
      retentionDays: days,
      expiresAt,
      remindersSent: 0,
    };

    // Route report + photos directly to Raspberry Pi Cloud Server before committing to Kagawad feed
    if (!clientSyncedToPi && piProbe && piProbe.mode === 'PULSE_SERVER') {
      try {
        const piPostCtrl = new AbortController();
        const piPostTimer = setTimeout(() => piPostCtrl.abort(), 15000);
        const piPostRes = await fetch(`${targetPi}/api/reports`, {
          method: 'POST',
          headers: {
            ...PI_STANDARD_HEADERS,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(newReport),
          signal: piPostCtrl.signal,
        }).catch(() => null);
        clearTimeout(piPostTimer);

        if (!piPostRes || !piPostRes.ok) {
          // Fallback to /api/reports/sync if older server.py only exposes /api/reports/sync
          const syncFallbackCtrl = new AbortController();
          const syncFallbackTimer = setTimeout(() => syncFallbackCtrl.abort(), 15000);
          const syncFallbackRes = await fetch(`${targetPi}/api/reports/sync`, {
            method: 'POST',
            headers: {
              ...PI_STANDARD_HEADERS,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify([newReport, ...reports]),
            signal: syncFallbackCtrl.signal,
          }).catch(() => null);
          clearTimeout(syncFallbackTimer);

          if (!syncFallbackRes || !syncFallbackRes.ok) {
            return res.status(503).json({
              success: false,
              piOffline: true,
              error: isEn
                ? 'Could not write photos to Raspberry Pi Cloud Server. Report remains safely saved on your phone.'
                : 'Hindi naipadala ang mga litrato sa Raspberry Pi Cloud Server. Naka-save pa rin nang ligtas sa iyong cellphone ang ulat.',
            });
          }
        }
      } catch {
        return res.status(503).json({
          success: false,
          piOffline: true,
          error: isEn
            ? 'Connection to Raspberry Pi Cloud Server interrupted. Report is safely saved on your phone.'
            : 'Naputol ang koneksyon sa Raspberry Pi Cloud Server. Ligtas na naka-save sa iyong cellphone ang ulat.',
        });
      }
    }

    reports.unshift(newReport);
    persistReports();

    if (!isLanPi) {
      syncReportsWithPi(targetPi).catch(() => {});
    }

    // Telegram Bot 2-Message Broadcast:
    //  1) New Concern Info (with attached photo when valid)
    //  2) Active & Unresolved Concerns List + Quick Bubble Buttons
    await resolveServerTelegramCreds(req);
    const tgDelivery = await dispatchNewConcernTwoTelegramMessages(
      newReport,
      isEn ? 'en' : 'tl'
    ).catch((e) => {
      console.warn('[Telegram Dispatch Warning]:', e);
      return { notified: false, msg1Ok: false, msg2Ok: false };
    });

    res.status(201).json({
      success: true,
      report: newReport,
      telegramNotified: tgDelivery.notified,
      telegramMessagesSent: (tgDelivery.msg1Ok ? 1 : 0) + (tgDelivery.msg2Ok ? 1 : 0),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to submit report' });
  }
});

// 3. Update report status / Kagawad actions
app.patch(['/api/reports/:id', '/api/reports/:id/status'], async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, dispatchedKagawad, resolvedBy, proofPhotos, resolutionNotes, cancellationReason, lang } = req.body;
  const reqLang: 'tl' | 'en' = lang === 'en' ? 'en' : 'tl';

  const targetTicket = formatServerTicket(id).toUpperCase();
  const report = reports.find(
    (r) =>
      r.id === id ||
      r.ticketNumber === id ||
      (targetTicket && formatServerTicket(r.ticketNumber).toUpperCase() === targetTicket)
  );
  if (!report) {
    return res.status(404).json({ error: 'Report not found' });
  }
  report.ticketNumber = formatServerTicket(report.ticketNumber) || report.ticketNumber;

  const nowIso = new Date().toISOString();
  let telegramNotified = false;

  if (status) {
    if (status === 'DISPATCHED') {
      report.status = 'DISPATCHED';
      report.dispatchedAt = nowIso;
      report.dispatchedKagawad = dispatchedKagawad || 'Barangay 40/41 Kagawad';
      persistReports();
    } else if (status === 'RESOLVED') {
      const isOutsideReport = Boolean(report.needsAssistanceOutside || report.isWithinJurisdiction === false);
      const validProofs = Array.isArray(proofPhotos) ? proofPhotos : [];

      if (!isOutsideReport && validProofs.length === 0) {
        return res.status(400).json({
          error: 'Bawal ma-resolve nang walang litrato ng proeba (katibayan) mula sa Kagawad para sa sakop ng Barangay 40 at 41.',
        });
      }

      report.status = 'RESOLVED';
      report.resolvedAt = nowIso;
      report.resolvedBy = resolvedBy || 'Barangay Kagawad Team';
      report.proofPhotos = validProofs;
      report.resolutionNotes =
        resolutionNotes ||
        (isOutsideReport
          ? 'Inaksyunan at binigyan ng abiso ng Barangay Kagawad.'
          : 'Nalinis at nakolekta na ang basura.');
      const proofMb = +(validProofs.length * 0.75).toFixed(2);
      report.proofPhotosSizeMb = proofMb;
      report.storageUsedMb = +(((report.residentPhotosSizeMb || 0.8) + proofMb).toFixed(2));
      persistReports();

      await resolveServerTelegramCreds(req);
      const resolvedTg = await dispatchResolvedConcernTwoTelegramMessages(report, reqLang).catch(() => ({
        notified: false,
      }));
      telegramNotified = resolvedTg.notified;
    } else if (status === 'CANCELLED') {
      report.status = 'CANCELLED';
      report.cancelledAt = nowIso;
      report.cancellationReason = cancellationReason || 'Kinansela ng Kagawad o residente.';
      persistReports();
    } else {
      report.status = status;
      persistReports();
    }
  }

  // Sync directly to authoritative Pi server (PATCH first, fallback to merge sync)
  const targetPi = livePiConnection.configuredUrl || telegramConfig.piServerUrl;
  if (targetPi && !isPrivateNetworkHost(targetPi)) {
    try {
      const piPatchRes = await fetch(`${targetPi}/api/reports/${encodeURIComponent(id)}/status`, {
        method: 'PATCH',
        headers: { ...PI_STANDARD_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
      }).catch(() => null);
      if (!piPatchRes || !piPatchRes.ok) {
        await syncReportsWithPi(targetPi).catch(() => {});
      }
    } catch {
      syncReportsWithPi(targetPi).catch(() => {});
    }
  }

  res.json({ success: true, report, telegramNotified });
});

// 4. Delete report immediately
app.delete('/api/reports/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const targetTicket = formatServerTicket(id).toUpperCase();
  const index = reports.findIndex(
    (r) =>
      r.id === id ||
      r.ticketNumber === id ||
      (targetTicket && formatServerTicket(r.ticketNumber).toUpperCase() === targetTicket)
  );
  if (index === -1) {
    return res.status(404).json({ error: 'Report not found' });
  }

  const deleted = reports.splice(index, 1)[0];
  const formattedDeletedTicket = formatServerTicket(deleted.ticketNumber) || deleted.ticketNumber;
  recordServerDeletedKeys([...extractServerReportKeys(deleted), ...extractServerReportKeys(id)]);
  persistReports();

  const targetPi = livePiConnection.configuredUrl || telegramConfig.piServerUrl;
  if (targetPi && !isPrivateNetworkHost(targetPi)) {
    await fetch(`${targetPi}/api/reports?id=${encodeURIComponent(deleted.id || id)}`, {
      method: 'DELETE',
      headers: PI_STANDARD_HEADERS,
    }).catch(() => null);
  }

  const phTime = getPhilippineDateTime();
  const deleteAlert =
    `🗑️ <b>[T.U.G.O.N. - BINURANG CONCERN]</b>\n` +
    `Ticket: <b>#${escapeHtml(formattedDeletedTicket)}</b>\n` +
    `Lugar: ${escapeHtml(deleted.purok)}\n` +
    `Oras: ${escapeHtml(phTime)}\n\n` +
    `${formatActiveUnfinishedListHtml()}`;
  sendRealTelegramMessage(deleteAlert).catch(() => {});

  res.json({ success: true, deletedId: deleted.id, ticketNumber: formattedDeletedTicket });
});

// 4b. Clear all reports (Reset to clean production state)
app.post('/api/reports/clear-all', async (_req: Request, res: Response) => {
  const keys = reports.flatMap((r) => extractServerReportKeys(r));
  if (keys.length > 0) recordServerDeletedKeys(keys);
  reports = [];
  persistReports();
  const targetPi = livePiConnection.configuredUrl || telegramConfig.piServerUrl;
  if (targetPi && !isPrivateNetworkHost(targetPi)) {
    await fetch(`${targetPi}/api/reports/clear-all`, {
      method: 'POST',
      headers: { ...PI_STANDARD_HEADERS, 'Content-Type': 'application/json' },
    }).catch(() => null);
  }
  res.json({ success: true, message: 'Matagumpay na nalinisan ang lahat ng ulat para sa malinis na produksyon.' });
});

// 5. Live Ping / Test & Save Raspberry Pi Connection
app.post('/api/pi/ping', async (req: Request, res: Response) => {
  const isEn = req.body?.lang === 'en';
  const rawUrl = String(req.body?.url || '').trim();
  const target = normalizePiUrl(rawUrl);

  if (!target || !isValidServerUrl(target)) {
    return res.status(400).json({
      success: false,
      online: false,
      error: isEn
        ? 'Invalid Cloud Server URL link. Please enter a valid Raspberry Pi server URL.'
        : 'Hindi valid ang inilagay na Cloud Server link. Pakisuri ang URL.',
    });
  }

  const lockState = getEffectiveCloudLockState();
  if (lockState.locked && !isUrlAllowedUnderLock(target, lockState)) {
    return res.status(403).json({
      success: false,
      online: false,
      locked: true,
      error: isEn
        ? `Cloud Server binding is locked to ${lockState.lockedUrl}. Unlock with Admin credentials before changing.`
        : `Naka-LOCK ang Cloud Server link sa ${lockState.lockedUrl}. I-unlock muna gamit ang Admin password bago magpalit.`,
    });
  }

  const probe = await probePiServer(target, true);

  if (probe.isLive) {
    // Only bind and persist URL once verified as a live, valid server
    livePiConnection.configuredUrl = target;
    telegramConfig.piServerUrl = target;
    persistedConfig.piServerUrl = target;
    persistSystemConfig();

    livePiConnection.isLive = true;
    livePiConnection.latencyMs = probe.latencyMs;
    livePiConnection.lastPingAt = new Date().toISOString();
    livePiConnection.lastError = '';
    livePiConnection.connectionMethod = detectConnectionMethod(target);

    if (probe.mode === 'PULSE_SERVER') {
      await syncReportsWithPi(target).catch(() => {});
    }

    return res.json({
      success: true,
      online: true,
      normalizedUrl: target,
      latencyMs: probe.latencyMs,
      url: target,
      lastPingAt: livePiConnection.lastPingAt,
      method: livePiConnection.connectionMethod,
      mode: probe.mode,
      piData: probe.data,
      message: isEn
        ? `Connected to Raspberry Pi Cloud Server! (${probe.latencyMs}ms)`
        : `Konektado sa Raspberry Pi Cloud Server! (${probe.latencyMs}ms)`,
    });
  } else {
    return res.json({
      success: false,
      online: false,
      normalizedUrl: '',
      isPrivateLanIp: probe.isPrivateLanIp,
      latencyMs: 0,
      url: target,
      error: isEn
        ? `Cloud Server is offline, invalid, or unreachable at ${target}. Please check that your Pi server (port 3000 or 8000) and tunnel are active.`
        : probe.errorDetail || `Naka-off, hindi valid, o hindi maabot ang Raspberry Pi Cloud Server sa ${target}.`,
    });
  }
});

// 5b. Browser Direct LAN Bridge (When browser on local Wi-Fi reaches 192.168.x.x:8000 directly)
app.post('/api/pi/client-bridge', (req: Request, res: Response) => {
  const { url, piData, latencyMs, piReports } = req.body || {};
  const cleanUrl = normalizePiUrl(url || '');
  if (!cleanUrl || !piData) {
    return res.status(400).json({ success: false, error: 'Invalid bridge payload' });
  }
  const lockState = getEffectiveCloudLockState();
  if (lockState.locked && !isUrlAllowedUnderLock(cleanUrl, lockState)) {
    return res.status(403).json({
      success: false,
      error: 'Cloud Server binding is locked. External bridge override rejected.',
    });
  }

  livePiConnection.configuredUrl = cleanUrl;
  livePiConnection.isLive = true;
  livePiConnection.latencyMs = Number(latencyMs) || 15;
  livePiConnection.lastPingAt = new Date().toISOString();
  livePiConnection.connectionMethod = 'Local Wi-Fi / LAN (Direct Bridge)';
  livePiConnection.serverMode = 'CLIENT_LAN_BRIDGE';
  livePiConnection.lastError = '';
  livePiConnection.clientBridgeActiveUntil = Date.now() + 25000;
  livePiConnection.clientBridgeData = { ...piData, endpoint: cleanUrl };

  telegramConfig.piServerUrl = cleanUrl;
  persistedConfig.piServerUrl = cleanUrl;
  persistSystemConfig();

  if (Array.isArray(piData?.deletedReportIds) && piData.deletedReportIds.length > 0) {
    const allTombstones = recordServerDeletedKeys(
      piData.deletedReportIds.flatMap((k: string) => extractServerReportKeys(k))
    );
    const tombstoneSet = new Set(allTombstones);
    reports = reports.filter((r) => !isServerReportTombstoned(r, tombstoneSet));
    persistReports();
  }

  if (Array.isArray(piReports)) {
    reports = mergeReportsLists(reports, piReports);
    persistReports();
  }

  res.json({
    success: true,
    online: true,
    normalizedUrl: cleanUrl,
    reports,
    reportsCount: reports.length,
  });
});

// 5c. Manual Two-Way Sync Trigger with Raspberry Pi
app.post('/api/pi/sync', async (req: Request, res: Response) => {
  const isEn = req.body?.lang === 'en';
  const target = normalizePiUrl(
    req.body?.url || livePiConnection.configuredUrl || telegramConfig.piServerUrl || ''
  );
  if (!target) {
    return res.status(400).json({
      success: false,
      error: isEn ? 'No Cloud Server URL configured.' : 'Walang naka-set na Raspberry Pi URL.',
    });
  }

  const probe = await probePiServer(target, true);
  if (!probe.isLive) {
    return res.json({
      success: false,
      online: false,
      isPrivateLanIp: probe.isPrivateLanIp,
      normalizedUrl: target,
      error: isEn
        ? 'Cannot reach the Raspberry Pi Cloud Server for synchronization.'
        : probe.errorDetail || 'Hindi maabot ang Raspberry Pi server para sa sync.',
    });
  }

  const syncRes = await syncReportsWithPi(target);
  return res.json({
    success: true,
    online: true,
    synced: syncRes.synced,
    count: syncRes.count,
    mode: probe.mode,
    piData: probe.data,
    message: syncRes.synced
      ? isEn
        ? `Successfully synced ${syncRes.count} report(s) with Raspberry Pi Hard Drive!`
        : `Matagumpay na na-sync ang ${syncRes.count} ulat sa Raspberry Pi Hard Drive!`
      : isEn
        ? `Connected to Pi (${probe.mode}).`
        : `Konektado sa Pi (${probe.mode}).`,
  });
});

// 5d. Download Raspberry Pi Scripts Directly (server.py / setup_autostart.sh)
app.get('/api/pi/download-script/:scriptName', (req: Request, res: Response) => {
  const { scriptName } = req.params;
  if (scriptName !== 'server.py' && scriptName !== 'setup_autostart.sh') {
    return res.status(404).send('Script not found');
  }
  const filePath = path.resolve(process.cwd(), 'raspberry-pi-server', scriptName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Script file missing on server');
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${scriptName}"`);
  res.send(fs.readFileSync(filePath, 'utf8'));
});

// 5e. Lock or Unlock Cloud Server Binding (Admin protected)
app.post('/api/pi/lock', (req: Request, res: Response) => {
  const isEn = req.body?.lang === 'en';
  const wantLock = Boolean(req.body?.lock);
  const adminPassword = String(req.body?.adminPassword || '').trim();
  const candidateUrl = normalizePiUrl(
    req.body?.url || livePiConnection.configuredUrl || persistedConfig.piServerUrl || ''
  );

  if (!isAuthorizedAdminPassword(adminPassword)) {
    return res.status(403).json({
      success: false,
      error: isEn
        ? 'Valid Admin password is required to modify Cloud Server Lock.'
        : 'Kailangan ng wastong Admin password upang baguhin ang Cloud Server Lock.',
    });
  }

  const currentLock = getEffectiveCloudLockState();
  if (
    !wantLock &&
    (currentLock.source === 'hardcoded' ||
      currentLock.source === 'config_file' ||
      currentLock.source === 'env')
  ) {
    return res.status(403).json({
      success: false,
      error: isEn
        ? 'Cloud Server link is permanently locked in system configuration.'
        : 'Ang Cloud Server link ay permanenteng naka-lock sa configuration ng system.',
    });
  }

  if (wantLock && !candidateUrl) {
    return res.status(400).json({
      success: false,
      error: isEn
        ? 'Connect a valid Cloud Server URL before locking.'
        : 'Ikonekta muna ang isang valid na Cloud Server URL bago i-lock.',
    });
  }

  if (wantLock && candidateUrl) {
    persistedConfig.piServerUrl = candidateUrl;
    livePiConnection.configuredUrl = candidateUrl;
  }
  persistedConfig.piServerLocked = wantLock;
  persistSystemConfig();

  const updated = getEffectiveCloudLockState();
  res.json({
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
});

// 5f. Disconnect / Clear Raspberry Pi URL
app.post('/api/pi/disconnect', async (req: Request, res: Response) => {
  const isEn = req.body?.lang === 'en';
  const lockState = getEffectiveCloudLockState();
  if (lockState.locked && !isAuthorizedAdminPassword(req.body?.adminPassword)) {
    return res.status(403).json({
      success: false,
      error: isEn
        ? 'Cloud Server binding is locked. Unlock with Admin credentials first.'
        : 'Naka-lock ang Cloud Server binding. I-unlock muna gamit ang Admin password.',
    });
  }
  persistedConfig.piServerLocked = false;
  livePiConnection.configuredUrl = '';
  livePiConnection.isLive = false;
  livePiConnection.latencyMs = 0;
  livePiConnection.lastPingAt = '';
  livePiConnection.connectionMethod = 'Not Set';
  livePiConnection.lastError = '';
  livePiConnection.cachedData = null;
  livePiConnection.clientBridgeActiveUntil = 0;
  livePiConnection.clientBridgeData = null;
  telegramConfig.piServerUrl = '';
  persistedConfig.piServerUrl = '';
  persistSystemConfig();
  return res.json({
    success: true,
    message: isEn
      ? 'Cloud Server link disconnected and cleared.'
      : 'Matagumpay na nadiskonekta at natanggal ang Pi Server link.',
  });
});

// 6. Safe Power Controls for Raspberry Pi (Remote Shutdown / Reboot)
app.post('/api/pi/system-action', async (req: Request, res: Response) => {
  const { action, url, lang } = req.body; // 'shutdown' | 'reboot'
  const isEn = lang === 'en';
  const target = normalizePiUrl(url || livePiConnection.configuredUrl || telegramConfig.piServerUrl || '');
  if (!target) {
    return res.status(400).json({
      success: false,
      error: isEn ? 'No connected Raspberry Pi Cloud Server URL.' : 'Walang konektadong Raspberry Pi server URL.',
    });
  }

  try {
    const endpoint = action === 'reboot' ? `${target}/api/system/reboot` : `${target}/api/system/shutdown`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);

    const piRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...PI_STANDARD_HEADERS,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    }).catch(() => null);
    clearTimeout(timeout);

    if (action === 'shutdown') {
      livePiConnection.isLive = false;
      livePiConnection.clientBridgeActiveUntil = 0;
      livePiConnection.lastError = 'Server halted by safe shutdown command';
    }

    if (piRes && piRes.ok) {
      const data = await piRes.json().catch(() => ({}));
      return res.json({
        success: true,
        delivered: true,
        message:
          data.message ||
          (action === 'shutdown'
            ? isEn
              ? 'Safe shutdown initiated. Wait 5 seconds before unplugging power.'
              : 'Nagsisimula na ang ligtas na shutdown. Maghintay ng 5 segundo bago bunutin sa saksakan.'
            : isEn
              ? 'Raspberry Pi is rebooting.'
              : 'Nagre-reboot na ang Raspberry Pi.'),
      });
    }

    return res.json({
      success: false,
      delivered: false,
      isPrivateLanIp: isPrivateNetworkHost(target),
      message:
        action === 'reboot'
          ? isEn
            ? 'Reboot command could not reach the Pi server.'
            : 'Hindi umabot ang reboot command. Tiyaking bukas ang Pi server.'
          : isEn
            ? 'Shutdown command could not reach the Pi server.'
            : 'Hindi umabot ang shutdown command. Tiyaking bukas ang Pi server.',
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e?.message || 'Failed to send system action' });
  }
});

// 7. Raspberry Pi 4B Storage Status & Metrics
app.get('/api/pi-status', async (req: Request, res: Response) => {
  const isEn = req.query.lang === 'en';
  const lockState = getEffectiveCloudLockState();
  const queryEndpoint = normalizePiUrl((req.query.endpoint as string) || '');
  const activeEndpoint =
    lockState.locked && lockState.lockedUrl
      ? normalizePiUrl(lockState.lockedUrl)
      : queryEndpoint ||
        livePiConnection.configuredUrl ||
        normalizePiUrl(process.env.PI_SERVER_URL || '') ||
        '';

  const brgy40Count = reports.filter((r) => r.barangay?.includes('40') || r.purok?.includes('40')).length;
  const brgy41Count = reports.filter((r) => r.barangay?.includes('41') || r.purok?.includes('41') || !r.barangay).length;

  if (!activeEndpoint) {
    return res.json({
      hardware: isEn ? 'Raspberry Pi 4 Model B (Not Configured)' : 'Raspberry Pi 4 Model B (Hindi Pa Naka-set)',
      ram: isEn ? 'Standby' : 'Naka-standby',
      storageUsedMb: 0,
      storage_folder: isEn ? 'No Cloud Server Configured' : 'Walang Naka-configure na Pi Server',
      disk_total: '0 GB',
      disk_used: '0 GB',
      disk_free: '0 GB',
      pulseFolderMb: 0,
      pulseFolderKb: 0,
      pulseStorageSummary: isEn
        ? 'No Cloud Server link configured. Paste your Cloud Server URL above.'
        : 'Walang naka-set na Cloud Server link. I-paste ang link ng iyong Cloud Server.',
      residentPhotosCount: 0,
      residentPhotosMb: 0,
      proofPhotosCount: 0,
      proofPhotosMb: 0,
      cachedImagesCount: 0,
      activeTicketsCount: reports.length,
      pendingTicketsCount: reports.filter((r) => r.status === 'PENDING').length,
      brgy40Count,
      brgy41Count,
      autoPurgeTtlDays: AUTO_PURGE_TTL_DAYS,
      cpuTempCelsius: 0,
      cpu_temp: 'N/A',
      ipAddress: '',
      localHostname: 'N/A',
      online: false,
      isConfigured: false,
      configuredUrl: '',
      latencyMs: 0,
      lastPingAt: '',
      connectionMethod: isEn ? 'Not Set' : 'Walang Naka-set',
      lastPurgeRun: '',
      savedLogbooksCount: savedLogBooks.length,
    });
  }

  const probe = await probePiServer(activeEndpoint, false);
  livePiConnection.isLive = probe.isLive;

  if (probe.isLive) {
    livePiConnection.configuredUrl = activeEndpoint;
    livePiConnection.latencyMs = probe.latencyMs;
    livePiConnection.lastPingAt = new Date().toISOString();
    livePiConnection.connectionMethod =
      probe.mode === 'CLIENT_LAN_BRIDGE'
        ? 'Local Wi-Fi / LAN (Direct Bridge)'
        : detectConnectionMethod(activeEndpoint);
    livePiConnection.lastError = '';
  }

  if (!probe.isLive) {
    return res.json({
      hardware: 'Raspberry Pi 4 Model B',
      ram: 'Offline',
      storageUsedMb: 0,
      storage_folder: `DISCONNECTED (${activeEndpoint})`,
      disk_total: '0 GB',
      disk_used: '0 GB',
      disk_free: '0 GB',
      pulseFolderMb: 0,
      pulseFolderKb: 0,
      pulseStorageSummary: isEn
        ? 'Cannot reach the Cloud Server at the configured URL.'
        : probe.errorDetail || 'Hindi maabot ang Pi server sa ibinigay na URL.',
      residentPhotosCount: 0,
      residentPhotosMb: 0,
      proofPhotosCount: 0,
      proofPhotosMb: 0,
      cachedImagesCount: 0,
      activeTicketsCount: reports.length,
      pendingTicketsCount: reports.filter((r) => r.status === 'PENDING').length,
      brgy40Count,
      brgy41Count,
      autoPurgeTtlDays: AUTO_PURGE_TTL_DAYS,
      cpuTempCelsius: 0,
      cpu_temp: 'N/A',
      ipAddress: activeEndpoint,
      localHostname: 'raspberrypi.local',
      online: false,
      isConfigured: true,
      configuredUrl: activeEndpoint,
      latencyMs: 0,
      lastPingAt: livePiConnection.lastPingAt || '',
      connectionMethod: 'Disconnected',
      errorDetail: isEn ? 'Cloud Server is offline or unreachable.' : probe.errorDetail,
      isPrivateLanIp: probe.isPrivateLanIp,
      lastPurgeRun: '',
      savedLogbooksCount: savedLogBooks.length,
    });
  }

  const remotePiData = probe.data || {};
  const totalResidentPhotos = reports.reduce((acc, r) => acc + (r.photos?.length || 0), 0);
  const totalProofPhotos = reports.reduce((acc, r) => acc + (r.proofPhotos?.length || 0), 0);
  const totalResidentMb = +(totalResidentPhotos * 0.8).toFixed(2);
  const totalProofMb = +(totalProofPhotos * 0.75).toFixed(2);
  const totalStorageUsedMb = +(totalResidentMb + totalProofMb + reports.length * 0.02).toFixed(2);

  res.json({
    hardware: remotePiData?.hardware || 'Raspberry Pi 4 Model B (Barangay Local Cloud Storage)',
    ram: remotePiData?.ram || 'Active',
    ramUsagePercent: remotePiData?.ramUsagePercent,
    storageUsedMb: remotePiData?.pulse_folder_mb ?? totalStorageUsedMb,
    storage_folder: remotePiData?.storage_folder || '/media/pi/Vherrsie Back-up/RESEARCH TRASH',
    disk_total: remotePiData?.disk_total || '500.0 GB',
    disk_used: remotePiData?.disk_used || '20.0 GB',
    disk_free: remotePiData?.disk_free || '480.0 GB',
    pulseFolderMb: remotePiData?.pulse_folder_mb ?? totalStorageUsedMb,
    pulseFolderKb: remotePiData?.pulse_folder_kb ?? +(totalStorageUsedMb * 1024).toFixed(0),
    pulseStorageSummary:
      remotePiData?.pulse_storage_summary ||
      (isEn ? `${totalStorageUsedMb} MB used on hard drive` : `${totalStorageUsedMb} MB lamang ang kinakain sa hard drive`),
    residentPhotosCount: remotePiData?.resident_photos_count ?? totalResidentPhotos,
    residentPhotosMb: totalResidentMb,
    proofPhotosCount: remotePiData?.proof_photos_count ?? totalProofPhotos,
    proofPhotosMb: totalProofMb,
    cachedImagesCount: totalResidentPhotos + totalProofPhotos,
    activeTicketsCount: remotePiData?.reports_count ?? reports.length,
    pendingTicketsCount: reports.filter((r) => r.status === 'PENDING').length,
    brgy40Count,
    brgy41Count,
    autoPurgeTtlDays: Number(remotePiData?.autoPurgeTtlDays ?? AUTO_PURGE_TTL_DAYS),
    cpuTempCelsius: remotePiData?.cpuTempCelsius || (remotePiData?.cpu_temp ? parseFloat(remotePiData.cpu_temp) : 42.0),
    cpu_temp: remotePiData?.cpu_temp || '42.0°C',
    ipAddress: remotePiData?.lan_ip || activeEndpoint,
    localHostname: remotePiData?.hostname || 'raspberrypi.local',
    online: true,
    isConfigured: true,
    configuredUrl: activeEndpoint,
    latencyMs: probe.latencyMs,
    lastPingAt: livePiConnection.lastPingAt,
    connectionMethod: livePiConnection.connectionMethod,
    serverMode: probe.mode,
    isPrivateLanIp: probe.isPrivateLanIp,
    lastPurgeRun: new Date().toISOString(),
    savedLogbooksCount: Math.max(savedLogBooks.length, Number(remotePiData?.logbooks_count) || 0),
  });
});

// 8. Save Log Book snapshot (Syncs to Pi Hard Drive + Local Cloud Archive)
app.post('/api/pi/save-logbook', async (req: Request, res: Response) => {
  try {
    const { savedBy, destination, piEndpoint, clientSyncedToPi, lang } = req.body;
    const isEn = lang === 'en';
    const phTime = getPhilippineDateTime();
    const nowIso = new Date().toISOString();

    const brgy40Count = reports.filter((r) => r.barangay?.includes('40') || r.purok?.includes('40')).length;
    const brgy41Count = reports.filter((r) => r.barangay?.includes('41') || r.purok?.includes('41') || !r.barangay).length;
    const pendingRecords = reports.filter((r) => r.status === 'PENDING').length;
    const dispatchedRecords = reports.filter((r) => r.status === 'DISPATCHED').length;
    const resolvedRecords = reports.filter((r) => r.status === 'RESOLVED').length;
    const cancelledRecords = reports.filter((r) => r.status === 'CANCELLED').length;

    const totalResidentMb = reports.reduce((acc, r) => acc + (r.residentPhotosSizeMb || (r.photos?.length || 0) * 0.8), 0);
    const totalProofMb = reports.reduce((acc, r) => acc + (r.proofPhotosSizeMb || (r.proofPhotos?.length || 0) * 0.75), 0);
    const storageUsedMb = +(totalResidentMb + totalProofMb).toFixed(2);

    const logbookId = `LOG-${Date.now()}`;
    const filename = `TUGON_Logbook_Brgy40_41_${new Date().toISOString().slice(0, 10)}_${Date.now().toString().slice(-4)}.json`;

    let syncStatus: 'SYNCED' | 'LOCAL_ONLY' = clientSyncedToPi ? 'SYNCED' : 'LOCAL_ONLY';
    const targetUrl = normalizePiUrl(piEndpoint || livePiConnection.configuredUrl || telegramConfig.piServerUrl || '');

    if (!clientSyncedToPi && targetUrl && !isPrivateNetworkHost(targetUrl)) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const piRes = await fetch(`${targetUrl}/api/logbook/save`, {
          method: 'POST',
          headers: {
            ...PI_STANDARD_HEADERS,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            logbookId,
            filename,
            savedAt: nowIso,
            savedAtPhilippineTime: phTime,
            savedBy: savedBy || (isEn ? 'Barangay 40 & 41 Official' : 'Barangay 40 & 41 Kagawad'),
            totalRecords: reports.length,
            reports,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (piRes.ok) {
          syncStatus = 'SYNCED';
        }
      } catch {
        syncStatus = 'LOCAL_ONLY';
      }
    }

    const newLogBook: SavedLogBook = {
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
      storageUsedMb,
      savedBy: savedBy || (isEn ? 'Barangay 40 & 41 Official' : 'Barangay 40 & 41 Kagawad'),
      destination: destination || 'Raspberry Pi 4B Cloud Server',
      syncStatus,
      recordsSummary: isEn
        ? `${reports.length} total records (Pending: ${pendingRecords}, Resolved: ${resolvedRecords})`
        : `${reports.length} kabuuang tala (Pending: ${pendingRecords}, Resolved: ${resolvedRecords})`,
      recordsSnapshot: [...reports],
    };

    savedLogBooks.unshift(newLogBook);
    persistSavedLogBooks();

    res.json({
      success: true,
      logbook: newLogBook,
      targetUrl,
      isPrivateLanIp: targetUrl ? isPrivateNetworkHost(targetUrl) : false,
      message:
        syncStatus === 'SYNCED'
          ? isEn
            ? `Log Book saved and synced to Raspberry Pi Hard Drive! (${phTime})`
            : `Matagumpay na na-save at na-sync ang Log Book sa Raspberry Pi Hard Drive! (${phTime})`
          : isEn
            ? `Log Book snapshot saved to Cloud Archive! (${phTime})`
            : `Nai-save ang Log Book snapshot sa Cloud Archive! (${phTime})`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to save logbook' });
  }
});

// 9. Retrieve Saved Log Books (Merges remote Pi logbooks if online)
app.get('/api/pi/saved-logbooks', async (req: Request, res: Response) => {
  const isEn = req.query.lang === 'en';
  const targetUrl = livePiConnection.configuredUrl || telegramConfig.piServerUrl;
  if (targetUrl && livePiConnection.isLive && !isPrivateNetworkHost(targetUrl)) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(`${targetUrl}/api/logbooks`, {
        signal: ctrl.signal,
        headers: PI_STANDARD_HEADERS,
      });
      clearTimeout(t);
      if (r.ok) {
        const remoteList = await r.json().catch(() => []);
        if (Array.isArray(remoteList)) {
          for (const rem of remoteList) {
            if (rem?.filename && !savedLogBooks.some((l) => l.filename === rem.filename)) {
              savedLogBooks.push({
                id: rem.id || rem.filename,
                filename: rem.filename,
                savedAt: rem.modified || new Date().toISOString(),
                savedAtPhilippineTime: rem.modified || getPhilippineDateTime(),
                totalRecords: rem.totalRecords || 0,
                pendingRecords: 0,
                dispatchedRecords: 0,
                resolvedRecords: 0,
                cancelledRecords: 0,
                brgy40Count: 0,
                brgy41Count: 0,
                storageUsedMb: rem.sizeKb ? +(rem.sizeKb / 1024).toFixed(2) : 0.1,
                savedBy: rem.savedBy || 'Raspberry Pi Hard Drive',
                destination: 'Raspberry Pi 4B Cloud Server',
                syncStatus: 'SYNCED',
                recordsSummary: isEn
                  ? 'Stored on Raspberry Pi External Hard Drive'
                  : 'Naka-imbak sa Raspberry Pi External Hard Drive',
              });
            }
          }
        }
      }
    } catch {}
  }

  res.json({
    success: true,
    count: savedLogBooks.length,
    logbooks: savedLogBooks.map((l) => ({
      ...l,
      recordsSummary: isEn
        ? `${l.totalRecords} total records (Pending: ${l.pendingRecords}, Resolved: ${l.resolvedRecords})`
        : l.recordsSummary,
      recordsSnapshot: undefined,
    })),
  });
});

// 10. Delete Saved Log Book
app.delete('/api/pi/logbooks/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const index = savedLogBooks.findIndex((l) => l.id === id || l.filename === id);
  if (index !== -1) {
    const deletedLog = savedLogBooks.splice(index, 1)[0];
    persistSavedLogBooks();

    const targetUrl = livePiConnection.configuredUrl || telegramConfig.piServerUrl;
    if (targetUrl && !isPrivateNetworkHost(targetUrl)) {
      fetch(`${targetUrl}/api/logbooks?filename=${encodeURIComponent(deletedLog.filename)}`, {
        method: 'DELETE',
        headers: PI_STANDARD_HEADERS,
      }).catch(() => null);
    }

    return res.json({ success: true, deletedId: id, filename: deletedLog.filename });
  }
  res.status(404).json({ error: 'Logbook not found' });
});

// 11. Download full Log Book as JSON (Fetches from Pi if snapshot only resides on Pi)
app.get('/api/pi/download-logbook/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const logbook = savedLogBooks.find((l) => l.id === id || l.filename === id);
  if (!logbook) {
    return res.status(404).json({ error: 'Logbook not found' });
  }

  if (!logbook.recordsSnapshot && livePiConnection.configuredUrl && !isPrivateNetworkHost(livePiConnection.configuredUrl)) {
    try {
      const r = await fetch(
        `${livePiConnection.configuredUrl}/api/logbooks/${encodeURIComponent(logbook.filename)}`,
        { headers: PI_STANDARD_HEADERS }
      );
      if (r.ok) {
        const remotePayload = await r.json();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${logbook.filename}"`);
        return res.json(remotePayload);
      }
    } catch {}
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${logbook.filename}"`);
  return res.json(logbook);
});

// 12. Telegram Auto-Detect Chat ID via getUpdates (with automatic Webhook conflict recovery)
app.post('/api/telegram/detect-chat', async (req: Request, res: Response) => {
  const token = String(req.body?.botToken || telegramConfig.botToken || '').trim();
  const isEn = req.body?.lang === 'en';
  if (!token) {
    return res.status(400).json({
      success: false,
      error: isEn
        ? 'Please enter your Telegram Bot Token from @BotFather first.'
        : 'Pakilagay muna ang iyong Telegram Bot Token mula kay @BotFather.',
    });
  }

  try {
    const fetchUpdates = async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);
      const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=30`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await r.json().catch(() => null);
      return { r, data };
    };

    let { r, data } = await fetchUpdates();

    // Auto-clear webhook if Telegram returns 409 Conflict (webhook previously active)
    if (r.status === 409 || String(data?.description || '').toLowerCase().includes('webhook')) {
      await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`, {
        method: 'POST',
      }).catch(() => null);
      const retried = await fetchUpdates();
      r = retried.r;
      data = retried.data;
    }

    if (!r.ok || !data?.ok) {
      return res.status(400).json({
        success: false,
        error:
          data?.description ||
          (isEn
            ? 'Invalid Bot Token. Please verify the token from @BotFather.'
            : 'Invalid ang Bot Token. Pakisuri ang token mula kay @BotFather.'),
      });
    }

    const updates = Array.isArray(data.result) ? data.result : [];
    const chats: { id: string; title: string; type: string }[] = [...seenTelegramChats];

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
            chat.title ||
            [chat.first_name, chat.last_name].filter(Boolean).join(' ') ||
            chat.username ||
            idStr;
          chats.push({ id: idStr, title, type: chat.type || 'private' });
        }
      }
    }

    if (chats.length === 0) {
      return res.json({
        success: false,
        chats: [],
        error: isEn
          ? 'Your bot has not received any messages yet. Open your bot in Telegram, tap /start or send "Hello" in the chat/group, then click Auto-Detect again!'
          : 'Wala pang natatanggap na mensahe ang iyong bot. Buksan muna ang bot mo sa Telegram app at i-tap ang /start o mag-send ng "Hello", saka pindutin muli ang Auto-Detect!',
      });
    }

    return res.json({
      success: true,
      chatId: chats[0].id,
      chatTitle: chats[0].title,
      chats,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err?.message || (isEn ? 'Could not reach Telegram API.' : 'Hindi makakonekta sa Telegram API.'),
    });
  }
});

// 13. Telegram Test Alert Endpoint (Attaches interactive bubble keyboard to Telegram!)
app.post('/api/telegram/test-notify', async (req: Request, res: Response) => {
  const { botToken, chatId, message, lang } = req.body;
  const isEn = lang === 'en';
  const reqLang: 'tl' | 'en' = isEn ? 'en' : 'tl';
  if (botToken && String(botToken).trim()) {
    telegramConfig.botToken = String(botToken).trim();
    persistedConfig.telegramBotToken = telegramConfig.botToken;
  }
  if (chatId && String(chatId).trim()) {
    telegramConfig.chatId = String(chatId).trim();
    persistedConfig.telegramChatId = telegramConfig.chatId;
  }
  persistSystemConfig();

  const phTime = getPhilippineDateTime();
  const pendingLen = reports.filter((r) => r.status === 'PENDING').length;
  const simulatedMessage =
    message ||
    (isEn
      ? `🔔 <b>[T.U.G.O.N. TEST ALERT - BARANGAY 40 &amp; 41]</b>\n` +
        `Status: Active &amp; Connected to Portal\n` +
        `Time: ${escapeHtml(phTime)}\n` +
        `Current Pending: ${pendingLen} concern(s)\n` +
        `Jurisdiction: Barangay 40 (Gumamela) &amp; Barangay 41 (Rosal), Cavite City\n\n` +
        `💡 Tap any bubble button below anytime to check active/unresolved concerns!`
      : `🔔 <b>[T.U.G.O.N. TEST ALERT - BARANGAY 40 &amp; 41]</b>\n` +
        `Status: Aktibo at Konektado sa Portal\n` +
        `Oras: ${escapeHtml(phTime)}\n` +
        `Kasalukuyang Pending: ${pendingLen} concern(s)\n` +
        `Sakop: Barangay 40 (Gumamela) at Barangay 41 (Rosal), Cavite City\n\n` +
        `💡 Pindutin ang mga bubble button sa ibaba anumang oras para tingnan ang active concerns!`);

  const telegramResult = await sendRealTelegramMessage(
    simulatedMessage,
    buildTelegramReplyKeyboard(reqLang)
  );
  await runTelegramWatchdogCheck(false);

  if (telegramResult.ok) {
    persistedConfig.telegramSetupComplete = true;
    recordTelegramBroadcast(simulatedMessage, phTime);
  }

  res.json({
    success: true,
    delivered: telegramResult.ok,
    message: telegramResult.ok
      ? isEn
        ? `Test alert successfully delivered to Telegram! (${phTime})`
        : `Matagumpay na naipadala ang alert sa Telegram ng Kagawad! (${phTime})`
      : telegramResult.description ||
        (isEn
          ? 'Could not deliver to Telegram. Please check your Bot Token and Chat ID.'
          : 'Hindi naipadala sa Telegram. Pakisuri ang Bot Token at Chat ID.'),
    telegramResult,
    broadcast: htmlToPlainTelegramText(simulatedMessage),
    timestamp: phTime,
    watchdog: {
      status: telegramWatchdog.status,
      online: telegramWatchdog.status === 'ONLINE',
      botUsername: telegramWatchdog.botUsername,
    },
  });
});

// 13b-webhook. Telegram Webhook Handler (Cloud Bubbles, callback_query & live updates)
app.post('/api/telegram/webhook', async (req: Request, res: Response) => {
  await resolveServerTelegramCreds(req);
  const token = telegramConfig.botToken?.trim();
  const updatePayload = req.body;
  if (!updatePayload || typeof updatePayload !== 'object') {
    return res.status(400).json({ ok: false, error: 'Invalid Telegram update payload.' });
  }
  if (!token || token === 'YOUR_BOT_TOKEN_HERE') {
    return res.json({ ok: true, ignored: true });
  }
  const liveReports = await pullAuthoritativePiReports();
  const processed = await processServerTelegramUpdate(updatePayload, token, liveReports, true);
  return res.json({ ok: true, processed });
});

// 13b. Interactive Telegram Bot Chat (Get History + Sync Incoming Telegram Chats)
app.get('/api/telegram/chat', async (req: Request, res: Response) => {
  await resolveServerTelegramCreds(req);
  await pullAuthoritativePiReports();
  if (telegramConfig.botToken && telegramConfig.botToken !== 'YOUR_BOT_TOKEN_HERE') {
    await pollTelegramUpdatesOnce().catch(() => null);
  }
  res.json({
    success: true,
    messages: telegramChatHistory,
    activeUnfinishedCount: reports.filter((r) => r.status === 'PENDING' || r.status === 'DISPATCHED').length,
    pendingCount: reports.filter((r) => r.status === 'PENDING').length,
  });
});

// 13c. Interactive Telegram Bot Chat (Send message or quick bubble button press from App)
app.post('/api/telegram/chat', async (req: Request, res: Response) => {
  const { message, lang, sendToTelegram, botToken, chatId } = req.body || {};
  const reqLang: 'tl' | 'en' = lang === 'en' ? 'en' : 'tl';
  const userText = String(message || '').trim();
  if (!userText) {
    return res.status(400).json({ success: false, error: 'Message is required.' });
  }

  if (botToken && String(botToken).trim()) {
    telegramConfig.botToken = String(botToken).trim();
    persistedConfig.telegramBotToken = telegramConfig.botToken;
  }
  if (chatId && String(chatId).trim()) {
    telegramConfig.chatId = String(chatId).trim();
    persistedConfig.telegramChatId = telegramConfig.chatId;
  }
  await resolveServerTelegramCreds(req);
  const liveReports = await pullAuthoritativePiReports();

  const phTime = getPhilippineDateTime();
  const parsedBubble = parseTelegramCloudBubblePayload(userText);
  const userEntry: ServerTelegramChatMessage = {
    id: `app-u-${Date.now()}`,
    sender: 'user',
    text: parsedBubble.displayLabel || userText,
    timestamp: phTime,
    source: 'app',
  };
  pushTelegramChatEntry(userEntry);

  const reply = generateBotChatReply(userText, liveReports, reqLang);
  const botEntry: ServerTelegramChatMessage = {
    id: `app-b-${Date.now() + 1}`,
    sender: 'bot',
    text: reply.textPlain,
    timestamp: phTime,
    source: 'app',
    matchedIntent: reply.matchedIntent,
  };
  pushTelegramChatEntry(botEntry);

  let telegramDelivered = false;
  if (sendToTelegram && telegramConfig.botToken && telegramConfig.chatId) {
    const sent = await sendRealTelegramMessage(
      reply.textHtml,
      buildTelegramReplyKeyboard(reqLang)
    );
    telegramDelivered = sent.ok;
    if (sent.ok) {
      recordTelegramBroadcast(reply.textHtml, phTime);
    }
  }

  res.json({
    success: true,
    userMessage: userEntry,
    botMessage: botEntry,
    messages: telegramChatHistory,
    telegramDelivered,
    activeUnfinishedCount: reply.activeCount,
  });
});

// 14. Telegram Status Endpoint
app.get('/api/telegram/status', async (req: Request, res: Response) => {
  const queryToken = ((req.query.token as string) || '').trim();
  const queryChatId = ((req.query.chatId as string) || '').trim();

  let changed = false;
  if (queryToken && queryToken !== telegramConfig.botToken) {
    telegramConfig.botToken = queryToken;
    persistedConfig.telegramBotToken = queryToken;
    changed = true;
  }
  if (queryChatId && queryChatId !== telegramConfig.chatId) {
    telegramConfig.chatId = queryChatId;
    persistedConfig.telegramChatId = queryChatId;
    changed = true;
  }
  if (changed) {
    persistSystemConfig();
    await runTelegramWatchdogCheck(false);
  } else if (telegramConfig.botToken && telegramWatchdog.status === 'NOT_CONFIGURED') {
    await runTelegramWatchdogCheck(false);
  }

  const phTime = getPhilippineDateTime();
  res.json({
    online: telegramWatchdog.status === 'ONLINE',
    status: telegramWatchdog.status,
    botConfigured: Boolean(telegramConfig.botToken && telegramConfig.chatId),
    setupComplete: persistedConfig.telegramSetupComplete || Boolean(telegramConfig.botToken && telegramConfig.chatId),
    chatId: telegramConfig.chatId,
    botUsername: telegramWatchdog.botUsername,
    botFirstName: telegramWatchdog.botFirstName,
    autoRestartCount: telegramWatchdog.autoRestartCount,
    reconnectAttempts: telegramWatchdog.reconnectAttempts,
    lastCheckedAt: telegramWatchdog.lastCheckedAt || phTime,
    lastSeenOnline: telegramWatchdog.lastSeenOnline || '',
    lastError: telegramWatchdog.lastError,
    watchdogActive: telegramWatchdog.watchdogActive,
    lastBroadcastMessage: telegramConfig.lastBroadcastMessage,
    lastBroadcastTime: telegramConfig.lastBroadcastTime,
    broadcastHistory: persistedConfig.broadcastHistory || [],
    philippineTime: phTime,
    pendingCount: reports.filter((r) => r.status === 'PENDING').length,
    activeUnfinishedCount: reports.filter((r) => r.status === 'PENDING' || r.status === 'DISPATCHED').length,
  });
});

// 15. Telegram Restart Watchdog
app.post('/api/telegram/restart', async (req: Request, res: Response) => {
  const isEn = req.body?.lang === 'en';
  if (req.body?.botToken) {
    telegramConfig.botToken = String(req.body.botToken).trim();
    persistedConfig.telegramBotToken = telegramConfig.botToken;
    persistSystemConfig();
  }
  telegramWatchdog.status = 'RECONNECTING';
  telegramWatchdog.autoRestartCount++;
  telegramWatchdog.reconnectAttempts++;
  await runTelegramWatchdogCheck(true);

  const isOnline = (telegramWatchdog.status as string) === 'ONLINE';
  res.json({
    success: isOnline,
    status: telegramWatchdog.status,
    online: isOnline,
    botUsername: telegramWatchdog.botUsername,
    autoRestartCount: telegramWatchdog.autoRestartCount,
    message: isOnline
      ? isEn
        ? `Telegram Bot (@${telegramWatchdog.botUsername || 'TUGON_Bot'}) restarted and is now online!`
        : `Matagumpay na nag-restart at aktibo na muli ang Telegram Bot (@${telegramWatchdog.botUsername || 'TUGON_Bot'})!`
      : telegramWatchdog.lastError ||
        (isEn ? 'Could not verify Telegram Bot Token.' : 'Hindi ma-verify ang Telegram Bot Token.'),
  });
});

// 16. Telegram Configure & Persist
app.post('/api/telegram/configure', async (req: Request, res: Response) => {
  const { botToken, chatId, lang } = req.body;
  const isEn = lang === 'en';
  const cleanToken = botToken !== undefined ? String(botToken).trim() : telegramConfig.botToken;
  const cleanChat = chatId !== undefined ? String(chatId).trim() : telegramConfig.chatId;

  telegramConfig.botToken = cleanToken;
  telegramConfig.chatId = cleanChat;
  persistedConfig.telegramBotToken = cleanToken;
  persistedConfig.telegramChatId = cleanChat;

  await runTelegramWatchdogCheck(true);
  const isOnline = (telegramWatchdog.status as string) === 'ONLINE';

  if (isOnline && cleanChat) {
    persistedConfig.telegramSetupComplete = true;
  }
  persistSystemConfig();

  res.json({
    success: isOnline && Boolean(cleanChat),
    status: telegramWatchdog.status,
    online: isOnline,
    botUsername: telegramWatchdog.botUsername,
    chatId: telegramConfig.chatId,
    error: !isOnline
      ? telegramWatchdog.lastError || 'Invalid Telegram Bot Token.'
      : !cleanChat
        ? isEn
          ? 'Please enter or auto-detect your Chat ID.'
          : 'Pakilagay o i-auto-detect ang iyong Chat ID.'
        : undefined,
    message:
      isOnline && cleanChat
        ? isEn
          ? `Telegram Bot @${telegramWatchdog.botUsername} connected and saved on the server!`
          : `Konektado at naka-save na sa server ang Telegram Bot @${telegramWatchdog.botUsername}!`
        : telegramWatchdog.lastError ||
          (isEn
            ? 'Please check your Bot Token and Chat ID.'
            : 'Pakisuri ang iyong Bot Token at Chat ID.'),
  });
});

// 16b. Telegram Disconnect & Clear
app.post('/api/telegram/disconnect', (req: Request, res: Response) => {
  const isEn = req.body?.lang === 'en';
  telegramConfig.botToken = '';
  telegramConfig.chatId = '';
  persistedConfig.telegramBotToken = '';
  persistedConfig.telegramChatId = '';
  persistedConfig.telegramSetupComplete = false;
  telegramWatchdog.status = 'NOT_CONFIGURED';
  telegramWatchdog.isHealthy = false;
  telegramWatchdog.botUsername = '';
  telegramWatchdog.lastError = '';
  persistSystemConfig();
  res.json({
    success: true,
    message: isEn
      ? 'Telegram Bot credentials disconnected and cleared.'
      : 'Matagumpay na nadiskonekta at nalinis ang Telegram Bot credentials.',
  });
});

// 17. Source Tree API
app.get('/api/source-tree', (_req: Request, res: Response) => {
  try {
    const files: { path: string; content: string }[] = [];
    const rootDir = process.cwd();

    function readFilesRecursively(dir: string) {
      const list = fs.readdirSync(dir);
      for (const item of list) {
        if (['node_modules', 'dist', '.git', '.aistudio', '__pycache__', 'aistudio'].includes(item)) continue;
        const fullPath = path.join(dir, item);
        const relPath = path.relative(rootDir, fullPath);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          readFilesRecursively(fullPath);
        } else {
          if (
            item.endsWith('.zip') ||
            item.endsWith('.png') ||
            item.endsWith('.jpg') ||
            item.endsWith('.apk') ||
            item.endsWith('.pyc') ||
            item === 'pulse_config.json' ||
            item === 'bun.lock' ||
            item === 'bun.lockb'
          ) {
            continue;
          }
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            files.push({ path: relPath.replace(/\\/g, '/'), content });
          } catch {}
        }
      }
    }

    readFilesRecursively(rootDir);
    res.json({ success: true, count: files.length, files });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to read source tree' });
  }
});

// 18. Direct Download Dynamic ZIP
app.get('/api/download-zip', async (_req: Request, res: Response) => {
  try {
    const rootDir = process.cwd();
    const zip = new JSZip();

    function addFilesToZip(dir: string) {
      const list = fs.readdirSync(dir);
      for (const item of list) {
        if (['node_modules', 'dist', '.git', '.aistudio', '__pycache__', 'aistudio'].includes(item)) continue;
        const fullPath = path.join(dir, item);
        const relPath = path.relative(rootDir, fullPath);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          addFilesToZip(fullPath);
        } else {
          if (
            item.endsWith('.zip') ||
            item.endsWith('.pyc') ||
            item === 'pulse_config.json' ||
            item === 'bun.lock' ||
            item === 'bun.lockb'
          ) continue;
          try {
            const data = fs.readFileSync(fullPath);
            zip.file(relPath.replace(/\\/g, '/'), data);
          } catch {}
        }
      }
    }

    addFilesToZip(rootDir);

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="tugon-barangay40-41-source.zip"');
    res.setHeader('Content-Length', zipBuffer.length.toString());
    res.send(zipBuffer);
  } catch (err: any) {
    res.status(500).send(`Failed to generate ZIP: ${err?.message}`);
  }
});

// Start Express and Vite middleware on shared HTTP server
async function startServer() {
  const httpServer = http.createServer(app);
  const publicPath = path.resolve(process.cwd(), 'public');
  if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath));
  }

  const distPath = path.resolve(process.cwd(), 'dist');
  const hasDist = fs.existsSync(distPath);

  if (process.env.NODE_ENV === 'production') {
    if (hasDist) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.resolve(distPath, 'index.html'));
      });
    } else {
      app.get('*', (_req, res) => {
        res.sendFile(path.resolve(process.cwd(), 'index.html'));
      });
    }
  } else {
    const disableHmr = process.env.DISABLE_HMR === 'true';
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: disableHmr ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`T.U.G.O.N. Barangay 40 & 41 Waste Collection Service running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
