/**
 * 埋点测试（qoder 的三个硬条件）。
 *
 * ① 事件带 instrumentVersion；历史事件没有（不伪造）。
 * ② 埋点不得改召回行为：同一批查询，埋点前后 blocks/entries/tokens 三个计数必须一致。
 * ③ 事件里能看到"哪几条被注入"（id 级），以及注入块里出现过的词（用于判"抄"）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'loom-instrument-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json') });
  await store.open();
  return { dir, store };
}

test('埋点：recall.entries 带 instrumentVersion 与 id 级条目', async () => {
  const { dir, store } = await tempStore();
  try {
    await store.write({ kind: 'fact', text: '用户喜欢喝手冲咖啡，不加糖', sessionId: 's-1' });
    const snapshot = store.buildRecall('手冲咖啡 不加糖');
    await store.recordRecall({ ...snapshot, sessionId: 's-1' });
    const event = store.state.events.filter((e) => e.kind === 'recall.entries').at(-1);
    assert.ok(event, '必须有 recall.entries 事件');
    assert.equal(event.payload.instrumentVersion, 'ctx-ids-v1');
    assert.ok(Array.isArray(event.payload.entryIds));
    assert.ok(event.payload.entryIds.every((row) => typeof row.id === 'string'));
    assert.ok(Array.isArray(event.payload.blockTokens), '要存注入块里出现过的词，否则判不了"抄"');
    assert.equal(event.payload.sessionId, 's-1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('埋点不得改召回行为：快照三个计数与埋点事件一致', async () => {
  const { dir, store } = await tempStore();
  try {
    for (let i = 0; i < 6; i += 1) await store.write({ kind: 'fact', text: `第 ${i} 条：用户喜欢喝手冲咖啡，不加糖` });
    const query = '手冲咖啡 不加糖 哪个更好';
    const before = store.buildRecall(query);
    await store.recordRecall({ ...before, sessionId: 's-2' });
    const after = store.buildRecall(query);
    assert.equal(after.blocks.length, before.blocks.length, '埋点不许改块数');
    const recallEvent = store.state.events.filter((e) => e.kind === 'recall').at(-1);
    assert.equal(recallEvent.payload.blocks, before.size?.blocks ?? 0);
    assert.equal(recallEvent.payload.entries, before.size?.entries ?? 0);
    assert.equal(recallEvent.payload.tokens, before.gate?.tokens ?? null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('埋点：历史 recall 事件没有被伪造 instrumentVersion', async () => {
  const { dir, store } = await tempStore();
  try {
    await store.write({ kind: 'fact', text: '一条普通事实，用于触发召回' });
    await store.recordRecall({ ...store.buildRecall('普通事实'), sessionId: 's-3' });
    const legacy = store.state.events.filter((e) => e.kind === 'recall');
    assert.ok(legacy.length > 0);
    assert.ok(legacy.every((e) => e.payload.instrumentVersion === undefined), '旧 recall 事件不许事后加版本号');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
