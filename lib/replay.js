/**
 * 回放扫描器（第一阶段：零模型，只读）。
 *
 * 为什么需要它：抽取网（后台把长会话里该记的东西捞出来）要用数据说话，
 * 而 yu/loom 不存对话原文 —— 原文在宿主的会话日志里。日志是 ground truth（"说过什么"），
 * 库是被验对象。这个文件只做一件事：把日志和库在**写动作**上对齐，产出可算数的配对。
 *
 * 四条实测出来的硬规矩（都是踩过的，不是设计洁癖）：
 * ① 会话日志是**多帧拼接**的 zstd。`zstdDecompressSync` 和 `createZstdDecompress` 都只解第一帧
 *    —— 37.7MB 的日志只会吐出开头 186 字节。必须按帧魔数切开逐帧解压。
 * ② 注入消息也叫 `user/message`。不过滤的话，一半"用户原话"其实是插件自己的注入；
 *    而注入块装的恰好是最相关的条目 —— 回声不是均匀加噪，是把分数系统性抬高。
 *    判据只有一个：`data.source.kind === 'user'`。
 * ③ 同一会话目录可能多版本共存（plain + v3）。逐文件计数会把同一个会话数两遍。
 *    按目录去重、取最高版本，且**严禁**按文件数当会话数。
 * ④ **查重命中不是新写入**。结果正文里"未新建：与已有记忆重复（id X）"同样带着一个 uuid，
 *    照单全收会把 NOOP 算成覆盖 —— 而第二阶段量的恰恰就是 NOOP 率。
 *    所以每条配对必须带 `status: created | deduped | error | unknown`。
 *
 * 对齐用 callId，不用时间：
 *   tool/call  → data.callId / data.name / data.arguments / data.turn / data.step
 *   tool/result→ data.message.toolCallId（不在顶层）/ data.message.isError / 正文里带条目 uuid
 * 批量写入是 1:N —— 结果正文逐行对应 `arguments.entries`，拆成多行、共享 callId。
 * 正文与 entry 条数不等时**不回落**到第一条（那会把两条不同的东西算成同一条），标记 `textMissing`。
 *
 * 零运行时依赖：只用 node:zlib 的同步 zstd（Node ≥22.15；更老的 Node 会在这里明确报错，不静默降级）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

export const SCANNER_VERSION = '0.2.2';

/** 扫描规则：改任何一条都会移动分数，所以它们和版本号、代码哈希一起进报告头。 */
export const SCAN_RULES = {
  frameSplit: 'zstd 多帧按魔数 28 b5 2f fd 切分逐帧解压，失败向后吞帧重试（防伪魔数）',
  versionRank: '同一会话目录内 session.v4 > session.v3 > plain，只取一个；按目录去重，不按文件计数',
  pairing: 'callId ↔ data.message.toolCallId；批量按结果正文行序对应 arguments.entries',
  injectFilter: "user/message 只认 data.source.kind === 'user'；其余一律算注入，且插件注入与宿主样板分开报",
  dedupeStatus: "结果正文含「已写入」=created，含「未新建/重复」=deduped；deduped 不算分母",
  recallBase:
    '召回分母 = created ∧ kind !== slot ∧ 本库命中（slot 是状态覆盖写，不是新事实，进分母会稀释召回；行仍留工件供审计）。2026-11-17 用户 D4 已批',
  cutoff:
    '每行带会话 cutoff = 该会话最大的 row.time（**故意偏离** spec 的「最后 turn/end」：中断会话可能没有 turn/end，取最大值更稳）；库快照按 cutoff 重建（archivedAt > cutoff 视为当时活跃）',
  hookCutoff: '钩子行没有轮次坐标，cutoff 按 sessionId 从会话统计继承；会话不在本批扫描里则留 null',
  dedupeBySession: '会话身份 = 目录名，不是文件名',
};

/** 规则摘要：进报告头的规则指纹，用来分开"代码变了"和"规则变了"。 */
export function ruleDigest() {
  const text = Object.entries(SCAN_RULES)
    .map(([key, value]) => `${key}=${value}`)
    .join('|');
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/** 代码指纹：规则没变但实现变了，分数照样会动 —— 两个都得钉住。 */
export function codeDigest() {
  try {
    const file = fileURLToPath(import.meta.url);
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

const FRAME_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** 逐个候选起点切帧：解不开就往后吞一帧再试（伪魔数会在这里被吸收掉）。 */
export function splitZstdFrames(buffer) {
  if (typeof zstdDecompressSync !== 'function') {
    throw new Error(`回放扫描需要 Node ≥22.15 的 zstd 支持（当前 ${process.version}）——先升级或用 zstd CLI 预处理`);
  }
  const starts = [];
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (
      buffer[i] === FRAME_MAGIC[0] &&
      buffer[i + 1] === FRAME_MAGIC[1] &&
      buffer[i + 2] === FRAME_MAGIC[2] &&
      buffer[i + 3] === FRAME_MAGIC[3]
    ) {
      starts.push(i);
    }
  }
  const chunks = [];
  let failedCandidates = 0;
  let index = 0;
  while (index < starts.length) {
    let done = null;
    for (let end = index + 1; end <= Math.min(index + 6, starts.length); end += 1) {
      const slice = buffer.subarray(starts[index], starts[end] ?? buffer.length);
      try {
        const out = zstdDecompressSync(slice);
        // 空输出不算解成功：把半帧/裸魔数当"帧"会静默丢数据（实测：只喂 4 字节魔数会返回空而不报错）
        if (out.length === 0) continue;
        done = { out, next: end };
        break;
      } catch {
        /* 换个更长的跨度再试 */
      }
    }
    if (done === null) {
      failedCandidates += 1;
      index += 1;
      continue;
    }
    chunks.push(done.out);
    index = done.next;
  }
  return { frames: chunks.length, failedCandidates, text: Buffer.concat(chunks).toString('utf8') };
}

/** 解析日志正文：一行一个 JSON。坏行不吞掉，计数报出来。 */
export function parseSessionRows(text) {
  const rows = [];
  let badLines = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      badLines += 1;
    }
  }
  return { rows, badLines };
}

export function decodeSessionLog(buffer) {
  const { frames, failedCandidates, text } = splitZstdFrames(buffer);
  const { rows, badLines } = parseSessionRows(text);
  return { frames, failedCandidates, badLines, rows };
}

/** 日志文件名的版本优先级：v4 > v3 > plain。 */
export function logVersionOf(name) {
  if (/\.v4\./.test(name)) return 4;
  if (/\.v3\./.test(name)) return 3;
  return 1;
}

/**
 * 找会话日志：按会话目录去重、取最高版本。
 *
 * 实测（2026-11-17，231 个会话目录）：plain 89 / v3 47 / v4 95，其中 8 个目录 plain+v3 共存
 * —— 逐文件计数会得到 239，比真实会话数多 8。所以会话身份是目录名。
 */
export function listSessionLogs(root) {
  const logs = [];
  const duplicates = [];
  let slugs = [];
  try {
    slugs = readdirSync(root);
  } catch (error) {
    throw new Error(`读不到会话根目录：${root}（${error instanceof Error ? error.message : String(error)}）`);
  }
  for (const slug of slugs) {
    const slugPath = join(root, slug);
    let sessionDirs = [];
    try {
      if (!statSync(slugPath).isDirectory()) continue;
      sessionDirs = readdirSync(slugPath);
    } catch {
      continue;
    }
    for (const sessionId of sessionDirs) {
      const dirPath = join(slugPath, sessionId);
      let names = [];
      try {
        if (!statSync(dirPath).isDirectory()) continue;
        names = readdirSync(dirPath).filter((name) => /^session.*\.jsonl\.zstd$/.test(name));
      } catch {
        continue;
      }
      if (names.length === 0) continue;
      const picked = names
        .map((name) => ({ name, version: logVersionOf(name) }))
        .sort((left, right) => right.version - left.version)[0];
      if (names.length > 1) duplicates.push({ slug, sessionId, files: names.slice().sort() });
      logs.push({ slug, sessionId, file: join(dirPath, picked.name), version: picked.version });
    }
  }
  logs.sort((left, right) => `${left.slug}/${left.sessionId}`.localeCompare(`${right.slug}/${right.sessionId}`));
  return { logs, duplicates };
}

/** 默认会话日志根目录（宿主相关，所以在 CLI 里也可覆盖）。 */
export function defaultSessionRoot() {
  return join(homedir(), '.dsh', 'sessions');
}

export function extractUuids(text) {
  return String(text ?? '').match(UUID_RE) ?? [];
}

/** 把 `data.arguments`（JSON 字符串）掰开：单条取 [text]，批量取 entries[].text 与 kind。 */
function parseWriteArgs(rawArguments) {
  try {
    const args = JSON.parse(String(rawArguments ?? '{}'));
    if (Array.isArray(args?.entries)) {
      return args.entries.map((entry) => ({
        text: entry?.text === undefined ? null : String(entry.text),
        kind: entry?.kind === undefined ? null : String(entry.kind),
      }));
    }
    return [{ text: args?.text === undefined ? null : String(args.text), kind: args?.kind === undefined ? null : String(args.kind) }];
  } catch {
    return [];
  }
}

const KIND_IN_PARENS = /（([a-z]+)）/;
/** 只认这两种行首：批量结果里每条的写法。note 行（"- 这条带状态变化口吻…"）不是条目。 */
const ENTRY_LINE = /^-\s*(已写入|重复，已累加命中)[：:]/;

/**
 * 结果正文 → 逐条状态。
 *
 * 只有三种正文形状（yu 侧 index.js 渲染）：
 *   单条：`已写入记忆 <id>（<kind>）。` / `未新建：与已有记忆重复（id <id>），已累加命中。`
 *   批量：`一次写入 N 条：\n- 已写入：<id>（<kind>）\n- 重复，已累加命中：<id>（<kind>）`
 *   两种后面都可能跟 note 行，同样以 `- ` 开头 —— 把它们当条目会把 31 次写入解析成 144 行未知。
 *
 * 查重命中的行同样带 uuid —— 不分类就会把 NOOP 算成新写入（第二阶段量的就是 NOOP）。
 */
export function parseWriteResult(text, isError = false) {
  if (isError === true) return [{ status: 'error', id: null, kind: null }];
  const body = String(text ?? '');
  const classify = (line) => {
    const id = extractUuids(line)[0] ?? null;
    const kindMatch = KIND_IN_PARENS.exec(line);
    const kind = kindMatch === null ? null : kindMatch[1];
    if (line.includes('已写入')) return { status: 'created', id, kind };
    if (line.includes('未新建') || line.includes('重复')) return { status: 'deduped', id, kind };
    return { status: 'unknown', id, kind };
  };

  // 单条形状：正文第一行就是结论（后面可能跟 note）
  const firstLine = body.split('\n')[0] ?? '';
  if (firstLine.includes('已写入记忆') || firstLine.includes('未新建')) return [classify(firstLine)];

  // 批量形状：只取严格匹配的条目行，note 行忽略
  const entries = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => ENTRY_LINE.test(line));
  if (entries.length > 0) return entries.map(classify);

  // 都不像：别扔，交一个 unknown 出去（带 uuid 就带 uuid），让报告能看见它
  return [classify(firstLine)];
}

/**
 * 一个会话的写配对：callId → 提交的文本 → 结果正文里的状态与 uuid。
 *
 * 失败调用留一行（status=error、id 为空）：试着写但失败了是链路的一部分，不该从统计里消失。
 * 正文与 entries 条数不等时不回落（`textMissing: true`）——静默回落等于把两条不同的东西算成同一条。
 */
export function buildWritePairs(rows, sessionId = null, extra = {}) {
  const calls = new Map();
  let callCount = 0;
  const nameCounts = new Map();
  for (const row of rows) {
    if (row?.type !== 'tool/call') continue;
    callCount += 1;
    const name = String(row.data?.name ?? '?');
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    calls.set(String(row.data?.callId ?? ''), {
      name,
      arguments: row.data?.arguments,
      turn: typeof row.data?.turn === 'number' ? row.data.turn : null,
      step: typeof row.data?.step === 'number' ? row.data.step : null,
    });
  }

  const pairs = [];
  let writeCalls = 0;
  for (const row of rows) {
    if (row?.type !== 'tool/result') continue;
    const callId = String(row.data?.message?.toolCallId ?? row.data?.toolCallId ?? '');
    const call = calls.get(callId);
    if (call === undefined || call.name !== 'memory_write') continue;
    writeCalls += 1;
    const message = row.data?.message ?? {};
    const isError = message.isError === true;
    const resultText = String(message.content?.[0]?.text ?? '');
    const results = parseWriteResult(resultText, isError);
    const submitted = parseWriteArgs(call.arguments);
    // 数目对不上就标出来：新形状若悄悄少解析，靠这个计数能看见，而不是从分母里凭空消失
    const countMismatch = results.length !== submitted.length;
    const base = {
      sessionId,
      slug: extra.slug ?? null,
      turn: call.turn,
      step: call.step,
      callId,
      name: call.name,
      rawArgs: String(call.arguments ?? ''),
      resultText: resultText.slice(0, 300),
      label: 'tool',
    };
    results.forEach((result, index) => {
      const entry = submitted[index];
      pairs.push({
        ...base,
        kind: result.kind ?? entry?.kind ?? null,
        text: entry === undefined ? null : entry.text,
        textMissing: entry === undefined || entry?.text === null,
        id: result.id,
        status: result.status,
        countMismatch,
        isError,
      });
    });
  }
  return { pairs, callCount, writeCalls, nameCounts };
}

/**
 * 钩子写入（explicit / 事件钩子直接落库）：transcript 里没有 tool/call 锚。
 *
 * 实测这个库里只有个位数，但它是"该记什么"的一部分 ——
 * 所以单列一个口径，且它只有 session 级坐标、没有轮次坐标，不能和 tool 口径混算总分。
 * cutoff 按 sessionId 从会话统计继承（`cutoffs`）；会话不在本批扫描里就留 null，不猜。
 */
export function buildHookPairs(storeState, toolIds = new Set(), cutoffs = new Map()) {
  const pairs = [];
  const memories = Array.isArray(storeState?.memories) ? storeState.memories : [];
  for (const row of memories) {
    const isHook = row?.source === 'explicit' || row?.explicit === true;
    if (!isHook) continue;
    if (toolIds.has(String(row.id))) continue;
    const sessionId = row.sessionId ?? null;
    pairs.push({
      sessionId,
      slug: null,
      cutoff: cutoffs.get(sessionId) ?? null,
      turn: null,
      step: null,
      callId: null,
      name: 'hook',
      kind: String(row.kind ?? ''),
      text: String(row.text ?? ''),
      textMissing: false,
      rawArgs: '',
      resultText: null,
      countMismatch: false,
      id: String(row.id ?? ''),
      status: 'created',
      isError: false,
      label: 'hook',
    });
  }
  return pairs;
}

/**
 * 库快照：按某个时刻重建"当时的样子"。
 *
 * 为什么必须能重建：残差的全库匹配若用今天的库，会拿会话结束之后才写进去的条目自证
 * —— 那是时间泄漏。规则只有一条：`archivedAt > cutoff` 的行当时还活跃。
 * slot 以 `updatedAt` 计（状态是覆盖写，只看最后那一次）。
 *
 * 注意语义边界：这里重建的是「**存在且活跃**」，不是「生效」。
 * 被 relax 过的约束在旧库里仍然是 active —— 消费侧要"生效"语义，得自己按 `relaxedAt <= cutoff` 再滤一遍。
 */
export function snapshotAt(storeState, cutoff) {
  const memories = (Array.isArray(storeState?.memories) ? storeState.memories : []).filter((row) => {
    if ((Number(row.createdAt) || 0) > cutoff) return false;
    if (row.status === 'active') return true;
    return (Number(row.archivedAt) || 0) > cutoff;
  });
  const slots = (Array.isArray(storeState?.slots) ? storeState.slots : []).filter(
    (row) => (Number(row.createdAt ?? 0) || 0) <= cutoff && (Number(row.updatedAt ?? 0) || 0) <= cutoff,
  );
  const loops = (Array.isArray(storeState?.loops) ? storeState.loops : []).filter(
    (row) => (Number(row.openedAt ?? 0) || 0) <= cutoff && (row.closedAt == null || Number(row.closedAt) > cutoff),
  );
  return { memories, slots, loops, cutoff };
}

/** 一个会话的读数：注入口径、轮次、写配对、cutoff。 */
export function scanSession({ rows, sessionId = null, slug = null }) {
  const cutoff = rows.reduce((latest, row) => {
    const at = Number(row?.time ?? row?.data?.time ?? 0) || 0;
    return at > latest ? at : latest;
  }, 0);
  const { pairs, writeCalls, nameCounts } = buildWritePairs(rows, sessionId, { slug, cutoff });
  const inject = new Map();
  let turns = 0;
  let userTurns = 0;
  for (const row of rows) {
    if (row?.type === 'turn/start') turns += 1;
    if (row?.type !== 'user/message') continue;
    const kind = String(row.data?.source?.kind ?? 'none');
    inject.set(kind, (inject.get(kind) ?? 0) + 1);
    if (kind === 'user') userTurns += 1;
  }
  for (const pair of pairs) pair.cutoff = cutoff;
  return {
    sessionId,
    slug,
    cutoff,
    turns,
    userMessages: userTurns,
    injectByKind: Object.fromEntries([...inject.entries()].sort((left, right) => right[1] - left[1])),
    writeCalls,
    toolCalls: [...nameCounts.entries()].sort((left, right) => right[1] - left[1]),
    pairs,
  };
}

/**
 * 扫一个根目录，产出报告 + 配对表。
 *
 * 分两层是硬的（实测：15 个会话有写入、216 个没有；82.8% 的轮次没有分母）：
 * 有标签层只能算召回，且样本小到别当发布数；无标签层只能测误报和覆盖率，**禁算召回**。
 */
export function scanRoot(root, options = {}) {
  const store = options.store ?? null;
  const { logs, duplicates } = listSessionLogs(root);
  const byVersion = new Map();
  const sessions = [];
  let failedCandidates = 0;
  let badLines = 0;
  let totalFrames = 0;

  for (const log of logs) {
    byVersion.set(log.version, (byVersion.get(log.version) ?? 0) + 1);
    let decoded;
    try {
      decoded = decodeSessionLog(readFileSync(log.file));
    } catch (error) {
      sessions.push({ sessionId: log.sessionId, slug: log.slug, error: String(error?.message ?? error) });
      continue;
    }
    failedCandidates += decoded.failedCandidates;
    badLines += decoded.badLines;
    totalFrames += decoded.frames;
    const scanned = scanSession({ rows: decoded.rows, sessionId: log.sessionId, slug: log.slug });
    sessions.push({ ...scanned, version: log.version, frames: decoded.frames });
  }

  const toolPairs = sessions.flatMap((session) => session.pairs ?? []);
  const toolIds = new Set(toolPairs.map((pair) => pair.id).filter(Boolean));
  const cutoffs = new Map(sessions.filter((session) => typeof session.cutoff === 'number').map((session) => [session.sessionId, session.cutoff]));
  const hookPairs = store === null ? [] : buildHookPairs(store, toolIds, cutoffs);
  const pairs = [...toolPairs, ...hookPairs];

  const statusCounts = new Map();
  for (const pair of pairs) statusCounts.set(pair.status, (statusCounts.get(pair.status) ?? 0) + 1);

  const usedMemories = new Set((store?.memories ?? []).map((row) => row.id));
  const createdTool = toolPairs.filter((pair) => pair.status === 'created');
  const createdNonSlot = createdTool.filter((pair) => pair.kind !== 'slot');
  const matchedInStore = createdNonSlot.filter((pair) => usedMemories.has(pair.id));
  const missingInStore = createdNonSlot.filter((pair) => !usedMemories.has(pair.id));

  const labeledSessions = sessions.filter((session) => (session.pairs ?? []).some((pair) => pair.status === 'created'));
  const unlabeledSessions = sessions.filter((session) => !labeledSessions.includes(session));
  const injectTotals = new Map();
  for (const session of sessions) {
    for (const [kind, count] of Object.entries(session.injectByKind ?? {})) {
      injectTotals.set(kind, (injectTotals.get(kind) ?? 0) + count);
    }
  }
  const pluginKinds = [...injectTotals.entries()].filter(([kind]) => kind.startsWith('plugin'));
  const pluginTotal = pluginKinds.reduce((sum, [, count]) => sum + count, 0);
  const userMessages = injectTotals.get('user') ?? 0;
  const injected = [...injectTotals.entries()].filter(([kind]) => kind !== 'user').reduce((sum, [, count]) => sum + count, 0);

  const header = {
    type: 'header',
    scannerVersion: SCANNER_VERSION,
    rulesDigest: ruleDigest(),
    codeDigest: codeDigest(),
    rules: SCAN_RULES,
    engineGit: options.engineGit ?? null,
    generatedAt: new Date(options.now ?? Date.now()).toISOString(),
    root,
    storePath: options.storePath ?? null,
  };

  return {
    header,
    files: {
      sessions: logs.length,
      byVersion: Object.fromEntries([...byVersion.entries()].sort()),
      multiVersionDirs: duplicates.length,
      duplicates,
      frames: totalFrames,
      failedCandidates,
      badLines,
      errored: sessions.filter((session) => session.error !== undefined).length,
    },
    layers: {
      labeledSessions: labeledSessions.length,
      unlabeledSessions: unlabeledSessions.length,
      labeledTurns: labeledSessions.reduce((sum, session) => sum + (session.turns ?? 0), 0),
      unlabeledTurns: unlabeledSessions.reduce((sum, session) => sum + (session.turns ?? 0), 0),
    },
    inject: {
      byKind: Object.fromEntries([...injectTotals.entries()].sort((left, right) => right[1] - left[1])),
      userMessages,
      injected,
      pluginTotal,
      pluginKinds: Object.fromEntries(pluginKinds.sort((left, right) => right[1] - left[1])),
      hostBoilerplate: injected - pluginTotal,
    },
    status: Object.fromEntries([...statusCounts.entries()].sort()),
    denominators: {
      toolPairs: toolPairs.length,
      createdTool: createdTool.length,
      deduped: (statusCounts.get('deduped') ?? 0),
      errors: (statusCounts.get('error') ?? 0),
      unknown: (statusCounts.get('unknown') ?? 0),
      // 召回分母：只算真正新建的、且不是 slot 覆盖写（状态更新不是新事实）
      recallBase: createdNonSlot.length,
      matchedInStore: matchedInStore.length,
      missingInStore: missingInStore.length,
      missingInStoreIds: missingInStore.map((pair) => `${pair.sessionId}/${pair.id}`),
      hookOnly: hookPairs.length,
      toolPlusHook: createdNonSlot.length + hookPairs.length,
      // 正文条数与提交条数对不上的调用数：新形状悄悄少解析时，这里是唯一的出口
      countMismatchCalls: new Set(toolPairs.filter((pair) => pair.countMismatch === true).map((pair) => pair.callId)).size,
      textMissingRows: pairs.filter((pair) => pair.textMissing === true).length,
      hookWithoutCutoff: hookPairs.filter((pair) => pair.cutoff === null).length,
    },
    pairs,
    sessions,
  };
}

/** 配对表：第一行是表头（含 generatedAt/版本/规则/代码指纹），之后一行一个配对。 */
export function pairsToJsonl(report) {
  const lines = [JSON.stringify(report.header)];
  for (const pair of report.pairs) {
    lines.push(
      JSON.stringify({
        sessionId: pair.sessionId,
        slug: pair.slug ?? null,
        cutoff: pair.cutoff ?? null,
        turn: pair.turn,
        step: pair.step,
        callId: pair.callId,
        name: pair.name,
        label: pair.label,
        kind: pair.kind ?? null,
        status: pair.status,
        id: pair.id,
        text: pair.text ?? null,
        textMissing: pair.textMissing === true,
        countMismatch: pair.countMismatch === true,
        resultText: pair.resultText ?? null,
        isError: pair.isError === true,
      }),
    );
  }
  return `${lines.join('\n')}\n`;
}
