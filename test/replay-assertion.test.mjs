/**
 * 断言层原语的测试。
 *
 * 注意范围：这里只测**确定性原语**（抽属性、判极性、取值实体化），
 * **不测"能不能认出同一决定"**——因为那一层在 12 条双标集上没通过校准
 * （三个取值口径分别只覆盖 0.333 / 0.25 / 0.000），现在写通过性测试等于把失败包装成通过。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { attrOf, polarityOf, extractDecision, valueEntities, ATTR_CLASSES, ASSERTION_VERSION } from '../lib/replay-assertion.js';

test('属性维度：按维度归类命中，不收录原句', () => {
  assert.equal(attrOf('轴注册表归人格层').attr, '归属');
  assert.equal(attrOf('先做会成长的自我，再接其他能力').attr, '顺序');
  assert.equal(attrOf('面板偏好半透明').attr, '风格');
  assert.equal(attrOf('一句跟维度无关的话').attr, 'unknown');
});

test('极性：否决类词一律判负，并留证据', () => {
  const negative = polarityOf('半透明已被否决，不再采用');
  assert.equal(negative.negative, true);
  assert.ok(negative.evidence !== null);
  assert.equal(polarityOf('采用纯星图风格').negative, false);
});

test('抽决定：抽不出属性要标 degraded（降级占比是读数）', () => {
  const degraded = extractDecision('一句跟维度无关的话');
  assert.equal(degraded.degraded, true);
  const normal = extractDecision('轴注册表归人格层');
  assert.equal(normal.degraded, false);
  assert.equal(normal.attr, '归属');
  assert.equal(normal.version, ASSERTION_VERSION);
});

test('取值实体化：确定性，且去虚词碎片', () => {
  const first = valueEntities('半透明玻璃拟态');
  const second = valueEntities('半透明玻璃拟态');
  assert.deepEqual([...first].sort(), [...second].sort());
  assert.ok(first.has('半透') || first.has('透明'));
});

test('attr 闭集：判据/代码同源，12 类不多不少', () => {
  assert.equal(ATTR_CLASSES.length, 12);
  for (const name of ATTR_CLASSES) assert.ok(typeof name === 'string' && name.length > 0);
  assert.ok(ATTR_CLASSES.includes('命名'), 'v1.4 初稿漏过的维度必须留在这份闭集里');
  // attrOf 只会产出闭集成员或 unknown
  for (const text of ['轴注册表归人格层', '先做成长自我再接手脚', '取名叫余', '一句无关的话']) {
    const { attr } = attrOf(text);
    assert.ok(attr === 'unknown' || ATTR_CLASSES.includes(attr), `attrOf 产出了闭集外的值：${attr}`);
  }
});
