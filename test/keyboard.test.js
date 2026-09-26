/**
 * `chunkButtons` — the compact two-column keyboard helper.
 *
 * The helper exists so long single-column lists (settings, filters, archive
 * actions) become a compact grid. These tests pin both the packing and the
 * guardrails that keep a compact keyboard readable.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { btn, chunkButtons, keyboard } from '../src/telegram/ui.js';

const labels = (rows) => rows.map((row) => row.map((button) => button.text));

describe('chunkButtons', () => {
  it('packs short buttons two per row', () => {
    const rows = chunkButtons([
      btn('A', 'a'),
      btn('B', 'b'),
      btn('C', 'c'),
      btn('D', 'd'),
    ]);
    assert.deepEqual(labels(rows), [
      ['A', 'B'],
      ['C', 'D'],
    ]);
  });

  it('leaves an odd trailing button on its own row', () => {
    const rows = chunkButtons([btn('A', 'a'), btn('B', 'b'), btn('C', 'c')]);
    assert.deepEqual(labels(rows), [['A', 'B'], ['C']]);
  });

  it('honours a custom column count', () => {
    const rows = chunkButtons([btn('A', 'a'), btn('B', 'b'), btn('C', 'c')], 3);
    assert.deepEqual(labels(rows), [['A', 'B', 'C']]);
  });

  it('gives a long label its own full-width row', () => {
    const long = btn('هذا نص زر طويل جداً لا ينبغي حشره', 'long');
    const rows = chunkButtons([btn('A', 'a'), long, btn('B', 'b'), btn('C', 'c')]);
    assert.deepEqual(labels(rows), [
      ['A'],
      ['هذا نص زر طويل جداً لا ينبغي حشره'],
      ['B', 'C'],
    ]);
  });

  it('gives a fullWidth-matching button its own row', () => {
    const rows = chunkButtons(
      [btn('A', 'a'), btn('B', 'home'), btn('C', 'c')],
      2,
      { fullWidth: (button) => button.callback_data === 'home' },
    );
    assert.deepEqual(labels(rows), [['A'], ['B'], ['C']]);
  });

  it('produces a valid keyboard object and never an empty row', () => {
    const markup = keyboard(chunkButtons([btn('A', 'a')]));
    assert.deepEqual(markup, { inline_keyboard: [[{ text: 'A', callback_data: 'a' }]] });
  });

  it('returns an empty list for empty input and ignores falsy entries', () => {
    assert.deepEqual(chunkButtons([]), []);
    assert.deepEqual(chunkButtons([null, undefined]), []);
  });

  it('is used by the settings screen so its list is two-column', async () => {
    const { showSettings } = await import('../src/ui/adminSettings.js');
    const db = await import('../src/db/index.js');
    const { callbackCtx, cleanupDb, FakeBot, freshDb } = await import('./helpers/harness.js');

    const dbPath = freshDb('keyboard-settings');
    const owner = 7700;
    db.registerUser(owner, 'kbowner', 'KB Owner');
    db.addSubAdmin(owner, 'kbowner');
    db.setAdminRole(owner, 'owner');
    db.updateAdminPermissions(owner, db.defaultPermissions());

    const bot = new FakeBot();
    await showSettings(callbackCtx(bot, owner, 'admin_settings'));
    const rows = bot.last('editMessageText').args.options.reply_markup.inline_keyboard;
    // Five settings pack into three rows instead of five.
    const settingRows = rows.filter((row) =>
      row.some((button) => String(button.callback_data).startsWith('settings_edit:')),
    );
    assert.equal(settingRows.length, 3);
    assert.ok(settingRows[0].length === 2);

    cleanupDb(dbPath);
  });
});
