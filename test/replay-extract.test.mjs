/**
 * 第二阶段骨架的测试：轮次窗切分 + 候选判分。
 *
 * 守两条：
 * ① 窗口只收真用户正文（注入块也是 user/message，混进来就自我放大）；
 * ② 候选的"命运"必须走治理链的同一份判据（previewWrite），不是自己算相似度另说一套。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';
import { buildTurnWindows, coveredRanges, labelsInScope, scoreCandidates } from '../lib/replay-extract.js';

async function openTempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'loom-extract-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 0 });
  await store.open();
  return { dir, store };
}

const rows = [
  { type: 'turn/start', time: 100 },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一轮的话' }] } },
  { type: 'user/message', data: { source: { kind: 'plugin:dsh-memory-loom' }, content: [{ type: 'text', text: '<memory-loom>注入</memory-loom>' }] } },
  { type: 'turn/end', time: 150 },
  { type: 'turn/start', time: 200 },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮的话' }] } },
  { type: 'turn/end', time: 260 },
  { type: 'turn/start', time: 300 },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第三轮的话' }] } },
  { type: 'turn/end', time: 360 },
];

test('轮次窗：按 turn/start 切，不进注入块', () => {
  const { windows, turns, userTurns } = buildTurnWindows(rows, { sessionId: 's-1', turns: 2, stride: 2 });
  assert.equal(turns, 3);
  assert.equal(userTurns, 3);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].fromTurn, 1);
  assert.equal(windows[0].toTurn, 2);
  assert.ok(windows[0].userText.includes('第一轮的话'));
  assert.ok(windows[0].userText.includes('第二轮的话'));
  assert.equal(windows[0].userText.includes('memory-loom'), false, '注入块不许进窗口');
  assert.equal(windows[0].cutoff, 260, 'cutoff 取窗口内最后一个 turn/end');
  assert.equal(windows[1].fromTurn, 3);
});

test('轮次窗：没有 turn/end 的会话也能切（取 turn/start 时间）', () => {
  const broken = [
    { type: 'turn/start', time: 10 },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '只有开始' }] } },
  ];
  const { windows } = buildTurnWindows(broken, { turns: 3 });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].cutoff, 10);
});

test('候选判分：治理链说 dedupe 的，不许算成召回', async () => {
  const { dir, store } = await openTempStore();
  try {
    const written = await store.write({ kind: 'fact', text: '用户喜欢喝手冲咖啡，不加糖' });
    const { rows: scored, tally } = scoreCandidates([{ kind: 'fact', text: '用户喜欢喝手冲咖啡，不加糖' }], {
      preview: (input) => store.previewWrite(input),
      labels: [{ id: written.id, text: '用户喜欢喝手冲咖啡，不加糖' }],
    });
    assert.equal(scored[0].action, 'dedupe');
    assert.equal(scored[0].nearestId, written.id);
    assert.equal(scored[0].fate, 'dedupe-label', '复述旧结论是 NOOP，不是召回');
    assert.equal(tally['dedupe-label'], 1);
    assert.equal(tally['create-match'], undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('候选判分：全新的候选与当年写过的一条高度相似 → create-match（真召回）', async () => {
  const { dir, store } = await openTempStore();
  try {
    const written = await store.write({ kind: 'fact', text: '面试时报 18 到 22K，底线 15K 且五险一金按实缴' });
    const { rows: scored } = scoreCandidates([{ kind: 'fact', text: '薪资区间报 18-22K，底线 15K，五险一金实缴' }], {
      preview: (input) => store.previewWrite(input),
      labels: [{ id: written.id, text: '面试时报 18 到 22K，底线 15K 且五险一金按实缴' }],
      matchThreshold: 0.5,
    });
    assert.equal(scored[0].fate, 'create-match');
    assert.equal(scored[0].matchedLabelId, written.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('候选判分：库里没有的 → create-new（要人标的残差）', async () => {
  const { dir, store } = await openTempStore();
  try {
    const { rows: scored, tally } = scoreCandidates([{ kind: 'fact', text: '用户养了一只叫团子的猫' }], {
      preview: (input) => store.previewWrite(input),
      labels: [],
    });
    assert.equal(scored[0].fate, 'create-new');
    assert.equal(tally['create-new'], 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('previewWrite：只判不写 —— 库不长、hits 不涨、不落事件', async () => {
  const { dir, store } = await openTempStore();
  try {
    await store.write({ kind: 'fact', text: '用户喜欢喝手冲咖啡，不加糖' });
    const before = store.state.memories.length;
    const hitsBefore = store.state.memories[0].hits ?? 0;
    const eventsBefore = store.state.events.length;
    const preview = store.previewWrite({ kind: 'fact', text: '用户喜欢喝手冲咖啡，不加糖' });
    assert.equal(preview.action, 'dedupe');
    assert.equal(store.state.memories.length, before, '预览不许长新条目');
    assert.equal(store.state.memories[0].hits ?? 0, hitsBefore, '预览不许涨 hits');
    assert.equal(store.state.events.length, eventsBefore, '预览不许落事件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('previewWrite：高相似但极性相反 → create + contradicted（该出 supersedes 提案）', async () => {
  const { dir, store } = await openTempStore();
  try {
    // 用引擎文档里的原例：原句不带否定、新句带否定，守卫能认出来
    await store.write({ kind: 'fact', text: '用户喜欢深色主题' });
    const preview = store.previewWrite({ kind: 'fact', text: '用户不喜欢深色主题了，改成浅色' });
    assert.equal(preview.action, 'create');
    assert.equal(preview.contradicted, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('previewWrite：slot 是覆盖写、choice 不查重（两条例外都要在预览里成立）', async () => {
  const { dir, store } = await openTempStore();
  try {
    await store.write({ kind: 'slot', entity: '我', attr: '在做的事', text: '写回放' });
    const slotPreview = store.previewWrite({ kind: 'slot', entity: '我', attr: '在做的事', text: '换了一件事' });
    assert.equal(slotPreview.action, 'slot');

    await store.write({ kind: 'choice', text: '取名时选了结构名', choiceA: '故事名', choiceB: '结构名', choicePicked: 'b' });
    const choicePreview = store.previewWrite({ kind: 'choice', text: '取名时选了结构名', choiceA: '故事名', choiceB: '结构名', choicePicked: 'b' });
    assert.equal(choicePreview.action, 'create', '取舍是事件，不查重');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 分母不变式（锁 bug 类，不锁实例） ──

test('分母不看产出：同一份选择清单，候选为零时分母不变', () => {
  const plan = [
    { sessionId: 's-1', fromTurn: 1, toTurn: 6 },
    { sessionId: 's-1', fromTurn: 7, toTurn: 12 },
    { sessionId: 's-2', fromTurn: 1, toTurn: 6 },
  ];
  const labels = [
    { id: 'a', sessionId: 's-1', turn: 2 },
    { id: 'b', sessionId: 's-1', turn: 9 },
    { id: 'c', sessionId: 's-1', turn: 30 }, // 窗外
    { id: 'd', sessionId: 's-2', turn: 4 },
    { id: 'e', sessionId: 's-2', turn: null }, // 映射不上
  ];
  const covered = coveredRanges(plan);
  const withCandidates = labelsInScope(labels, covered);
  // 「零候选」不改变分母：这个函数根本没有候选参数，也读不到候选
  const withoutCandidates = labelsInScope(labels, coveredRanges(plan));
  assert.equal(withCandidates.length, withoutCandidates.length, '分母不许随候选增减');
  assert.deepEqual(withCandidates.map((l) => l.id), ['a', 'b', 'd']);
  assert.equal(labelsInScope.length, 2, 'labelsInScope(labels, covered) 只有两个入参：结构上读不到候选');
});

test('分母：零候选窗口里的标签仍然计入（第三次同向 bug 的位置）', () => {
  const plan = [{ sessionId: 's-1', fromTurn: 1, toTurn: 6 }];
  const labels = [{ id: 'x', sessionId: 's-1', turn: 3 }];
  // 候选为空 —— 旧实现在这里会把分母算成 0，召回变成 0/0 或者直接消失
  assert.equal(labelsInScope(labels, coveredRanges(plan)).length, 1);
});

test('coveredRanges：畸形窗口直接跳过，不猜', () => {
  const covered = coveredRanges([
    { sessionId: 's-1', fromTurn: 1, toTurn: 6 },
    { sessionId: null, fromTurn: 1, toTurn: 6 },
    { sessionId: 's-1', fromTurn: 'x', toTurn: 6 },
    null,
    undefined,
  ]);
  assert.equal(covered.size, 1);
  assert.deepEqual(covered.get('s-1'), [[1, 6]]);
});
