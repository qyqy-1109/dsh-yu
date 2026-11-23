/**
 * 源分布 vs 候选分布：抽出来的东西像不像源？零模型、确定性。
 *
 * 为什么要这一步：prompt v2 显式索取六类之后，事实占比只从 65% 掉到 63%。
 * 如果**源窗里的句子本身**就以事实为主，那事实主导就不是网的问题，是源的针密度 ——
 * prompt 单独修不了，召回天花板由源决定。这个脚本就是把源分布量出来。
 *
 * 用法：
 *   node scripts/source-type-mix.mjs --plan out/plan-59.json [--candidates out/cand-full-59-v2.jsonl]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { decodeSessionLog, listSessionLogs, defaultSessionRoot } from '../lib/replay.js';
import { classifyType } from '../lib/replay-proposition.js';

function parseArgs(argv) {
  const args = { plan: null, candidates: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--plan') args.plan = argv[++i];
    else if (token === '--candidates') args.candidates.push(argv[++i]);
    else throw new Error(`不认识的参数：${token}`);
  }
  return args;
}

/** 句子切分：只按中文句读与换行，不猜语义。 */
function splitSentences(text) {
  return String(text ?? '')
    .split(/[。！？!?\n]+/)
    .map((line) => line.trim())
    .filter((line) => [...line].length >= 6);
}

const args = parseArgs(process.argv.slice(2));
const plan = JSON.parse(readFileSync(resolve(args.plan), 'utf8')).selected ?? [];
const { logs } = listSessionLogs(defaultSessionRoot());
const bySession = new Map(logs.map((log) => [log.sessionId, log]));

const sourceCounts = {};
let sentences = 0;
const perWindow = [];
for (const window of plan) {
  const log = bySession.get(window.sessionId);
  if (log === undefined) continue;
  let rows;
  try {
    rows = decodeSessionLog(readFileSync(log.file)).rows;
  } catch {
    continue;
  }
  // 只取计划窗口里的真用户正文
  const texts = [];
  let turn = 0;
  for (const row of rows) {
    if (row?.type === 'turn/start') {
      turn += 1;
      continue;
    }
    if (row?.type !== 'user/message') continue;
    if (row.data?.source?.kind !== 'user') continue;
    if (turn < window.fromTurn || turn > window.toTurn) continue;
    const text = (row.data?.content ?? []).filter((part) => part?.type === 'text').map((part) => String(part.text ?? '')).join('');
    if (text.trim().length > 0) texts.push(text);
  }
  const local = {};
  let localCount = 0;
  for (const text of texts) {
    for (const sentence of splitSentences(text)) {
      const { type } = classifyType(sentence);
      sourceCounts[type] = (sourceCounts[type] ?? 0) + 1;
      local[type] = (local[type] ?? 0) + 1;
      localCount += 1;
      sentences += 1;
    }
  }
  perWindow.push({ sessionId: window.sessionId, fromTurn: window.fromTurn, toTurn: window.toTurn, sentences: localCount, types: local });
}

const asShare = (counts, total) => Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([type, count]) => [type, { count, share: Number((count / total).toFixed(3)) }]));

const candidateMixes = args.candidates.map((path) => {
  const rows = readFileSync(resolve(path), 'utf8').trim().split('\n').slice(1).map((line) => JSON.parse(line));
  const counts = {};
  for (const row of rows) {
    const { type } = classifyType(row.text);
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return { file: resolve(path), candidates: rows.length, mix: asShare(counts, rows.length) };
});

console.log(
  JSON.stringify(
    {
      windows: perWindow.length,
      sourceSentences: sentences,
      sourceMix: asShare(sourceCounts, sentences),
      candidateMixes,
      interpretation: '源分布里 fact 占多少，候选里 fact 占多少 —— 两者接近就说明事实主导是源驱动，不是网退化',
      perWindow: perWindow.filter((window) => window.sentences > 0).slice(0, 10),
    },
    null,
    2,
  ),
);
