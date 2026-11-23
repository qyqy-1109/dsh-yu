/**
 * test-retest：同一段文本抽两次，看 subject / attr / value / negative 稳不稳。
 *
 * 这一刀决定两件不同的事（qoder r28）：
 *   · **不稳定** → 温度 0 的推理模型也有方差 → subject/attr 门的上限钉在这儿，认命写进 limits；
 *   · **稳定** → 模型是确定的 → #22 那种"两侧同内容、归类不同"是**两侧文本措辞不同**导致的边界模糊 → 归一救得了。
 *
 * 逐类报稳定率：哪一类 attr / subject 不稳，比总稳定率更有用。
 *
 * 用法：
 *   $env:WB_API_KEY=...; node scripts/test-retest-schema.mjs --schema labels/schema-pairs-v5b-2026-11-23.jsonl --limit 20 --out labels/test-retest-2026-11-23.jsonl
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { buildPrompt, parseCandidates, PROMPT_VERSION } from './extract-candidates.mjs';
import { valueEntities } from '../lib/replay-compare.js';

function parseArgs(argv) {
  const args = { schema: null, limit: 20, out: null, model: 'cn:deepseek-v4.1-flash', base: 'http://localhost:7864/v1' };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--schema') args.schema = argv[++i];
    else if (token === '--limit') args.limit = Number(argv[++i]);
    else if (token === '--out') args.out = argv[++i];
    else if (token === '--model') args.model = argv[++i];
    else throw new Error(`不认识的参数：${token}`);
  }
  return args;
}

async function callModel({ base, model, apiKey, text }) {
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 3000, messages: [{ role: 'user', content: buildPrompt(text) }] }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  return parseCandidates(String(payload?.choices?.[0]?.message?.content ?? '')).slice(0, 8);
}

const args = parseArgs(process.argv.slice(2));
const apiKey = process.env.WB_API_KEY;
if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('缺 WB_API_KEY');

const rows = readFileSync(resolve(args.schema), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.type !== 'header');
// 取"有决定的文本"，等距抽样
const withDecisions = rows.filter((row) => (row.decisions ?? []).length > 0);
const step = Math.max(1, Math.floor(withDecisions.length / args.limit));
const sample = [];
for (let i = 0; i < withDecisions.length && sample.length < args.limit; i += step) sample.push(withDecisions[i]);

const results = [];
for (const [index, item] of sample.entries()) {
  let first;
  let second;
  try {
    first = await callModel({ base: args.base, model: args.model, apiKey, text: item.text });
    second = await callModel({ base: args.base, model: args.model, apiKey, text: item.text });
  } catch (error) {
    console.error(`第 ${index + 1}/${sample.length} 条失败：${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  // 按 value 实体重合配对两次输出（≥0.5 视为同一条决定）
  const pairings = [];
  const usedSecond = new Set();
  for (const a of first) {
    let best = null;
    for (let j = 0; j < second.length; j += 1) {
      if (usedSecond.has(j)) continue;
      const ea = valueEntities(a.value);
      const eb = valueEntities(second[j].value);
      if (ea.size === 0 || eb.size === 0) continue;
      let inter = 0;
      for (const token of ea) if (eb.has(token)) inter += 1;
      const score = inter / Math.min(ea.size, eb.size);
      if (best === null || score > best.score) best = { j, score, other: second[j] };
    }
    if (best !== null && best.score >= 0.5) {
      usedSecond.add(best.j);
      pairings.push({ a, b: best.other, score: best.score });
    }
  }
  const stable = {
    key: item.key,
    text: item.text.slice(0, 40),
    firstCount: first.length,
    secondCount: second.length,
    paired: pairings.length,
    subjectStable: pairings.filter((p) => p.a.subject === p.b.subject).length,
    attrStable: pairings.filter((p) => p.a.attr === p.b.attr).length,
    negativeStable: pairings.filter((p) => (p.a.negative === true) === (p.b.negative === true)).length,
    perAttr: pairings.map((p) => ({ attr: p.a.attr, same: p.a.attr === p.b.attr })),
    perSubject: pairings.map((p) => ({ subject: p.a.subject, same: p.a.subject === p.b.subject })),
  };
  results.push(stable);
  console.error(`第 ${index + 1}/${sample.length} 条：配对 ${stable.paired}/${Math.max(first.length, second.length)}，attr 稳 ${stable.attrStable}，subject 稳 ${stable.subjectStable}`);
}

const totalPaired = results.reduce((sum, row) => sum + row.paired, 0);
const rate = (key) => (totalPaired === 0 ? null : Number((results.reduce((sum, row) => sum + row[key], 0) / totalPaired).toFixed(3)));
// 逐类稳定率
const byAttr = new Map();
const bySubject = new Map();
for (const row of results) {
  for (const item of row.perAttr) {
    const bucket = byAttr.get(item.attr) ?? { total: 0, same: 0 };
    bucket.total += 1;
    if (item.same) bucket.same += 1;
    byAttr.set(item.attr, bucket);
  }
  for (const item of row.perSubject) {
    const bucket = bySubject.get(item.subject) ?? { total: 0, same: 0 };
    bucket.total += 1;
    if (item.same) bucket.same += 1;
    bySubject.set(item.subject, bucket);
  }
}
const asRates = (map) =>
  Object.fromEntries([...map.entries()].map(([name, bucket]) => [name, { total: bucket.total, stable: Number((bucket.same / bucket.total).toFixed(3)) }]));

const summary = {
  promptVersion: PROMPT_VERSION,
  model: args.model,
  texts: results.length,
  pairedDecisions: totalPaired,
  subjectStability: rate('subjectStable'),
  attrStability: rate('attrStable'),
  negativeStability: rate('negativeStable'),
  byAttr: asRates(byAttr),
  bySubject: asRates(bySubject),
  caveat: '温度 0 的推理模型不保证确定性；这里量的是"同一 prompt 同一文本两次输出"的一致性',
  rows: results,
};
if (args.out !== null) {
  const target = resolve(args.out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.error(`已写入 ${target}`);
}
console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
