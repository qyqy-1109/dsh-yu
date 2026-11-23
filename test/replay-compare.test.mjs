/**
 * 尺子（compare-v1）的测试。
 *
 * 守四条判据，重点是**极性永不降级**——那是引擎到尺子一以贯之的底线。
 * 另外守"降级只丢 2、3 两条，且降级要标出来"。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { sameStructured, sameStructuredWithout, matchDecisionSets, valueEntities, normalizeSubject, SUBJECT_CLASSES } from '../lib/replay-compare.js';

const decision = (over) => ({ subject: 'product', attr: '风格', value: '半透明', negative: false, ...over });

test('四条全同 → 同一决定', () => {
  const verdict = sameStructured(decision(), decision());
  assert.equal(verdict.same, true);
  assert.equal(verdict.containment, 1);
});

test('极性相反 → 否，且不因任何降级被放过（attr 都是 unknown 也一样）', () => {
  const verdict = sameStructured(decision({ negative: true, attr: 'unknown' }), decision({ negative: false, attr: 'unknown' }));
  assert.equal(verdict.same, false);
  assert.deepEqual(verdict.reasons, ['polarity-mismatch']);
  assert.equal(verdict.degraded.attr, false, '极性先判，走不到降级那一步');
});

test('属性不同 → 否（闭集内）', () => {
  const verdict = sameStructured(decision({ attr: '风格' }), decision({ attr: '底线' }));
  assert.equal(verdict.same, false);
  assert.deepEqual(verdict.reasons, ['attr-mismatch']);
});

test('属性 unknown → 降级但仍比取值（降级要标出来）', () => {
  const verdict = sameStructured(decision({ attr: 'unknown' }), decision({ attr: '风格' }));
  assert.equal(verdict.same, true);
  assert.equal(verdict.degraded.attr, true);
  assert.equal(verdict.anyDegraded, true);
});

test('主语不同（非 other）→ 否；一方 other → 降级不拦', () => {
  const mismatch = sameStructured(decision({ subject: 'product' }), decision({ subject: 'agent' }));
  assert.equal(mismatch.same, false);
  assert.deepEqual(mismatch.reasons, ['subject-mismatch']);

  const degraded = sameStructured(decision({ subject: 'other' }), decision({ subject: 'product' }));
  assert.equal(degraded.same, true);
  assert.equal(degraded.degraded.subject, true);
});

test('τ 可调：取值包含在 0.4~0.6 之间时，τ 决定结果', () => {
  const left = decision({ value: '半透明面板风格' });
  const right = decision({ value: '半透明玻璃拟态' });
  const low = sameStructured(left, right, { tau: 0.3 });
  const high = sameStructured(left, right, { tau: 0.9 });
  assert.equal(low.same, true, `低 τ 应通过（containment=${low.containment}）`);
  assert.equal(high.same, false);
  assert.equal(low.containment, high.containment, 'τ 不该改变 containment 本身');
});

test('取值实体：确定性 + 去虚词碎片', () => {
  const first = valueEntities('面板的半透明风格');
  const second = valueEntities('面板的半透明风格');
  assert.deepEqual([...first].sort(), [...second].sort());
  assert.ok(first.has('半透') || first.has('透明'));
});

test('subject 规整：闭集外的值归 other，不猜', () => {
  assert.equal(normalizeSubject('product'), 'product');
  assert.equal(normalizeSubject('面板'), 'other');
  for (const value of ['user', 'agent', 'product', 'project', 'other']) assert.ok(SUBJECT_CLASSES.includes(value));
});

test('集合对集合：任一决定对上即记录命中，并报决定级覆盖', () => {
  const candidates = [
    { subject: 'product', attr: '风格', value: '半透明', negative: true },
    { subject: 'product', attr: '风格', value: '深空星图', negative: false },
  ];
  const labels = [
    { subject: 'product', attr: '风格', value: '半透明玻璃拟态', negative: true },
    { subject: 'product', attr: '风格', value: '深空星图面板', negative: false },
    { subject: 'product', attr: '口径', value: '先量再下结论', negative: false },
  ];
  const verdict = matchDecisionSets(candidates, labels, { tau: 0.5 });
  assert.equal(verdict.same, true);
  assert.equal(verdict.labelCount, 3);
  assert.equal(verdict.decisionCoverage, Number((2 / 3).toFixed(3)), '标签 3 个决定只复现 2 个，覆盖率必须露出来');
  assert.equal(verdict.pairsCompared, 6, '对数要报，误配膨胀看这个');
});

test('集合对集合：一条都没对上 → 否；空集合不抛', () => {
  const none = matchDecisionSets([{ subject: 'user', attr: '结论', value: '公司名', negative: false }], [{ subject: 'product', attr: '风格', value: '半透明', negative: true }], { tau: 0.5 });
  assert.equal(none.same, false);
  assert.equal(none.decisionCoverage, 0);
  const empty = matchDecisionSets([], []);
  assert.equal(empty.same, false);
  assert.equal(empty.decisionCoverage, null);
});

test('极性即使在集合里也永不降级：候选 ¬X 不会配上标签 X', () => {
  const verdict = matchDecisionSets(
    [{ subject: 'product', attr: '风格', value: '半透明', negative: true }],
    [{ subject: 'product', attr: '风格', value: '半透明', negative: false }],
    { tau: 0.3 },
  );
  assert.equal(verdict.same, false);
});

test('条件边际工具：关掉 subject 后同一对能过（用来量 subject 的净贡献）', () => {
  const left = { subject: 'product', attr: '风格', value: '半透明', negative: true };
  const right = { subject: 'project', attr: '风格', value: '半透明', negative: true };
  assert.equal(sameStructured(left, right).same, false);
  assert.equal(sameStructuredWithout(left, right, { skip: 'subject' }).same, true);
});

test('subject 三档：strict 硬拒、adjacent 放行 product/project/agent 互跳、off 不判', () => {
  const left = { subject: 'project', attr: '结论', value: '三工作区并行', negative: false };
  const right = { subject: 'product', attr: '结论', value: '三工作区并行', negative: false };
  assert.equal(sameStructured(left, right).same, false, 'strict 应拒');
  assert.equal(sameStructured(left, right, { subjectMode: 'adjacent' }).same, true, 'adjacent 应放行相邻类');
  assert.equal(sameStructured(left, right, { subjectMode: 'off' }).same, true);
  const far = { subject: 'user', attr: '结论', value: '三工作区并行', negative: false };
  assert.equal(sameStructured(left, far, { subjectMode: 'adjacent' }).same, false, 'user 与 product/project/agent 不互跳');
});
