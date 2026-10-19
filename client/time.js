/** Relative timestamps in the native list's style: 刚刚 / N 分钟 / N 小时 / 昨天 / N 天 / N 个月. */
import { t } from './i18n.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelative(updatedAt, now = Date.now()) {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
  const delta = Math.max(0, now - updatedAt);
  if (delta < MINUTE) return t('time.now');
  if (delta < HOUR) return t('time.minutes', { n: Math.floor(delta / MINUTE) });
  if (delta < DAY) return t('time.hours', { n: Math.floor(delta / HOUR) });
  const days = Math.floor(delta / DAY);
  if (days === 1) return t('time.yesterday');
  if (days < 30) return t('time.days', { n: days });
  const months = Math.floor(days / 30);
  if (months < 12) return t('time.months', { n: months });
  return t('time.years', { n: Math.floor(months / 12) });
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}
