/**
 * 类型分类器校准（规则版，零模型）：在 gold-20 上报混淆矩阵 + 类型门的拦截效果。
 *
 * 为什么单独一个脚本：分类器是**尺子的一部分**，它自己的准头必须单独量，
 * 不能混在召回数里。它错了要能看见错在哪一格，而不是笼统"分数不高"。
 *
 * 用法：
 *   node scripts/calibrate-types.mjs --types labels/types-20-lead-2026-11-19.jsonl
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { classifyType, classifySubject, sameProposition, PROPOSITION_TYPES, TYPE_CLASSIFIER_VERSION } from '../lib/replay-proposition.js';

function parseArgs(argv) {
  const args = { types: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--types') args.types = argv[++i];
    else throw new Error(`不认识的参数：${token}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const rows = readFileSync(resolve(args.types), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => typeof row.n === 'number');

// 混淆矩阵：行 = 金标类型，列 = 规则预测
const matrix = new Map();
const errors = [];
const count = (gold, predicted) => matrix.set(`${gold}|${predicted}`, (matrix.get(`${gold}|${predicted}`) ?? 0) + 1);
let typeTotal = 0;
let typeCorrect = 0;
for (const row of rows) {
  const pairs = [['candidate', row.candidateText, row.candidateTypeGold]];
  if (row.labelText !== null) pairs.push(['label', row.labelText, row.labelTypeGold]);
  for (const [where, text, gold] of pairs) {
    const predicted = classifyType(text).type;
    count(gold, predicted);
    typeTotal += 1;
    if (predicted === gold) typeCorrect += 1;
    else errors.push({ n: row.n, where, gold, predicted, text: String(text).slice(0, 40) });
  }
}

// 类型门 + 主语门 vs 金标 pairSame
const gate = [];
for (const row of rows.filter((r) => r.labelText !== null)) {
  const verdict = sameProposition({ text: row.candidateText }, { text: row.labelText });
  const predicted = verdict.same;
  const gold = row.pairSameGold === true;
  gate.push({
    n: row.n,
    predicted,
    gold,
    ok: predicted === gold,
    reason: verdict.reason,
    candidateType: verdict.candidateType,
    labelType: verdict.labelType,
    candidateSubject: verdict.candidateSubject,
    labelSubject: verdict.labelSubject,
  });
}
const tp = gate.filter((g) => g.predicted === false && g.gold === false).length;
const fp = gate.filter((g) => g.predicted === false && g.gold === true).length;
const tn = gate.filter((g) => g.predicted === true && g.gold === true).length;
const fn = gate.filter((g) => g.predicted === true && g.gold === false).length;

// type-only 的边际：只看类型是否相同
const typeOnlyGate = [];
for (const row of rows.filter((r) => r.labelText !== null)) {
  const same = classifyType(row.candidateText).type === classifyType(row.labelText).type;
  typeOnlyGate.push({ n: row.n, predicted: same, gold: row.pairSameGold === true });
}
const summarize = (list) => {
  const tn = list.filter((g) => g.predicted === true && g.gold === true).length;
  const fn = list.filter((g) => g.predicted === true && g.gold === false).length;
  const tp = list.filter((g) => g.predicted === false && g.gold === false).length;
  const fp = list.filter((g) => g.predicted === false && g.gold === true).length;
  return { acceptedCorrectly: tn, acceptedWrongly: fn, rejectedCorrectly: tp, rejectedWrongly: fp, pairPrecision: tn + fn === 0 ? null : Number((tn / (tn + fn)).toFixed(3)), rejectPrecision: tp + fp === 0 ? null : Number((tp / (tp + fp)).toFixed(3)) };
};

const table = {};
for (const gold of PROPOSITION_TYPES) {
  table[gold] = {};
  for (const predicted of PROPOSITION_TYPES) {
    const value = matrix.get(`${gold}|${predicted}`);
    if (value !== undefined) table[gold][predicted] = value;
  }
}

console.log(
  JSON.stringify(
    {
      classifier: TYPE_CLASSIFIER_VERSION,
      typeAccuracy: { total: typeTotal, correct: typeCorrect, rate: Number((typeCorrect / typeTotal).toFixed(3)) },
      confusion: table,
      typeErrors: errors,
      gate: {
        note: '类型门 + 主语门；predicted=false 表示"判为非同一命题"',
        n: gate.length,
        // 相对金标"配对正确"：把"判非同一命题"当作否定预测
        rejectedCorrectly: tp,
        rejectedWrongly: fp,
        acceptedCorrectly: tn,
        acceptedWrongly: fn,
        pairPrecision: tn + fn === 0 ? null : Number((tn / (tn + fn)).toFixed(3)),
        rejectPrecision: tp + fp === 0 ? null : Number((tp / (tp + fp)).toFixed(3)),
      },
      gateTypeOnly: summarize(typeOnlyGate),
      gateTypePlusSubject: summarize(gate),
      subjectGateMarginal: 'type-only 与 type+subject 的差就是主语门的净贡献（实测净负 → 默认不启用）',
      gateDetail: gate,
      subjectOf: rows.map((row) => ({ n: row.n, subject: classifySubject(row.candidateText).subject })),
    },
    null,
    2,
  ),
);
