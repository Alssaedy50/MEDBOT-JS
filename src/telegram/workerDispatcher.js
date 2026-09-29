import { buildWorkerContext } from './workerContext.js';

/**
 * Worker domain dispatcher boundary.
 *
 * Handlers are injected rather than imported, preventing Node/SQLite modules
 * from entering the Worker bundle. This is the seam used to port MEDBOT
 * workflows one subsystem at a time.
 */
export function createWorkerTelegramDispatcher({ bot, db, handlers = {}, userData = new Map() }) {
  return async function dispatch(update) {
    const fromId = update?.callback_query?.from?.id ?? update?.message?.from?.id;
    const scratch = fromId == null ? {} : (userData.get(fromId) ?? {});
    if (fromId != null) userData.set(fromId, scratch);

    const context = buildWorkerContext({ update, bot, db, userData: scratch });
    const handler = context.kind === 'callback'
      ? handlers.callback
      : context.kind === 'message'
        ? (String(context.text).startsWith('/') ? handlers.command : handlers.message)
        : null;

    if (typeof handler !== 'function') {
      throw new Error('worker_telegram_handler_not_migrated');
    }

    await handler(context);
  };
}
