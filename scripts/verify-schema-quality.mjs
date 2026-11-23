/**
 * 网侧三元组质量：结构化 ≠ 正确，这一层必须单独量。
 *
 * 做法：把新候选（schema-v1）对齐到**人标过的条目**（12 条断言集 + 人审池 36 条，
 * 它们的候选侧三元组是我逐条标的），再比字段：
 *   属性一致率 / 主语类一致率 / 极性正确率 / unknown 率
 *
 * 局限必须写在报告里：对齐靠实体重合（≥0.6），不是同一条文本；
 * 对齐本身有误差，所以这四个率是**近似值**，不是逐条精确核验。
 * 精确核验要另抽一批结构化输出逐条人标——那是下一步。
 *
 * 用法：
 *   node scripts/verify-schema-quality.mjs --candidates out/cand-schema-v1.jsonl \
 *     --assertion labels/assertion-set-12-2026-11-19.jsonl \
 *     --pool-labels labels/review-pool-labels-lead-2026-11-19.jsonl \
 *     --pool labels/review-pool-2026-11-19.jsonl
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { entityOverlap } from '../lib/replay-recall.js';

function parseArgs(argv) {
  const args = { candidates: null, assertion: null, poolLabels: null, pool: null, align: 0.6 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--candidates') args.candidates = argv[++i];
    else if (token === '--assertion') args.assertion = argv[++i];
    else if (token === '--pool-labels') args.poolLabels = argv[++i];
    else if (token === '--pool') args.pool = argv[++i];
    else if (token === '--align') args.align = Number(argv[++i]);
    else throw new Error(`不认识的参数：${token}`);
  }
  return args;
}

const readRows = (path) =>
  readFileSync(resolve(path), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((row) => typeof row.n === 'number');

const args = parseArgs(process.argv.slice(2));
const candidates = readFileSync(resolve(args.candidates), 'utf8').trim().split('\n').slice(1).map((line) => JSON.parse(line));

// 人标三元组（候选侧）：12 条断言集 + 人审池 36 条
const human = [];
for (const row of readRows(args.assertion)) {
  human.push({ from: 'assertion', n: row.n, text: row.candidateText, subject: null, attr: row.attr, value: row.value, negative: null, humanSubjectClass: null });
}
const poolByN = new Map(readRows(args.pool).map((row) => [row.n, row]));
for (const row of readRows(args.poolLabels)) {
  const poolRow = poolByN.get(row.n);
  human.push({ from: 'pool', n: row.n, text: poolRow?.candidateText ?? '', subject: null, attr: row.attr, value: row.value, negative: null, humanSubjectClass: null });
}

/** 主语粗类：人标里没有闭集，就用可对齐的映射（用户→user，我→agent，面板/插件/库/引擎→product） */
function subjectClassOf(text) {
  const raw = String(text ?? '');
  if (/用户|他|你/.test(raw)) return 'user';
  if (/我|我们/.test(raw)) return 'agent';
  if (/面板|插件|记忆库|引擎|库|入口|导航/.test(raw)) return 'product';
  if (/项目|工作区|shuttle|dsh/.test(raw)) return 'project';
  return 'other';
}

const aligned = [];
for (const item of human) {
  if (!item.text) continue;
  let best = null;
  for (const candidate of candidates) {
    const { score } = entityOverlap(item.text, candidate.text);
    if (best === null || score > best.score) best = { candidate, score };
  }
  if (best === null || best.score < args.align) continue;
  const humanSubject = subjectClassOf(item.text);
  aligned.push({
    from: item.from,
    n: item.n,
    alignScore: Number(best.score.toFixed(2)),
    text: item.text.slice(0, 40),
    attr: { human: item.attr, net: best.candidate.attr, ok: item.attr === best.candidate.attr },
    subject: { human: humanSubject, net: best.candidate.subject, ok: humanSubject === best.candidate.subject },
    value: { human: item.value, net: best.candidate.value },
  });
}

const tally = (key) => {
  const ok = aligned.filter((row) => row[key].ok).length;
  return { aligned: aligned.length, ok, rate: aligned.length === 0 ? null : Number((ok / aligned.length).toFixed(3)) };
};

console.log(
  JSON.stringify(
    {
      schemaVersion: 'schema-v1',
      note: '对齐靠实体重合 ≥ ' + args.align + '，不是同一条文本：四率是近似值；精确核验需另抽结构化输出逐条人标',
      candidates: candidates.length,
      humanLabelled: human.length,
      aligned: aligned.length,
      attrAgreement: tally('attr'),
      subjectAgreement: tally('subject'),
      attrDistribution: Object.entries(candidates.reduce((acc, row) => {
        acc[row.attr] = (acc[row.attr] ?? 0) + 1;
        return acc;
      }, {})).sort((a, b) => b[1] - a[1]),
      unknownRate: Number((candidates.filter((row) => row.attr === 'unknown').length / candidates.length).toFixed(3)),
      negativeRate: Number((candidates.filter((row) => row.negative === true).length / candidates.length).toFixed(3)),
      mismatches: aligned.filter((row) => !row.attr.ok || !row.subject.ok).slice(0, 12),
    },
    null,
    2,
  ),
);
