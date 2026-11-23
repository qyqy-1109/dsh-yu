/**
 * 抽取网的输入与判分（第二阶段骨架，零模型）：
 * 把会话日志切成"轮次窗"，再把候选喂给治理链的只读判据（`MemoryStore.previewWrite`）。
 *
 * 为什么不按帧切：帧是 flush 粒度（实测 2.09 行/帧），轮次才是语义单位（`turn/start`）。
 * 为什么喂给 previewWrite 而不是自己算相似度：NOOP 的判据必须和被验系统同一份，
 * 否则量出来的是另一个系统的命中率。
 */
import { similarity } from './text.js';

/**
 * 切轮次窗。
 *
 * 只收 `source.kind === 'user'` 的正文 —— 注入块也是 user/message，
 * 混进来等于让抽取网把自己上一轮的输出当用户原话再抽一遍。
 *
 * @param {Array<object>} rows 会话日志行
 * @param {{sessionId?: string|null, turns?: number, stride?: number, now?: number}} [options]
 * @returns {{sessionId: string|null, windows: Array<object>, turns: number, userTurns: number}}
 */
export function buildTurnWindows(rows, options = {}) {
  const sessionId = options.sessionId ?? null;
  const size = Math.max(1, Number(options.turns ?? 6));
  const stride = Math.max(1, Number(options.stride ?? size));

  const turns = [];
  let current = null;
  for (const row of rows) {
    if (row?.type === 'turn/start') {
      current = { turn: turns.length + 1, startAt: Number(row.time ?? 0) || 0, userTexts: [], endAt: null };
      turns.push(current);
      continue;
    }
    if (row?.type === 'turn/end' && current !== null) {
      current.endAt = Number(row.time ?? 0) || 0;
      continue;
    }
    if (row?.type !== 'user/message') continue;
    if (row?.data?.source?.kind !== 'user') continue;
    const text = (row.data?.content ?? [])
      .filter((part) => part?.type === 'text')
      .map((part) => String(part.text ?? ''))
      .join('')
      .trim();
    if (text.length === 0) continue;
    if (current === null) {
      current = { turn: turns.length + 1, startAt: Number(row.time ?? 0) || 0, userTexts: [], endAt: null };
      turns.push(current);
    }
    current.userTexts.push(text);
  }

  const userTurns = turns.filter((turn) => turn.userTexts.length > 0).length;
  const windows = [];
  for (let from = 0; from < turns.length; from += stride) {
    const slice = turns.slice(from, from + size);
    if (slice.length === 0) break;
    const userText = slice
      .flatMap((turn) => turn.userTexts)
      .join('\n---\n')
      .trim();
    if (userText.length === 0) continue;
    const last = slice.at(-1);
    windows.push({
      sessionId,
      fromTurn: slice[0].turn,
      toTurn: last.turn,
      turns: slice.length,
      chars: userText.length,
      userText,
      cutoff: last.endAt ?? last.startAt,
    });
  }
  return { sessionId, windows, turns: turns.length, userTurns };
}

/**
 * 给候选打分：先问治理链要不要它，再问它是不是我们当年真写过的那条。
 *
 * 返回四种命运，别混：
 *   dedupe-label   治理链命中，且命中的正是当年写下的条目 → 抽取网在复述旧结论（NOOP 的一种）
 *   dedupe-other   命中库里别的条目 → 也是 NOOP，但可解释为"库里有近义条目"
 *   create-match   会新建，且与当年写下的一条高度相似 → **真召回**
 *   create-new     会新建，且对不上任何标签 → 新候选（精确与否要人标）
 *
 * @param {Array<{text: string, kind?: string}>} candidates
 * @param {{preview: (input: object) => object, labels?: Array<{id: string, text: string, kind?: string}>, matchThreshold?: number}} context
 */
export function scoreCandidates(candidates, context) {
  const labels = Array.isArray(context.labels) ? context.labels : [];
  const matchThreshold = Number(context.matchThreshold ?? 0.65);
  const rows = [];
  for (const candidate of candidates) {
    const text = String(candidate?.text ?? '').trim();
    if (text.length === 0) continue;
    const preview = context.preview({ kind: candidate.kind ?? 'fact', text });
    let bestLabel = null;
    for (const label of labels) {
      const score = similarity(text, String(label.text ?? ''));
      if (bestLabel === null || score > bestLabel.score) bestLabel = { label, score };
    }
    const matched = bestLabel !== null && bestLabel.score >= matchThreshold ? bestLabel : null;
    let fate;
    if (preview.action === 'dedupe') {
      fate = matched !== null && matched.label.id === preview.nearestId ? 'dedupe-label' : 'dedupe-other';
    } else {
      fate = matched === null ? 'create-new' : 'create-match';
    }
    rows.push({
      text,
      kind: candidate.kind ?? 'fact',
      action: preview.action,
      score: preview.score,
      nearestId: preview.nearestId,
      contradicted: preview.contradicted === true,
      fate,
      matchedLabelId: matched === null ? null : matched.label.id,
      matchedLabelScore: matched === null ? null : Number(matched.score.toFixed(3)),
    });
  }
  const tally = new Map();
  for (const row of rows) tally.set(row.fate, (tally.get(row.fate) ?? 0) + 1);
  return { rows, tally: Object.fromEntries([...tally.entries()].sort()) };
}


/**
 * 覆盖范围：哪些轮次被"处理过"。
 *
 * **不变式（写进测试）**：这个范围只能来自**选择清单**（plan），不能来自候选集。
 * 已经栽过三次同向的 bug：漏钩子标签 → 拿"产出过候选的窗口"当分母 → 零候选窗口从分母消失。
 * 三次方向一致：分母变小、数字变好看。所以分母的输入里不许出现候选。
 *
 * @param {Array<{sessionId: string, fromTurn: number, toTurn: number}>} windows
 * @returns {Map<string, Array<[number, number]>>}
 */
export function coveredRanges(windows) {
  const covered = new Map();
  for (const window of Array.isArray(windows) ? windows : []) {
    if (window === null || typeof window !== 'object') continue;
    const sessionId = window.sessionId ?? null;
    const from = Number(window.fromTurn);
    const to = Number(window.toTurn);
    if (sessionId === null || !Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (!covered.has(sessionId)) covered.set(sessionId, []);
    covered.get(sessionId).push([from, to]);
  }
  return covered;
}

/**
 * 分母：落在被处理轮次里的标签。**只吃 labels + covered，不吃候选。**
 *
 * @param {Array<{id: string, sessionId: string, turn: number|null}>} labels
 * @param {Map<string, Array<[number, number]>>} covered
 */
export function labelsInScope(labels, covered) {
  return (Array.isArray(labels) ? labels : []).filter((label) => {
    if (label === null || typeof label !== 'object') return false;
    if (typeof label.turn !== 'number') return false;
    const ranges = covered.get(label.sessionId) ?? [];
    return ranges.some(([from, to]) => label.turn >= from && label.turn <= to);
  });
}
