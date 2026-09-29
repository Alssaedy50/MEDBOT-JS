/** Worker-safe Telegram context; no Node or SQLite imports. */
export function buildWorkerContext({ update, bot = null, db = null, userData = {} }) {
  const q = update?.callback_query;
  const m = update?.message;
  const from = q?.from ?? m?.from ?? null;
  const chatId = q?.message?.chat?.id ?? m?.chat?.id ?? from?.id ?? null;
  return {
    kind: q ? 'callback' : (m ? 'message' : 'unknown'),
    from: from ? { id: from.id, username: from.username ?? null, first_name: from.first_name ?? null, last_name: from.last_name ?? null } : null,
    data: q?.data ?? null, text: m?.text ?? m?.caption ?? '', message: m ?? null,
    chatId, userData, bot, db, callbackQueryId: q?.id ?? null, messageId: q?.message?.message_id ?? null,
    async answer(options = {}) { if (this.bot?.answerCallbackQuery && this.callbackQueryId) return this.bot.answerCallbackQuery(this.callbackQueryId, options); return null; },
    async reply(text, options = {}) { if (this.bot?.sendMessage) return this.bot.sendMessage(this.chatId, text, options); return null; },
    async editMessageText(text, options = {}) { if (this.bot?.editMessageText) return this.bot.editMessageText(text, { ...options, chat_id: this.chatId, message_id: options.message_id ?? this.messageId }); return null; },
    getBot() { if (!this.bot) throw new Error('Worker Telegram bot transport is not configured.'); return this.bot; },
  };
}

export function workerUpdateKind(update) {
  if (update?.callback_query) return 'callback';
  if (update?.message) return 'message';
  return null;
}
