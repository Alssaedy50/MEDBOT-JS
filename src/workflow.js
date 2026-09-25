/**
 * Single-owner workflow state for MEDBOT.
 *
 * Several admin/student flows wait for a typed message (a section name, a
 * rejection reason, a notification body, ...). When two flows overlapped,
 * whichever text handler sat earliest consumed the text for the stale flow.
 *
 * The fix is one marker of the currently active workflow. Starting a flow
 * cancels every other flow's pending keys and claims the marker; a text
 * consumer may only take the message when it owns the marker (or when no flow
 * is active, which keeps direct/legacy calls working). A message is therefore
 * consumed by exactly the workflow the user is actually in.
 *
 * Keys are grouped per workflow because a flow may use more than one key.
 * Re-entering the same flow is idempotent.
 */

export const ACTIVE_KEY = 'active_workflow';

// Each workflow -> the user_data keys it owns while active.
export const WORKFLOWS = Object.freeze({
  admin_upload: [
    'admin_upload',
    'admin_upload_folder',
    'admin_upload_preview',
    'admin_upload_waiting_title',
    'admin_upload_title',
  ],
  admin_file_rename: [
    'admin_file_rename',
    'admin_file_rename_id',
    'admin_file_rename_waiting',
  ],
  admin_folder_create: [
    'admin_folder_create',
    'admin_folder_parent',
    'admin_folder_name',
    'admin_folder_type',
  ],
  admin_folder_rename: ['admin_folder_rename', 'admin_folder_rename_id'],
  admin_folder_move: ['admin_folder_move', 'admin_folder_move_id'],
  admin_file_move: ['admin_file_move', 'admin_file_move_id'],
  admin_folder_retype: ['admin_folder_retype_id'],
  review_note: ['review_note_kind', 'review_note_id'],
  contact_message: ['contact_category'],
  admin_reply: ['contact_reply_id'],
  admin_add: ['admin_mgmt_waiting_add'],
  settings_edit: ['settings_edit_key'],
  topics_create: ['topics_create'],
  topics_link: ['topics_link_id'],
  notification_body: ['notifications_body'],
  news_draft: [
    'news_new_type',
    'news_new_step',
    'news_new_title',
    'news_new_body',
    'news_new_doctor',
    'news_new_event',
    'news_new_section',
    'news_new_resource',
  ],
  contrib_upload: [
    'contrib_folder',
    'contrib_state',
    'contrib_file_id',
    'contrib_file_type',
    'contrib_resubmit_id',
    'contrib_resubmit_file_id',
    'contrib_resubmit_file_type',
  ],
  ai_chat: ['ai_mode'],
});

/**
 * Make `name` the single active workflow, cancelling any other.
 *
 * The other workflows' keys are removed, so their text consumers can no longer
 * accidentally consume input meant for the new flow.
 */
export function begin(context, name) {
  if (!(name in WORKFLOWS)) return;

  for (const [other, keys] of Object.entries(WORKFLOWS)) {
    if (other === name) continue;
    for (const key of keys) delete context.userData[key];
  }

  context.userData[ACTIVE_KEY] = name;
}

/**
 * True when `name` may consume the pending message.
 *
 * When no workflow is marked active (a direct handler call, or a flow armed
 * before this registry existed), ownership is not contested and the caller's
 * own state check decides.
 */
export function owns(context, name) {
  const active = context.userData[ACTIVE_KEY];
  return active === undefined || active === null || active === name;
}

/** Clear the active workflow and its own pending keys. */
export function clear(context) {
  const name = context.userData[ACTIVE_KEY];
  delete context.userData[ACTIVE_KEY];
  for (const key of WORKFLOWS[name] ?? []) delete context.userData[key];
}

/** Clear every workflow's pending keys and the marker. */
export function clearAll(context) {
  delete context.userData[ACTIVE_KEY];
  for (const keys of Object.values(WORKFLOWS)) {
    for (const key of keys) delete context.userData[key];
  }
}
