export const AUTO_PURGE_TTL_DAYS = 7;
export const AUTO_PURGE_TTL_MS = AUTO_PURGE_TTL_DAYS * 24 * 60 * 60 * 1000;

export type PurgeTtlRule =
  | '7_DAYS_UNRESOLVED'
  | '7_DAYS_RESOLVED'
  | '3_DAYS_UNRESOLVED'
  | '1_DAY_RESOLVED';

export interface ReportPurgeComputation {
  isPurgedFromFeed: boolean;
  purgeRemainingMs: number;
  feedExpiresAt: string;
  purgeCountdownText: string;
  purgeTtlRule: PurgeTtlRule;
}

export function computeUnifiedPurgeInfo(
  report: {
    status?: string;
    resolvedAt?: string;
    cancelledAt?: string;
    createdAt?: string;
  },
  lang: 'tl' | 'en' = 'tl'
): ReportPurgeComputation {
  const isEn = lang === 'en';
  const now = Date.now();
  const status = String(report?.status || 'PENDING').toUpperCase();
  const isResolved = status === 'RESOLVED';
  const isCancelled = status === 'CANCELLED';

  const parseTime = (iso?: string): number => {
    if (!iso) return now;
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) ? ms : now;
  };

  if (isResolved) {
    const anchorTime = parseTime(report.resolvedAt || report.createdAt);
    const ageMs = Math.max(0, now - anchorTime);
    const isPurgedFromFeed = ageMs >= AUTO_PURGE_TTL_MS;
    const purgeRemainingMs = Math.max(0, AUTO_PURGE_TTL_MS - ageMs);
    const feedExpiresAt = new Date(anchorTime + AUTO_PURGE_TTL_MS).toISOString();
    const daysLeft = Math.floor(purgeRemainingMs / (24 * 3600 * 1000));
    const hoursLeft = Math.floor((purgeRemainingMs % (24 * 3600 * 1000)) / (3600 * 1000));
    const minsLeft = Math.floor((purgeRemainingMs % (3600 * 1000)) / (60 * 1000));
    const countdownLabel =
      daysLeft > 0 ? `${daysLeft}d ${hoursLeft}h` : `${hoursLeft}h ${minsLeft}m`;
    const countdownLabelTl =
      daysLeft > 0 ? `${daysLeft} araw ${hoursLeft} oras` : `${hoursLeft}h ${minsLeft}m`;

    return {
      isPurgedFromFeed,
      purgeRemainingMs,
      feedExpiresAt,
      purgeCountdownText: isPurgedFromFeed
        ? isEn
          ? `Auto-purged from feed (${AUTO_PURGE_TTL_DAYS} days after resolution • Safely stored in Pi Logbook)`
          : `Na-auto-purge sa feed (${AUTO_PURGE_TTL_DAYS} araw tapos maresolba • Ligtas sa Pi Logbook)`
        : isEn
          ? `Resolved: ${countdownLabel} left (${AUTO_PURGE_TTL_DAYS}-Day TTL)`
          : `Naresolba: ${countdownLabelTl} na lang (${AUTO_PURGE_TTL_DAYS}-Araw TTL)`,
      purgeTtlRule: '7_DAYS_RESOLVED',
    };
  }

  if (isCancelled) {
    const anchorTime = parseTime(report.cancelledAt || report.createdAt);
    const ageMs = Math.max(0, now - anchorTime);
    const isPurgedFromFeed = ageMs >= AUTO_PURGE_TTL_MS;
    const purgeRemainingMs = Math.max(0, AUTO_PURGE_TTL_MS - ageMs);
    const feedExpiresAt = new Date(anchorTime + AUTO_PURGE_TTL_MS).toISOString();
    const daysLeft = Math.floor(purgeRemainingMs / (24 * 3600 * 1000));
    const hoursLeft = Math.floor((purgeRemainingMs % (24 * 3600 * 1000)) / (3600 * 1000));

    return {
      isPurgedFromFeed,
      purgeRemainingMs,
      feedExpiresAt,
      purgeCountdownText: isPurgedFromFeed
        ? isEn
          ? `Auto-purged (Cancelled after ${AUTO_PURGE_TTL_DAYS} days • Safely stored in Pi Logbook)`
          : `Na-auto-purge (Kinansela matapos ang ${AUTO_PURGE_TTL_DAYS} araw • Ligtas sa Pi Logbook)`
        : isEn
          ? `Cancelled: ${daysLeft}d ${hoursLeft}h remaining (${AUTO_PURGE_TTL_DAYS}-Day TTL)`
          : `Kinansela: ${daysLeft} araw ${hoursLeft} oras bago maalis (${AUTO_PURGE_TTL_DAYS}-Araw TTL)`,
      purgeTtlRule: '7_DAYS_RESOLVED',
    };
  }

  const createdTime = parseTime(report.createdAt);
  const ageMs = Math.max(0, now - createdTime);
  const isPurgedFromFeed = ageMs >= AUTO_PURGE_TTL_MS;
  const purgeRemainingMs = Math.max(0, AUTO_PURGE_TTL_MS - ageMs);
  const feedExpiresAt = new Date(createdTime + AUTO_PURGE_TTL_MS).toISOString();
  const daysLeft = Math.floor(purgeRemainingMs / (24 * 3600 * 1000));
  const hoursLeft = Math.floor((purgeRemainingMs % (24 * 3600 * 1000)) / (3600 * 1000));

  return {
    isPurgedFromFeed,
    purgeRemainingMs,
    feedExpiresAt,
    purgeCountdownText: isPurgedFromFeed
      ? isEn
        ? `Auto-purged after ${AUTO_PURGE_TTL_DAYS} days (Safely stored in Pi Logbook)`
        : `Na-auto-purge matapos ang ${AUTO_PURGE_TTL_DAYS} araw (Ligtas sa Pi Logbook)`
      : isEn
        ? `${daysLeft}d ${hoursLeft}h remaining (${AUTO_PURGE_TTL_DAYS}-Day TTL)`
        : `${daysLeft} araw ${hoursLeft} oras bago maalis (${AUTO_PURGE_TTL_DAYS}-Araw TTL)`,
    purgeTtlRule: '7_DAYS_UNRESOLVED',
  };
}
