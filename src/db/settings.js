/**
 * Generic key/value settings, platform settings and feature visibility.
 *
 * All three live in the existing `settings` table, so no schema change is
 * needed and an unset key falls back to a sensible default (existing installs
 * keep working unchanged).
 */

import { get, run, withDb } from './core.js';
import {
  FEATURES,
  PLATFORM_SETTING_DEFAULTS,
  PLATFORM_SETTING_KEYS,
  SETTINGS_MAX_LENGTH,
  SETTING_HIDDEN_FEATURES,
} from '../constants.js';

export function getSetting(key, fallback = null) {
  const row = withDb((db) => get(db, 'SELECT value FROM settings WHERE key = ?', [key]));
  return row ? row[0] : fallback;
}

export function setSetting(key, value) {
  withDb((db) =>
    run(
      db,
      'INSERT INTO settings (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
    ),
  );
}

export function getAboutUs() {
  const row = withDb((db) => get(db, 'SELECT content FROM about_us WHERE id = 1'));
  return row ? row[0] : null;
}

export function setAboutUs(content) {
  withDb((db) =>
    run(
      db,
      'INSERT INTO about_us (id, content, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP) ' +
        'ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = CURRENT_TIMESTAMP',
      [content],
    ),
  );
}

// ---------------------------------------------------------------------------
// Platform settings
// ---------------------------------------------------------------------------

/**
 * Resolve a platform setting, falling back to the built-in default.
 *
 * Unconfigured installations (no row in `settings`) return the default, so
 * every existing install keeps working without a migration step.
 */
export function getPlatformSetting(key, fallback = null) {
  const defaultValue =
    fallback === null ? PLATFORM_SETTING_DEFAULTS[key] : fallback;
  let value;
  try {
    value = getSetting(key);
  } catch {
    return defaultValue;
  }
  if (value === null || value === undefined || !String(value).trim()) {
    return defaultValue;
  }
  return value;
}

/** All platform settings resolved to their effective values. */
export function getPlatformSettings() {
  const result = {};
  for (const key of PLATFORM_SETTING_KEYS) {
    result[key] = getPlatformSetting(key);
  }
  return result;
}

/** Persist one platform setting. Unknown keys are rejected. */
export function setPlatformSetting(key, value) {
  if (!PLATFORM_SETTING_KEYS.includes(key)) return false;
  const text = String(value ?? '').trim();
  if (!text || text.length > SETTINGS_MAX_LENGTH) return false;
  try {
    setSetting(key, text);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Navigation feature visibility
// ---------------------------------------------------------------------------

/**
 * Features currently hidden from users, as a `Set` of `FEATURES` keys.
 *
 * Stored as a comma-separated list in the existing `settings` table so no
 * schema change is needed; an unset key means "everything visible".
 */
export function getHiddenFeatures() {
  let raw;
  try {
    raw = getSetting(SETTING_HIDDEN_FEATURES);
  } catch {
    return new Set();
  }
  if (!raw) return new Set();
  return new Set(
    String(raw)
      .split(',')
      .map((part) => part.trim())
      .filter((part) => FEATURES.includes(part)),
  );
}

/** Persist the hidden-feature set (unknown keys are ignored). */
export function setHiddenFeatures(features) {
  try {
    const source = new Set(features ?? []);
    const cleaned = FEATURES.filter((key) => source.has(key));
    setSetting(SETTING_HIDDEN_FEATURES, cleaned.join(','));
    return true;
  } catch {
    return false;
  }
}

export function isFeatureHidden(feature) {
  if (!FEATURES.includes(feature)) return false;
  return getHiddenFeatures().has(feature);
}
