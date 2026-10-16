import { isSqlite, query } from './db';
import type { AdminSettings } from '../types';
import { sellMoreOfYourMasterPrompt } from '../data/masterPrompt';

export const defaultSettings: AdminSettings = {
  masterPrompt: sellMoreOfYourMasterPrompt,
  generationTime: '08:00',
  generationFrequency: 'daily',
  generationMode: 'daily',
  generationCount: 1,
  generationTimes: ['08:00'],
  generationWeekdays: [1],
  autoGenerationEnabled: false,
};

function normalizeSettings(input: Partial<AdminSettings>): AdminSettings {
  const merged = { ...defaultSettings, ...input };
  const times = Array.isArray(merged.generationTimes) && merged.generationTimes.length > 0
    ? merged.generationTimes
    : [merged.generationTime || defaultSettings.generationTime];
  const cleanTimes = times
    .map((time) => String(time).trim())
    .filter((time) => /^\d{2}:\d{2}$/.test(time))
    .slice(0, 12);
  const count = Math.min(12, Math.max(1, Number(merged.generationCount) || cleanTimes.length || 1));
  const weekdays = Array.isArray(merged.generationWeekdays) && merged.generationWeekdays.length > 0
    ? merged.generationWeekdays.map(Number).filter((day) => day >= 0 && day <= 6)
    : defaultSettings.generationWeekdays;

  return {
    ...merged,
    generationMode: merged.generationMode || merged.generationFrequency || 'daily',
    generationFrequency: merged.generationMode || merged.generationFrequency || 'daily',
    generationCount: count,
    generationTimes: cleanTimes.length > 0 ? cleanTimes.slice(0, count) : defaultSettings.generationTimes,
    generationTime: (cleanTimes[0] || merged.generationTime || defaultSettings.generationTime),
    generationWeekdays: [...new Set(weekdays)].sort(),
    autoGenerationEnabled: Boolean(merged.autoGenerationEnabled),
  };
}

export async function getAdminSettings(): Promise<AdminSettings> {
  const result = await query<{ value: Partial<AdminSettings> }>('SELECT value FROM admin_settings WHERE key = $1', ['generation']);
  const value = result.rows[0]?.value;
  return normalizeSettings((typeof value === 'string' ? JSON.parse(value) : value) || {});
}

export async function updateAdminSettings(input: Partial<AdminSettings>): Promise<AdminSettings> {
  const next = normalizeSettings({ ...(await getAdminSettings()), ...input });
  await query(
    `INSERT INTO admin_settings (key, value) VALUES ('generation', $1)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = ${isSqlite ? "(strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z')" : 'now()'}`,
    [JSON.stringify(next)],
  );
  return next;
}
