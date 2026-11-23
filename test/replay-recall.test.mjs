/**
 * 召回尺子的测试。
 *
 * 守三条：
 * ① 确定性：同一段文本永远给出同一组实体（回放要可复算）；
 * ② containment 而不是 Jaccard：抽象表述是长句的子集时，真命中不许被长度差压死；
 * ③ **kind 不当门**：fact 标签 × world 候选必须能配上（0.846 那条就是跨 kind）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { entityOverlap, isJunctionBigram, keyEntities, matchByEntities, matchByEntitiesV2, sharedEvidence, RECALL_RULER } from '../lib/replay-recall.js';

/** 用真实语料里量到的 df 造一张表：这些数是 343 条标签上的实测值。 */
const DF = new Map([
  ['记忆', 68],
  ['架构', 10],
  ['忆架', 1],
  ['半透', 2],
  ['透明', 6],
  ['帧率', 2],
  ['绕圈', 1],
  ['星图', 9],
  ['面板', 20],
]);

test('跨词碎片：忆架是「记忆」+「架构」的交界，不是稀有证据', () => {
  const evidence = sharedEvidence('为 dsh 做可视化记忆插件，需贴合项目现有记忆架构', '一起把「旧识」的四层记忆架构改写成插件', { df: DF });
  assert.ok(evidence.junction.includes('忆架'), '忆架要被识别成交界碎片');
  assert.equal(evidence.rare.includes('忆架'), false, '交界碎片不许当稀有证据');
});

test('词内碎片必须留着：半透 / 帧率 / 绕圈 是真命中的唯一载体', () => {
  const half = sharedEvidence('否决半透明面板，视觉要有记忆特色', '用户偏好不透明的深空星图面板，明确拒绝半透明玻璃拟态', { df: DF });
  assert.ok(half.rare.includes('半透'), '半透是「半透明」的碎片，但它承载语义，不许滤');
  const fps = sharedEvidence('面板必须有动态效果，且帧率要有保证', '用户要求记忆插件的面板动画必须有帧率保障', { df: DF });
  assert.ok(fps.rare.includes('帧率'));
  const circle = sharedEvidence('用户不喜欢反复绕圈，希望我换思路', '别在同一处反复调，一直绕圈圈没用', { df: DF });
  assert.ok(circle.rare.includes('绕圈'));
});

test('isJunctionBigram：只有两半都被共享高频词包住才算交界', () => {
  const frequent = new Set(['记忆', '架构', '面板']);
  assert.equal(isJunctionBigram('忆架', frequent), true);
  assert.equal(isJunctionBigram('半透', frequent), false, '没有共享高频词以“半”收尾');
  assert.equal(isJunctionBigram('单个', frequent), false, '不是二元组就不算');
});

test('entity-v2：跨词碎片不算证据，误配被挡掉', () => {
  const labels = [{ id: 'L1', kind: 'episode', text: '一起把「旧识」的四层记忆架构改写成插件，装进 desktop profile' }];
  const hit = matchByEntitiesV2({ kind: 'world', text: '为 dsh 做可视化记忆插件，需贴合项目现有记忆架构' }, labels, { df: DF, threshold: 0.1, rareMin: 1 });
  assert.equal(hit, null, '只共享「记忆」+「架构」+交界碎片，不该算命中');
});

test('entity-v2：真命中要靠稀有证据，且 kind 仍不当门', () => {
  const labels = [{ id: 'L1', kind: 'fact', text: '用户偏好不透明的深空星图面板，明确拒绝半透明玻璃拟态' }];
  const hit = matchByEntitiesV2({ kind: 'world', text: '面板否决半透明风格，要有记忆特色' }, labels, { df: DF, threshold: 0.1, rareMin: 1 });
  assert.ok(hit !== null);
  assert.equal(hit.id, 'L1');
  assert.ok(hit.rare.includes('半透'));
});

test('entity-v2：只共享一个高频词时不算命中（#10 这类弱样本会被漏掉，已知且可解释）', () => {
  const labels = [{ id: 'L1', kind: 'fact', text: '用户偏好不透明的深空星图面板，明确拒绝半透明玻璃拟态' }];
  const hit = matchByEntitiesV2({ kind: 'world', text: '视觉方向已定为纯星图派' }, labels, { df: DF, threshold: 0.1, rareMin: 1 });
  assert.equal(hit, null, '只有「星图」df=9 这一个桥，没有稀有证据');
});

test('实体抽取：确定性 + 去单字/停用词/纯数字', () => {
  const text = '两个 agent 同时在三个工作区进行项目开发和优化，帧率 59 也不够';
  const first = keyEntities(text);
  const second = keyEntities(text);
  assert.deepEqual([...first].sort(), [...second].sort(), '同一段文本两次抽取必须相同');
  for (const token of first) {
    assert.ok([...token].length >= 2, `单字不许当实体：${token}`);
    assert.equal(/^\d+([.]\d+)?$/.test(token), false, `纯数字不许当实体：${token}`);
  }
  assert.ok(first.has('agent'), '英文标识要留下');
});

test('重合度：完全相同的两句 = 1', () => {
  const text = '面板要有动态效果并保证帧率';
  assert.equal(entityOverlap(text, text).score, 1);
});

test('重合度：无关的两句 = 0（UI 细节不许被算成同一件事）', () => {
  const { score } = entityOverlap('面板要有动态效果，且帧率必须有保证', '窗口位置保持在右上角下方');
  assert.equal(score, 0);
});

test('重合度：抽象表述是长句的子集时仍算命中（containment 的意义）', () => {
  const { score } = entityOverlap('面板否决半透明风格，要有记忆特色', '记忆面板要有记忆特色，不要半透明样式');
  assert.ok(score >= RECALL_RULER.defaultThreshold, `子集关系要被认出来，实际 ${score}`);
});

test('matchByEntities：跨 kind 不许被挡住（fact 标签 × world 候选）', () => {
  const labels = [
    { id: 'L1', kind: 'fact', text: '你记住就行，你们现在是两个agent同时在三个工作区进行项目开发和优化' },
  ];
  const hit = matchByEntities({ kind: 'world', text: '两个agent同时在三个工作区进行项目开发和优化' }, labels);
  assert.ok(hit !== null, '同 kind 硬门会在这里把真命中挡掉 —— 那正是要防的回归');
  assert.equal(hit.id, 'L1');
  assert.equal(hit.sameKind, false);
  assert.equal(hit.kindAsSignal, 0);
});

test('matchByEntities：同 kind 只加一点排序分，不改变"有没有配上"', () => {
  const labels = [
    { id: 'L1', kind: 'world', text: '记忆面板要有记忆特色，不要半透明样式' },
    { id: 'L2', kind: 'fact', text: '记忆面板要有记忆特色，不要半透明样式' },
  ];
  const hit = matchByEntities({ kind: 'world', text: '面板否决半透明风格，要有记忆特色' }, labels);
  assert.ok(hit !== null);
  assert.equal(hit.sameKind, true);
  assert.ok(hit.score > hit.rawScore, '同 kind 的排序分要看得见');
  assert.ok(hit.kindAsSignal <= 0.05, 'kind 只是信号，不许压倒实体重合');
});

test('matchByEntities：够不上门槛就返回 null（宁可漏，不要乱配）', () => {
  const labels = [{ id: 'L1', kind: 'fact', text: '记忆按钮放在编辑按钮旁' }];
  assert.equal(matchByEntities({ kind: 'fact', text: '面板否决半透明风格' }, labels), null);
});
