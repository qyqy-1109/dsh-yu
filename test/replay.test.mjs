/**
 * 回放扫描器的回归测试。
 *
 * 守的是实测出来的坑，不是设计偏好：
 * ① 多帧 zstd：同步/流式解压都只解第一帧，逐帧切才拿得到全文；
 * ② 注入即 user/message：不按 source.kind 滤，一半"用户原话"是插件自己的输出；
 * ③ 同目录多版本：按文件计数会把同一个会话数两遍，会话身份是目录名；
 * ④ 查重命中同样带 uuid：不分类就把 NOOP 算成覆盖 —— 第二阶段量的就是 NOOP。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

import {
  buildHookPairs,
  buildWritePairs,
  codeDigest,
  decodeSessionLog,
  extractUuids,
  listSessionLogs,
  logVersionOf,
  pairsToJsonl,
  parseWriteResult,
  ruleDigest,
  scanRoot,
  scanSession,
  snapshotAt,
  splitZstdFrames,
} from '../lib/replay.js';

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'loom-replay-'));
}

function frame(rows) {
  const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  return zstdCompressSync(Buffer.from(text, 'utf8'));
}

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

test('多帧 zstd：一次解压只拿到第一帧，逐帧切才拿得到全文', () => {
  const buffer = Buffer.concat([
    frame([{ type: 'session', id: 's-1' }]),
    frame([{ type: 'user/message', seq: 2 }]),
    frame([{ type: 'turn/start', seq: 3 }]),
  ]);

  // 对照组：这就是那个"37.7MB 只吐出 186 字节"的坑
  const naive = zstdDecompressSync(buffer).toString('utf8');
  assert.equal(naive.trim().split('\n').length, 1, '一次同步解压只解第一帧');
  assert.equal(naive.includes('turn/start'), false);

  const decoded = decodeSessionLog(buffer);
  assert.equal(decoded.frames, 3, '三帧都要解出来');
  assert.equal(decoded.failedCandidates, 0);
  assert.equal(decoded.rows.length, 3);
  assert.equal(decoded.rows[2].type, 'turn/start');
  assert.equal(decoded.badLines, 0);
});

test('多帧 zstd：坏帧不静默吞掉，计数报出来', () => {
  const good = frame([{ type: 'session' }]);
  const garbage = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('这不是一帧')]);
  const { frames, failedCandidates } = splitZstdFrames(Buffer.concat([good, garbage]));
  assert.equal(frames, 1);
  assert.equal(failedCandidates, 1);
});

test('伪魔数重试：帧中间夹一个裸魔数，两帧都要解出来、且不静默', () => {
  // 真实的 zstd 帧头就是这个魔数；压缩流里偶然出现同样的四字节时，
  // 按魔数切会把一帧切成两半 —— 吞帧重试必须把它吸收掉。
  const first = frame([{ type: 'session', tag: 'A' }]);
  const second = frame([{ type: 'turn/start', tag: 'B' }]);
  const buffer = Buffer.concat([first, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), second]);

  const { frames, failedCandidates, text } = splitZstdFrames(buffer);
  assert.equal(frames, 2, '两帧都要解出来');
  assert.ok(text.includes('"tag":"A"'), '第一帧内容在');
  assert.ok(text.includes('"tag":"B"'), '第二帧内容在');
  assert.equal(failedCandidates, 1, '伪魔数被计数，不静默');
});

test('版本优先级：v4 > v3 > plain', () => {
  assert.equal(logVersionOf('session.v4.jsonl.zstd'), 4);
  assert.equal(logVersionOf('session.v3.jsonl.zstd'), 3);
  assert.equal(logVersionOf('session.jsonl.zstd'), 1);
});

test('按目录去重：同目录 v4+plain 只算一个会话，且取 v4', async () => {
  const root = await tempDir();
  const sessionDir = join(root, '--D-work--', 'session-aaa');
  try {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'session.jsonl.zstd'), frame([{ type: 'session' }]));
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), frame([{ type: 'session' }]));

    const { logs, duplicates } = listSessionLogs(root);
    assert.equal(logs.length, 1, '会话身份是目录名，不是文件名');
    assert.equal(logs[0].version, 4);
    assert.equal(duplicates.length, 1, '共存要留痕，别偷偷丢掉');
    assert.deepEqual(duplicates[0].files, ['session.jsonl.zstd', 'session.v4.jsonl.zstd']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const callRow = (args, callId = 'call-1', turn = 3, step = 7) => ({
  type: 'tool/call',
  data: { turn, step, callId, name: 'memory_write', arguments: JSON.stringify(args) },
});
const resultRow = (text, callId = 'call-1', isError = false) => ({
  type: 'tool/result',
  data: { message: { toolCallId: callId, isError, content: [{ type: 'text', text }] } },
});

test('配对：callId 对上，批量 1:N 按顺序拆行，kind 从 entries 带出来', () => {
  const rows = [
    callRow({ entries: [{ kind: 'fact', text: '第一条' }, { kind: 'self', text: '第二条' }] }),
    resultRow(`一次写入 2 条：\n- 已写入：${UUID_A}（fact）\n- 已写入：${UUID_B}（self）`),
  ];
  const { pairs, writeCalls } = buildWritePairs(rows, 's-1');
  assert.equal(writeCalls, 1);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].id, UUID_A);
  assert.equal(pairs[0].text, '第一条');
  assert.equal(pairs[0].kind, 'fact');
  assert.equal(pairs[1].kind, 'self');
  assert.equal(pairs[0].status, 'created');
  assert.equal(pairs[0].callId, pairs[1].callId, '同一个 callId，一呼多应');
  assert.equal(pairs[0].turn, 3);
  assert.equal(pairs[0].step, 7);
});

test('查重命中不算新写入：deduped 带 id、status 分开、计数不进 created', () => {
  const single = parseWriteResult(`未新建：与已有记忆重复（id ${UUID_A}），已累加命中。`);
  assert.equal(single.length, 1);
  assert.equal(single[0].status, 'deduped');
  assert.equal(single[0].id, UUID_A, 'dedupe 的 id 是已有条目，仍然可追溯');

  const batch = parseWriteResult(
    `一次写入 2 条：\n- 已写入：${UUID_B}（fact）\n- 重复，已累加命中：${UUID_C}（self）`,
  );
  assert.deepEqual(batch.map((entry) => entry.status), ['created', 'deduped']);

  const rows = [
    callRow({ entries: [{ kind: 'fact', text: '新的' }, { kind: 'self', text: '重复的' }] }),
    resultRow(`一次写入 2 条：\n- 已写入：${UUID_B}（fact）\n- 重复，已累加命中：${UUID_C}（self）`),
  ];
  const { pairs } = buildWritePairs(rows, 's-1');
  assert.equal(pairs.filter((pair) => pair.status === 'created').length, 1, '只有一条是新写入');
  assert.equal(pairs.filter((pair) => pair.status === 'deduped').length, 1);
  assert.equal(pairs[1].id, UUID_C);
  assert.equal(pairs[1].text, '重复的', 'deduped 行也有提交文本，别丢');
});

test('单条写入后面跟 note 行：note 不是条目，已写入的 id 不许丢', () => {
  // 实测踩过：note 也以 "- " 开头，被当成条目后 31 次写入解析成 144 行 unknown
  const text = `已写入记忆 ${UUID_A}（episode）。\n- 这条带状态变化口吻：如果它取代了某条旧记忆，请用 supersedes 指定那条的 id`;
  const parsed = parseWriteResult(text);
  assert.equal(parsed.length, 1, 'note 行不许算成一条写入');
  assert.equal(parsed[0].status, 'created');
  assert.equal(parsed[0].id, UUID_A);
  assert.equal(parsed[0].kind, 'episode');
});

test('批量写入后面跟 note 行：只认条目行', () => {
  const text = `一次写入 1 条：\n- 已写入：${UUID_A}（fact）\n- 与已有条目重复（相似度 0.83），只累加命中`;
  const parsed = parseWriteResult(text);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].status, 'created');
  assert.equal(parsed[0].id, UUID_A);
});

test('配对：正文条数少于提交条数时不回落第一条，标记 textMissing', () => {
  const rows = [
    callRow({ entries: [{ kind: 'fact', text: '甲' }, { kind: 'self', text: '乙' }] }),
    resultRow(`一次写入 1 条：\n- 已写入：${UUID_A}（fact）`),
  ];
  const { pairs } = buildWritePairs(rows, 's-1');
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].text, '甲');
  assert.equal(pairs[0].textMissing, false);

  const rowsShort = [
    callRow({ entries: [{ kind: 'fact', text: '甲' }] }),
    resultRow(`一次写入 2 条：\n- 已写入：${UUID_A}（fact）\n- 已写入：${UUID_B}（self）`),
  ];
  const short = buildWritePairs(rowsShort, 's-1').pairs;
  assert.equal(short.length, 2);
  assert.equal(short[1].text, null, '缺的那条不许拿第一条顶上');
  assert.equal(short[1].textMissing, true);
});

test('配对：失败的调用留痕（status=error、id 为空）', () => {
  const rows = [callRow({ text: 'x', kind: 'fact' }), resultRow('写失败', 'call-1', true)];
  const { pairs } = buildWritePairs(rows, 's-1');
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].status, 'error');
  assert.equal(pairs[0].id, null);
  assert.equal(pairs[0].isError, true);
});

test('配对：别的工具不掺进来', () => {
  const rows = [
    { type: 'tool/call', data: { callId: 'c9', name: 'pwsh', arguments: '{}' } },
    resultRow(UUID_A, 'c9'),
  ];
  const { pairs, writeCalls } = buildWritePairs(rows, 's-1');
  assert.equal(writeCalls, 0);
  assert.equal(pairs.length, 0);
});

test('注入过滤：只认 source.kind === user，且插件注入与宿主样板分开', () => {
  const rows = [
    { type: 'turn/start', time: 1000 },
    { type: 'user/message', data: { source: { kind: 'user' } } },
    { type: 'user/message', data: { source: { kind: 'plugin:dsh-memory-loom' } } },
    { type: 'user/message', data: { source: { kind: 'time-context' } } },
  ];
  const scanned = scanSession({ rows, sessionId: 's-1' });
  assert.equal(scanned.userMessages, 1);
  assert.equal(scanned.injectByKind['plugin:dsh-memory-loom'], 1);
  assert.equal(scanned.injectByKind['time-context'], 1);
  assert.equal(scanned.turns, 1);
  assert.equal(scanned.cutoff, 1000, 'cutoff 取会话里最后一个时间戳');
});

test('钩子口径：explicit 写入单列，且不与 tool 口径重复计', () => {
  const store = {
    memories: [
      { id: UUID_A, kind: 'fact', text: 'tool 写过的', source: 'tool', explicit: false, sessionId: 's-1' },
      { id: UUID_B, kind: 'fact', text: '钩子写的', source: 'explicit', explicit: true, sessionId: 's-2' },
    ],
  };
  const pairs = buildHookPairs(store, new Set([UUID_A]));
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].id, UUID_B);
  assert.equal(pairs[0].label, 'hook');
  assert.equal(pairs[0].turn, null, '钩子没有轮次坐标，不许假装有');
});

test('快照语义：按 cutoff 重建，晚于 cutoff 的不算、当时还活跃的算', () => {
  const store = {
    memories: [
      { id: 'old', status: 'active', createdAt: 100, archivedAt: null },
      { id: 'later', status: 'active', createdAt: 900, archivedAt: null },
      { id: 'archived-before', status: 'archived', createdAt: 100, archivedAt: 300 },
      { id: 'archived-after', status: 'archived', createdAt: 100, archivedAt: 700 },
    ],
    slots: [
      { entity: 'a', attr: 'b', createdAt: 100, updatedAt: 200 },
      { entity: 'a', attr: 'c', createdAt: 100, updatedAt: 900 },
    ],
    loops: [
      { id: 'l1', text: '开着的', openedAt: 100, closedAt: null },
      { id: 'l2', text: '后来关的', openedAt: 100, closedAt: 900 },
      { id: 'l3', text: '还没开的', openedAt: 900, closedAt: null },
    ],
  };
  const snapshot = snapshotAt(store, 500);
  assert.deepEqual(
    snapshot.memories.map((row) => row.id).sort(),
    ['archived-after', 'old'],
    '晚于 cutoff 的不算；archivedAt > cutoff 的当时还活跃',
  );
  assert.equal(snapshot.slots.length, 1, 'slot 只看最后更新时间');
  assert.deepEqual(snapshot.loops.map((row) => row.id), ['l1', 'l2']);
  assert.equal(snapshot.cutoff, 500);
});

test('uuid 提取：一段正文里多个 id 按出现顺序', () => {
  assert.deepEqual(extractUuids(`已写入：${UUID_A}（fact）\n- 已写入：${UUID_B}（self）`), [UUID_A, UUID_B]);
  assert.deepEqual(extractUuids('没有 id'), []);
});

test('指纹：规则摘要与代码摘要都要有（分数漂移要能归因到规则还是实现）', () => {
  assert.match(ruleDigest(), /^[0-9a-f]{12}$/);
  assert.match(codeDigest(), /^[0-9a-f]{12}$/);
});

test('配对表：首行是表头，行里带 slug/cutoff/kind/status', () => {
  const report = {
    header: { type: 'header', generatedAt: '2026-11-17T00:00:00.000Z' },
    pairs: [
      {
        sessionId: 's-1',
        slug: '--D-work--',
        cutoff: 1000,
        turn: 3,
        step: 7,
        callId: 'call-1',
        name: 'memory_write',
        label: 'tool',
        kind: 'fact',
        status: 'created',
        id: UUID_A,
        text: '第一条',
        textMissing: false,
        isError: false,
      },
    ],
  };
  const lines = pairsToJsonl(report).trim().split('\n');
  assert.equal(lines.length, 2);
  const header = JSON.parse(lines[0]);
  assert.equal(header.type, 'header');
  assert.equal(header.generatedAt, '2026-11-17T00:00:00.000Z');
  const row = JSON.parse(lines[1]);
  assert.equal(row.slug, '--D-work--');
  assert.equal(row.cutoff, 1000);
  assert.equal(row.kind, 'fact');
  assert.equal(row.status, 'created');
});

test('钩子口径：cutoff 按 sessionId 从会话统计继承，会话不在本批就留 null', () => {
  const store = {
    memories: [
      { id: UUID_A, kind: 'fact', text: '在扫描范围内的会话', source: 'explicit', explicit: true, sessionId: 's-known' },
      { id: UUID_B, kind: 'fact', text: '不在扫描范围内的会话', source: 'explicit', explicit: true, sessionId: 's-unknown' },
    ],
  };
  const cutoffs = new Map([['s-known', 424242]]);
  const pairs = buildHookPairs(store, new Set(), cutoffs);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].cutoff, 424242, '有会话统计就继承 cutoff');
  assert.equal(pairs[1].cutoff, null, '没有就留 null，不猜');
});

test('审计标记：正文条数与提交条数不符的调用会被记下来（防新形状静默丢条目）', () => {
  const rows = [
    callRow({ entries: [{ kind: 'fact', text: '甲' }] }),
    resultRow(`一次写入 2 条：\n- 已写入：${UUID_A}（fact）\n- 已写入：${UUID_B}（self）`),
  ];
  const { pairs } = buildWritePairs(rows, 's-1');
  assert.ok(pairs.every((pair) => pair.countMismatch === true), '条数对不上要标出来');
  assert.equal(pairs.filter((pair) => pair.textMissing).length, 1);

  const okRows = [
    callRow({ entries: [{ kind: 'fact', text: '甲' }] }),
    resultRow(`一次写入 1 条：\n- 已写入：${UUID_A}（fact）`),
  ];
  assert.ok(buildWritePairs(okRows, 's-1').pairs.every((pair) => pair.countMismatch === false));
});

test('端到端：扫目录出报告，漏斗和注入口径都对得上', async () => {
  const root = await tempDir();
  const writeSession = join(root, '--D-work--', 'session-w');
  const quietSession = join(root, '--D-work--', 'session-q');
  try {
    await mkdir(writeSession, { recursive: true });
    await mkdir(quietSession, { recursive: true });
    await writeFile(
      join(writeSession, 'session.v4.jsonl.zstd'),
      Buffer.concat([
        frame([
          { type: 'session', time: 10 },
          { type: 'turn/start', time: 20 },
          { type: 'user/message', time: 21, data: { source: { kind: 'user' } } },
          { type: 'user/message', time: 22, data: { source: { kind: 'plugin:dsh-memory-loom' } } },
        ]),
        frame([
          callRow({ entries: [{ kind: 'fact', text: '第一条' }, { kind: 'slot', entity: 'e', attr: 'a', text: '状态' }] }, 'call-1', 1, 2),
          resultRow(`一次写入 2 条：\n- 已写入：${UUID_A}（fact）\n- 已写入：${UUID_B}（slot）`),
          { type: 'turn/end', time: 99 },
        ]),
      ]),
    );
    await writeFile(
      join(quietSession, 'session.v3.jsonl.zstd'),
      frame([{ type: 'turn/start', time: 5 }, { type: 'user/message', time: 6, data: { source: { kind: 'time-context' } } }]),
    );

    const report = scanRoot(root, { store: null, engineGit: 'test' });
    assert.equal(report.files.sessions, 2);
    assert.equal(report.layers.labeledSessions, 1);
    assert.equal(report.layers.unlabeledSessions, 1);
    assert.equal(report.denominators.toolPairs, 2, '批量写入拆成两行');
    assert.equal(report.denominators.createdTool, 2);
    assert.equal(report.denominators.recallBase, 1, 'slot 覆盖写不进召回分母');
    assert.equal(report.denominators.hookOnly, 0);
    assert.equal(report.inject.userMessages, 1);
    assert.equal(report.inject.pluginTotal, 1, '插件注入单列');
    assert.equal(report.inject.hostBoilerplate, 1, '宿主样板另算');
    assert.equal(report.header.engineGit, 'test');
    assert.equal(report.header.codeDigest.length, 12);
    assert.equal(report.pairs.length, 2);
    const cutoffs = report.pairs.map((pair) => pair.cutoff);
    assert.deepEqual(cutoffs, [99, 99], '每行都带会话 cutoff');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
