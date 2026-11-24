/**
 * used 口径报表（按 2026-11-24 与 qoder 定下的口径）。
 *
 * 三条纪律，都是被踩出来的：
 *   ① **null ≠ 0**：没测出来写 null，测了确实没有写 0，两者在输出里必须不同形。
 *   ② **主读数只认 b2（bornFrom）**；b1（摘要成员）只作上界旁证，标 [upper bound]。
 *   ③ 旧口径（"下一轮复述指纹词"）只作为 legacy 读数留档，不参与任何推断。
 *
 * 用法：
 *   node scripts/used-report.mjs [--store <path>] [--json]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function parseArgs(argv) {
  const args = { store: join(homedir(), '.dsh', 'memory-loom', 'store.json'), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--store') args.store = argv[i + 1], (i += 1);
    else if (token === '--json') args.json = true;
    else throw new Error(`不认识的参数：${token}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const state = JSON.parse(readFileSync(args.store, 'utf8'));
const events = Array.isArray(state.events) ? state.events : [];
const memories = Array.isArray(state.memories) ? state.memories : [];
const summaries = Array.isArray(state.summaries) ? state.summaries : [];
const principles = Array.isArray(state.self?.principles) ? state.self.principles : [];

/** 埋点事件：有 instrumentVersion 的才作数；没有的属于 pre-instrument 区间。 */
const INSTRUMENT = 'ctx-ids-v1';
const instrumented = events.filter((e) => e.kind === 'recall.entries' && e.payload?.instrumentVersion === INSTRUMENT);
const legacyRecalls = events.filter((e) => e.kind === 'recall' && e.payload?.instrumentVersion === undefined);

/** 旧口径（legacy）：命中数 / provided 数。只留档。 */
const usage = events.filter((e) => e.kind === 'memory.usage');
const legacy = {
  settled: usage.length,
  offered: usage.reduce((sum, e) => sum + (e.payload?.offered ?? 0), 0),
  hit: usage.reduce((sum, e) => sum + (e.payload?.hit ?? 0), 0),
};
legacy.rate = legacy.offered === 0 ? null : Number((legacy.hit / legacy.offered).toFixed(4));

/** b2：原理的出处指针。主读数只认 bornFrom；pointer 单列；两者都有记 both。 */
const refKind = { bornFrom: 0, pointer: 0, both: 0, none: 0 };
for (const principle of principles) {
  const hasBornFrom = Array.isArray(principle.bornFrom) && principle.bornFrom.length > 0;
  const hasPointer = Boolean(principle.evidence?.lastPointer);
  if (hasBornFrom && hasPointer) refKind.both += 1;
  else if (hasBornFrom) refKind.bornFrom += 1;
  else if (hasPointer) refKind.pointer += 1;
  else refKind.none += 1;
}

/** 取舍/事实的 sources：接线前恒空 —— 这是 null（没接线），不是 0（测了没有）。 */
const activeRows = memories.filter((row) => row.status === 'active');
const rowsWithSources = activeRows.filter((row) => Array.isArray(row.sources) && row.sources.length > 0).length;
const sourcesWired = rowsWithSources > 0;

/** b1：摘要成员（聚类产物）= 上界旁证，永远不主读。 */
const summaryMembers = summaries.reduce((sum, s) => sum + (Array.isArray(s.memberIds) ? s.memberIds.length : 0), 0);

const report = {
  store: args.store,
  instrumentVersion: INSTRUMENT,
  a: {
    value: instrumented.length === 0 ? null : 'computable',
    status: instrumented.length === 0 ? 'null: 无 id 级注入事件（埋点区间还没产生数据）' : 'ok',
    instrumentedInjections: instrumented.length,
    preInstrumentRecalls: legacyRecalls.length,
    note: 'used_a 需要「哪几条被注入 + 后续 3 轮输出」，缺 id 即为 null，不许当 0',
  },
  b1: {
    value: summaryMembers,
    status: `upper bound: 摘要 ${
      summaries.length
    } 条的 memberIds 共 ${summaryMembers} 个，聚类自动产物，不作证据`,
  },
  b2: {
    value: sourcesWired ? rowsWithSources : null,
    status: sourcesWired ? 'ok' : 'null: sources 未接线（不是 0）',
    refKind,
    primaryReading: { bornFrom: refKind.bornFrom + refKind.both, total: principles.length },
  },
  legacy,
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`used 报表 · ${args.store}`);
  console.log(`埋点版本 ${INSTRUMENT} · id 级注入事件 ${report.a.instrumentedInjections} 条 · pre-instrument 召回 ${report.a.preInstrumentRecalls} 条`);
  console.log(`used_a        ${report.a.value === null ? 'null（未测：缺 id 级注入数据）' : report.a.value}`);
  console.log(`used_b1       ${report.b1.value} 个成员 [upper bound, not evidence]`);
  console.log(`used_b2       ${report.b2.value === null ? 'null（未测：sources 未接线）' : report.b2.value}`);
  console.log(`  refKind     bornFrom ${refKind.bornFrom} / pointer ${refKind.pointer} / both ${refKind.both} / none ${refKind.none}`);
  console.log(`  主读数       ${report.b2.primaryReading.bornFrom}/${report.b2.primaryReading.total} 条原理有 bornFrom`);
  console.log(`legacy 口径   ${legacy.hit}/${legacy.offered} = ${legacy.rate === null ? 'null' : legacy.rate}（留档，不用于推断）`);
}
