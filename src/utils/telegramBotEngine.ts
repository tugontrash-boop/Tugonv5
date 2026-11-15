import type { TelegramQuickBubble, WasteReport } from '../types';

export type TelegramReportLike = Omit<Partial<WasteReport>, 'urgency' | 'status' | 'severityLevel'> & {
  urgency?: string;
  status?: string;
  severityLevel?: string;
};

export const TELEGRAM_QUICK_BUBBLES: TelegramQuickBubble[] = [
  {
    id: 'active',
    command: '/active',
    labelTl: '📋 Active & Unresolved Concerns',
    labelEn: '📋 Check Active Concerns / Unresolved',
    autoMessageTl: '📋 Check Active Concerns / Unresolved',
    autoMessageEn: '📋 Check Active Concerns / Unresolved',
  },
  {
    id: 'summary',
    command: '/summary',
    labelTl: '📊 Buod at Bilang',
    labelEn: '📊 Show Summary & Counts',
    autoMessageTl: '📊 Ipakita ang Buod at Bilang',
    autoMessageEn: '📊 Show Summary & Counts',
  },
  {
    id: 'help',
    command: '/help',
    labelTl: '❓ Help / Mga Command',
    labelEn: '❓ Help / Bot Commands',
    autoMessageTl: '❓ Help / Mga Command ng Bot',
    autoMessageEn: '❓ Help / Bot Commands',
  },
];

export function escapeTelegramHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatTelegramTicket(raw?: string): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^#+/, '');
  if (!cleaned) return '';
  return cleaned
    .replace(/^(PULSE|TRASH|DRAW)-CAV-/i, 'TUGON-CAV-')
    .replace(/^TUGON-CAV-/i, 'TUGON-CAV-');
}

export function getTelegramPhTime(): string {
  try {
    return new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

export function htmlToPlainTelegramText(html: string): string {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a\s+href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2: $1')
    .replace(/<\/?(b|strong|i|em|u|code|pre|a)[^>]*>/gi, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

/**
 * Persistent Reply Keyboard bubble buttons for Telegram chat.
 * Tapping any button in Telegram auto-sends that text to the bot immediately.
 */
export function buildTelegramReplyKeyboard(lang: 'tl' | 'en' = 'tl') {
  const isEn = lang === 'en';
  const find = (id: string) =>
    TELEGRAM_QUICK_BUBBLES.find((b) => b.id === id) || TELEGRAM_QUICK_BUBBLES[0];

  const row1 = [
    { text: isEn ? find('active').autoMessageEn : find('active').autoMessageTl },
  ];
  const row2 = [
    { text: isEn ? find('summary').autoMessageEn : find('summary').autoMessageTl },
    { text: isEn ? find('help').autoMessageEn : find('help').autoMessageTl },
  ];

  return {
    keyboard: [row1, row2],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

/**
 * Normalizes any incoming cloud bubble payload (inline callback_data, JSON notification bubble payload,
 * persistent reply keyboard button label, or slash command) into a canonical command string & language.
 */
export function detectTelegramLanguage(
  rawText: string,
  fallback: 'tl' | 'en' = 'tl'
): 'tl' | 'en' {
  const txt = String(rawText || '').trim();
  if (!txt) return fallback;
  const lower = txt.toLowerCase();

  // Explicit Tagalog markers take priority so shared words like "Check" or "Help" don't flip Tagalog bubbles to English
  if (
    /\b(mga|ipakita|buod|bilang|tingnan|ulat|kamusta|kumusta|kagawad|basura|hindi pa tapos|lugar|tulong|ilan)\b/i.test(
      lower
    )
  ) {
    return 'tl';
  }
  if (
    lower === '📊 show summary & counts' ||
    lower === '❓ help / bot commands' ||
    /\b(pending only|show summary|bot commands|how many|counts|status of|resolved)\b/i.test(lower)
  ) {
    return 'en';
  }
  return fallback;
}

export function parseTelegramCloudBubblePayload(rawInput: string): {
  normalizedCommand: string;
  displayLabel: string;
  detectedLang?: 'tl' | 'en';
  ticketNumber?: string;
} {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) {
    return { normalizedCommand: '', displayLabel: '' };
  }

  // Handle JSON cloud bubble payloads sent from webhook/server buttons or bridge
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') {
        const actionRaw = String(
          obj.command || obj.action || obj.bubble || obj.cmd || obj.intent || obj.type || ''
        )
          .trim()
          .toLowerCase();
        const langHint =
          obj.lang === 'en' ? 'en' : obj.lang === 'tl' ? 'tl' : undefined;
        const ticket = obj.ticketNumber ? String(obj.ticketNumber).trim() : undefined;

        if (ticket) {
          return {
            normalizedCommand: ticket,
            displayLabel: `🎫 Ticket ${ticket}`,
            detectedLang: langHint,
            ticketNumber: ticket,
          };
        }
        if (actionRaw.includes('summary') || actionRaw.includes('count') || actionRaw.includes('buod')) {
          return {
            normalizedCommand: '/summary',
            displayLabel: '📊 Show Summary & Counts',
            detectedLang: langHint,
          };
        }
        if (actionRaw.includes('help') || actionRaw.includes('command')) {
          return {
            normalizedCommand: '/help',
            displayLabel: '❓ Help / Bot Commands',
            detectedLang: langHint,
          };
        }
        if (
          actionRaw.includes('active') ||
          actionRaw.includes('unresolved') ||
          actionRaw.includes('pending') ||
          actionRaw.includes('cloud_bubble')
        ) {
          return {
            normalizedCommand: '/active',
            displayLabel: '📋 Check Active Concerns / Unresolved',
            detectedLang: langHint,
          };
        }
        if (obj.text || obj.message) {
          return {
            normalizedCommand: String(obj.text || obj.message).trim(),
            displayLabel: String(obj.text || obj.message).trim(),
            detectedLang: langHint,
          };
        }
      }
    } catch {
      // Fallback to string matching below
    }
  }

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('tg_cmd:active') ||
    lower.startsWith('cloud_bubble:active') ||
    lower.startsWith('bubble:active')
  ) {
    return {
      normalizedCommand: '/active',
      displayLabel: '📋 Check Active Concerns / Unresolved',
      detectedLang: lower.endsWith(':en') ? 'en' : undefined,
    };
  }
  if (
    lower.startsWith('tg_cmd:summary') ||
    lower.startsWith('cloud_bubble:summary') ||
    lower.startsWith('bubble:summary')
  ) {
    return {
      normalizedCommand: '/summary',
      displayLabel: '📊 Show Summary & Counts',
      detectedLang: lower.endsWith(':en') ? 'en' : undefined,
    };
  }
  if (
    lower.startsWith('tg_cmd:help') ||
    lower.startsWith('cloud_bubble:help') ||
    lower.startsWith('bubble:help')
  ) {
    return {
      normalizedCommand: '/help',
      displayLabel: '❓ Help / Bot Commands',
      detectedLang: lower.endsWith(':en') ? 'en' : undefined,
    };
  }

  const ticketBubbleMatch = lower.match(/^(?:tg_cmd:ticket:|cloud_bubble:ticket:)(.+)$/);
  if (ticketBubbleMatch && ticketBubbleMatch[1]) {
    return {
      normalizedCommand: ticketBubbleMatch[1].trim(),
      displayLabel: `🎫 ${ticketBubbleMatch[1].trim()}`,
      ticketNumber: ticketBubbleMatch[1].trim(),
    };
  }

  return {
    normalizedCommand: trimmed,
    displayLabel: trimmed,
  };
}

/**
 * Inline cloud bubble buttons attached directly under Message 1 (New Concern card).
 */
export function buildNewConcernInlineKeyboard(
  report: TelegramReportLike,
  lang: 'tl' | 'en' = 'tl'
) {
  const isEn = lang === 'en';
  const coords = report.coordinates || { lat: 14.47558, lng: 120.89115 };
  const mapsUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
  return {
    inline_keyboard: [
      [
        {
          text: isEn ? '🗺 Open Google Maps' : '🗺 Buksan sa Google Maps',
          url: mapsUrl,
        },
        {
          text: isEn ? '📋 Check Active / Unresolved' : '📋 Active & Unresolved',
          callback_data: `tg_cmd:active:${lang}`,
        },
      ],
      [
        {
          text: isEn ? '📊 Show Summary & Counts' : '📊 Buod at Bilang',
          callback_data: `tg_cmd:summary:${lang}`,
        },
        {
          text: isEn ? '❓ Help / Bot Commands' : '❓ Help / Mga Command',
          callback_data: `tg_cmd:help:${lang}`,
        },
      ],
    ],
  };
}

/**
 * Message 1 of 2: Full details for the newly submitted concern.
 */
export function buildNewConcernMessage1Html(
  report: TelegramReportLike,
  lang: 'tl' | 'en' = 'tl',
  phTime = getTelegramPhTime()
): string {
  const isEn = lang === 'en';
  const ticket = formatTelegramTicket(report.ticketNumber) || 'TUGON-CAV-0000';
  const coords = report.coordinates || { lat: 14.47558, lng: 120.89115 };
  const mapsUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
  const locationText =
    report.realtimeGpsAddress ||
    [report.houseNumber, report.streetAddress, report.purok || report.barangay, 'Cavite City']
      .filter(Boolean)
      .join(', ');
  const wasteTypesText =
    Array.isArray(report.wasteTypes) && report.wasteTypes.length > 0
      ? report.wasteTypes.join(', ')
      : 'Household Trash';
  const photoCount = Array.isArray(report.photos) ? report.photos.length : 0;
  const priorityBanner = report.isElderly
    ? isEn
      ? '🚨 <b>[SENIOR CITIZEN / PWD PRIORITY]</b>\n'
      : '🚨 <b>[SENIOR CITIZEN / PWD PRIORITY]</b>\n'
    : report.severityLevel === 'EMERGENCY' || report.severityLevel === 'OVERFLOWING'
      ? isEn
        ? '⚠️ <b>[HIGH URGENCY / OVERFLOWING]</b>\n'
        : '⚠️ <b>[MATAAS NA KALUBHAAN / UMAAPAW]</b>\n'
      : '';

  const extraLine = report.extraMessage
    ? `\n${isEn ? 'Notes' : 'Mensahe'}: "${escapeTelegramHtml(report.extraMessage)}"`
    : '';
  const landmarkLine = report.landmark
    ? `\n${isEn ? 'Landmark' : 'Palatandaan'}: ${escapeTelegramHtml(report.landmark)}`
    : '';

  if (isEn) {
    return (
      `🗑 <b>[T.U.G.O.N. NEW CONCERN REPORT - ${escapeTelegramHtml(report.barangay || 'Brgy 40 & 41')}]</b>\n` +
      `${priorityBanner}` +
      `🎫 Ticket: <b>#${escapeTelegramHtml(ticket)}</b>\n` +
      `🕒 Time: ${escapeTelegramHtml(phTime)}\n` +
      `👤 Resident: ${escapeTelegramHtml(report.residentName || 'Concerned Resident')}\n` +
      `📍 Location: ${escapeTelegramHtml(locationText)}${landmarkLine}\n` +
      `🗺 Google Maps: ${mapsUrl}\n` +
      `♻️ Waste Type: ${escapeTelegramHtml(wasteTypesText)}\n` +
      `⚡ Severity: ${escapeTelegramHtml(report.severityLevel || 'MODERATE')} (${escapeTelegramHtml(report.estimatedBags || '1-3 bags')})\n` +
      `📸 Photos: ${photoCount} attached${extraLine}\n` +
      `📌 Status: ⏳ PENDING`
    );
  }

  return (
    `🗑 <b>[T.U.G.O.N. BAGONG CONCERN - ${escapeTelegramHtml(report.barangay || 'Brgy 40 & 41')}]</b>\n` +
    `${priorityBanner}` +
    `🎫 Ticket: <b>#${escapeTelegramHtml(ticket)}</b>\n` +
    `🕒 Oras: ${escapeTelegramHtml(phTime)}\n` +
    `👤 Residente: ${escapeTelegramHtml(report.residentName || 'Residente')}\n` +
    `📍 Lugar: ${escapeTelegramHtml(locationText)}${landmarkLine}\n` +
    `🗺 Google Maps: ${mapsUrl}\n` +
    `♻️ Uri ng Basura: ${escapeTelegramHtml(wasteTypesText)}\n` +
    `⚡ Kalubhaan: ${escapeTelegramHtml(report.severityLevel || 'MODERATE')} (${escapeTelegramHtml(report.estimatedBags || '1-3 bags')})\n` +
    `📸 Litrato: ${photoCount} nakalakip${extraLine}\n` +
    `📌 Katayuan: ⏳ PENDING`
  );
}

/**
 * Compact HTML caption (<= 950 chars) for sendPhoto on Message 1.
 */
export function buildNewConcernPhotoCaptionHtml(
  report: TelegramReportLike,
  lang: 'tl' | 'en' = 'tl',
  phTime = getTelegramPhTime()
): string {
  const full = buildNewConcernMessage1Html(report, lang, phTime);
  if (full.length <= 950) return full;
  const ticket = formatTelegramTicket(report.ticketNumber) || 'TUGON-CAV-0000';
  const coords = report.coordinates || { lat: 14.47558, lng: 120.89115 };
  const mapsUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
  const loc = (
    report.realtimeGpsAddress ||
    report.streetAddress ||
    report.purok ||
    report.barangay ||
    'Cavite City'
  ).slice(0, 140);
  return (
    `🗑 <b>[T.U.G.O.N. ${lang === 'en' ? 'NEW CONCERN' : 'BAGONG CONCERN'} - ${escapeTelegramHtml(report.barangay || 'Brgy 40 & 41')}]</b>\n` +
    `🎫 Ticket: <b>#${escapeTelegramHtml(ticket)}</b>\n` +
    `🕒 ${escapeTelegramHtml(phTime)}\n` +
    `📍 ${escapeTelegramHtml(loc)}\n` +
    `🗺 Maps: ${mapsUrl}\n` +
    `⚡ ${escapeTelegramHtml(report.severityLevel || 'MODERATE')} • 📸 ${report.photos?.length || 1} photo(s)\n` +
    `📌 Status: ⏳ PENDING`
  ).slice(0, 950);
}

/**
 * Message 2 of 2: Active & Unresolved Concerns list (PENDING + DISPATCHED).
 */
export function buildActiveUnresolvedConcernsMessage2Html(
  allReports: TelegramReportLike[],
  lang: 'tl' | 'en' = 'tl',
  filterMode: 'ACTIVE' | 'BRGY40' | 'BRGY41' = 'ACTIVE'
): string {
  const isEn = lang === 'en';
  const active = (Array.isArray(allReports) ? allReports : []).filter(
    (r) => r && (r.status === 'PENDING' || r.status === 'DISPATCHED')
  );

  let filtered = active;
  if (filterMode === 'BRGY40') {
    filtered = active.filter(
      (r) => String(r.barangay || r.purok || '').toLowerCase().includes('40')
    );
  } else if (filterMode === 'BRGY41') {
    filtered = active.filter(
      (r) => !String(r.barangay || r.purok || '').toLowerCase().includes('40')
    );
  }

  if (filtered.length === 0) {
    if (filterMode === 'ACTIVE') {
      return isEn
        ? '✨ <b>[ACTIVE &amp; UNRESOLVED CONCERNS: 0]</b>\nAll waste concerns in Barangay 40 &amp; 41 have been cleared! 🎉'
        : '✨ <b>[MGA ACTIVE AT HINDI PA TAPOS NA CONCERNS: 0]</b>\nLahat ng concerns sa Barangay 40 &amp; 41 ay malinis at tapos na! 🎉';
    }
    return isEn
      ? `✨ <b>No active concerns in ${filterMode === 'BRGY40' ? 'Barangay 40' : 'Barangay 41'}.</b>\nTotal Active Unresolved: ${active.length}`
      : `✨ <b>Walang active concern sa ${filterMode === 'BRGY40' ? 'Barangay 40' : 'Barangay 41'}.</b>\nKabuuang Active Unresolved: ${active.length}`;
  }

  const sortByPriorityAndTime = (arr: TelegramReportLike[]) =>
    [...arr].sort((a, b) => {
      const score = (r: TelegramReportLike) =>
        (r.isElderly ? 100 : 0) +
        (r.severityLevel === 'EMERGENCY' ? 50 : r.severityLevel === 'OVERFLOWING' ? 25 : 0);
      const diff = score(b) - score(a);
      if (diff !== 0) return diff;
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });

  // Divide cleanly into: 1) Senior Citizen / PWD Priority, 2) Pending (Regular/Emergency), 3) Dispatched (Regular/Emergency)
  const seniorSection = sortByPriorityAndTime(filtered.filter((r) => Boolean(r.isElderly)));
  const pendingRegularSection = sortByPriorityAndTime(
    filtered.filter((r) => !r.isElderly && r.status === 'PENDING')
  );
  const dispatchedRegularSection = sortByPriorityAndTime(
    filtered.filter((r) => !r.isElderly && r.status === 'DISPATCHED')
  );

  const formatConcernItem = (r: TelegramReportLike, idx: number): string => {
    const ticket = formatTelegramTicket(r.ticketNumber) || `TUGON-CAV-${idx + 1}`;
    const createdMs = new Date(r.createdAt || Date.now()).getTime();
    const minsAgo = Math.max(0, Math.floor((Date.now() - createdMs) / 60000));
    const ageLabel =
      minsAgo < 60
        ? isEn
          ? `${minsAgo}m ago`
          : `${minsAgo}m nakalipas`
        : isEn
          ? `${Math.floor(minsAgo / 60)}h ago`
          : `${Math.floor(minsAgo / 60)}h nakalipas`;

    const tags: string[] = [];
    if (r.isElderly) tags.push('🚨 SENIOR/PWD');
    if (r.severityLevel === 'EMERGENCY') tags.push('⚠️ EMERGENCY');
    else if (r.severityLevel === 'OVERFLOWING') tags.push('⚠️ OVERFLOWING');
    else if (r.severityLevel) tags.push(`⚡ ${escapeTelegramHtml(r.severityLevel)}`);
    const tagStr = tags.length > 0 ? ` • ${tags.join(' • ')}` : '';

    const statusLabel =
      r.status === 'DISPATCHED'
        ? isEn
          ? '🚚 DISPATCHED'
          : '🚚 KINOKOLEKTA (DISPATCHED)'
        : '⏳ PENDING';

    const brgy =
      r.barangay || (String(r.purok || '').includes('40') ? 'Barangay 40' : 'Barangay 41');
    const addr = r.realtimeGpsAddress || r.streetAddress || r.purok || 'Cavite City';
    const coords = r.coordinates || { lat: 14.47558, lng: 120.89115 };
    const mapUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;

    return (
      `${idx + 1}. <b>#${escapeTelegramHtml(ticket)}</b>${tagStr}\n` +
      `   📌 ${statusLabel} (${escapeTelegramHtml(ageLabel)})\n` +
      `   📍 ${escapeTelegramHtml(brgy)}: ${escapeTelegramHtml(addr.slice(0, 80))}\n` +
      `   🗺 <a href="${mapUrl}">Maps</a>`
    );
  };

  const MAX_TOTAL_ITEMS = 12;
  let remainingSlots = MAX_TOTAL_ITEMS;

  const takeSlice = (arr: TelegramReportLike[]) => {
    const taken = arr.slice(0, Math.max(0, remainingSlots));
    remainingSlots -= taken.length;
    return { taken, omitted: Math.max(0, arr.length - taken.length) };
  };

  const seniorTake = takeSlice(seniorSection);
  const pendingTake = takeSlice(pendingRegularSection);
  const dispatchedTake = takeSlice(dispatchedRegularSection);
  const totalOmitted = seniorTake.omitted + pendingTake.omitted + dispatchedTake.omitted;

  const headerTitle =
    filterMode === 'BRGY40'
      ? `📍 <b>[BARANGAY 40 (GUMAMELA) ACTIVE CONCERNS (${filtered.length})]</b>`
      : filterMode === 'BRGY41'
        ? `📍 <b>[BARANGAY 41 (ROSAL) ACTIVE CONCERNS (${filtered.length})]</b>`
        : isEn
          ? `📋 <b>[ACTIVE &amp; UNRESOLVED CONCERNS (${filtered.length} total)]</b>`
          : `📋 <b>[MGA ACTIVE AT HINDI PA TAPOS NA CONCERNS (${filtered.length} kabuuan)]</b>`;

  const noneLabel = isEn ? '<i>None</i>' : '<i>Wala sa ngayon</i>';
  const divider = '──────────────';

  const seniorBlock =
    `🚨 <b>${isEn ? 'SENIOR CITIZEN / PWD PRIORITY' : 'SENIOR CITIZEN / PWD PRIORITY'} (${seniorSection.length})</b>\n` +
    (seniorSection.length === 0
      ? noneLabel
      : seniorTake.taken.map((r, i) => formatConcernItem(r, i)).join('\n\n'));

  const pendingBlock =
    `⏳ <b>${isEn ? 'PENDING (WAITING FOR DISPATCH)' : 'PENDING (NAGHIHINTAY NG KOLEKTA)'} (${pendingRegularSection.length})</b>\n` +
    (pendingRegularSection.length === 0
      ? noneLabel
      : pendingTake.taken.map((r, i) => formatConcernItem(r, i)).join('\n\n'));

  const dispatchedBlock =
    `🚚 <b>${isEn ? 'DISPATCHED (CURRENTLY COLLECTING)' : 'DISPATCHED (KASALUKUYANG KINOKOLEKTA)'} (${dispatchedRegularSection.length})</b>\n` +
    (dispatchedRegularSection.length === 0
      ? noneLabel
      : dispatchedTake.taken.map((r, i) => formatConcernItem(r, i)).join('\n\n'));

  const suffix =
    totalOmitted > 0
      ? isEn
        ? `\n\n...and ${totalOmitted} more active unresolved concern(s) in portal.`
        : `\n\n...at ${totalOmitted} pang active unresolved concern(s) sa portal.`
      : '';

  const totalPending = filtered.filter((r) => r.status === 'PENDING').length;
  const totalDispatched = filtered.filter((r) => r.status === 'DISPATCHED').length;
  const statsFooter = isEn
    ? `\n${divider}\n📊 Senior/PWD: <b>${seniorSection.length}</b> • Pending: <b>${totalPending}</b> • Dispatched: <b>${totalDispatched}</b> • Total Active: <b>${filtered.length}</b>`
    : `\n${divider}\n📊 Senior/PWD: <b>${seniorSection.length}</b> • Pending: <b>${totalPending}</b> • Dispatched: <b>${totalDispatched}</b> • Kabuuang Active: <b>${filtered.length}</b>`;

  return `${headerTitle}\n\n${seniorBlock}\n${divider}\n${pendingBlock}\n${divider}\n${dispatchedBlock}${suffix}${statsFooter}`;
}

export function buildResolvedConcernMessage1Html(
  report: TelegramReportLike,
  lang: 'tl' | 'en' = 'tl',
  phTime = getTelegramPhTime()
): string {
  const isEn = lang === 'en';
  const ticket = formatTelegramTicket(report.ticketNumber) || 'TUGON-CAV-0000';
  const coords = report.coordinates || { lat: 14.47558, lng: 120.89115 };
  const mapsUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
  const proofCount = Array.isArray(report.proofPhotos) ? report.proofPhotos.length : 0;

  if (isEn) {
    return (
      `✅ <b>[T.U.G.O.N. - CONCERN RESOLVED / CLEARED]</b>\n` +
      `🎫 Ticket: <b>#${escapeTelegramHtml(ticket)}</b>\n` +
      `📍 Jurisdiction: ${escapeTelegramHtml(report.barangay || 'Brgy 40 & 41')}\n` +
      `🕒 Resolved At: ${escapeTelegramHtml(phTime)}\n` +
      `📌 Location: ${escapeTelegramHtml(report.realtimeGpsAddress || report.streetAddress || report.purok || 'Cavite City')}\n` +
      `🗺 Maps: ${mapsUrl}\n` +
      `👮 Official: ${escapeTelegramHtml(report.resolvedBy || 'Barangay Official')}\n` +
      `📝 Notes: ${escapeTelegramHtml(report.resolutionNotes || 'Collected and cleaned.')}\n` +
      `📸 Proof Photos: ${proofCount} attached`
    );
  }

  return (
    `✅ <b>[T.U.G.O.N. - TAPOS AT NAKOLEKTA NA]</b>\n` +
    `🎫 Ticket: <b>#${escapeTelegramHtml(ticket)}</b>\n` +
    `📍 Hurisdiksyon: ${escapeTelegramHtml(report.barangay || 'Brgy 40 & 41')}\n` +
    `🕒 Oras ng Pagtatapos: ${escapeTelegramHtml(phTime)}\n` +
    `📍 Lugar: ${escapeTelegramHtml(report.realtimeGpsAddress || report.streetAddress || report.purok || 'Cavite City')}\n` +
    `🗺 Maps: ${mapsUrl}\n` +
    `👮 Kagawad: ${escapeTelegramHtml(report.resolvedBy || 'Barangay Kagawad')}\n` +
    `📝 Ulat ng Proeba: ${escapeTelegramHtml(report.resolutionNotes || 'Nalinis at nakolekta na.')}\n` +
    `📸 Litrato ng Proeba: ${proofCount} patunay`
  );
}

/**
 * Interactive Bot Reply Engine for BOTH Telegram chat and In-App Telegram Bot Chat.
 */
export function generateBotChatReply(
  rawInput: string,
  allReports: TelegramReportLike[],
  lang: 'tl' | 'en' = 'tl'
): {
  textHtml: string;
  textPlain: string;
  matchedIntent: string;
  activeCount: number;
} {
  const parsedBubble = parseTelegramCloudBubblePayload(rawInput);
  const resolvedLang: 'tl' | 'en' =
    parsedBubble.detectedLang || detectTelegramLanguage(parsedBubble.normalizedCommand, lang);
  const isEn = resolvedLang === 'en';
  const input = parsedBubble.normalizedCommand;
  const normalized = input.toLowerCase();
  const list = Array.isArray(allReports) ? allReports : [];
  const active = list.filter((r) => r && (r.status === 'PENDING' || r.status === 'DISPATCHED'));
  const pending = active.filter((r) => r.status === 'PENDING');
  const dispatched = active.filter((r) => r.status === 'DISPATCHED');
  const resolved = list.filter((r) => r && r.status === 'RESOLVED');
  const seniorActive = active.filter(
    (r) => r.isElderly || r.severityLevel === 'EMERGENCY' || r.severityLevel === 'OVERFLOWING'
  );
  const brgy40Active = active.filter((r) =>
    String(r.barangay || r.purok || '').toLowerCase().includes('40')
  );
  const brgy41Active = active.filter(
    (r) => !String(r.barangay || r.purok || '').toLowerCase().includes('40')
  );

  let textHtml = '';
  let matchedIntent = 'GENERAL';

  // 1. Check for specific Ticket Number lookup (#TUGON-CAV-XXXX, PULSE-CAV-XXXX, or 4 digits)
  const fullTicketMatch = input.match(/#?(?:TUGON|PULSE|TRASH|DRAW)-CAV-(\d{2,6})/i);
  const digitsOnlyMatch = !fullTicketMatch ? input.match(/\b(\d{3,5})\b/) : null;
  const searchDigits = fullTicketMatch?.[1] || (normalized.includes('ticket') || normalized.includes('tugon') || /^\d{4}$/.test(normalized) ? digitsOnlyMatch?.[1] : undefined);

  if (searchDigits) {
    const found = list.find((r) => {
      const t = formatTelegramTicket(r.ticketNumber).toUpperCase();
      return t.endsWith(`-${searchDigits}`) || t.includes(searchDigits);
    });
    if (found) {
      matchedIntent = 'TICKET_LOOKUP';
      const ticket = formatTelegramTicket(found.ticketNumber);
      const coords = found.coordinates || { lat: 14.47558, lng: 120.89115 };
      const mapsUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
      const statusBadge =
        found.status === 'RESOLVED'
          ? '✅ RESOLVED'
          : found.status === 'DISPATCHED'
            ? '🚚 DISPATCHED'
            : found.status === 'CANCELLED'
              ? '❌ CANCELLED'
              : '⏳ PENDING';
      textHtml = isEn
        ? `🎫 <b>[TICKET STATUS: #${escapeTelegramHtml(ticket)}]</b>\n` +
          `Status: <b>${statusBadge}</b>\n` +
          `Barangay: ${escapeTelegramHtml(found.barangay || 'Brgy 40/41')}\n` +
          `Location: ${escapeTelegramHtml(found.realtimeGpsAddress || found.streetAddress || found.purok || 'Cavite City')}\n` +
          `Severity: ${escapeTelegramHtml(found.severityLevel || 'MODERATE')}${found.isElderly ? ' (🚨 Senior/PWD Priority)' : ''}\n` +
          `Photos: ${found.photos?.length || 0} • Proof Photos: ${found.proofPhotos?.length || 0}\n` +
          (found.resolvedBy ? `Resolved By: ${escapeTelegramHtml(found.resolvedBy)}\n` : '') +
          `Maps: ${mapsUrl}`
        : `🎫 <b>[KATAYUAN NG TICKET: #${escapeTelegramHtml(ticket)}]</b>\n` +
          `Katayuan: <b>${statusBadge}</b>\n` +
          `Barangay: ${escapeTelegramHtml(found.barangay || 'Brgy 40/41')}\n` +
          `Lugar: ${escapeTelegramHtml(found.realtimeGpsAddress || found.streetAddress || found.purok || 'Cavite City')}\n` +
          `Kalubhaan: ${escapeTelegramHtml(found.severityLevel || 'MODERATE')}${found.isElderly ? ' (🚨 Senior/PWD Priority)' : ''}\n` +
          `Litrato: ${found.photos?.length || 0} • Proeba: ${found.proofPhotos?.length || 0}\n` +
          (found.resolvedBy ? `Kagawad: ${escapeTelegramHtml(found.resolvedBy)}\n` : '') +
          `Maps: ${mapsUrl}`;
    } else {
      matchedIntent = 'TICKET_NOT_FOUND';
      textHtml = isEn
        ? `🔍 No report found matching ticket <b>#${escapeTelegramHtml(searchDigits)}</b>. There are currently <b>${active.length}</b> active unresolved concern(s).`
        : `🔍 Walang nahanap na ulat para sa ticket <b>#${escapeTelegramHtml(searchDigits)}</b>. Mayroon pang <b>${active.length}</b> active unresolved concern(s).`;
    }
  } else if (
    normalized.startsWith('/start') ||
    /^(hi|hello|hey|kamusta|kumusta|good\s+(morning|afternoon|evening)|magandang\s+(umaga|hapon|gabi))/i.test(
      normalized
    )
  ) {
    matchedIntent = 'GREETING';
    textHtml = isEn
      ? `👋 <b>Hello! I am the T.U.G.O.N. Barangay 40 &amp; 41 Bot.</b>\n\n` +
        `I notify Kagawads for every new waste concern and help track unresolved reports.\n` +
        `📊 Live Right Now: <b>${pending.length}</b> Pending • <b>${dispatched.length}</b> Dispatched • <b>${active.length}</b> Active Unresolved.\n\n` +
        `Tap any <b>bubble button</b> below or type a command/ticket number (e.g. <code>TUGON-CAV-7766</code>)!`
      : `👋 <b>Kamusta! Ako ang T.U.G.O.N. Barangay 40 &amp; 41 Bot.</b>\n\n` +
        `Awtomatiko akong nagno-notify sa bawat bagong ulat at handang sagutin ang lagay ng mga concerns.\n` +
        `📊 Live Ngayon: <b>${pending.length}</b> Pending • <b>${dispatched.length}</b> Kinokolekta • <b>${active.length}</b> Active Unresolved.\n\n` +
        `Pindutin ang alinmang <b>bubble button</b> sa ibaba o mag-type ng ticket number (hal. <code>TUGON-CAV-7766</code>)!`;
  } else if (
    normalized.includes('40') ||
    normalized.includes('gumamela')
  ) {
    matchedIntent = 'BRGY_40';
    textHtml = buildActiveUnresolvedConcernsMessage2Html(list, resolvedLang, 'BRGY40');
  } else if (
    normalized.includes('41') ||
    normalized.includes('rosal')
  ) {
    matchedIntent = 'BRGY_41';
    textHtml = buildActiveUnresolvedConcernsMessage2Html(list, resolvedLang, 'BRGY41');
  } else if (
    normalized.includes('tg_cmd:summary') ||
    normalized.startsWith('/summary') ||
    normalized.startsWith('/status') ||
    normalized.includes('summary') ||
    normalized.includes('buod') ||
    normalized.includes('bilang') ||
    normalized.includes('count') ||
    normalized.includes('how many') ||
    normalized.includes('ilan')
  ) {
    matchedIntent = 'SUMMARY';
    const phTime = getTelegramPhTime();
    textHtml = isEn
      ? `📊 <b>[T.U.G.O.N. LIVE SUMMARY - BRGY 40 &amp; 41]</b>\n` +
        `🕒 ${escapeTelegramHtml(phTime)}\n\n` +
        `• 📋 Active &amp; Unresolved: <b>${active.length}</b>\n` +
        `• 🚨 Senior / PWD Priority Active: <b>${seniorActive.length}</b>\n` +
        `• ⏳ Pending: <b>${pending.length}</b>\n` +
        `• 🚚 Dispatched: <b>${dispatched.length}</b>\n` +
        `• 📍 Brgy 40 (Gumamela) Active: <b>${brgy40Active.length}</b>\n` +
        `• 📍 Brgy 41 (Rosal) Active: <b>${brgy41Active.length}</b>\n` +
        `• ✅ Resolved Total: <b>${resolved.length}</b>`
      : `📊 <b>[T.U.G.O.N. LIVE NA BUOD - BRGY 40 &amp; 41]</b>\n` +
        `🕒 ${escapeTelegramHtml(phTime)}\n\n` +
        `• 📋 Active &amp; Hindi Pa Tapos: <b>${active.length}</b>\n` +
        `• 🚨 Senior / PWD Priority Active: <b>${seniorActive.length}</b>\n` +
        `• ⏳ Pending: <b>${pending.length}</b>\n` +
        `• 🚚 Kinokolekta (Dispatched): <b>${dispatched.length}</b>\n` +
        `• 📍 Brgy 40 (Gumamela) Active: <b>${brgy40Active.length}</b>\n` +
        `• 📍 Brgy 41 (Rosal) Active: <b>${brgy41Active.length}</b>\n` +
        `• ✅ Kabuuang Na-resolve: <b>${resolved.length}</b>`;
  } else if (
    normalized.includes('tg_cmd:active') ||
    normalized.startsWith('/active') ||
    normalized.startsWith('/unresolved') ||
    normalized.startsWith('/pending') ||
    normalized.startsWith('/dispatched') ||
    normalized.startsWith('/urgent') ||
    normalized.includes('active') ||
    normalized.includes('unresolved') ||
    normalized.includes('hindi pa tapos') ||
    normalized.includes('pending') ||
    normalized.includes('dispatch') ||
    normalized.includes('kinokolekta') ||
    normalized.includes('senior') ||
    normalized.includes('urgent') ||
    normalized.includes('concern') ||
    normalized.includes('ulat') ||
    normalized.includes('check') ||
    normalized.includes('list') ||
    normalized.includes('tingnan')
  ) {
    matchedIntent = 'ACTIVE_UNRESOLVED';
    textHtml = buildActiveUnresolvedConcernsMessage2Html(list, resolvedLang, 'ACTIVE');
  } else if (
    normalized.includes('tg_cmd:help') ||
    normalized.startsWith('/help') ||
    normalized.includes('help') ||
    normalized.includes('tulong') ||
    normalized.includes('command') ||
    normalized.includes('menu')
  ) {
    matchedIntent = 'HELP';
    textHtml = isEn
      ? `❓ <b>[T.U.G.O.N. BOT COMMANDS &amp; CHAT GUIDE]</b>\n\n` +
        `Tap any quick bubble button below or send:\n` +
        `• <code>/active</code> — Check all active &amp; unresolved concerns (divided into Senior/PWD, Pending &amp; Dispatched)\n` +
        `• <code>/summary</code> — Show live Barangay 40 &amp; 41 counts\n` +
        `• <code>/help</code> — Show bot commands &amp; chat guide\n` +
        `• Send any ticket like <code>TUGON-CAV-7766</code> or ask <i>"Brgy 40"</i> / <i>"Brgy 41"</i>!`
      : `❓ <b>[MGA COMMAND AT GABAY SA T.U.G.O.N. BOT]</b>\n\n` +
        `Pindutin ang anumang bubble button sa ibaba o i-type ang:\n` +
        `• <code>/active</code> — Tingnan lahat ng active &amp; unresolved (nakahati sa Senior/PWD, Pending at Dispatched)\n` +
        `• <code>/summary</code> — Ipakita ang buod at bilang sa Brgy 40 at 41\n` +
        `• <code>/help</code> — Mga command at gabay ng bot\n` +
        `• Mag-send ng ticket (hal. <code>TUGON-CAV-7766</code>) o itanong <i>"Brgy 40"</i> / <i>"Brgy 41"</i>!`;
  } else {
    matchedIntent = 'CHAT_FALLBACK';
    textHtml = isEn
      ? `🤖 Received: "<i>${escapeTelegramHtml(input.slice(0, 120))}</i>"\n\n` +
        `There are currently <b>${active.length}</b> active unresolved concern(s) (🚨 ${seniorActive.length} Senior/PWD • ⏳ ${pending.length} Pending • 🚚 ${dispatched.length} Dispatched).\n` +
        `Tap <b>Check Active Concerns / Unresolved</b> below or ask about a ticket (e.g. <code>TUGON-CAV-7766</code>), <b>Brgy 40</b>, or <b>Brgy 41</b>.`
      : `🤖 Natanggap: "<i>${escapeTelegramHtml(input.slice(0, 120))}</i>"\n\n` +
        `Mayroon ngayong <b>${active.length}</b> active at hindi pa tapos na concern(s) (🚨 ${seniorActive.length} Senior/PWD • ⏳ ${pending.length} Pending • 🚚 ${dispatched.length} Dispatched).\n` +
        `Pindutin ang <b>Check Active Concerns / Unresolved</b> sa ibaba o itanong ang ticket (hal. <code>TUGON-CAV-7766</code>), <b>Brgy 40</b>, o <b>Brgy 41</b>.`;
  }

  return {
    textHtml,
    textPlain: htmlToPlainTelegramText(textHtml),
    matchedIntent,
    activeCount: active.length,
  };
}
