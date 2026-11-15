import { WasteReport } from '../types';
import { getStoredPiEndpoint, isLocalLanUrl, pushSingleReportDirectToPi } from './piBridge';
import { canonicalTicketKey, formatTicketNumber, isValidPhotoSrc } from './imageCompressor';

const DEVICE_ID_KEY = 'tugon_device_id_v1';
export const RESIDENT_REPORTS_STORAGE_KEY = 'pulse_resident_my_reports';
export const OFFLINE_QUEUE_STORAGE_KEY = 'pulse_offline_queue';
const MIGRATED_FLAG_KEY = 'tugon_idb_migrated_v1';
const FALLBACK_STORAGE_KEY = RESIDENT_REPORTS_STORAGE_KEY;

export const CLIENT_STORAGE_SCOPE = 'CLIENT_LOCAL_DEVICE' as const;

const DB_NAME = 'tugon_resident_device_db';
const DB_VERSION = 1;
const STORE_NAME = 'my_reports';

export function getOrCreateDeviceId(): string {
  try {
    let existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing && existing.trim().length >= 8) {
      return existing.trim();
    }
    const randomPart =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    existing = `DEV-${randomPart}`;
    localStorage.setItem(DEVICE_ID_KEY, existing);
    return existing;
  } catch {
    return `DEV-SESSION-${Date.now().toString(36)}`;
  }
}

function openDeviceDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

function readFallbackReports(): WasteReport[] {
  try {
    const raw =
      localStorage.getItem(RESIDENT_REPORTS_STORAGE_KEY) ||
      localStorage.getItem('tugon_device_reports_fallback_v1');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mirrorToClientLocalStorage(reports: WasteReport[]): void {
  try {
    localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(reports));
  } catch {
    // If localStorage hits quota with large base64 photos, store lightweight metadata copy (first 2 photos)
    try {
      const light = reports.map((r) => ({
        ...r,
        photos: Array.isArray(r.photos) ? r.photos.slice(0, 2) : [],
        proofPhotos: Array.isArray(r.proofPhotos) ? r.proofPhotos.slice(0, 1) : [],
      }));
      localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(light));
    } catch {
      // Last-resort metadata-only record so resident's localStorage ALWAYS keeps transaction history even offline
      try {
        const metaOnly = reports.map((r) => ({
          ...r,
          photos: [],
          proofPhotos: [],
        }));
        localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(metaOnly));
      } catch {}
    }
  }
}

export async function saveDeviceReport(report: WasteReport): Promise<void> {
  const deviceId = getOrCreateDeviceId();
  const normalized: WasteReport = {
    ...report,
    deviceId: report.deviceId || deviceId,
    localSyncStatus: report.localSyncStatus || 'SAVED_ON_DEVICE',
    sourceStorage:
      report.localSyncStatus === 'SENT_TO_PI'
        ? report.sourceStorage || 'Raspberry Pi 4B Cloud Storage'
        : report.sourceStorage || 'Client Device Local Storage (Offline-Safe)',
  };

  // 1. Always mirror into IndexedDB for full-resolution photos & transaction records
  try {
    const db = await openDeviceDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(normalized);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error('IndexedDB write failed'));
      };
    });
  } catch {}

  // 2. Always keep localStorage mirror synchronized so offline device storage persists even if IDB is unavailable
  const current = readFallbackReports();
  const idx = current.findIndex((r) => r.id === normalized.id);
  if (idx >= 0) {
    current[idx] = normalized;
  } else {
    current.unshift(normalized);
  }
  mirrorToClientLocalStorage(current);
}

export async function saveDeviceReportsBulk(reports: WasteReport[]): Promise<void> {
  const deviceId = getOrCreateDeviceId();
  const normalizedList: WasteReport[] = reports.map((r) => ({
    ...r,
    deviceId: r.deviceId || deviceId,
    localSyncStatus: r.localSyncStatus || 'SAVED_ON_DEVICE',
  }));

  try {
    const db = await openDeviceDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const item of normalizedList) {
        store.put(item);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error('IndexedDB bulk write failed'));
      };
    });
  } catch {}

  mirrorToClientLocalStorage(normalizedList);
}

export async function getAllDeviceReports(): Promise<WasteReport[]> {
  const deviceId = getOrCreateDeviceId();

  // One-time migration from localStorage into IndexedDB if present on this phone
  try {
    if (!localStorage.getItem(MIGRATED_FLAG_KEY)) {
      const legacyRaw = localStorage.getItem(RESIDENT_REPORTS_STORAGE_KEY);
      if (legacyRaw) {
        const parsed = JSON.parse(legacyRaw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const tagged: WasteReport[] = parsed.map((item: WasteReport) => ({
            ...item,
            deviceId: item.deviceId || deviceId,
            localSyncStatus: item.localSyncStatus || 'SENT_TO_PI',
          }));
          await saveDeviceReportsBulk(tagged);
        }
      }
      localStorage.setItem(MIGRATED_FLAG_KEY, '1');
    }
  } catch {}

  let idbRecords: WasteReport[] = [];
  try {
    const db = await openDeviceDb();
    idbRecords = await new Promise<WasteReport[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        db.close();
        resolve(Array.isArray(req.result) ? req.result : []);
      };
      req.onerror = () => {
        db.close();
        reject(req.error || new Error('IndexedDB read failed'));
      };
    });
  } catch {
    idbRecords = [];
  }

  // Merge IndexedDB + localStorage fallback non-destructively so neither copy loses client records
  const lsRecords = readFallbackReports();
  const combinedById = new Map<string, WasteReport>();
  for (const r of lsRecords) {
    if (r && r.id) combinedById.set(r.id, r);
  }
  for (const r of idbRecords) {
    if (!r || !r.id) continue;
    const prev = combinedById.get(r.id);
    if (!prev) {
      combinedById.set(r.id, r);
    } else {
      const idbPhotos = Array.isArray(r.photos) ? r.photos.filter(isValidPhotoSrc) : [];
      const lsPhotos = Array.isArray(prev.photos) ? prev.photos.filter(isValidPhotoSrc) : [];
      combinedById.set(r.id, {
        ...prev,
        ...r,
        photos: idbPhotos.length >= lsPhotos.length ? idbPhotos : lsPhotos,
      });
    }
  }

  return Array.from(combinedById.values())
    .filter((r) => !r.deviceId || r.deviceId === deviceId)
    .map((r) => ({ ...r, ticketNumber: formatTicketNumber(r.ticketNumber) }))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function deleteDeviceReport(reportId: string): Promise<WasteReport[]> {
  try {
    const db = await openDeviceDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(reportId);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error('IndexedDB delete failed'));
      };
    });
  } catch {}

  try {
    const fallback = readFallbackReports().filter((r) => r.id !== reportId);
    mirrorToClientLocalStorage(fallback);
    removeFromOfflineQueue(reportId);
  } catch {}

  return getAllDeviceReports();
}

export async function clearAllDeviceReports(): Promise<void> {
  try {
    const db = await openDeviceDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error('IndexedDB clear failed'));
      };
    });
  } catch {}

  try {
    localStorage.removeItem(RESIDENT_REPORTS_STORAGE_KEY);
    localStorage.removeItem('tugon_device_reports_fallback_v1');
    localStorage.removeItem(OFFLINE_QUEUE_STORAGE_KEY);
    localStorage.setItem(MIGRATED_FLAG_KEY, '1');
  } catch {}
}

/**
 * Resilient Offline Queue (`pulse_offline_queue` in localStorage):
 * Holds failed/offline submissions until connectivity & Raspberry Pi tunnel succeed.
 */
export function getOfflineQueue(): WasteReport[] {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOfflineQueue(queue: WasteReport[]): void {
  try {
    localStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Quota guard: retain metadata + first 2 photos so retry item never drops silently
    try {
      const compact = queue.map((item) => ({
        ...item,
        photos: Array.isArray(item.photos) ? item.photos.slice(0, 2) : [],
      }));
      localStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(compact));
    } catch {
      try {
        const minimal = queue.map((item) => ({ ...item, photos: [], proofPhotos: [] }));
        localStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(minimal));
      } catch {}
    }
  }
}

export function enqueueOfflineReport(report: WasteReport): WasteReport[] {
  const queue = getOfflineQueue();
  const normalized: WasteReport = {
    ...report,
    deviceId: report.deviceId || getOrCreateDeviceId(),
    localSyncStatus: 'SAVED_ON_DEVICE',
  };
  const next = [normalized, ...queue.filter((q) => q && q.id !== normalized.id)];
  writeOfflineQueue(next);
  return next;
}

export function removeFromOfflineQueue(reportId: string): WasteReport[] {
  const next = getOfflineQueue().filter((q) => q && q.id !== reportId);
  writeOfflineQueue(next);
  return next;
}

let isFlushingOfflineQueue = false;

export async function flushOfflineQueue(
  pushFn: (report: WasteReport) => Promise<boolean>
): Promise<{ syncedReports: WasteReport[]; remainingCount: number }> {
  if (isFlushingOfflineQueue) {
    return { syncedReports: [], remainingCount: getOfflineQueue().length };
  }
  const queue = getOfflineQueue();
  if (queue.length === 0) {
    return { syncedReports: [], remainingCount: 0 };
  }

  isFlushingOfflineQueue = true;
  const syncedReports: WasteReport[] = [];
  const stillPending: WasteReport[] = [];

  try {
    // Re-hydrate full-res photos from device storage if queue was quota-compacted
    const deviceReports = await getAllDeviceReports();
    const byId = new Map(deviceReports.map((r) => [r.id, r]));

    for (const queuedItem of queue) {
      if (!queuedItem || !queuedItem.id) continue;
      const fullRecord = byId.get(queuedItem.id);
      const payload =
        fullRecord && Array.isArray(fullRecord.photos) && fullRecord.photos.length > (queuedItem.photos?.length || 0)
          ? fullRecord
          : queuedItem;

      let ok = false;
      try {
        ok = await pushFn(payload);
      } catch {
        ok = false;
      }

      if (ok) {
        const updated: WasteReport = {
          ...payload,
          localSyncStatus: 'SENT_TO_PI',
          sourceStorage: 'Raspberry Pi 4B Cloud Storage',
        };
        await saveDeviceReport(updated);
        syncedReports.push(updated);
      } else {
        stillPending.push(payload);
      }
    }

    writeOfflineQueue(stillPending);
    return { syncedReports, remainingCount: stillPending.length };
  } finally {
    isFlushingOfflineQueue = false;
  }
}


/**
 * Non-destructive client/server merge boundary:
 * - Preserves ALL local resident reports (even offline `SAVED_ON_DEVICE` or purged server records).
 * - Server sync NEVER overrides client-authored report fields or the resident's high-res local photos.
 * - Only merges server-side official fulfillment fields (status, dispatch/resolve timestamps, proofPhotos).
 */
export async function mergeServerUpdatesIntoDeviceReports(
  serverReports: WasteReport[]
): Promise<WasteReport[]> {
  const localReports = await getAllDeviceReports();
  if (localReports.length === 0 || !Array.isArray(serverReports) || serverReports.length === 0) {
    return localReports;
  }

  const STATUS_RANK: Record<string, number> = {
    PENDING: 1,
    DISPATCHED: 2,
    CANCELLED: 3,
    RESOLVED: 4,
  };

  const serverById = new Map<string, WasteReport>();
  const serverByTicket = new Map<string, WasteReport>();
  for (const sr of serverReports) {
    if (!sr) continue;
    if (sr.id) serverById.set(sr.id, sr);
    if (sr.ticketNumber) {
      serverByTicket.set(sr.ticketNumber, sr);
      const canon = canonicalTicketKey(sr.ticketNumber);
      if (canon) serverByTicket.set(canon, sr);
    }
  }

  let hasChanges = false;
  const updated = localReports.map((local) => {
    const localCanon = local.ticketNumber ? canonicalTicketKey(local.ticketNumber) : '';
    const match =
      serverById.get(local.id) ||
      (local.ticketNumber ? serverByTicket.get(local.ticketNumber) : undefined) ||
      (localCanon ? serverByTicket.get(localCanon) : undefined);

    // Offline / unsynced client records stay 100% untouched locally
    if (!match) return local;

    const validLocalPhotos = Array.isArray(local.photos) ? local.photos.filter(isValidPhotoSrc) : [];
    const validServerPhotos = Array.isArray(match.photos) ? match.photos.filter(isValidPhotoSrc) : [];
    const validServerProofs = Array.isArray(match.proofPhotos) ? match.proofPhotos.filter(isValidPhotoSrc) : [];
    const validLocalProofs = Array.isArray(local.proofPhotos) ? local.proofPhotos.filter(isValidPhotoSrc) : [];

    // Do not regress local status backward if local state already progressed
    const localRank = STATUS_RANK[local.status] || 1;
    const serverRank = STATUS_RANK[match.status] || 1;
    const nextStatus = serverRank >= localRank ? match.status : local.status;

    // Strictly lock resident-authored client data (`local.*`) against server overrides
    const merged: WasteReport = {
      ...local,
      ticketNumber: local.ticketNumber
        ? formatTicketNumber(local.ticketNumber)
        : formatTicketNumber(match.ticketNumber),
      status: nextStatus,
      dispatchedAt: match.dispatchedAt || local.dispatchedAt,
      resolvedAt: match.resolvedAt || local.resolvedAt,
      resolvedBy: match.resolvedBy || local.resolvedBy,
      resolutionNotes: match.resolutionNotes || local.resolutionNotes,
      proofPhotos:
        validServerProofs.length > 0
          ? validServerProofs
          : validLocalProofs.length > 0
          ? validLocalProofs
          : Array.isArray(match.proofPhotos) && match.proofPhotos.length > 0
          ? match.proofPhotos
          : local.proofPhotos || [],
      proofSubmittedAt: match.proofSubmittedAt || local.proofSubmittedAt,
      proofKagawadName: match.proofKagawadName || local.proofKagawadName,
      cancellationReason: match.cancellationReason || local.cancellationReason,
      cancelledAt: match.cancelledAt || local.cancelledAt,
      sourceStorage: match.sourceStorage || local.sourceStorage,
      localSyncStatus: 'SENT_TO_PI',
      // Client-side submitted photos are NEVER overwritten by server sync if local valid copies exist
      photos:
        validLocalPhotos.length > 0
          ? validLocalPhotos
          : validServerPhotos.length > 0
          ? validServerPhotos
          : Array.isArray(local.photos) && local.photos.length > 0
          ? local.photos
          : match.photos || [],
    };

    if (
      merged.ticketNumber !== local.ticketNumber ||
      merged.status !== local.status ||
      (merged.proofPhotos?.length || 0) !== (local.proofPhotos?.length || 0) ||
      merged.localSyncStatus !== local.localSyncStatus ||
      merged.cancellationReason !== local.cancellationReason ||
      merged.dispatchedAt !== local.dispatchedAt ||
      merged.resolvedAt !== local.resolvedAt
    ) {
      hasChanges = true;
    }

    return merged;
  });

  if (hasChanges) {
    await saveDeviceReportsBulk(updated);
  }

  return updated;
}

/**
 * If the Raspberry Pi is running on the same local Wi-Fi LAN (e.g. 192.168.x.x:8000),
 * pushes a single report non-destructively from the phone browser to the Pi Server.
 */
export async function tryPushReportToLanPi(report: WasteReport): Promise<boolean> {
  const endpoint = getStoredPiEndpoint();
  if (!endpoint || !isLocalLanUrl(endpoint)) return false;
  return pushSingleReportDirectToPi(endpoint, report);
}
