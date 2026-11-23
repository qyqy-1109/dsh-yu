/**
 * 断言层校准：在 12 条双标正例 + gold-20 上量规则覆盖，并报 E 的排除数。
 *
 * 四条透明要求（审查方定的护栏）：
 * ① E 只读冻结 verdict，不重判；② 报 E 排除数；③ useful 与 raw 双召回并列；
 * ④ 降级（抽不出属性）单独报，不与正常路径混算。
 *
 * 用法：
 *   node scripts/calibrate-assertion.mjs \
 *     --assertion labels/assertion-set-12-2026-11-19.jsonl \
 *     --pool labels/review-pool-2026-11-19.jsonl \
 *     --pool-labels labels/review-pool-labels-lead-2026-11-19.jsonl \
 *     --gold labels/types-20-lead-2026-11-19.jsonl
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sameDecision, extractDecision, ASSERTION_VERSION } from '../lib/replay-assertion.js';
import { classifyType } from '../lib/replay-proposition.js';

function parseArgs(argv) {
  const args = { assertion: null, pool: null, poolLabels: null, gold: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--assertion') args.assertion = argv[++i];
    else if (token === '--pool') args.pool = argv[++i];
    else if (token === '--pool-labels') args.poolLabels = argv[++i];
    else if (token === '--gold') args.gold = argv[++i];
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

// ① 12 条正例：规则能不能把它们认成同一决定
const assertion = readRows(args.assertion);
const covered = [];
for (const row of assertion) {
  const verdict = sameDecision(row.candidateText, row.labelText);
  covered.push({ n: row.n, same: verdict.same, degraded: verdict.degraded, reason: verdict.reason, containment: verdict.containment ?? null, candidateAttr: verdict.left.attr, labelAttr: verdict.right.attr });
}
const recovered = covered.filter((row) => row.same === true).length;

// ② 人审池：E 排除数 + useful/raw
const pool = readRows(args.pool);
const poolLabels = readRows(args.poolLabels);
const labelByN = new Map(poolLabels.map((row) => [row.n, row]));
const eExcluded = pool.filter((row) => labelByN.get(row.n)?.verdict === '不该记');
const usefulPool = pool.filter((row) => labelByN.get(row.n)?.verdict !== '不该记');
const pairSameYes = pool.filter((row) => labelByN.get(row.n)?.pairSame === true);
const pairSameYesUseful = usefulPool.filter((row) => labelByN.get(row.n)?.pairSame === true);

// ③ gold-20：门之后断言层能捞回多少、会不会乱认
const gold = readRows(args.gold).filter((row) => row.labelText !== null);
const pipeline = gold.map((row) => {
  const typeSame = classifyType(row.candidateText).type === classifyType(row.labelText).type;
  const assertionVerdict = sameDecision(row.candidateText, row.labelText);
  const finalSame = typeSame || assertionVerdict.same;
  return { n: row.n, gold: row.pairSameGold === true, typeSame, assertionSame: assertionVerdict.same, finalSame, recoveredByAssertion: !typeSame && assertionVerdict.same };
});
const summary = (list) => {
  const tn = list.filter((r) => r.finalSame === true && r.gold === true).length;
  const fn = list.filter((r) => r.finalSame === true && r.gold === false).length;
  const tp = list.filter((r) => r.finalSame === false && r.gold === false).length;
  const fp = list.filter((r) => r.finalSame === false && r.gold === true).length;
  return { acceptedCorrectly: tn, acceptedWrongly: fn, rejectedCorrectly: tp, rejectedWrongly: fp, pairPrecision: tn + fn === 0 ? null : Number((tn / (tn + fn)).toFixed(3)), rejectPrecision: tp + fp === 0 ? null : Number((tp / (tp + fp)).toFixed(3)) };
};

console.log(
  JSON.stringify(
    {
      assertion: ASSERTION_VERSION,
      positives12: {
        total: assertion.length,
        recovered,
        coverage: Number((recovered / assertion.length).toFixed(3)),
        degraded: covered.filter((row) => row.degraded === true).length,
        degradedShare: Number((covered.filter((row) => row.degraded === true).length / assertion.length).toFixed(3)),
        detail: covered,
      },
      eGuard: {
        note: 'E 只读冻结 verdict，不重判',
        poolSize: pool.length,
        excludedByE: eExcluded.length,
        excludedShare: Number((eExcluded.length / pool.length).toFixed(3)),
        excludedNs: eExcluded.map((row) => row.n),
        usefulPoolSize: usefulPool.length,
        pairSameYesTotal: pairSameYes.length,
        pairSameYesUseful: pairSameYesUseful.length,
        rawVsUseful: { raw: `${pairSameYes.length}/${pool.length}`, useful: `${pairSameYesUseful.length}/${usefulPool.length}` },
      },
      gold20Pipeline: {
        n: gold.length,
        gateOnly: summary(gold.map((row) => ({ gold: row.pairSameGold === true, finalSame: classifyType(row.candidateText).type === classifyType(row.labelText).type }))),
        gatePlusAssertion: summary(pipeline),
        recoveredByAssertion: pipeline.filter((row) => row.recoveredByAssertion).map((row) => row.n),
        assertionFalseAccepts: pipeline.filter((row) => row.finalSame === true && row.gold === false).map((row) => row.n),
      },
    },
    null,
    2,
  ),
);
