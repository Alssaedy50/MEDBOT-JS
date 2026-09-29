import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerHome, buildWorkerAccount } from '../src/telegram/workerHome.js';

function db() {
  const users = new Map();
  return {
    prepare(sql) {
      return {
        bind(..._params) {
          return {
            async run() { return { meta: { changes: 1, last_row_id: 1 } }; },
            raw: async () => {\n              if (sql.includes('FROM users')) return [['ar']];\n              if (sql.includes('FROM settings')) return [];\n              if (sql.includes('FROM admins')) return [];\n              if (sql.includes('FROM daily_ai_usage')) return [];\n              if (sql.includes('FROM news')) return [[0]];\n              if (sql.includes('FROM contributions')) return [[0]];\n              return [];\n            },\n            async first() {
              if (sql.includes('FROM users')) return ['ar'];
              if (sql.includes('FROM settings')) return null;
              if (sql.includes('FROM admins')) return null;
              if (sql.includes('FROM daily_ai_usage')) return null;
              if (sql.includes('FROM news')) return [0];
              if (sql.includes('FROM contributions')) return [0];
              return null;
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
    batch: async (items) => items.map(() => ({ meta: { changes: 1 } })),
    _users: users,
  };
}

test('Worker home is backed by D1 and preserves the public menu callbacks', async () => {
  const result = await buildWorkerHome(db(), { id: 100, first_name: 'Ali' });
  assert.match(result.text, /Ali/);
  const callbacks = result.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(callbacks.includes('resources'));
  assert.ok(callbacks.includes('account'));
});

test('Worker account is backed by D1 and includes the AI allowance', async () => {
  const result = await buildWorkerAccount(db(), { id: 100, first_name: 'Ali', username: 'ali' });
  assert.match(result.text, /25/);
  assert.ok(result.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'home'));
});
