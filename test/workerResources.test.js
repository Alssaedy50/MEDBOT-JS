import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerLibraryRoot, buildWorkerFolder, findWorkerResources } from '../src/telegram/workerResources.js';

function mockDb(rows = {}) {
  return {
    prepare() { throw new Error('not used in unit test'); },
    ...rows,
  };
}

test('worker resources module is runtime-safe and exports navigation builders', () => {
  assert.equal(typeof buildWorkerLibraryRoot, 'function');
  assert.equal(typeof buildWorkerFolder, 'function');
  assert.equal(typeof findWorkerResources, 'function');
  assert.ok(mockDb());
});
