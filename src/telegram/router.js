/**
 * Callback routing.
 *
 * The Python MEDBOT registered each isolated subsystem's own
 * `CallbackQueryHandler` *before* a catch-all `callback_router`, so a module's
 * callbacks always won over the generic router. This module keeps that shape
 * explicitly: a list of registered routes (prefix -> handler), tried in
 * registration order, then the catch-all. Registration order is therefore
 * meaningful and matches the Python `main()` registration sequence.
 */

const routes = [];
let catchAllHandler = null;
let textHandlers = [];
let mediaHandler = null;
let commandHandlers = new Map();

/**
 * Register a callback route.
 *
 * `prefixes` is a list of callback_data prefixes; a callback matches when it
 * equals the prefix or starts with `prefix:` / the prefix (so `news_open:5`
 * matches both `news` and `news_open:`).
 */
export function registerRoute({ name, prefixes, handler }) {
  routes.push({ name, prefixes: prefixes.map(String), handler });
}

/** Register the catch-all callback handler (always tried last). */
export function setCatchAll(handler) {
  catchAllHandler = handler;
}

/** Register a text handler. Handlers return true when they consumed the text. */
export function registerTextHandler(name, handler) {
  textHandlers.push({ name, handler });
}

/** Register the media handler (uploads / contributions). */
export function setMediaHandler(handler) {
  mediaHandler = handler;
}

/** Register a `/command` handler. */
export function registerCommand(name, handler) {
  commandHandlers.set(name, handler);
}

export function getCommandHandlers() {
  return commandHandlers;
}

function prefixMatches(data, prefix) {
  if (data === prefix) return true;
  if (data.startsWith(`${prefix}:`)) return true;
  // A registered prefix may itself carry the colon (e.g. "news_open:").
  if (prefix.endsWith(':') && data.startsWith(prefix)) return true;
  // A trailing underscore marks a family (e.g. "msg_", "admin_folder_").
  if (prefix.endsWith('_') && data.startsWith(prefix)) return true;
  return false;
}

/**
 * Route one callback context through the registered routes.
 *
 * Returns true when a route handled it. Unknown callbacks fall through to the
 * catch-all, which renders a safe "unknown action" message rather than
 * dead-ending the user.
 */
export async function routeCallback(context) {
  const data = context.data ?? '';

  for (const route of routes) {
    if (route.prefixes.some((prefix) => prefixMatches(data, prefix))) {
      await route.handler(context);
      return true;
    }
  }

  if (catchAllHandler) {
    await catchAllHandler(context);
    return true;
  }
  return false;
}

/** Give each registered text handler a chance to consume a typed message. */
export async function routeText(context) {
  for (const { handler } of textHandlers) {
    const consumed = await handler(context);
    if (consumed) return true;
  }
  return false;
}

export async function routeMedia(context) {
  if (!mediaHandler) return false;
  await mediaHandler(context);
  return true;
}

/** Clear every registration (test isolation). */
export function resetRouter() {
  routes.length = 0;
  catchAllHandler = null;
  textHandlers = [];
  mediaHandler = null;
  commandHandlers = new Map();
}

/** Introspection for tests: the registered route names, in order. */
export function registeredRoutes() {
  return routes.map((route) => ({ name: route.name, prefixes: route.prefixes }));
}
