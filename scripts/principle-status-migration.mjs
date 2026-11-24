/**
 * 原理账本状态迁移（**只算不写**）：给「三档 status」这条待裁事项一份可复核的迁移表。
 *
 * 判定式（写死，不手工改）：
 *   ref := bornFrom ∪ {evidence.lastPointer}
 *   proven>0 且 ref 为空        → unverified（有验证计数却没有出处，不成立）
 *   proven=0 且 ref 为空        → unverified（从来没被验证过，也没有出处）
 *   proven>0 且 ref 非空        → live（保持；主读数只认 bornFrom，pointer 单列）
 *   已 retired                  → 不动
 *
 * 用法：
 *   node scripts/principle-status-migration.mjs            # 只打印迁移表
 *   node scripts/principle-status-migration.mjs --json     # 机器可读
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = { store: join(homedir(), '.dsh', 'memory-loom', 'store.json'), json: process.argv.includes('--json') };
const state = JSON.parse(readFileSync(args.store, 'utf8'));
const principles = Array.isArray(state.self?.principles) ? state.self.principles : [];

const rows = principles.map((principle) => {
  const proven = principle.evidence?.proven ?? 0;
  const broken = principle.evidence?.broken ?? 0;
  const bornFrom = Array.isArray(principle.bornFrom) ? principle.bornFrom.length : 0;
  const pointer = principle.evidence?.lastPointer ? 1 : 0;
  const hasRef = bornFrom > 0 || pointer > 0;
  const before = principle.status ?? 'live';
  let after = before;
  let rule = 'already-retired';
  if (before !== 'retired') {
    if (!hasRef) {
      after = 'unverified';
      rule = proven > 0 ? 'proven-without-ref' : 'never-verified';
    } else {
      rule = 'has-ref';
    }
  }
  return { id: principle.id, text: String(principle.text ?? '').slice(0, 40), proven, broken, bornFrom, pointer, before, after, rule };
});

const tally = rows.reduce((acc, row) => {
  const key = `${row.before}→${row.after}`;
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});

if (args.json) {
  console.log(JSON.stringify({ store: args.store, rows, tally }, null, 2));
} else {
  console.log(`原理账本迁移表（只算不写）· ${args.store}`);
  for (const row of rows) {
    console.log(`  ${row.before} → ${row.after}  [proven=${row.proven} born=${row.bornFrom} ptr=${row.pointer}] ${row.rule} :: ${row.text}`);
  }
  console.log(`合计：${JSON.stringify(tally)}`);
  console.log('主读数（只认 bornFrom）：', rows.filter((r) => r.bornFrom > 0 && r.before !== 'retired').length, '/', rows.filter((r) => r.before !== 'retired').length);
}
