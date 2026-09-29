import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerAdmin, buildWorkerPending } from '../src/telegram/workerAdmin.js';
import { buildWorkerContext } from '../src/telegram/workerContext.js';
import { getWorkerState, setWorkerState, clearWorkerState } from '../src/db/d1/workerState.js';

test('Phase 16 Worker context remains media-aware',()=>{const c=buildWorkerContext({update:{message:{from:{id:7},chat:{id:7},photo:[{file_id:'x'}]}}});assert.equal(c.kind,'media');});
test('Phase 16 durable state module exposes D1 persistence boundaries',()=>{assert.equal(typeof getWorkerState,'function');assert.equal(typeof setWorkerState,'function');assert.equal(typeof clearWorkerState,'function');});
test('Phase 16 admin builders are exported',()=>{assert.equal(typeof buildWorkerAdmin,'function');assert.equal(typeof buildWorkerPending,'function');});
