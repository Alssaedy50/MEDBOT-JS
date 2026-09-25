/**
 * Telegram update -> handler-context adapter, and the polling loop.
 *
 * The adapter is the only place that knows about Telegram's update shape. It
 * normalises an update into the small context every handler expects (see
 * `./context.js`) and dispatches through the ordered router.
 *
 * Ordering matters and mirrors the Python `main()` registration sequence: the
 * isolated subsystems (news, admin management, settings, …) register their
 * callback namespaces BEFORE the general router, so a subsystem's callbacks
 * always win over the generic fallback.
 */

import { buildCallbackContext, buildMediaContext, buildMessageContext } from './context.js';
import { getCommandHandlers, routeCallback, routeMedia, routeText } from './router.js';

/** Per-user scratch space (workflow state). In-memory, like the Python bot. */
const userDataStore = new Map();

function userDataFor(userId) {
  if (!userDataStore.has(userId)) userDataStore.set(userId, {});
  return userDataStore.get(userId);
}

const COMMANDS = new Map([
  ['/start', 'start'],
  ['/cancel', 'cancel'],
  ['/help', 'help'],
  ['/quota', 'quota'],
  ['/whoami', 'whoami'],
  ['/search', 'search'],
  ['/ask', 'ask'],
  ['/contact', 'contact'],
]);

/** Normalise a raw Telegram update into the context shape handlers expect. */
export function buildContext(update, bot, options = {}) {
  const userData = options.userDataFor ?? userDataFor;

  if (update.callback_query) {
    const query = update.callback_query;
    return buildCallbackContext({
      from: query.from,
      data: query.data ?? '',
      bot,
      chatId: query.message?.chat?.id ?? query.from?.id,
      userData: userData(query.from?.id),
    });
  }

  if (update.message) {
    const message = update.message;

    // Commands are routed by their leading token.
    const text = String(message.text ?? '');
    const commandKey = text.split(' ')[0].split('@')[0].toLowerCase();

    if (COMMANDS.has(commandKey)) {
      const context = buildMessageContext({
        from: message.from,
        text,
        bot,
        chatId: message.chat?.id ?? message.from?.id,
        userData: userData(message.from?.id),
      });
      context.command = COMMANDS.get(commandKey);
      return context;
    }

    // A media message carries a document/photo/video/audio/voice.
    if (
      message.document ||
      message.photo ||
      message.video ||
      message.audio ||
      message.voice
    ) {
      return buildMediaContext({
        from: message.from,
        message,
        bot,
        chatId: message.chat?.id ?? message.from?.id,
        userData: userData(message.from?.id),
      });
    }

    return buildMessageContext({
      from: message.from,
      text,
      bot,
      chatId: message.chat?.id ?? message.from?.id,
      userData: userData(message.from?.id),
    });
  }

  return null;
}

/**
 * Dispatch one update.
 *
 * Callbacks go through the router (ordered), text through the text-handler
 * chain, then commands, then media. A command handler is looked up by name so
 * the UI modules stay free of Telegram plumbing.
 */
export async function dispatchUpdate(update, bot, options = {}) {
  const context = buildContext(update, bot, options);
  if (!context) return false;

  try {
    if (context.kind === 'callback') {
      return await routeCallback(context);
    }

    if (context.kind === 'media') {
      return await routeMedia(context);
    }

    // Commands first, then the workflow text handlers.
    if (context.command) {
      const handler = getCommandHandlers().get(context.command);
      if (handler) {
        await handler(context);
        return true;
      }
    }

    const consumed = await routeText(context);
    if (consumed) return true;

    // A plain message nothing claimed: fall through to the text catch-all.
    const textHandler = getCommandHandlers().get('text');
    if (textHandler) {
      await textHandler(context);
      return true;
    }
    return false;
  } catch (error) {
    if (options.onError) {
      options.onError(error, context);
    } else {
      console.error('Handler error:', error);
    }
    return false;
  }
}

/**
 * Long-polling loop.
 *
 * Runs until `shouldStop()` returns true. Transport errors back off
 * exponentially (capped) so a transient network failure cannot spin the loop.
 */
export async function pollUpdates(bot, options = {}) {
  const onError = options.onError ?? ((error) => console.error('Update error:', error));
  const shouldStop = options.shouldStop ?? (() => false);
  let offset = options.offset ?? 0;
  let backoff = 1;

  while (!shouldStop()) {
    let updates;
    try {
      updates = await bot.getUpdates(offset, 30);
      backoff = 1;
    } catch (error) {
      onError(error);
      await new Promise((resolve) => setTimeout(resolve, backoff * 1000));
      backoff = Math.min(backoff * 2, 30);
      continue;
    }

    for (const update of updates ?? []) {
      offset = Math.max(offset, (update.update_id ?? 0) + 1);
      await dispatchUpdate(update, bot, options);
    }
  }

  return offset;
}

/** Test hook: clear per-user scratch space between cases. */
export function resetUserData() {
  userDataStore.clear();
}

export { userDataFor };
