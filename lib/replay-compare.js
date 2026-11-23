/**
 * 尺子：结构化决定的**确定性判等**（判据 v1.4，四条）。
 *
 * 分工原则：模型做理解（把文本抽成 {subject, attr, value, negative}），尺子只做比较。
 * 所以这个文件里**不出现任何模型调用、不出现分词启发式之外的猜测**——
 * 它必须是可复算的：同样的两份结构化输入，永远给同样的判定。
 *
 * 四条（判据 v1.4 定稿）：
 *   1. negative 相等 —— **永不降级**（¬X 与 X 不是同一个决定；与引擎 isSameClaim 同纪律）
 *   2. subject 同类 —— 粗粒度闭集；任一方 other 时不参与（记 subject 未定）
 *   3. attr 相等 —— 闭集 12 类；任一方 unknown 时不参与（记降级）
 *   4. 取值实体包含 ≥ τ —— τ 是暂定起点 0.5，必须在校准集上扫定
 */
import { tokenize } from './text.js';
import { isStopToken } from './rank.js';
import { ATTR_CLASSES } from './replay-assertion.js';

export const COMPARE_VERSION = 'compare-v1';
export const SUBJECT_CLASSES = ['user', 'agent', 'product', 'project', 'other'];
export const DEFAULT_TAU = 0.5;

/** 取值实体：确定性分词 → 去单字/停用词/虚词碎片。 */
export function valueEntities(value) {
  const out = new Set();
  for (const token of tokenize(String(value ?? ''))) {
    if ([...token].length < 2) continue;
    if (isStopToken(token)) continue;
    const first = [...token][0];
    const last = [...token].at(-1);
    if ('的了着过和与也都就才而之其这那个些上中下里在'.includes(first)) continue;
    if ('的了着过和与也都就才而之其这那个些上中下里在'.includes(last)) continue;
    out.add(token);
  }
  return out;
}

/** 两份结构化决定是否同一（四条判据）。 */
export function sameStructured(left, right, options = {}) {
  const tau = Number(options.tau ?? DEFAULT_TAU);
  const degraded = { negative: false, subject: false, attr: false };
  const reasons = [];

  // ① 极性：永不降级
  const leftNeg = left?.negative === true;
  const rightNeg = right?.negative === true;
  if (leftNeg !== rightNeg) {
    return { same: false, degraded, reasons: ['polarity-mismatch'], containment: null, tau };
  }

  // ② 主语粗类（三档：strict / adjacent / off）
  const mode = String(options.subjectMode ?? 'strict');
  const leftSubject = String(left?.subject ?? 'other');
  const rightSubject = String(right?.subject ?? 'other');
  if (mode === 'off') {
    /* 关掉：不判 */
  } else if (leftSubject === 'other' || rightSubject === 'other') {
    degraded.subject = true;
  } else if (leftSubject !== rightSubject) {
    const ADJACENT = new Set(['product', 'project', 'agent']);
    const adjacentOk = mode === 'adjacent' && ADJACENT.has(leftSubject) && ADJACENT.has(rightSubject);
    if (!adjacentOk) {
      return { same: false, degraded, reasons: ['subject-mismatch'], containment: null, tau };
    }
  }

  // ③ 属性闭集
  const leftAttr = String(left?.attr ?? 'unknown');
  const rightAttr = String(right?.attr ?? 'unknown');
  if (leftAttr !== 'unknown' && !ATTR_CLASSES.includes(leftAttr)) reasons.push(`attr-out-of-set:${leftAttr}`);
  if (leftAttr === 'unknown' || rightAttr === 'unknown') degraded.attr = true;
  else if (leftAttr !== rightAttr) {
    return { same: false, degraded, reasons: ['attr-mismatch'], containment: null, tau };
  }

  // ④ 取值实体包含
  const a = valueEntities(left?.value);
  const b = valueEntities(right?.value);
  if (a.size === 0 || b.size === 0) {
    return { same: false, degraded, reasons: ['value-empty'], containment: 0, tau };
  }
  let inter = 0;
  for (const token of a) if (b.has(token)) inter += 1;
  const containment = inter / Math.min(a.size, b.size);
  const same = containment >= tau;
  if (!same) reasons.push('value-mismatch');
  return {
    same,
    degraded,
    anyDegraded: degraded.subject || degraded.attr,
    reasons,
    containment: Number(containment.toFixed(3)),
    tau,
  };
}

/** 把 subject 规整进闭集（网输出越界时归 other，不猜）。 */
export function normalizeSubject(subject) {
  const value = String(subject ?? '').trim();
  return SUBJECT_CLASSES.includes(value) ? value : 'other';
}


/**
 * 集合对集合判等（schema v5）：候选的任一决定与标签的任一决定对上，即这条**记录**算命中。
 *
 * 两个必须同时报的量（否则虚高）：
 * ① **pair 级**命中率——一条记录对一个对得上就算命中，会把漏检藏起来；
 * ② **决定级**复现率——标签里 3 个决定、候选只命中 1 个时，另外 2 个是漏的。
 * 另外按"决定对数"看待选匹配，碰撞面变大，所以 pairPrecision 之外要报**对数**。
 */
export function matchDecisionSets(candidateDecisions, labelDecisions, options = {}) {
  const tau = Number(options.tau ?? DEFAULT_TAU);
  const candidates = Array.isArray(candidateDecisions) ? candidateDecisions : [];
  const labels = Array.isArray(labelDecisions) ? labelDecisions : [];
  const matches = [];
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = 0; j < candidates.length; j += 1) {
      const verdict = sameStructured(candidates[j], labels[i], { tau });
      if (verdict.same) matches.push({ labelIndex: i, candidateIndex: j, containment: verdict.containment, reasons: verdict.reasons });
    }
  }
  const matchedLabelIndexes = new Set(matches.map((match) => match.labelIndex));
  const matchedCandidateIndexes = new Set(matches.map((match) => match.candidateIndex));
  return {
    same: matches.length > 0,
    tau,
    candidateCount: candidates.length,
    labelCount: labels.length,
    pairsCompared: candidates.length * labels.length,
    matches,
    decisionCoverage: labels.length === 0 ? null : Number((matchedLabelIndexes.size / labels.length).toFixed(3)),
    candidateCoverage: candidates.length === 0 ? null : Number((matchedCandidateIndexes.size / candidates.length).toFixed(3)),
  };
}

/** 只测某一条条件（用于量 subject / attr 的边际贡献：把该条件关掉再跑一遍）。 */
export function sameStructuredWithout(left, right, options = {}) {
  const skip = options.skip ?? null;
  if (skip === null) return sameStructured(left, right, options);
  const patchedLeft = { ...left };
  const patchedRight = { ...right };
  if (skip === 'subject') {
    patchedLeft.subject = 'product';
    patchedRight.subject = 'product';
  }
  if (skip === 'attr') {
    patchedLeft.attr = '风格';
    patchedRight.attr = '风格';
  }
  return sameStructured(patchedLeft, patchedRight, options);
}
