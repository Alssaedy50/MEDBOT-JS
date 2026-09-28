import test from 'node:test';
import assert from 'node:assert/strict';

import { localizeText, localizeMarkup, t } from '../src/i18n.js';

test('i18n renders canonical keys in both languages', () => {
  assert.equal(t('menu_resources', 'ar'), '📚 موارد المنصة');
  assert.equal(t('menu_resources', 'en'), '📚 Resources');
  assert.equal(t('language_title', 'en'), '🌐 *Language*\n\nChoose the platform interface language.');
});

test('legacy Arabic UI text is localized to English', () => {
  const text = '🤖 <b>المساعد الذكي</b>\n\n🔎 بحث في موارد المنصة\n\n⚠️ إجراء غير معروف.';
  const translated = localizeText(text, 'en');
  assert.match(translated, /AI Assistant/);
  assert.match(translated, /Search Platform Resources/);
  assert.match(translated, /Unknown action/);
  assert.doesNotMatch(translated, /المساعد الذكي|إجراء غير معروف/);
});

test('legacy English UI text is localized to Arabic', () => {
  const text = '🏠 Home\n📚 Resources\n🤖 AI Registry';
  const translated = localizeText(text, 'ar');
  assert.equal(translated, '🏠 الرئيسية\n📚 موارد المنصة\n🤖 سجل الذكاء الاصطناعي');
});

test('markup localization changes labels but preserves callback data', () => {
  const markup = {
    inline_keyboard: [
      [
        { text: '🏠 الرئيسية', callback_data: 'home' },
        { text: '📚 موارد المنصة', callback_data: 'resources' },
      ],
    ],
  };

  const localized = localizeMarkup(markup, 'en');
  assert.deepEqual(localized.inline_keyboard[0], [
    { text: '🏠 Home', callback_data: 'home' },
    { text: '📚 Resources', callback_data: 'resources' },
  ]);
});

test('user/resource text is not translated merely because it contains Arabic', () => {
  const original = 'اسم المورد: فسيولوجيا العضلات';
  assert.equal(localizeText(original, 'en'), original);
});
