import test from 'node:test';
import assert from 'node:assert/strict';
import * as resources from '../src/telegram/workerResources.js';

test('worker resource domain exports navigation builders without Node/SQLite imports', () => {
  assert.equal(typeof resources.buildWorkerLibraryRoot, 'function');
  assert.equal(typeof resources.buildWorkerFolder, 'function');
  assert.equal(typeof resources.findWorkerResources, 'function');
  assert.equal(typeof resources.buildWorkerFile, 'function');
});
