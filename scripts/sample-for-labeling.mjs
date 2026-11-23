/**
 * 抽样给人标：全量精确率要靠人标，不能靠尺子自证。
 *
 * 分层：命中组（entity-v2 认了）与未命中组各抽一半，组内按固定步长等距取，
 * 保证可复算（同样的候选工件 + 同样的 n 出同样的人标集）。不随机、不用时间。
 *
 * 用法：
 *   node scripts/sample-for-labeling.mjs --candidates out/cand-full-59-r3.jsonl \
 *     --scored out/scored-full-r3.jsonl --pairs ... --store ... --n 20 --out labels/sample-20.jsonl
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function parseArgs(argv) {
  const args = { scored: null, perGroup: 10, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--scored') args.scored = argv[++i];
    else if (token === '--per-group') args.perGroup = Number(argv[++i]);
    else if (token === '--out') args.out = argv[++i];
    else throw new Error(`不认识的参数：${token}`);
  }
  return args;
}

/** 等距取样：给定列表和要取的条数，按固定步长取下标的样本，确定性。 */
function stridePick(list, count) {
  if (list.length <= count) return list.slice();
  const step = list.length / count;
  const picked = [];
  for (let i = 0; i < count; i += 1) picked.push(list[Math.floor(i * step)]);
  return picked;
}

const args = parseArgs(process.argv.slice(2));
const rows = readFileSync(resolve(args.scored), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const matched = rows.filter((row) => row.entityMatchLabelId !== null && row.duplicate !== true);
const unmatched = rows.filter((row) => row.entityMatchLabelId === null && row.duplicate !== true);

const sample = [...stridePick(matched, args.perGroup).map((row) => ({ ...row, group: 'matched' })), ...stridePick(unmatched, args.perGroup).map((row) => ({ ...row, group: 'unmatched' }))].map((row, index) => ({
  n: index + 1,
  group: row.group,
  sessionId: row.sessionId,
  fromTurn: row.fromTurn,
  kind: row.kind,
  text: row.text,
  chainAction: row.action,
  matchedLabelId: row.entityMatchLabelId === null ? null : row.entityMatchLabelId.slice(0, 8),
  matchedLabelScore: row.entityMatchScore,
  matchedLabelText: row.matchedLabelText ?? null,
}));

if (args.out !== null) {
  const target = resolve(args.out);
  mkdirSync(dirname(target), { recursive: true });
  const header = { type: 'header', version: 'sample-v1', groups: { matched: Math.min(args.perGroup, matched.length), unmatched: Math.min(args.perGroup, unmatched.length) }, scoredFile: resolve(args.scored) };
  writeFileSync(target, [JSON.stringify(header), ...sample.map((row) => JSON.stringify(row))].join('\n') + '\n', 'utf8');
  console.error(`抽样已写入 ${target}（${sample.length} 条）`);
}
console.log(JSON.stringify({ matchedPool: matched.length, unmatchedPool: unmatched.length, sampled: sample.length }, null, 2));
