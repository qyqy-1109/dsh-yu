/**
 * used 报表的口径测试：null 与 0 必须不同形。
 *
 * 这条不是形式主义：1.4% 那个假信号的一半成因，就是"没测"被读成了"没有"。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../scripts/used-report.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

async function runWith(store) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-usedreport-'));
  const file = join(dir, 'store.json');
  await writeFile(file, JSON.stringify(store), 'utf8');
  try {
    return JSON.parse(execFileSync(process.execPath, [SCRIPT, '--store', file, '--json'], { encoding: 'utf8' }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const base = { events: [], memories: [], summaries: [], self: { principles: [] } };

test('没有任何 id 级注入事件 → used_a 是 null，不是 0', async () => {
  const report = await runWith({ ...base, events: [{ kind: 'recall', payload: { blocks: 4, entries: 0, tokens: 0 } }] });
  assert.equal(report.a.value, null);
  assert.equal(report.a.preInstrumentRecalls, 1);
});

test('sources 未接线 → used_b2 是 null；接了线但为空 → 0', async () => {
  const unwired = await runWith({ ...base, memories: [{ status: 'active', sources: [] }] });
  assert.equal(unwired.b2.value, null, '未接线是 null');

  const wired = await runWith({
    ...base,
    memories: [
      { status: 'active', sources: ['a'] },
      { status: 'active', sources: [] },
    ],
  });
  assert.equal(wired.b2.value, 1, '接了线就报实数');
});

test('b1 只作上界旁证；主读数只认 bornFrom 与 both', async () => {
  const report = await runWith({
    ...base,
    summaries: [{ memberIds: ['a', 'b', 'c'] }],
    self: {
      principles: [
        { bornFrom: ['x'], evidence: { lastPointer: null } },
        { bornFrom: ['y'], evidence: { lastPointer: 'p1' } },
        { bornFrom: [], evidence: { lastPointer: 'p2' } },
        { bornFrom: [], evidence: { lastPointer: null } },
      ],
    },
  });
  assert.equal(report.b1.value, 3);
  assert.deepEqual(report.b2.refKind, { bornFrom: 1, pointer: 1, both: 1, none: 1 });
  assert.equal(report.b2.primaryReading.bornFrom, 2, '主读数 = bornFrom + both，不含纯 pointer');
});

test('旧口径只作 legacy 留档，且有分母才给率', async () => {
  const report = await runWith({ ...base, events: [{ kind: 'memory.usage', payload: { hit: 1, offered: 4 } }] });
  assert.equal(report.legacy.hit, 1);
  assert.equal(report.legacy.offered, 4);
  assert.equal(report.legacy.rate, 0.25);

  const empty = await runWith({ ...base });
  assert.equal(empty.legacy.rate, null, '没有分母时率是 null，不是 0');
});
