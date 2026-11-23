/**
 * 回放扫描（第一阶段：零模型）。
 *
 * 用法：
 *   node scripts/replay.mjs                       # 扫 ~/.dsh/sessions，出报告
 *   node scripts/replay.mjs --json                # 报告整段 JSON
 *   node scripts/replay.mjs --store <store.json>  # 顺带收钩子口径 + 库连接（漏斗）
 *   node scripts/replay.mjs --out <pairs.jsonl>   # 落配对表：首行表头，之后一行一个配对
 *   node scripts/replay.mjs --root <dir>          # 换会话根目录
 *
 * 它不调模型、不改任何库。产物只有两样：报告（stdout）和配对 jsonl（自带表头，可复算、可排序）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { defaultSessionRoot, pairsToJsonl, scanRoot, SCANNER_VERSION } from '../lib/replay.js';

function parseArgs(argv) {
  const args = { root: null, out: null, store: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') args.json = true;
    else if (token === '--root') args.root = argv[++i];
    else if (token === '--out') args.out = argv[++i];
    else if (token === '--store') args.store = argv[++i];
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`不认识的参数：${token}`);
  }
  return args;
}

/** 引擎代码身份：优先 git SHA；没有仓库就明确说 no-git（代码指纹另有 codeDigest 兜底）。 */
function engineGit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'no-git';
  }
}

function loadStore(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`读不到记忆库：${path}（${error instanceof Error ? error.message : String(error)}）`);
  }
}

function pct(part, whole) {
  if (!whole) return '0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function render(report) {
  const lines = [];
  const { header, files, layers, inject, status, denominators } = report;
  lines.push(`回放扫描 ${header.scannerVersion} · 规则 ${header.rulesDigest} · 代码 ${header.codeDigest} · 引擎 ${header.engineGit}`);
  lines.push(`根目录 ${header.root}`);
  lines.push(`生成于 ${header.generatedAt}${header.storePath === null ? '' : ` · 库 ${header.storePath}`}`);
  lines.push('');
  lines.push(`会话目录 ${files.sessions}（v4 ${files.byVersion[4] ?? 0} / v3 ${files.byVersion[3] ?? 0} / plain ${files.byVersion[1] ?? 0}），多版本共存 ${files.multiVersionDirs}`);
  lines.push(`帧 ${files.frames}，解压失败候选 ${files.failedCandidates}，坏行 ${files.badLines}，读不出的会话 ${files.errored}`);
  lines.push('');
  const totalTurns = layers.labeledTurns + layers.unlabeledTurns;
  lines.push(
    `分层：有标签 ${layers.labeledSessions} 个会话 / ${layers.labeledTurns} 轮（${pct(layers.labeledTurns, totalTurns)}）；` +
      `无标签 ${layers.unlabeledSessions} 个 / ${layers.unlabeledTurns} 轮（${pct(layers.unlabeledTurns, totalTurns)}）`,
  );
  lines.push(
    `注入口径：真用户 ${inject.userMessages} 条 · 插件注入 ${inject.pluginTotal} 条（${pct(inject.pluginTotal, inject.userMessages + inject.injected)}）· 宿主样板 ${inject.hostBoilerplate} 条`,
  );
  const pluginDetail = Object.entries(inject.pluginKinds)
    .map(([kind, count]) => `${kind}:${count}`)
    .join(' ');
  lines.push(`  插件明细：${pluginDetail}`);
  lines.push('');
  lines.push(
    `写入：配对 ${denominators.toolPairs} 行 → created ${denominators.createdTool} / deduped ${denominators.deduped} / error ${denominators.errors} / unknown ${denominators.unknown}`,
  );
  lines.push(
    `漏斗：created ${denominators.createdTool} → 非 slot ${denominators.recallBase} → 本库命中 ${denominators.matchedInStore}` +
      `（跨库 ${denominators.missingInStore}，单列）；钩子另计 ${denominators.hookOnly}`,
  );
  if (denominators.missingInStore > 0) {
    lines.push(`  跨库未命中：${denominators.missingInStoreIds.join(' ')}`);
  }
  lines.push(
    `审计：正文条数与提交不符的调用 ${denominators.countMismatchCalls}，缺文本行 ${denominators.textMissingRows}，钩子行缺 cutoff ${denominators.hookWithoutCutoff}`,
  );
  lines.push('');
  const top = [...report.sessions]
    .filter((session) => (session.pairs ?? []).length > 0)
    .sort((left, right) => (right.pairs?.length ?? 0) - (left.pairs?.length ?? 0))
    .slice(0, 5);
  if (top.length > 0) {
    lines.push('写入最集中的会话：');
    for (const session of top) {
      lines.push(`  ${session.sessionId}  写入 ${session.pairs.length} 行 / ${session.turns ?? 0} 轮`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    console.log('用法：node scripts/replay.mjs [--root <dir>] [--store <store.json>] [--out <pairs.jsonl>] [--json]');
    return;
  }
  const root = args.root === null ? defaultSessionRoot() : resolve(args.root);
  const storePath = args.store === null ? null : resolve(args.store);
  const store = storePath === null ? null : loadStore(storePath);
  const report = scanRoot(root, { store, storePath, engineGit: engineGit() });

  if (args.out !== null) {
    const target = resolve(args.out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, pairsToJsonl(report), 'utf8');
    console.error(`配对表已写入 ${target}（${report.pairs.length} 行 + 1 行表头）`);
  }

  if (args.json === true) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(render(report));
    console.log('');
    console.log(`配对行数 ${report.pairs.length} · 扫描器 ${SCANNER_VERSION} · 生成于 ${report.header.generatedAt}`);
  }
}

await main();
