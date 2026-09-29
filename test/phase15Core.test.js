import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerTopics, buildWorkerTopic } from '../src/telegram/workerTopics.js';
import { buildWorkerContributionStart, prepareWorkerContribution } from '../src/telegram/workerContributions.js';
import { buildWorkerContext } from '../src/telegram/workerContext.js';

test('Phase 15 Worker context recognizes Telegram media updates',()=>{
 const ctx=buildWorkerContext({update:{message:{from:{id:1},chat:{id:1},document:{file_id:'x'}}}});
 assert.equal(ctx.kind,'media'); assert.equal(ctx.message.document.file_id,'x');
});

test('Phase 15 topic module exports Worker-native builders',()=>{
 assert.equal(typeof buildWorkerTopics,'function'); assert.equal(typeof buildWorkerTopic,'function');
});

test('Phase 15 contribution module exposes submission flow boundaries',()=>{
 assert.equal(typeof buildWorkerContributionStart,'function'); assert.equal(typeof prepareWorkerContribution,'function');
});
