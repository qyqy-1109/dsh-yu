/**
 * 候选判分：把抽取网的候选喂给治理链的只读判据，算两类召回。
 *
 * 三条纪律：
 * ① 判据走 `MemoryStore.previewWrite`（与被验系统同一份），不自己算相似度；
 * ② 标签集必须含**钩子口径**（explicit 写入在 transcript 里没有 tool/call 锚）——
 *    漏掉它召回会被系统性低估（实测：一条 0.846 的命中被 `label === 'tool'` 整段滤掉了）；
 * ③ 库用**临时副本**打开，绝不碰真库。
 *
 * 两类召回，别混：
 *   信息召回 —— 语义等价的候选接上了多少标签（字面相似度只是粗筛，最终要人标校准）
 *   治理召回 —— 治理链 dedupe 命中了多少标签（量的是**活库近重复污染**，不是抽取网好坏）
 *
 * 用法：
 *   node scripts/score-candidates.mjs --candidates <jsonl> --pairs <jsonl> --store <store.json> [--threshold 0.65]
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { MemoryStore } from '../lib/store.js';
import { similarity } from '../lib/text.js';
import { decodeSessionLog, listSessionLogs, defaultSessionRoot, SCANNER_VERSION, ruleDigest, codeDigest } from '../lib/replay.js';
import { matchByEntitiesV2, entityOverlap, sharedEvidence, keyEntities, RECALL_RULER } from '../lib/replay-recall.js';
import { coveredRanges, labelsInScope } from '../lib/replay-extract.js';
import { sameProposition, classifyType, TYPE_CLASSIFIER_VERSION } from '../lib/replay-proposition.js';

function parseArgs(argv) {
  const args = { gate: 'type', candidates: null, pairs: null, store: null, gold: null, plan: null, outScored: null, threshold: 0.65, verbose: false, sessionsRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--candidates') args.candidates = argv[++i];
    else if (token === '--pairs') args.pairs = argv[++i];
    else if (token === '--store') args.store = argv[++i];
    else if (token === '--gold') args.gold = argv[++i];
    else if (token === '--plan') args.plan = argv[++i];
    else if (token === '--gate') args.gate = argv[++i];
    else if (token === '--out-scored') args.outScored = argv[++i];
    else if (token === '--threshold') args.threshold = Number(argv[++i]);
    else if (token === '--sessions-root') args.sessionsRoot = argv[++i];
    else if (token === '--verbose') args.verbose = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`不认识的参数：${token}`);
  }
  return args;
}

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .filter((row) => row.type !== 'header');
}

/** 候选工件的第一行是表头（promptVersion/model/…），判分时要把 promptVersion 带进报告头。 */
function readCandidateHeader(path) {
  const first = readFileSync(path, 'utf8').split('\n').find((line) => line.trim().length > 0);
  if (first === undefined) return null;
  try {
    const parsed = JSON.parse(first);
    return parsed?.type === 'header' ? parsed : null;
  } catch {
    return null;
  }
}

/** 引擎代码身份：有 git 就用 SHA，没有就明确说 no-git（另有 codeDigest 兜底）。 */
function engineGit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'no-git';
  }
}

/**
 * 门判定：none 全放行；type 只比类型（**默认**）；type+subject 再加主语冲突。
 *
 * 主语门实测净负：gold-20 上 type-only 是 pairPrecision 0.80 / rejectPrecision 0.80，
 * 加上主语门掉到 0.75 / 0.667；全量上 gated 召回 5.8% → 5.0%（多拒 3 条、无精度收益）。
 * 所以默认不用它。留着代码是为了可回测，不是为了默认启用。
 */
function gateDecision(candidateText, labelText, mode) {
  const candidateType = classifyType(candidateText).type;
  const labelType = classifyType(labelText).type;
  if (mode === 'none') return { mode, pass: true, candidateType, labelType, reason: 'gate-off' };
  if (candidateType !== labelType) return { mode, pass: false, candidateType, labelType, reason: 'type-mismatch' };
  if (mode === 'type') return { mode, pass: true, candidateType, labelType, reason: 'type-match' };
  const verdict = sameProposition({ text: candidateText }, { text: labelText });
  return { mode, pass: verdict.same, candidateType, labelType, reason: verdict.reason };
}

async function openStoreCopy(storePath) {
  const dir = mkdtempSync(join(tmpdir(), 'loom-score-'));
  copyFileSync(storePath, join(dir, 'store.json'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 0 });
  await store.open();
  return { dir, store };
}

/** 会话的轮次时间表：钩子写入只有 createdAt，得靠它映射到轮次，否则会被 inScope 全滤掉。 */
function loadTurnRanges(sessionsRoot, wanted) {
  const ranges = new Map();
  let logs = [];
  try {
    logs = listSessionLogs(sessionsRoot).logs;
  } catch {
    return ranges;
  }
  for (const log of logs) {
    if (!wanted.has(log.sessionId)) continue;
    let rows;
    try {
      rows = decodeSessionLog(readFileSync(log.file)).rows;
    } catch {
      continue;
    }
    const list = [];
    let current = null;
    for (const row of rows) {
      if (row?.type === 'turn/start') {
        current = { turn: list.length + 1, startAt: Number(row.time ?? 0) || 0, endAt: null };
        list.push(current);
        continue;
      }
      if (row?.type === 'turn/end' && current !== null) current.endAt = Number(row.time ?? 0) || 0;
    }
    ranges.set(log.sessionId, list);
  }
  return ranges;
}

/** createdAt → 轮次：落在哪一轮的时间区间里就是那一轮；落在空档就归到前一轮。 */
function turnOfTime(ranges, createdAt) {
  if (!Array.isArray(ranges) || createdAt === null) return null;
  let candidate = null;
  for (const range of ranges) {
    const end = range.endAt ?? range.startAt;
    if (createdAt >= range.startAt) candidate = range.turn;
    if (createdAt >= range.startAt && createdAt <= end) return range.turn;
  }
  return candidate;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    console.log('用法：node scripts/score-candidates.mjs --candidates <jsonl> --pairs <jsonl> --store <store.json> [--threshold 0.65] [--verbose]');
    return;
  }
  const candidates = readJsonl(resolve(args.candidates));
  const candHeader = readCandidateHeader(resolve(args.candidates));
  const pairs = readJsonl(resolve(args.pairs));
  const { dir, store } = await openStoreCopy(resolve(args.store));
  try {
    const known = new Map(store.state.memories.map((row) => [row.id, row]));
    const wanted = new Set(candidates.map((candidate) => candidate.sessionId));
    const turnRanges = loadTurnRanges(args.sessionsRoot === null ? defaultSessionRoot() : resolve(args.sessionsRoot), wanted);

    /**
     * 标签 = 当年真的写进去的（created ∧ 非 slot ∧ 在本库），**tool 与 hook 都算**。
     * 钩子行没有 turn，按 createdAt 映射；映射不到就留 null（留 null 会被 inScope 排除，
     * 所以报告里单独报 mapped 数，别让它静默消失）。
     */
    const labels = [];
    for (const pair of pairs) {
      if (pair.status !== 'created' || pair.kind === 'slot' || pair.id === null) continue;
      if (pair.label !== 'tool' && pair.label !== 'hook') continue;
      const row = known.get(pair.id);
      if (row === undefined) continue;
      const turn = typeof pair.turn === 'number' ? pair.turn : turnOfTime(turnRanges.get(pair.sessionId), Number(row.createdAt ?? 0) || null);
      labels.push({ id: pair.id, sessionId: pair.sessionId, turn, kind: pair.kind, text: String(pair.text ?? ''), channel: pair.label });
    }
    const labelsBySession = new Map();
    for (const label of labels) {
      if (!labelsBySession.has(label.sessionId)) labelsBySession.set(label.sessionId, []);
      labelsBySession.get(label.sessionId).push(label);
    }

    /**
     * 分母 = 「被处理过的轮次里写下的条目」，覆盖范围**只来自选择清单**。
     *
     * 三次同向 bug 的教训（漏钩子标签 → 拿“产出过候选的窗口”当分母 → 零候选窗口从分母消失），
     * 方向全一致：分母变小、数字变好看。所以分母路径不读候选集；
     * 没给 plan 就直接拒绝跑 —— 宁可跑不了，也不给一个偏高的数。
     */
    if (args.plan === null) {
      throw new Error('判分必须带 --plan（由 extract-candidates.mjs --plan-only 产出）：分母不许从候选集推');
    }
    const planFile = JSON.parse(readFileSync(resolve(args.plan), 'utf8'));
    const covered = coveredRanges(planFile?.selected ?? []);
    // 分母只用 labelsInScope(labels, covered)：这个函数的入参里没有候选，结构上就撞不出第三次
    const scopedLabels = labelsInScope(labels, covered);

    const rows = [];
    /**
     * 标签语料的 df 表：entity-v2 的稀有证据判据要用它。
     * 在**这批标签**上统计，跟着工件一起被钉住，换语料就得重算（不要跨批复用）。
     */
    const df = new Map();
    for (const label of labels) for (const token of keyEntities(label.text)) df.set(token, (df.get(token) ?? 0) + 1);

    for (const candidate of candidates) {
      const preview = store.previewWrite({ kind: candidate.kind, text: candidate.text });
      const sessionLabels = labelsBySession.get(candidate.sessionId) ?? [];
      // 主尺子：entity-v2（冻结版：floor 0.1 + 稀有证据 ≥1，剔两类分词伪迹）
      const entityHit = matchByEntitiesV2({ kind: candidate.kind, text: candidate.text }, sessionLabels, {
        df,
        threshold: RECALL_RULER.defaultThreshold,
        rareMin: 1,
      });
      let surfaceHit = null;
      for (const label of sessionLabels) {
        const score = similarity(String(candidate.text), label.text);
        if (surfaceHit === null || score > surfaceHit.score) surfaceHit = { label, score };
      }
      if (surfaceHit !== null && surfaceHit.score < args.threshold) surfaceHit = null;
      rows.push({
        sessionId: candidate.sessionId,
        fromTurn: candidate.fromTurn,
        kind: candidate.kind,
        text: candidate.text,
        candidateType: classifyType(candidate.text).type,
        action: preview.action,
        chainScore: preview.score === null ? null : Number(preview.score.toFixed(3)),
        contradicted: preview.contradicted === true,
        entityMatchLabelId: entityHit === null ? null : entityHit.id,
        entityMatchScore: entityHit === null ? null : entityHit.score,
        entityMatchRare: entityHit === null ? [] : entityHit.rare,
        matchedLabelText: entityHit === null ? null : entityHit.labelText,
        surfaceMatchLabelId: surfaceHit === null ? null : surfaceHit.label.id,
        surfaceMatchScore: surfaceHit === null ? null : Number(surfaceHit.score.toFixed(3)),
        dedupeLabelId: preview.action === 'dedupe' ? preview.nearestId : null,
        proposition: entityHit === null ? null : gateDecision(candidate.text, entityHit.labelText ?? '', args.gate),
      });
    }

    /**
     * 去重：抽取网会跨窗重复提同一条（实测 15 条里 4 组）。
     *
     * 门槛故意比召回尺子**高**：召回宁可多认，去重不能乱合。
     * 判据 = (containment ≥ 0.5) 或 (稀有证据 ≥ 2)。
     * 只用 rare≥1 会把「星云底与丝带线」和「帧率保证」按「动态」这个泛词并成一条 —— 那是两个事实。
     * 够不上门槛但 containment ≥ 0.3 的单独计 `possibleDuplicates`，让口径的敏感性看得见。
     */
    let possibleDuplicates = 0;
    rows.forEach((row, index) => {
      row.duplicateOf = null;
      row.duplicate = false;
      if (index === 0) return;
      let best = null;
      for (let j = 0; j < index; j += 1) {
        const other = rows[j];
        const { score } = entityOverlap(row.text, other.text);
        const evidence = sharedEvidence(row.text, other.text, { df });
        const isDup = score >= 0.5 || evidence.rare.length >= 2;
        if (isDup) {
          if (best === null || score > best.score) best = { id: j + 1, score };
        } else if (score >= 0.3) possibleDuplicates += 1;
      }
      if (best !== null) {
        row.duplicateOf = best.id;
        row.duplicate = true;
      }
    });
    const effective = rows.filter((row) => row.duplicate !== true);

    const tally = { create: 0, dedupe: 0 };
    for (const row of rows) tally[row.action] += 1;

    // 主指标用全部行；去重后另算一份（去重规则本身未经验证，不许它悄悄挪动头条数）
    const entityHitLabels = new Set(rows.filter((row) => row.entityMatchLabelId !== null).map((row) => row.entityMatchLabelId));
    const entityHitLabelsDeduped = new Set(effective.filter((row) => row.entityMatchLabelId !== null).map((row) => row.entityMatchLabelId));
    const surfaceHitLabels = new Set(rows.filter((row) => row.surfaceMatchLabelId !== null).map((row) => row.surfaceMatchLabelId));
    const dedupeHitLabels = new Set(rows.filter((row) => row.dedupeLabelId !== null).map((row) => row.dedupeLabelId));
    const gatedHitLabels = new Set(rows.filter((row) => row.entityMatchLabelId !== null && row.proposition?.pass === true).map((row) => row.entityMatchLabelId));
    const gateStats = { mode: args.gate, pass: 0, rejectType: 0, rejectSubject: 0, humanReviewPool: 0 };
    const typeDistribution = {};
    for (const row of rows) {
      const type = classifyType(row.text).type;
      typeDistribution[type] = (typeDistribution[type] ?? 0) + 1;
      if (row.proposition === null) continue;
      if (row.proposition.pass === true) gateStats.pass += 1;
      else if (row.proposition.reason === 'type-mismatch') gateStats.rejectType += 1;
      else { gateStats.rejectSubject += 1; }
      if (row.proposition.pass !== true) gateStats.humanReviewPool += 1;
    }
    const tallyEffective = { create: 0, dedupe: 0 };
    for (const row of effective) tallyEffective[row.action] += 1;
    const hitIn = (set) => scopedLabels.filter((label) => set.has(label.id)).length;

    const header = {
      type: 'header',
      scorerVersion: '0.3.0',
      dedupeByDuplicateOf: args.gold !== null,
      goldFile: args.gold === null ? null : resolve(args.gold),
      ruler: RECALL_RULER,
      threshold: args.threshold,
      promptVersion: candHeader?.promptVersion ?? null,
      candidateModel: candHeader?.model ?? null,
      candidateDegradedCalls: candHeader?.degradedCalls ?? null,
      engineGit: engineGit(),
      scannerVersion: SCANNER_VERSION,
      rulesDigest: ruleDigest(),
      codeDigest: codeDigest(),
      storePath: resolve(args.store),
      planFile: args.plan === null ? null : resolve(args.plan),
      candidatesFile: resolve(args.candidates),
      pairsFile: resolve(args.pairs),
      generatedAt: new Date().toISOString(),
    };

    console.log(
      JSON.stringify(
        {
          header,
          candidates: rows.length,
          duplicatesRemoved: rows.length - effective.length,
          possibleDuplicates,
          candidatesEffective: effective.length,
          sessions: new Set(effective.map((row) => row.sessionId)).size,
          windows: new Set(effective.map((row) => `${row.sessionId}#${row.fromTurn}`)).size,
          labels: {
            total: labels.length,
            tool: labels.filter((label) => label.channel === 'tool').length,
            hook: labels.filter((label) => label.channel === 'hook').length,
            turnMapped: labels.filter((label) => label.turn !== null).length,
            inScope: scopedLabels.length,
          },
          chain: { create: tallyEffective.create, dedupe: tallyEffective.dedupe, dedupeRate: effective.length === 0 ? null : Number((tallyEffective.dedupe / effective.length).toFixed(3)) },
          infoRecall: {
            ruler: RECALL_RULER.version,
            labelsHit: hitIn(entityHitLabels),
            recall: scopedLabels.length === 0 ? null : Number((hitIn(entityHitLabels) / scopedLabels.length).toFixed(3)),
            gated: {
              note: '门是过滤器：rejectPrecision 0.667 意味着约 1/3 的拒绝是误杀，被拒的进人审池',
              labelsHit: hitIn(gatedHitLabels),
              recall: scopedLabels.length === 0 ? null : Number((hitIn(gatedHitLabels) / scopedLabels.length).toFixed(3)),
            },
            gate: gateStats,
            typeDistribution,
            typeClassifierVersion: TYPE_CLASSIFIER_VERSION,
            dedupedSensitivity: {
              note: '去重后另算一份；合并规则未经验证，只报不改头条',
              labelsHit: hitIn(entityHitLabelsDeduped),
              recall: scopedLabels.length === 0 ? null : Number((hitIn(entityHitLabelsDeduped) / scopedLabels.length).toFixed(3)),
            },
          },
          surfaceRecallForReference: {
            note: '字面相似度只作对照：它给治理链查重校准，不是召回尺子',
            threshold: args.threshold,
            labelsHit: hitIn(surfaceHitLabels),
            recall: scopedLabels.length === 0 ? null : Number((hitIn(surfaceHitLabels) / scopedLabels.length).toFixed(3)),
          },
          governanceRecall: {
            labelsDeduped: hitIn(dedupeHitLabels),
            rate: scopedLabels.length === 0 ? null : Number((hitIn(dedupeHitLabels) / scopedLabels.length).toFixed(3)),
          },
        },
        null,
        2,
      ),
    );
    if (args.outScored !== null) {
      writeFileSync(resolve(args.outScored), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    }
    if (args.verbose === true) for (const row of rows) console.log(JSON.stringify(row));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
