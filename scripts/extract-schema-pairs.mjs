/**
 * 把**校准集两侧的文本**都抽成结构化决定（尺子判等的输入）。
 *
 * 为什么两侧都要抽：库里的标签是自由文本，尺子比的是结构化决定，
 * 所以"理解"这一步必须在两侧用同一个 prompt 做一遍，钉同一份 promptVersion。
 *
 * 用法：
 *   $env:WB_API_KEY=...; node scripts/extract-schema-pairs.mjs \
 *     --pairs labels/assertion-set-12-2026-11-19.jsonl \
 *     --pairs labels/types-20-lead-2026-11-19.jsonl \
 *     --out labels/schema-pairs-2026-11-20.jsonl
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { buildPrompt, parseCandidates, PROMPT_VERSION } from './extract-candidates.mjs';

function parseArgs(argv) {
  const args = { pairs: [], out: null, model: 'cn:deepseek-v4.1-flash', base: 'http://localhost:7864/v1' };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--pairs') args.pairs.push(argv[++i]);
    else if (token === '--out') args.out = argv[++i];
    else if (token === '--model') args.model = argv[++i];
    else throw new Error(`不认识的参数：${token}`);
  }
  return args;
}

async function callModel({ base, model, apiKey, userText }) {
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 3000, messages: [{ role: 'user', content: buildPrompt(userText) }] }),
  });
  if (!response.ok) throw new Error(`模型调用失败：HTTP ${response.status}`);
  const payload = await response.json();
  return {
    content: String(payload?.choices?.[0]?.message?.content ?? ''),
    finish: String(payload?.choices?.[0]?.finish_reason ?? ''),
  };
}

/** 切块：按句读装袋，每袋不超过 maxChars 字。为什么切块而不加 max_tokens ——
 * 推理失控用预算治过两次都没用（4500→6000 降级一条没少），只能把单次输出压小。 */
function chunkText(text, maxChars = 120) {
  const sentences = String(text ?? '').split(/(?<=[。！？；\n])/).map((part) => part.trim()).filter((part) => part.length > 0);
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length > 0 && (current + sentence).length > maxChars) {
      chunks.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
    while (current.length > maxChars * 2) {
      chunks.push(current.slice(0, maxChars));
      current = current.slice(maxChars);
    }
  }
  if (current.trim().length > 0) chunks.push(current);
  return chunks.length === 0 ? [String(text ?? '').trim()] : chunks;
}

const args = parseArgs(process.argv.slice(2));
const apiKey = process.env.WB_API_KEY;
if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('缺 WB_API_KEY');

// 收集唯一文本：键 = 来源文件 + 侧 + 编号
const items = [];
for (const path of args.pairs) {
  const rows = readFileSync(resolve(path), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => typeof row.n === 'number');
  const base = resolve(path).split(/[\\/]/).pop();
  for (const row of rows) {
    const candidateText = row.candidateText ?? null;
    const labelText = row.labelText ?? null;
    if (candidateText !== null) items.push({ key: `${base}#${row.n}#candidate`, text: candidateText });
    if (labelText !== null) items.push({ key: `${base}#${row.n}#label`, text: labelText });
  }
}

const out = [];
let degraded = 0;
for (const [index, item] of items.entries()) {
  const MAX_DECISIONS = 8;
  const chunks = chunkText(item.text);
  const merged = [];
  let finish = null;
  let failedChunks = 0;
  for (const chunk of chunks) {
    let result;
    try {
      result = await callModel({ base: args.base, model: args.model, apiKey, userText: chunk });
      // 空输出（推理吃满预算）重试一次，换更短的块
      if (parseCandidates(result.content).length === 0 && chunk.length > 60) {
        const halves = [chunk.slice(0, Math.ceil(chunk.length / 2)), chunk.slice(Math.ceil(chunk.length / 2))];
        for (const half of halves) {
          if (half.trim().length < 6) continue;
          try {
            const retried = await callModel({ base: args.base, model: args.model, apiKey, userText: half });
            for (const decision of parseCandidates(retried.content)) merged.push(decision);
          } catch {
            failedChunks += 1;
          }
        }
        continue;
      }
    } catch (error) {
      failedChunks += 1;
      continue;
    }
    finish = result.finish;
    for (const decision of parseCandidates(result.content)) {
      const key = `${decision.attr}|${decision.value}|${decision.negative}`;
      if (merged.some((existing) => `${existing.attr}|${existing.value}|${existing.negative}` === key)) continue;
      merged.push(decision);
      if (merged.length >= MAX_DECISIONS) break;
    }
    if (merged.length >= MAX_DECISIONS) break;
  }
  const candidates = merged.slice(0, MAX_DECISIONS);
  const top = candidates[0] ?? null;
  if (top === null) degraded += 1;
  out.push({
    key: item.key,
    text: item.text,
    finish,
    decisions: candidates.map((item) => ({ subject: item.subject, attr: item.attr, value: item.value, negative: item.negative, text: item.text })),
    decisionCount: candidates.length,
    chunks: chunks.length,
    failedChunks,
  });
  console.error(`第 ${index + 1}/${items.length} 条：${top === null ? '降级' : `${top.subject}/${top.attr}/neg=${top.negative}`}`);
}

const header = { type: 'header', version: 'schema-pairs-v1', promptVersion: PROMPT_VERSION, model: args.model, temperature: 0, items: out.length, degraded, generatedAt: new Date().toISOString() };
if (args.out !== null) {
  const target = resolve(args.out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, [JSON.stringify(header), ...out.map((row) => JSON.stringify(row))].join('\n') + '\n', 'utf8');
  console.error(`已写入 ${target}`);
}
console.log(JSON.stringify(header, null, 2));
