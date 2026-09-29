// 按北京时间的自然日分组：列表行只显示时刻，日期交给分组标题。
import { localeCode, t } from '$lib/i18n.svelte';
import { beijingDayKey } from '../time';

export type DayGroup<T> = { key: string; label: string; items: T[] };

/** items 需已按时间倒序；相邻且同一天的条目归入同一组。 */
export function groupByDay<T>(items: T[], timeOf: (item: T) => string, now: number): DayGroup<T>[] {
  const today = beijingDayKey(new Date(now));
  const yesterday = beijingDayKey(new Date(now - 24 * 3600_000));
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const at = new Date(timeOf(item));
    const valid = !Number.isNaN(at.getTime());
    const key = valid ? beijingDayKey(at) : 'unknown';
    let group = groups.at(-1);
    if (!group || group.key !== key) {
      const label = !valid
        ? t('时间未知')
        : key === today
          ? t('今天')
          : key === yesterday
            ? t('昨天')
            : at.toLocaleDateString(localeCode(), {
                timeZone: 'Asia/Shanghai',
                month: 'long',
                day: 'numeric',
                weekday: 'short',
              });
      group = { key, label, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
