/**
 * 尺子校准：在金标上扫阈值与稀有词规则，报召回/精确。
 *
 * 为什么要扫而不是直接调参：15 条金标能调出一打漂亮曲线。这个脚本的作用是**把选择留下证据**，
 * 不是把数字调好看。定阈值的最后一步仍然是跑全量。
 *
 * 用法：
 *   node scripts/calibrate-ruler.mjs --gold labels/gold-2026-11-17.jsonl \
 *     --candidates out/cand-v1-smoke.jsonl --candidates out/cand-v1-3sess.jsonl \
 *     --pairs out/replay-pairs-2026-11-17-v0.2.2.jsonl
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { tokenize } from '../lib/text.js';
import { isStopToken } from '../lib/rank.js';
import { entityOverlap, sharedEvidence } from '../lib/replay-recall.js';

function parseArgs(argv) {
  const args = { gold: null, candidates: [], pairs: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--gold') args.gold = argv[++i];
    else if (token === '--candidates') args.candidates.push(argv[++i]);
    else if (token === '--pairs') args.pairs = argv[++i];
    else throw new Error(`不认识的参数：${token}`);
  }
  return args;
}

const readAll = (path) => readFileSync(resolve(path), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

function contentTokens(text) {
  const out = new Set();
  for (const token of tokenize(String(text ?? ''))) {
    if ([...token].length < 2) continue;
    if (isStopToken(token)) continue;
    if (/^\d+([.]\d+)?$/.test(token)) continue;
    out.add(token);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const gold = readAll(args.gold).filter((row) => typeof row.n === 'number');
const candidates = args.candidates.flatMap((path) => readAll(path).filter((row) => row.type !== 'header'));
const pairs = readAll(args.pairs).filter((row) => row.status === 'created' && row.kind !== 'slot' && row.id);

// 标签语料：只用来算 df（稀有词判据），不影响候选与标签的重合度算法
const df = new Map();
for (const pair of pairs) for (const token of contentTokens(pair.text)) df.set(token, (df.get(token) ?? 0) + 1);

const rows = candidates.map((candidate, index) => {
  const goldRow = gold.find((row) => row.n === index + 1);
  const inWindow = pairs.filter(
    (pair) =>
      pair.sessionId === candidate.sessionId &&
      typeof pair.turn === 'number' &&
      pair.turn >= candidate.fromTurn &&
      pair.turn <= candidate.toTurn,
  );
  let best = null;
  for (const label of inWindow) {
    const { score } = entityOverlap(candidate.text, label.text);
    const evidence = sharedEvidence(candidate.text, label.text, { df });
    if (best === null || score > best.score) {
      best = { id: label.id.slice(0, 8), score: Number(score.toFixed(3)), shared: evidence.shared, rare: evidence.rare, junction: evidence.junction, rareCount: evidence.rare.length, kind: label.kind };
    }
  }
  const goldIds = goldRow?.matchGold ?? [];
  return {
    n: index + 1,
    text: candidate.text,
    verdict: goldRow?.verdict ?? null,
    goldIds,
    gold: goldIds.join(','),
    best,
  };
});

/** 规则：containment ≥ floor，且共享的稀有词（df ≤ rareK）不少于 rareMin 个。 */
function evaluate({ floor, rareMin, rareK }) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const misses = [];
  const falseHits = [];
  for (const row of rows) {
    const usable = row.best !== null && row.best.score >= floor && (rareMin === 0 || row.best.rareCount >= rareMin);
    const hit = usable ? row.best.id : null;
    const goldIds = row.goldIds;
    if (goldIds.length === 0) {
      if (hit !== null) {
        fp += 1;
        falseHits.push({ n: row.n, hit, text: row.text.slice(0, 24) });
      }
      continue;
    }
    if (hit !== null && goldIds.includes(hit)) tp += 1;
    else {
      if (hit !== null) {
        fp += 1;
        falseHits.push({ n: row.n, hit, text: row.text.slice(0, 24) });
      }
      fn += 1;
      misses.push({ n: row.n, gold: row.gold, score: row.best?.score ?? null, text: row.text.slice(0, 24) });
    }
  }
  const positives = rows.filter((row) => row.goldIds.length > 0).length;
  return {
    floor,
    rareMin,
    rareK,
    tp,
    fp,
    fn,
    recall: positives === 0 ? null : Number((tp / positives).toFixed(3)),
    precision: tp + fp === 0 ? null : Number((tp / (tp + fp)).toFixed(3)),
    falseHits,
    misses,
  };
}

const grid = [];
for (const floor of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3]) {
  grid.push(evaluate({ floor, rareMin: 0, rareK: 3 })); // 纯 containment（旧尺子）
  for (const rareMin of [1, 2]) grid.push(evaluate({ floor, rareMin, rareK: 3 }));
}

console.log(
  JSON.stringify(
    {
      gold: { file: resolve(args.gold), positives: rows.filter((row) => row.goldIds.length > 0).length, negatives: rows.filter((row) => row.goldIds.length === 0).length },
      rows: rows.map((row) => ({ n: row.n, gold: row.gold || '-', best: row.best === null ? null : { id: row.best.id, score: row.best.score, rare: row.best.rare }, text: row.text.slice(0, 40) })),
      grid: grid.map(({ falseHits, misses, ...rest }) => rest),
      detail: { noRareRuleAt010: grid.find((g) => g.floor === 0.1 && g.rareMin === 0), rareMin1At010: grid.find((g) => g.floor === 0.1 && g.rareMin === 1), rareMin2At005: grid.find((g) => g.floor === 0.05 && g.rareMin === 2) },
    },
    null,
    2,
  ),
);
