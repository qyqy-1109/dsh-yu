/**
 * 尺子校准 v2（schema v5：集合对集合）。
 *
 * 三个量必须同时报，否则虚高：
 *   ① pair 级命中率（一条记录对上就算命中 —— 会藏漏检）
 *   ② 决定级复现率（标签 3 个决定只复现 1 个，另外 2 个是漏的）
 *   ③ 对数（候选决定 × 标签决定 —— 集合变大后误配面变大，看这个）
 * decisionCoverageMean 定义（2026-11-24 钉死，别改）：逐对先算「该对命中的金标决定数 / 该对金标决定数」，
 * 再对**金标为真的那几对**取算术平均；分母是每对各自的金标决定数，不是总决定数。
 * 钉它的原因：0.139 与 0.137 这种 0.002 的差，只有在同一口径下才是「抽取差」，换口径就成了噪声。
 *
 * 外加 **subject / attr 条件的边际贡献**：把该条件关掉再跑一遍，看它拒掉的是真对还是误配。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { matchDecisionSets, sameStructuredWithout, COMPARE_VERSION } from '../lib/replay-compare.js';

function parseArgs(argv) {
  const args = { schema: null, assertion: null, gold: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--schema') args.schema = argv[++i];
    else if (token === '--assertion') args.assertion = argv[++i];
    else if (token === '--gold') args.gold = argv[++i];
    else throw new Error(`不认识的参数：${token}`);
  }
  return args;
}

const readJsonl = (path) =>
  readFileSync(resolve(path), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

const args = parseArgs(process.argv.slice(2));
const schemaRows = readJsonl(args.schema);
const schemaHeader = schemaRows[0]?.type === 'header' ? schemaRows[0] : null;
const byKey = new Map(schemaRows.filter((row) => row.type !== 'header').map((row) => [row.key, row]));

const pairs = [];
for (const name of [args.assertion, args.gold]) {
  const file = resolve(name).split(/[\\/]/).pop();
  for (const row of readJsonl(name)) {
    if (typeof row.n !== 'number') continue;
    const goldSame = file.startsWith('assertion') ? true : row.pairSameGold === true;
    const candidate = byKey.get(`${file}#${row.n}#candidate`);
    const label = byKey.get(`${file}#${row.n}#label`);
    if (candidate === undefined || label === undefined) continue;
    if ((candidate.decisions ?? []).length === 0 || (label.decisions ?? []).length === 0) continue;
    pairs.push({ key: `${file}#${row.n}`, goldSame, candidate: candidate.decisions, label: label.decisions });
  }
}

const positives = pairs.filter((pair) => pair.goldSame);

/** 跑一遍给定条件（可关掉 subject / attr） */
function run({ tau, skip = null, subjectMode = 'strict' }) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let pairsCompared = 0;
  let decisionCoverageSum = 0;
  const misses = [];
  for (const pair of pairs) {
    let same;
    let decisionCoverage = null;
    if (skip === null) {
      const verdict = matchDecisionSets(pair.candidate, pair.label, { tau, subjectMode });
      same = verdict.same;
      decisionCoverage = verdict.decisionCoverage;
      pairsCompared += verdict.pairsCompared;
    } else {
      // 关掉某条件：把两侧该字段统一成同一个值，再逐对判
      const strip = (list, field) => list.map((item) => ({ ...item, [field]: field === 'subject' ? 'product' : '风格' }));
      const left = strip(pair.candidate, skip);
      const right = strip(pair.label, skip);
      const verdict = matchDecisionSets(left, right, { tau, subjectMode });
      same = verdict.same;
      decisionCoverage = verdict.decisionCoverage;
      pairsCompared += verdict.pairsCompared;
    }
    if (same && pair.goldSame) tp += 1;
    else if (same && !pair.goldSame) fp += 1;
    else if (!same && pair.goldSame) {
      fn += 1;
      misses.push(pair.key);
    } else tn += 1;
    if (pair.goldSame && decisionCoverage !== null) decisionCoverageSum += decisionCoverage;
  }
  return {
    tau,
    skip,
    subjectMode,
    pairs: pairs.length,
    positives: positives.length,
    tp,
    fp,
    fn,
    tn,
    pairCoverage: tp + fn === 0 ? null : Number((tp / (tp + fn)).toFixed(3)),
    pairPrecision: tp + fp === 0 ? null : Number((tp / (tp + fp)).toFixed(3)),
    rejectPrecision: tn + fn === 0 ? null : Number((tn / (tn + fn)).toFixed(3)),
    decisionCoverageMean: positives.length === 0 ? null : Number((decisionCoverageSum / positives.length).toFixed(3)),
    pairsCompared,
    misses,
  };
}

const sweep = [0.3, 0.4, 0.5, 0.6, 0.7].map((tau) => run({ tau }));

console.log(
  JSON.stringify(
    {
      compare: COMPARE_VERSION,
      promptVersion: schemaHeader?.promptVersion ?? null,
      schemaItems: byKey.size,
      schemaDegraded: schemaHeader?.degraded ?? null,
      pairsUsable: pairs.length,
      positives: positives.length,
      sweep: sweep.map(({ misses, ...rest }) => rest),
      subjectModesAt03: {
        note: 'test-retest 显示 project 稳定率只有 0.40（product/agent 都是 1.00），所以 subject 硬门可能在吞真对；三档对比看净收益',
        strict: (({ misses, ...rest }) => rest)(run({ tau: 0.3, subjectMode: 'strict' })),
        adjacent: (({ misses, ...rest }) => rest)(run({ tau: 0.3, subjectMode: 'adjacent' })),
        off: (({ misses, ...rest }) => rest)(run({ tau: 0.3, subjectMode: 'off' })),
      },
      marginalsAt05: {
        note: '关掉某条件看它拒掉的是真对还是误配；净负（拒掉真对多于防住误配）就该放宽',
        all: (({ misses, ...rest }) => rest)(run({ tau: 0.5 })),
        withoutSubject: (({ misses, ...rest }) => rest)(run({ tau: 0.5, skip: 'subject' })),
        withoutAttr: (({ misses, ...rest }) => rest)(run({ tau: 0.5, skip: 'attr' })),
      },
      detailAt05: run({ tau: 0.5 }),
    },
    null,
    2,
  ),
);
