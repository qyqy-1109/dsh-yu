/**
 * 命题类型分类器 + 两层门的测试。
 *
 * 守三条：确定性（同文本同结果）、版本可钉、以及"unknown 不参与主语门"（宁可放过不误杀）。
 * 注意：这里测的是**机制**，不是准头——准头由 scripts/calibrate-types.mjs 在 gold-20 上报。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { classifySubject, classifyType, sameProposition, PROPOSITION_TYPES, TYPE_CLASSIFIER_VERSION } from '../lib/replay-proposition.js';

test('类型：六类都认得出（道义模态 / 情感 / 目标 / 策略 / 评价 / 兜底事实）', () => {
  assert.equal(classifyType('记忆语义必须由人确认，禁止自动更新').type, 'requirement');
  assert.equal(classifyType('偏好用 TDD 方式开发').type, 'preference');
  assert.equal(classifyType('长期目标是造一个有自己倾向的人').type, 'goal');
  assert.equal(classifyType('主张先模拟并等待模型发展').type, 'strategy');
  assert.equal(classifyType('共享 session 更适合做存储，不算真正的记忆').type, 'evaluation');
  assert.equal(classifyType('cordis.patch.yml 里加了 llm-deepseek 路由').type, 'fact');
});

test('类型：确定性 —— 同一文本两次判定一致，且带版本号', () => {
  const text = '面板必须有动态效果，且帧率要有保证';
  const first = classifyType(text);
  const second = classifyType(text);
  assert.deepEqual(first, second);
  assert.equal(first.classifier, TYPE_CLASSIFIER_VERSION);
  assert.ok(PROPOSITION_TYPES.includes(first.type));
});

test('主语：抽不出来就 unknown，不猜', () => {
  assert.equal(classifySubject('用户偏好深空星图').subject, 'user');
  assert.equal(classifySubject('插件面板的入口在左侧导航').subject, 'product');
  assert.equal(classifySubject('我最初给的面板被否定了').subject, 'agent');
  assert.equal(classifySubject('深空星图').subject, 'unknown');
});

test('门：类型不同直接否', () => {
  const verdict = sameProposition(
    { text: '用户对动画流畅度很敏感' },
    { text: '面板必须有帧率保障' },
  );
  assert.equal(verdict.same, false);
  assert.match(verdict.reason, /类型不同/);
});

test('门：unknown 主语不参与拦截（宁可放过，不误杀）', () => {
  const verdict = sameProposition({ text: '深空星图' }, { text: '面板采用深空星图' });
  assert.equal(verdict.candidateSubject, 'unknown');
  assert.equal(verdict.same, true, '主语抽不出来就不许拿它当否决理由');
});

test('门：同一类型且主语明确冲突 → 否', () => {
  const verdict = sameProposition({ text: '用户目标是造一个有倾向的人' }, { text: '插件目标是造一个有倾向的人' });
  assert.equal(verdict.candidateType, verdict.labelType);
  assert.equal(verdict.same, false);
  assert.match(verdict.reason, /主语不同/);
});
