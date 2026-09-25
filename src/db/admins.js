/**
 * Admin identity, RBAC (roles + capabilities) and ownership.
 *
 * Roles live in `admins.role`; capabilities in the comma-separated
 * `admins.permissions` column. An EMPTY permissions column means "legacy row,
 * full access"; an explicitly revoked admin is stored as the `none` sentinel.
 *
 * Exactly one owner is a hard invariant. The UI never mints a second owner:
 * ownership moves only through `transferOwnership`, which swaps the two roles
 * atomically.
 */

import { get, run, withDb, withTransaction } from './core.js';
import {
  ADMIN_ROLES,
  PERMISSION_KEYS,
  ROLE_ASSIGNABLE,
  ROLE_PERMISSION_PRESETS,
  SETTING_CONFIGURED_ADMIN,
  SETTING_OWNER_ID,
  defaultPermissions,
  permissionsFromString,
  permissionsToString,
} from '../constants.js';
import { getSetting, setSetting } from './settings.js';

/** Owner count inside an existing connection. */
function ownerCount(db) {
  const row = get(db, "SELECT COUNT(*) FROM admins WHERE role = 'owner'");
  return row ? row[0] : 0;
}

/** Admin row as an RBAC dict, or null when the user is not an admin. */
export function getAdminRecord(userId) {
  let row;
  try {
    row = withDb((db) =>
      get(
        db,
        'SELECT telegram_id, username, added_at, role, permissions FROM admins WHERE telegram_id = ?',
        [userId],
      ),
    );
  } catch {
    return null;
  }
  if (!row) return null;
  return {
    telegram_id: row[0],
    username: row[1],
    added_at: row[2],
    role: row[3] || 'admin',
    permissions_raw: row[4],
    permissions: permissionsFromString(row[4]),
  };
}

/** Resolved permission map; all-false when not an active admin. */
export function getAdminPermissions(userId) {
  const record = getAdminRecord(userId);
  if (!record || record.role === 'none') {
    return Object.fromEntries(PERMISSION_KEYS.map((key) => [key, false]));
  }
  if (record.role === 'owner') return defaultPermissions();
  return record.permissions;
}

/**
 * Add (or refresh) an admin identity row.
 *
 * Mirrors the Python `INSERT OR REPLACE`; callers that must not clobber an
 * existing role (notably the owner) check first.
 */
export function addSubAdmin(telegramId, username = null) {
  try {
    return withDb((db) => {
      run(db, 'INSERT OR REPLACE INTO admins (telegram_id, username) VALUES (?, ?)', [
        telegramId,
        username,
      ]);
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Revoke an admin's access without deleting the row.
 *
 * The row (and its username) is kept and the role is set to 'none'. The sole
 * owner can never be revoked this way.
 */
export function removeSubAdmin(telegramId) {
  try {
    return withDb((db) => {
      const row = get(db, 'SELECT role FROM admins WHERE telegram_id = ?', [telegramId]);
      if (!row) return false;
      if (row[0] === 'owner' && ownerCount(db) <= 1) return false;
      run(db, "UPDATE admins SET role = 'none' WHERE telegram_id = ?", [telegramId]);
      return true;
    });
  } catch {
    return false;
  }
}

/** True when the account used to be an admin but was revoked. */
export function adminAccessDenied(telegramId) {
  if (!telegramId || Number(telegramId) <= 0) return false;
  let row;
  try {
    row = withDb((db) =>
      get(db, 'SELECT role FROM admins WHERE telegram_id = ?', [
        Number.parseInt(telegramId, 10),
      ]),
    );
  } catch {
    return false;
  }
  return Boolean(row) && row[0] === 'none';
}

/** Admin rows as RBAC dicts, including revoked ('none') rows. */
export function getAdminsFullRecords() {
  let ids;
  try {
    ids = withDb((db) =>
      db
        .prepare('SELECT telegram_id FROM admins ORDER BY added_at ASC')
        .all()
        .map((row) => row[0]),
    );
  } catch {
    return [];
  }
  const records = [];
  for (const telegramId of ids) {
    const record = getAdminRecord(telegramId);
    if (record) records.push(record);
  }
  return records;
}

/** Active admins only (revoked 'none' rows are excluded). */
export function getAllAdmins() {
  return withDb((db) =>
    db
      .prepare(
        "SELECT telegram_id, username, added_at FROM admins " +
          "WHERE role IS NULL OR role != 'none' ORDER BY added_at ASC",
      )
      .all(),
  );
}

/**
 * Active admins holding `permission`.
 *
 * Uses the same resolution as `userHasPermission`: the owner always passes, a
 * legacy empty-permission row keeps full access, and a 'none' role never
 * qualifies. This routes admin notifications to admins who can act on them.
 */
export function getAdminsWithPermission(permission) {
  if (!PERMISSION_KEYS.includes(permission)) return [];

  const rows = withDb((db) =>
    db
      .prepare(
        'SELECT telegram_id, username, added_at, role, permissions FROM admins ' +
          "WHERE role IS NULL OR role != 'none' ORDER BY added_at ASC",
      )
      .all(),
  );

  const allowed = [];
  for (const row of rows) {
    const role = row[3] || 'admin';
    if (role === 'owner') {
      allowed.push([row[0], row[1], row[2]]);
      continue;
    }
    if (permissionsFromString(row[4])[permission]) {
      allowed.push([row[0], row[1], row[2]]);
    }
  }
  return allowed;
}

/** True when the user is an active admin (role owner/admin/reviewer). */
export function isUserAdmin(telegramId) {
  const row = withDb((db) =>
    get(db, 'SELECT role FROM admins WHERE telegram_id = ?', [telegramId]),
  );
  if (!row) return false;
  const role = row[0];
  if (role === null || role === undefined) return true;
  return ADMIN_ROLES.includes(role);
}

/** True only for the account holding the owner role. */
export function isOwner(userId) {
  if (!userId || Number(userId) <= 0) return false;
  const record = getAdminRecord(userId);
  return Boolean(record) && record.role === 'owner';
}

/**
 * Capability check. Owner: always. Non-admin: never.
 *
 * An admin whose stored permissions are empty (pre-migration rows) keeps full
 * access, so enabling RBAC does not revoke anything that already worked. A
 * revoked ('none') role never holds a permission.
 */
export function userHasPermission(userId, permission) {
  if (!PERMISSION_KEYS.includes(permission)) return false;
  const record = getAdminRecord(userId);
  if (!record || record.role === 'none') return false;
  if (record.role === 'owner') return true;
  return Boolean(record.permissions[permission]);
}

/**
 * Set an admin's role. Unknown roles are rejected (no write).
 *
 * The configured owner is pinned: demoting the only owner is refused. The UI
 * never calls this with `owner`; that transition is reserved for
 * `transferOwnership`.
 */
export function setAdminRole(userId, role) {
  if (!ADMIN_ROLES.concat('none').includes(role)) return false;
  try {
    return withDb((db) => {
      if (role !== 'owner') {
        const row = get(db, 'SELECT role FROM admins WHERE telegram_id = ?', [userId]);
        if (row && row[0] === 'owner' && ownerCount(db) <= 1) return false;
      }
      return (
        run(db, 'UPDATE admins SET role = ? WHERE telegram_id = ?', [role, userId])
          .changes > 0
      );
    });
  } catch {
    return false;
  }
}

/** Persist a permission map. Keys outside PERMISSION_KEYS are ignored. */
export function updateAdminPermissions(userId, permissions) {
  if (!permissions || typeof permissions !== 'object') return false;
  const cleaned = Object.fromEntries(
    PERMISSION_KEYS.map((key) => [key, Boolean(permissions[key])]),
  );
  try {
    return withDb(
      (db) =>
        run(db, 'UPDATE admins SET permissions = ? WHERE telegram_id = ?', [
          permissionsToString(cleaned),
          userId,
        ]).changes > 0,
    );
  } catch {
    return false;
  }
}

/**
 * Persist the role and its baseline permission preset together.
 *
 * Choosing a role from the UI gives it a well-defined scope; the owner can
 * still adjust individual toggles afterwards. Only assignable roles are
 * accepted here — `owner` is reached through `transferOwnership`.
 */
export function applyRolePreset(userId, role) {
  if (!ROLE_ASSIGNABLE.includes(role)) return false;
  if (!setAdminRole(userId, role)) return false;
  return updateAdminPermissions(userId, { ...ROLE_PERMISSION_PRESETS[role] });
}

/** Demote every admin holding 'owner' except `ownerId` to 'admin'. */
export function demoteStaleOwners(ownerId) {
  withDb((db) =>
    run(
      db,
      "UPDATE admins SET role = 'admin', permissions = ? WHERE role = 'owner' AND telegram_id != ?",
      [permissionsToString({ ...ROLE_PERMISSION_PRESETS.admin }), ownerId],
    ),
  );
}

/** Return the persisted owner id (0 when unset/invalid). */
export function getPersistedOwnerId() {
  let raw;
  try {
    raw = getSetting(SETTING_OWNER_ID);
  } catch {
    return 0;
  }
  const value = Number.parseInt(String(raw ?? '').trim(), 10);
  if (Number.isNaN(value) || value <= 0) return 0;
  return value;
}

/**
 * Grant admin to the explicitly configured owner ID, idempotently.
 *
 * Passing `telegramId <= 0` is a no-op so a missing ADMIN_ID never grants
 * privileges to an arbitrary (or the first) user.
 *
 * A persisted owner id (set by an explicit ownership transfer) takes
 * precedence for a restart with the *same* ADMIN_ID: the transfer must not be
 * silently reverted. A genuine ADMIN_ID change still re-asserts the newly
 * configured owner.
 */
export function ensureConfiguredAdmin(telegramId, username = null) {
  if (!telegramId || Number(telegramId) <= 0) return false;

  const id = Number.parseInt(telegramId, 10);
  const persistedOwner = getPersistedOwnerId();

  let lastConfigured = 0;
  try {
    lastConfigured = Number.parseInt(String(getSetting(SETTING_CONFIGURED_ADMIN) ?? '').trim(), 10);
    if (Number.isNaN(lastConfigured)) lastConfigured = 0;
  } catch {
    lastConfigured = 0;
  }

  if (persistedOwner && persistedOwner !== id && lastConfigured === id) {
    if (!isUserAdmin(id)) addSubAdmin(id, username);
    return true;
  }

  if (!addSubAdmin(id, username)) return false;

  try {
    demoteStaleOwners(id);
    setAdminRole(id, 'owner');
    updateAdminPermissions(id, defaultPermissions());
    setSetting(SETTING_OWNER_ID, String(id));
    setSetting(SETTING_CONFIGURED_ADMIN, String(id));
  } catch {
    // Best-effort, exactly like the Python implementation.
  }
  return true;
}

/**
 * Atomically transfer ownership from the current owner to another admin.
 *
 * Guarantees a valid owner at all times: only the active owner may transfer,
 * the target must be an existing active admin, the target cannot already be the
 * owner, and the previous owner is demoted to `admin` with the admin baseline.
 * Persists the new owner id so a restart cannot silently revert it.
 *
 * Returns `[ok, message]`.
 */
export function transferOwnership(currentOwnerId, newOwnerId) {
  try {
    return withTransaction((db) => {
      if (!currentOwnerId || !newOwnerId) return [false, 'معرّف غير صالح.'];
      if (Number(currentOwnerId) === Number(newOwnerId)) {
        return [false, 'لا يمكن نقل الملكية إلى المالك الحالي.'];
      }

      const actor = get(db, 'SELECT role FROM admins WHERE telegram_id = ?', [
        Number(currentOwnerId),
      ]);
      if (!actor || actor[0] !== 'owner') {
        return [false, 'نقل الملكية متاح للمالك الحالي فقط.'];
      }

      const target = get(db, 'SELECT role FROM admins WHERE telegram_id = ?', [
        Number(newOwnerId),
      ]);
      if (!target || !ADMIN_ROLES.includes(target[0])) {
        return [false, 'الحساب الهدف ليس مشرفاً نشطاً.'];
      }
      if (target[0] === 'owner') return [false, 'هذا الحساب هو المالك بالفعل.'];

      const ownerPerms = permissionsToString({ ...ROLE_PERMISSION_PRESETS.owner });
      const prevOwnerPerms = permissionsToString({ ...ROLE_PERMISSION_PRESETS.admin });

      run(db, "UPDATE admins SET role = 'owner', permissions = ? WHERE telegram_id = ?", [
        ownerPerms,
        Number(newOwnerId),
      ]);
      run(db, "UPDATE admins SET role = 'admin', permissions = ? WHERE telegram_id = ?", [
        prevOwnerPerms,
        Number(currentOwnerId),
      ]);
      run(
        db,
        "UPDATE admins SET role = 'admin' WHERE role = 'owner' AND telegram_id NOT IN (?, ?)",
        [Number(newOwnerId), Number(currentOwnerId)],
      );
      run(
        db,
        'INSERT INTO settings (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [SETTING_OWNER_ID, String(Number(newOwnerId))],
      );

      return [true, 'تم نقل الملكية بنجاح.'];
    });
  } catch {
    return [false, 'تعذّر نقل الملكية.'];
  }
}
