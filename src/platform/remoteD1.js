/**
 * Runtime-Agnostic Cloudflare D1 Remote HTTP Bridge & Pure-JS Memory Fallback
 * (`src/platform/remoteD1.js`).
 *
 * Zero `node:sqlite` or `node:fs` imports so it runs on Vercel Serverless
 * (Node 18/20/22), Edge runtimes, Render, Hugging Face, and Cloudflare Workers.
 */

/**
 * Create a Remote Cloudflare D1 adapter over the official Cloudflare REST API.
 * Batches parameterless DDL/schema statements into a single HTTP request so
 * serverless functions on Vercel never time out during schema initialization.
 */
export function createCloudflareRemoteD1({ apiToken, accountId, databaseId, fetchImpl = globalThis.fetch }) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

  async function executeQuery(sql, params = []) {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sql,
        params: params.map((p) => (p === undefined ? null : p)),
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) {
      const msg = data?.errors?.[0]?.message || `Cloudflare D1 HTTP ${res.status}`;
      throw new Error(msg);
    }
    const firstResult = Array.isArray(data.result) ? data.result[0] : data.result;
    return {
      results: Array.isArray(firstResult?.results) ? firstResult.results : [],
      meta: firstResult?.meta || { changes: 0, last_row_id: 0 },
    };
  }

  function createPrepared(sql, boundParams = []) {
    return {
      __sql: sql,
      __params: boundParams,
      bind(...params) {
        return createPrepared(sql, params.map((p) => (p === undefined ? null : p)));
      },
      async raw() {
        const { results } = await executeQuery(sql, boundParams);
        return results.map((row) => Object.values(row));
      },
      async all() {
        const { results } = await executeQuery(sql, boundParams);
        return { results };
      },
      async first(colName) {
        const { results } = await executeQuery(sql, boundParams);
        const row = results[0] ?? null;
        if (!row) return null;
        return colName ? (row[colName] ?? null) : row;
      },
      async run() {
        const { meta } = await executeQuery(sql, boundParams);
        return {
          success: true,
          meta: {
            changes: Number(meta.changes ?? 0),
            last_row_id: Number(meta.last_row_id ?? 0),
          },
        };
      },
    };
  }

  return {
    __isRemoteCloudflareD1: true,
    prepare(sql) {
      return createPrepared(sql);
    },
    async batch(statements) {
      if (!Array.isArray(statements) || statements.length === 0) return [];
      const allParameterless = statements.every(
        (s) => s && typeof s.__sql === 'string' && (!s.__params || s.__params.length === 0),
      );
      if (allParameterless) {
        const combinedSql = statements.map((s) => s.__sql.trim().replace(/;$/, '')).join(';\n') + ';';
        await executeQuery(combinedSql, []);
        return statements.map(() => ({ success: true, meta: { changes: 0, last_row_id: 0 } }));
      }
      const out = [];
      for (const stmt of statements) {
        out.push(await stmt.run());
      }
      return out;
    },
    async exec(sql) {
      await executeQuery(sql, []);
      return { count: 1, duration: 0 };
    },
  };
}

/**
 * Auto-discover Cloudflare Account ID, D1 Database UUID (`medbot`), and Worker Subdomain
 * using just a `CLOUDFLARE_API_TOKEN`.
 */
export async function discoverCloudflareD1Bridge({
  apiToken,
  accountId: rawAccountId = '',
  databaseId: rawDatabaseId = '',
  workerUrl: rawWorkerUrl = '',
  fetchImpl = globalThis.fetch,
} = {}) {
  const token = String(apiToken || '').trim();
  if (!token) throw new Error('يرجى إدخال CLOUDFLARE_API_TOKEN.');

  const cfFetch = async (ep) => {
    const r = await fetchImpl(`https://api.cloudflare.com/client/v4${ep}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    return r.json().catch(() => ({ success: false }));
  };

  let accountId = (String(rawAccountId || '').match(/([a-f0-9]{32})/i) || [])[1] || '';
  if (!accountId) {
    const accData = await cfFetch('/accounts?per_page=10');
    if (accData?.success && Array.isArray(accData.result) && accData.result[0]?.id) {
      accountId = accData.result[0].id;
    }
  }
  if (!accountId) {
    throw new Error('تعذّر اكتشاف Cloudflare Account ID من هذا التوكن. تأكد من صلاحيات التوكن.');
  }

  let databaseId =
    (String(rawDatabaseId || '').match(
      /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
    ) || [])[1] || '';
  let databaseName = 'medbot';
  if (!databaseId) {
    const d1List = await cfFetch(`/accounts/${accountId}/d1/database`);
    if (d1List?.success && Array.isArray(d1List.result) && d1List.result.length > 0) {
      const found = d1List.result.find((d) => d.name === 'medbot') || d1List.result[0];
      databaseId = found.uuid;
      databaseName = found.name || 'medbot';
    }
  }
  if (!databaseId) {
    throw new Error('لم يتم العثور على قاعدة بيانات D1 في حساب Cloudflare هذا.');
  }

  let workerUrl = String(rawWorkerUrl || '').trim();
  if (!workerUrl) {
    const subData = await cfFetch(`/accounts/${accountId}/workers/subdomain`);
    if (subData?.success && subData.result?.subdomain) {
      workerUrl = `https://medbot-js.${subData.result.subdomain}.workers.dev`;
    }
  }

  const remoteD1 = createCloudflareRemoteD1({
    apiToken: token,
    accountId,
    databaseId,
    fetchImpl,
  });

  return {
    db: remoteD1,
    info: {
      connected: true,
      accountId,
      databaseId,
      databaseName,
      workerUrl: workerUrl || null,
    },
  };
}

/**
 * Lightweight Pure-JavaScript In-Memory D1 Store for Serverless environments (like Vercel
 * Node 20.x) where `node:sqlite` is unavailable and `CLOUDFLARE_API_TOKEN` has not been
 * entered yet. Ensures the Web Control Plane always loads with 200 OK and full interactivity.
 */
export function createPureJsMemoryD1() {
  const colleges = new Map();
  const platformSettings = new Map();
  const auditLogs = [];
  const tableSettings = new Map(); // tableName -> Map(key -> value)
  let nextAuditId = 1;

  function getSettingsMap(table = 'settings') {
    if (!tableSettings.has(table)) {
      tableSettings.set(table, new Map());
    }
    return tableSettings.get(table);
  }

  function collegeRowArray(c) {
    return [
      c.college_id,
      c.name_ar,
      c.name_en ?? null,
      c.manager_telegram_id ?? null,
      c.manager_username ?? null,
      c.bot_id ?? null,
      c.bot_username ?? null,
      c.bot_token_encrypted ?? null,
      c.webhook_secret ?? '',
      c.managed_bot_mode ?? 'managed_bot',
      c.db_binding ?? 'DB',
      c.archive_channel_id ?? null,
      c.status ?? 'pending_setup',
      c.suspension_reason ?? null,
      c.webhook_url ?? null,
      c.created_by ?? null,
      c.created_at ?? new Date().toISOString(),
      c.updated_at ?? new Date().toISOString(),
    ];
  }

  function execRaw(sql, params) {
    const norm = String(sql || '').replace(/\s+/g, ' ').trim();

    if (/FROM platform_colleges WHERE college_id = 'default'/i.test(norm)) {
      const c = colleges.get('default');
      return c ? [collegeRowArray(c)] : [];
    }
    if (/SELECT college_id FROM platform_colleges WHERE college_id = \?/i.test(norm)) {
      const c = colleges.get(String(params[0] || ''));
      return c ? [[c.college_id]] : [];
    }
    if (/FROM platform_colleges WHERE college_id = \?/i.test(norm)) {
      const c = colleges.get(String(params[0] || ''));
      return c ? [collegeRowArray(c)] : [];
    }
    if (/FROM platform_colleges WHERE manager_telegram_id = \?/i.test(norm)) {
      const uid = Number(params[0]);
      return Array.from(colleges.values())
        .filter((c) => Number(c.manager_telegram_id) === uid)
        .map(collegeRowArray);
    }
    if (/FROM platform_colleges ORDER BY/i.test(norm)) {
      const list = Array.from(colleges.values()).sort((a, b) => {
        if (a.college_id === 'default') return -1;
        if (b.college_id === 'default') return 1;
        return 0;
      });
      return list.map(collegeRowArray);
    }
    if (/SELECT value FROM platform_settings WHERE key =/i.test(norm)) {
      const m = norm.match(/key = '([^']+)'/i);
      const key = m ? m[1] : String(params[0] || '');
      return platformSettings.has(key) ? [[platformSettings.get(key)]] : [];
    }
    if (/FROM platform_audit_log/i.test(norm)) {
      const limit = Number(params[params.length - 1]) || 25;
      const list = norm.includes('WHERE college_id = ?')
        ? auditLogs.filter((l) => l.college_id === String(params[0]))
        : auditLogs;
      return list
        .slice(-limit)
        .reverse()
        .map((l) => [l.id, l.actor_id, l.actor_role, l.college_id, l.action, l.details, l.created_at]);
    }
    const settingsMatch = norm.match(/FROM ([a-z0-9_]*settings) WHERE key/i);
    if (settingsMatch) {
      const tbl = settingsMatch[1];
      const map = getSettingsMap(tbl);
      if (norm.includes("LIKE 'college_secret.v1.%'")) {
        return Array.from(map.entries())
          .filter(([k]) => k.startsWith('college_secret.v1.'))
          .map(([k, v]) => [k, v]);
      }
      const keyLiteral = norm.match(/key\s*=\s*'([^']+)'/i);
      const key = keyLiteral ? keyLiteral[1] : String(params[0] || '');
      return map.has(key) ? [[map.get(key)]] : [];
    }
    return [];
  }

  function execRun(sql, params) {
    const norm = String(sql || '').replace(/\s+/g, ' ').trim();
    const now = new Date().toISOString();

    if (/INSERT INTO platform_colleges/i.test(norm)) {
      const isDefaultInsert = norm.includes('ON CONFLICT(college_id) DO NOTHING') && params.length === 10;
      if (isDefaultInsert) {
        const id = String(params[0]);
        if (!colleges.has(id)) {
          colleges.set(id, {
            college_id: id,
            name_ar: params[1],
            name_en: params[2],
            manager_telegram_id: params[3],
            manager_username: null,
            bot_id: null,
            bot_username: null,
            bot_token_encrypted: null,
            webhook_secret: params[4],
            managed_bot_mode: params[5],
            db_binding: params[6],
            archive_channel_id: params[7],
            status: params[8],
            suspension_reason: null,
            webhook_url: null,
            created_by: params[9],
            created_at: now,
            updated_at: now,
          });
        }
        return { changes: 1, last_row_id: 1 };
      }

      const id = String(params[0]);
      colleges.set(id, {
        college_id: id,
        name_ar: params[1],
        name_en: params[2],
        manager_telegram_id: params[3],
        manager_username: params[4],
        bot_id: params[5],
        bot_username: params[6],
        bot_token_encrypted: params[7],
        webhook_secret: params[8],
        managed_bot_mode: params[9],
        db_binding: params[10],
        archive_channel_id: params[11],
        status: params[12],
        suspension_reason: null,
        webhook_url: params[13],
        created_by: params[14],
        created_at: now,
        updated_at: now,
      });
      return { changes: 1, last_row_id: colleges.size };
    }

    if (/UPDATE platform_colleges/i.test(norm)) {
      const slug = String(params[params.length - 1]);
      const col = colleges.get(slug);
      if (!col) return { changes: 0, last_row_id: 0 };

      if (norm.includes('SET manager_telegram_id = ?')) {
        col.manager_telegram_id = params[0];
        if (params[1]) col.manager_username = params[1];
      } else if (norm.includes('SET bot_token_encrypted = ?')) {
        col.bot_token_encrypted = params[0];
        col.bot_id = params[1];
        if (params[2]) col.bot_username = params[2];
        col.webhook_secret = params[3];
        if (params[4]) col.managed_bot_mode = params[4];
        if (params[5]) col.webhook_url = params[5];
      } else if (norm.includes('SET archive_channel_id = ?')) {
        col.archive_channel_id = params[0];
      } else if (norm.includes('SET webhook_url = ?')) {
        col.webhook_url = params[0];
      } else if (norm.includes('SET status = ?, suspension_reason = NULL')) {
        col.status = params[0];
        col.suspension_reason = null;
      } else if (norm.includes('SET status = ?, suspension_reason = ?')) {
        col.status = params[0];
        col.suspension_reason = params[1];
      } else if (norm.includes('SET status = ?')) {
        col.status = params[0];
      }
      col.updated_at = now;
      return { changes: 1, last_row_id: 1 };
    }

    if (/INSERT INTO platform_settings/i.test(norm)) {
      platformSettings.set(String(params[0]), String(params[1] ?? ''));
      return { changes: 1, last_row_id: 1 };
    }

    if (/INSERT INTO platform_audit_log/i.test(norm)) {
      auditLogs.push({
        id: nextAuditId++,
        actor_id: params[0],
        actor_role: params[1],
        college_id: params[2],
        action: params[3],
        details: params[4],
        created_at: now,
      });
      return { changes: 1, last_row_id: nextAuditId - 1 };
    }

    const insertSettingsMatch = norm.match(/INSERT INTO ([a-z0-9_]*settings)/i);
    if (insertSettingsMatch) {
      const tbl = insertSettingsMatch[1];
      const map = getSettingsMap(tbl);
      if (norm.includes("VALUES ('platform_name', ?)")) {
        map.set('platform_name', String(params[0] ?? ''));
      } else if (norm.includes("VALUES ('archive_channel_id', ?)")) {
        map.set('archive_channel_id', String(params[0] ?? ''));
      } else {
        map.set(String(params[0]), String(params[1] ?? ''));
      }
      return { changes: 1, last_row_id: 1 };
    }

    const delSettingsMatch = norm.match(/DELETE FROM ([a-z0-9_]*settings) WHERE key = \?/i);
    if (delSettingsMatch) {
      const map = getSettingsMap(delSettingsMatch[1]);
      const existed = map.delete(String(params[0]));
      return { changes: existed ? 1 : 0, last_row_id: 0 };
    }

    return { changes: 0, last_row_id: 0 };
  }

  function createPrepared(sql, boundParams = []) {
    return {
      __sql: sql,
      __params: boundParams,
      bind(...params) {
        return createPrepared(sql, params.map((p) => (p === undefined ? null : p)));
      },
      async raw() {
        return execRaw(sql, boundParams);
      },
      async all() {
        const rows = execRaw(sql, boundParams);
        return { results: rows };
      },
      async first() {
        const rows = execRaw(sql, boundParams);
        return rows[0] ?? null;
      },
      async run() {
        const meta = execRun(sql, boundParams);
        return { success: true, meta };
      },
    };
  }

  return {
    __isPureJsMemoryD1: true,
    prepare(sql) {
      return createPrepared(sql);
    },
    async batch(statements) {
      const out = [];
      for (const s of statements || []) {
        out.push(await s.run());
      }
      return out;
    },
    async exec() {
      return { count: 1, duration: 0 };
    },
  };
}
