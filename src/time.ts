import { localeCode, t } from '$lib/i18n.svelte';

function beijingTimeFormatter(): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(localeCode(), {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** 北京时间的「时:分」，用于已按天分组的列表。 */
export function formatBeijingClock(value: string | Date | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(localeCode(), {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** 北京时间的「时:分:秒」，用于同一次执行内的事件序列。 */
export function formatBeijingClockSeconds(value: string | Date | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(localeCode(), {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

/** 北京时间的「月/日 时:分」，用于不按天分组的列表。 */
export function formatBeijingShort(value: string | Date | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(localeCode(), {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** 北京时间的日期键（yyyy-mm-dd），用于按天分组，和列表里显示的时刻使用同一时区。 */
export function beijingDayKey(value: string | Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function formatBeijingTime(value: string | Date | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return beijingTimeFormatter().format(date).replace(/\//g, '/');
}

function relativeTimeFormatter(): Intl.RelativeTimeFormat {
  return new Intl.RelativeTimeFormat(localeCode(), { numeric: 'auto' });
}

export function formatRelativeTime(value: string | Date | number | null | undefined, now: number = Date.now()): string {
  if (value === null || value === undefined || value === '') return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const seconds = (date.getTime() - now) / 1000;
  const absoluteSeconds = Math.abs(seconds);
  if (absoluteSeconds < 10) return t('刚刚');
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 24 * 60 * 60],
    ['month', 30 * 24 * 60 * 60],
    ['day', 24 * 60 * 60],
    ['hour', 60 * 60],
    ['minute', 60],
    ['second', 1],
  ];
  const [unit, divisor] = ranges.find(([, size]) => absoluteSeconds >= size) ?? ['second', 1];
  return relativeTimeFormatter().format(Math.round(seconds / divisor), unit);
}
