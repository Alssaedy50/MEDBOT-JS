/**
 * Navigation visibility control (إظهار/إخفاء الأقسام/menus).
 *
 * Hiding a feature removes its button from the home page for regular users AND
 * blocks its callbacks, so a feature can be taken offline during a fault or an
 * update without a redeploy. Admins always keep their own entry point so they
 * can restore a hidden feature.
 *
 * The persisted state lives in the `settings` table, so no schema change is
 * involved.
 */

import * as db from './db/index.js';
import * as audit from './audit.js';
import { btn, keyboard } from './telegram/ui.js';

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function homeKeyboard() {
  return keyboard([[btn('🏠 الرئيسية', 'home')]]);
}

export function isAuthorized(userId) {
  try {
    return db.userHasPermission(userId, 'can_visibility');
  } catch {
    return false;
  }
}

function visibilityMenu(hidden) {
  const rows = [];
  for (const key of db.FEATURES) {
    const label = db.FEATURE_LABELS[key] ?? key;
    const mark = hidden.has(key) ? '🙈' : '👁';
    rows.push([btn(`${mark} ${label}`, `vis_toggle:${key}`)]);
  }
  rows.push([btn('✅ إظهار الكل', 'vis_showall')]);
  rows.push([btn('⬅️ إدارة المنصة', 'admin')]);
  rows.push([btn('🏠 الرئيسية', 'home')]);
  return keyboard(rows);
}

/** Admin screen: toggle each student-facing feature on or off. */
export async function showVisibility(ctx) {
  if (!isAuthorized(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  const hidden = db.getHiddenFeatures();
  const lines = [
    '🙈 <b>إظهار وإخفاء الأقسام</b>',
    '',
    'اختر أي قسم لإخفائه عن المستخدمين أو إظهاره.',
    'إخفاء القسم يزيل زرّه من الصفحة الرئيسية ويمنع الوصول إليه فوراً — دون الحاجة إلى إعادة تشغيل البوت.',
    '',
    `👁 الظاهرة: ${db.FEATURES.length - hidden.size} | 🙈 المخفية: ${hidden.size}`,
  ];

  await ctx.editMessageText(lines.join('\n'), { reply_markup: visibilityMenu(hidden) });
}

/** Flip one feature's visibility and re-render the menu. */
export async function toggleFeature(ctx, feature) {
  if (!isAuthorized(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  if (!db.FEATURES.includes(feature)) {
    await ctx.editMessageText('⚠️ قسم غير معروف.', {
      reply_markup: keyboard([[btn('⬅️ إظهار وإخفاء الأقسام', 'vis_list')]]),
    });
    return;
  }

  const hidden = db.getHiddenFeatures();
  let action;
  if (hidden.has(feature)) {
    hidden.delete(feature);
    action = 'show';
  } else {
    hidden.add(feature);
    action = 'hide';
  }

  if (db.setHiddenFeatures(hidden)) {
    await audit.logAction(ctx.from.id, 'feature_visibility', {
      targetType: 'feature',
      targetId: feature,
      details: action,
    });
  }

  await showVisibility(ctx);
}

/** Restore every feature at once (the recovery path after an update). */
export async function showAllFeatures(ctx) {
  if (!isAuthorized(ctx.from.id)) {
    await ctx.editMessageText('🔒 غير مصرح.', { reply_markup: homeKeyboard() });
    return;
  }

  if (db.setHiddenFeatures(new Set())) {
    await audit.logAction(ctx.from.id, 'feature_visibility', {
      targetType: 'feature',
      targetId: 'all',
      details: 'show',
    });
  }

  await showVisibility(ctx);
}

/** Callback handler for the visibility namespace. */
export async function visibilityCallbackHandler(ctx) {
  await ctx.answer();
  const data = ctx.data ?? '';

  if (data === 'vis_list') return showVisibility(ctx);
  if (data === 'vis_showall') return showAllFeatures(ctx);
  if (data.startsWith('vis_toggle:')) {
    return toggleFeature(ctx, data.split(':')[1]);
  }

  await ctx.editMessageText('⚠️ إجراء غير معروف.', { reply_markup: homeKeyboard() });
  return undefined;
}

export const VISIBILITY_PREFIXES = ['vis_list', 'vis_showall', 'vis_toggle:'];
