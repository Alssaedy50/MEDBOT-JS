import test from 'node:test';
import assert from 'node:assert/strict';

import * as users from '../src/db/d1/users.js';
import * as registry from '../src/db/d1/registry.js';

function mockD1() {
  const state = {
    users: new Map(),
    usage: new Map(),
    folders: new Map([
      [1, [1, null, 'Second Year', 'year', 0]],
      [2, [2, 1, 'MSK', 'block', 1]],
    ]),
    content: new Map([
      [7, [7, 2, 'Muscle Physiology', 'tg-file', 'document', 'direct', null, 10]],
    ]),
    nextFolder: 3,
    nextContent: 8,
  };

  function result(sql, params) {
    if (/INSERT OR IGNORE INTO users/i.test(sql)) {
      const id = Number(params[0]);
      if (!state.users.has(id)) state.users.set(id, [id, params[1], params[2], null]);
      return { changes: 1, last_row_id: id };
    }
    if (/UPDATE users SET username/i.test(sql)) {
      const id = Number(params[2]);
      const row = state.users.get(id);
      if (!row) return { changes: 0, last_row_id: 0 };
      row[1] = params[0]; row[2] = params[1];
      return { changes: 1, last_row_id: 0 };
    }
    if (/UPDATE users SET language/i.test(sql)) {
      const id = Number(params[1]);
      const row = state.users.get(id);
      if (!row) return { changes: 0, last_row_id: 0 };
      row[3] = params[0];
      return { changes: 1, last_row_id: 0 };
    }
    if (/INSERT INTO daily_ai_usage/i.test(sql)) {
      const key = String(params[0]) + ':' + params[1];
      const row = state.usage.get(key);
      if (!row) { state.usage.set(key, [params[0], params[1], 1]); return { changes: 1, last_row_id: 0 }; }
      if (row[2] >= Number(params[2])) return { changes: 0, last_row_id: 0 };
      row[2] += 1;
      return { changes: 1, last_row_id: 0 };
    }
    if (/INSERT INTO folders/i.test(sql)) {
      const id = state.nextFolder++;
      state.folders.set(id, [id, params[0], params[1], params[2], params[3]]);
      return { changes: 1, last_row_id: id };
    }
    if (/UPDATE folders SET name/i.test(sql)) {
      const row = state.folders.get(Number(params[1]));
      if (!row) return { changes: 0, last_row_id: 0 };
      row[2] = params[0]; return { changes: 1, last_row_id: 0 };
    }
    if (/UPDATE folders SET node_type/i.test(sql)) {
      const row = state.folders.get(Number(params[1]));
      if (!row) return { changes: 0, last_row_id: 0 };
      row[3] = params[0]; return { changes: 1, last_row_id: 0 };
    }
    if (/UPDATE folders SET accepts_contributions/i.test(sql)) {
      const row = state.folders.get(Number(params[1]));
      if (!row) return { changes: 0, last_row_id: 0 };
      row[4] = params[0]; return { changes: 1, last_row_id: 0 };
    }
    if (/INSERT INTO content/i.test(sql)) {
      const id = state.nextContent++;
      state.content.set(id, [id, ...params]);
      return { changes: 1, last_row_id: id };
    }
    if (/UPDATE content SET title/i.test(sql)) {
      const row = state.content.get(Number(params[1]));
      if (!row) return { changes: 0, last_row_id: 0 };
      row[2] = params[0]; return { changes: 1, last_row_id: 0 };
    }
    if (/DELETE FROM content/i.test(sql)) {
      return { changes: state.content.delete(Number(params[0])) ? 1 : 0, last_row_id: 0 };
    }
    return { changes: 0, last_row_id: 0 };
  }

  const db = {
    prepare(sql) {
      return {
        sql,
        params: [],
        bind(...params) {
          this.params = params;
          return this;
        },
        async raw() {
          const p = this.params ?? [];
          if (/SELECT language FROM users/i.test(sql)) {
            const row = state.users.get(Number(p[0]));
            return row ? [[row[3]]] : [];
          }
          if (/SELECT user_id FROM users/i.test(sql)) return [...state.users.values()].map((r) => [r[0]]);
          if (/SELECT user_id, language FROM users/i.test(sql)) return [...state.users.values()].map((r) => [r[0], r[3]]);
          if (/SELECT request_count FROM daily_ai_usage/i.test(sql)) {
            const row = state.usage.get(String(p[0]) + ':' + p[1]);
            return row ? [[row[2]]] : [];
          }
          if (/SELECT id, parent_id, name FROM folders/i.test(sql)) return [...state.folders.values()];
          if (/SELECT id, name, node_type, accepts_contributions FROM folders/i.test(sql)) {
            const parent = p.length ? p[0] : null;
            return [...state.folders.values()]
              .filter((r) => parent === null ? r[1] === null : r[1] === parent)
              .map((r) => [r[0], r[2], r[3], r[4]]);
          }
          if (/SELECT id, title, file_id, file_type, source_type/i.test(sql)) {
            return [...state.content.values()]
              .filter((r) => r[1] === p[0])
              .map((r) => [r[0], r[2], r[3], r[4], r[5], r[6], r[7]]);
          }
          if (/SELECT id, parent_id, name, node_type, description, keywords FROM folders/i.test(sql)) return [];
          if (/SELECT id, folder_id, title, file_type, description, keywords FROM content/i.test(sql)) return [];
          if (/SELECT id, parent_id, name, node_type, accepts_contributions FROM folders WHERE id/i.test(sql)) {
            const r = state.folders.get(Number(p[0])); return r ? [r] : [];
          }
          if (/SELECT parent_id FROM folders/i.test(sql)) {
            const r = state.folders.get(Number(p[0])); return r ? [[r[1]]] : [];
          }
          if (/SELECT accepts_contributions FROM folders/i.test(sql)) {
            const r = state.folders.get(Number(p[0])); return r ? [[r[4]]] : [];
          }
          if (/SELECT COUNT\(\*\) FROM folders/i.test(sql)) {
            return [[ [...state.folders.values()].filter((r) => r[1] === p[0]).length ]];
          }
          if (/SELECT id, folder_id, title, file_id, file_type FROM content WHERE id/i.test(sql)) {
            const r = state.content.get(Number(p[0])); return r ? [[r[0],r[1],r[2],r[3],r[4]]] : [];
          }
          if (/SELECT id, folder_id, title, file_id, file_type FROM content ORDER BY/i.test(sql)) {
            return [...state.content.values()].map((r) => [r[0],r[1],r[2],r[3],r[4]]);
          }
          return [];
        },
        async run() { return result(sql, this.params ?? []); },
      };
    },
    async batch(statements) {
      const outputs = [];
      for (const statement of statements) outputs.push(result(statement.sql ?? '', statement.params ?? []));
      return outputs;
    },
  };

  return db;
}

test('D1 users preserve language and quota semantics', async () => {
  const db = mockD1();
  await users.registerUser(db, 10, 'student', 'Student');
  assert.equal(await users.setUserLanguage(db, 10, 'en'), true);
  assert.equal(await users.getUserLanguage(db, 10), 'en');
  const first = await users.checkAndIncrementQuota(db, 10, 2);
  const second = await users.checkAndIncrementQuota(db, 10, 2);
  const third = await users.checkAndIncrementQuota(db, 10, 2);
  assert.deepEqual(first, [true, 1]);
  assert.deepEqual(second, [true, 0]);
  assert.deepEqual(third, [false, 0]);
});

test('D1 registry preserves the library row contracts', async () => {
  const db = mockD1();
  assert.deepEqual(await registry.getFolders(db, 0), [[1, 'Second Year', 'year', 0]]);
  assert.deepEqual(await registry.getFolders(db, 1), [[2, 'MSK', 'block', 1]]);
  assert.deepEqual(await registry.getFiles(db, 2), [[7, 'Muscle Physiology', 'tg-file', 'document', 'direct', null, 10]]);
  assert.equal(await registry.getBreadcrumbs(db, 2), 'الرئيسية 🏠 ⬅️ Second Year ⬅️ MSK');
  assert.equal(await registry.getParentId(db, 2), 1);
});

test('D1 registry writes use async D1 primitives', async () => {
  const db = mockD1();
  const id = await registry.addFolder(db, 2, 'Physiology', 'subject', 1);
  assert.equal(id, 3);
  assert.equal(await registry.updateFolderName(db, 3, 'Physiology II'), true);
  const contentId = await registry.addContent(db, 3, 'ANS', 'file-2', 'document');
  assert.equal(contentId, 8);
  assert.equal(await registry.updateFileTitle(db, 8, 'ANS revised'), true);
  assert.equal(await registry.deleteFile(db, 8), true);
});
