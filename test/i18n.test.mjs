import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, setLanguage, getLanguage, subscribeLanguage, locale } from '../client/i18n.js';

test('every key exists in both dictionaries', () => {
  const zhKeys = Object.keys(locale.zh).sort();
  const enKeys = Object.keys(locale.en).sort();
  const missing = zhKeys.filter((key) => !enKeys.includes(key));
  const extra = enKeys.filter((key) => !zhKeys.includes(key));
  assert.deepEqual(missing, [], 'keys without English copy');
  assert.deepEqual(extra, [], 'English-only keys are dead weight');
  assert.ok(zhKeys.length > 60);
});

test('parameterised keys use the same placeholders in both languages', () => {
  for (const [key, value] of Object.entries(locale.zh)) {
    const zhVars = [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    const enVars = [...String(locale.en[key]).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(enVars, zhVars, `placeholder mismatch for ${key}`);
  }
});

test('unknown keys render themselves instead of blanking out', () => {
  assert.equal(t('nope.not.a.key'), 'nope.not.a.key');
});

test('switching language re-translates and notifies subscribers', () => {
  const before = getLanguage();
  let notified = null;
  const unsubscribe = subscribeLanguage((next) => {
    notified = next;
  });
  assert.equal(setLanguage('en'), true);
  assert.equal(t('section.workspaces'), 'Workspaces');
  assert.equal(t('workspace.count', { n: 3 }), '3 sessions');
  assert.equal(notified, 'en');
  assert.equal(setLanguage('en'), false, 'a no-op switch does not notify again');
  setLanguage(before);
  assert.equal(t('section.workspaces'), '工作区');
  unsubscribe();
});

test('bogus language ids are ignored', () => {
  const before = getLanguage();
  assert.equal(setLanguage('fr'), false);
  assert.equal(setLanguage(undefined), false);
  assert.equal(setLanguage(''), false);
  assert.equal(getLanguage(), before);
});
