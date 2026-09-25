/**
 * Central scoped authorization service (Phase 3 — Scoped RBAC).
 *
 * This is the ONLY place that combines a *capability* (does this admin hold the
 * coarse permission at all?) with a *scope* (is the target inside the branch
 * they are responsible for?). Handlers never re-implement that decision; they
 * call `can()` (or `require()`) and act on the boolean.
 *
 * Model:
 *   Owner / Super Admin -> full access, every scope.
 *   Admin               -> a set of permissions; optionally restricted to a set
 *                          of scopes (subject / folder / resource).
 *   Default             -> DENY.
 *
 * Decision order for `can(userId, permission, targetType, targetId)`:
 *   1. Is the actor an active admin?                 no -> DENY
 *   2. Is the operation a known scoped permission?   no -> DENY
 *   3. Does the actor's role clear the coarse key?   no -> DENY
 *      (owner always clears it; a legacy admin with empty permissions keeps
 *      full access exactly as before this phase)
 *   4. Is the actor scope-restricted?
 *        - no scope rows -> platform-wide, handled like (3) -> ALLOW
 *        - has scope rows -> ALLOW only if the target resolves inside a scope;
 *          no target, unknown target, deleted target -> DENY (fail-closed)
 *
 * The scope layer is *opt-in*: an admin with no scope rows keeps the
 * pre-Phase-3 platform-wide reach, so installing this phase revokes nothing.
 *
 * Scope semantics (targetType -> tester):
 *   folder       -> target folder is at/beneath a folder scope, or inside a
 *                   topic scope's linked folders
 *   topic        -> the admin holds a `topic` scope on this exact topic
 *   resource     -> the resource is named by a `resource` scope, or its real
 *                   folder falls inside a folder/topic scope
 *   news         -> any real folder the item references falls inside a scope
 *   contribution -> the contribution's destination folder falls inside a scope
 *   (none/global)-> never inside a scope (so a scoped admin cannot broadcast
 *                   globally); only an unscoped admin or the owner may.
 */

import * as db from './db/index.js';

// Outcome codes for `require()` so callers can distinguish a missing capability
// (surface hidden) from an out-of-scope target (surface shown, action denied).
export const DECISION_ALLOW = 'allow';
export const DECISION_NO_PERMISSION = 'no_permission';
export const DECISION_OUT_OF_SCOPE = 'out_of_scope';
export const DECISION_NOT_ADMIN = 'not_admin';
export const DECISION_UNKNOWN = 'unknown_permission';

function toInt(value) {
  if (value === null || value === undefined || value === true || value === false) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Active admin (owner / admin / reviewer) — the coarse gate. */
export function isAdmin(userId) {
  try {
    return db.isUserAdmin(userId);
  } catch {
    return false;
  }
}

export function isOwner(userId) {
  try {
    return db.isOwner(userId);
  } catch {
    return false;
  }
}

/** True when (targetType, targetId) resolves inside the admin's scopes. */
function targetInScope(adminId, targetType, targetId) {
  if (!targetType) return false;

  switch (targetType) {
    case 'folder':
      return db.folderInAdminScope(adminId, targetId);
    case 'topic':
      return db.isTopicInAdminScope(adminId, targetId);
    case 'resource':
      return db.resourceInAdminScope(adminId, targetId);
    case 'news': {
      // Any real folder the item references inside a folder/topic scope allows
      // it; otherwise its referenced resource may be a direct resource scope.
      const folders = db.newsScopeFolderIds(targetId);
      for (const folderId of folders) {
        if (db.folderInAdminScope(adminId, folderId)) return true;
      }
      const resourceId = db.newsResourceId(targetId);
      if (resourceId !== null) {
        return db.resourceInAdminScope(adminId, resourceId);
      }
      return false;
    }
    case 'contribution': {
      const folderId = db.contributionFolderId(targetId);
      if (folderId === null) return false;
      return db.folderInAdminScope(adminId, folderId);
    }
    default:
      // Unknown/global target: never inside a scope (fail-closed).
      return false;
  }
}

/**
 * The single authorization predicate. Deny-by-default.
 *
 * See the module docstring for the decision order. Never throws.
 */
export function can(userId, permission, targetType = null, targetId = null) {
  try {
    if (!db.SCOPED_PERMISSIONS.includes(permission)) return false;

    const record = db.getAdminRecord(userId);
    if (!record || record.role === null || record.role === 'none') return false;
    if (record.role === 'owner') return true;

    const coarse = db.SCOPED_PERMISSION_COARSE[permission];
    if (!coarse) return false;
    if (!record.permissions[coarse]) return false;

    // Scope restriction is opt-in: no rows means platform-wide.
    if (!db.adminHasScopes(userId)) return true;

    return targetInScope(toInt(userId), targetType, targetId);
  } catch {
    return false;
  }
}

/** Audit a denial. Best-effort: never throws into the caller. */
async function auditDenial(userId, permission, targetType, targetId, decision) {
  try {
    const audit = await import('./audit.js');
    await audit.logAction(userId, 'authz_denied', {
      targetType,
      targetId,
      details: `permission=${permission};decision=${decision}`,
    });
  } catch {
    // Auditing is best-effort.
  }
}

/**
 * Like `can`, but returns a DECISION_* code and audits a denial.
 *
 * Callers that render a screen use this to show the right message (hidden
 * capability vs. out-of-scope target). Auditing never raises into the caller.
 */
export async function require(userId, permission, targetType = null, targetId = null) {
  if (!db.SCOPED_PERMISSIONS.includes(permission)) return DECISION_UNKNOWN;

  let record = null;
  try {
    record = db.getAdminRecord(userId);
  } catch {
    record = null;
  }

  if (!record || record.role === null || record.role === 'none') {
    await auditDenial(userId, permission, targetType, targetId, DECISION_NOT_ADMIN);
    return DECISION_NOT_ADMIN;
  }

  if (record.role === 'owner') return DECISION_ALLOW;

  const coarse = db.SCOPED_PERMISSION_COARSE[permission];
  if (!coarse || !record.permissions[coarse]) {
    await auditDenial(userId, permission, targetType, targetId, DECISION_NO_PERMISSION);
    return DECISION_NO_PERMISSION;
  }

  try {
    if (!db.adminHasScopes(userId)) return DECISION_ALLOW;
    if (targetInScope(toInt(userId), targetType, targetId)) return DECISION_ALLOW;
  } catch {
    // Fall through to the out-of-scope denial.
  }

  await auditDenial(userId, permission, targetType, targetId, DECISION_OUT_OF_SCOPE);
  return DECISION_OUT_OF_SCOPE;
}

export function decisionAllowed(decision) {
  return decision === DECISION_ALLOW;
}

// ---------------------------------------------------------------------------
// Convenience wrappers for the common call sites (no logic duplicated here —
// each is a thin `can` with the declared coarse capability + target).
// ---------------------------------------------------------------------------

/** `action` in {'view','create','edit','delete'} against a content row. */
export function canManageResource(userId, action, contentId) {
  return can(userId, `resource.${action}`, 'resource', contentId);
}

export function canCreateResourceInFolder(userId, folderId) {
  return can(userId, 'resource.create', 'folder', folderId);
}

export function canManageSection(userId, folderId) {
  return can(userId, 'section.manage', 'folder', folderId);
}

/** `action` in {'view','edit','publish','archive'} against a news row. */
export function canManageNews(userId, action, newsId) {
  return can(userId, `news.${action}`, 'news', newsId);
}

export function canCreateNewsInFolder(userId, folderId) {
  return can(userId, 'news.create', 'folder', folderId);
}

export function canReviewContribution(userId, contributionId) {
  return can(userId, 'contribution.review', 'contribution', contributionId);
}

/** Global broadcast has no folder target, so any scope restriction denies. */
export function canSendNotification(userId) {
  return can(userId, 'notification.send');
}

export function canManageAiRegistry(userId, topicId = null) {
  return can(userId, 'ai_registry.manage', 'topic', topicId);
}

// ---------------------------------------------------------------------------
// List filtering helpers for admin surfaces
// ---------------------------------------------------------------------------

/**
 * Subtree folder ids the admin may see, or null when unrestricted.
 *
 * null means "platform-wide" (owner / unscoped admin); callers treat it as "no
 * filter". An empty set means "restricted but no reachable folder".
 */
export function scopedFolderIds(userId) {
  try {
    if (db.isOwner(userId)) return null;
    if (!db.adminHasScopes(userId)) return null;
    const roots = db.topicFolderRoots(userId);
    return db.listFolderIdsUnder(roots);
  } catch {
    return new Set();
  }
}

/**
 * True when the admin is constrained by at least one scope (Phase 3).
 *
 * The owner is never restricted.
 */
export function isScopeRestricted(userId) {
  try {
    return db.adminHasScopes(userId) && !db.isOwner(userId);
  } catch {
    return false;
  }
}
