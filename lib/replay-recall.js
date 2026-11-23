/**
 * 召回尺子：判"候选和当年写下的条目是不是同一件事"。
 *
 * 为什么不用字面相似度：`similarity` 是给**治理链查重**校准的（0.72/0.18 那组数），
 * 它要的是"是不是几乎同一句话"。而召回要问的是"是不是同一件事"——两者不是一把尺子。
 * 实测两个方向都吃过亏：v0 里一条 0.516 的真命中被 0.65 门挡掉，v1 里更准确的抽象表述全落榜。
 *
 * 关键实体（确定性，可测）：
 *   1. 用引擎自己的分词 `tokenize`（中文二元组 + 英文/数字词）；
 *   2. 去掉单字（跨句撞车太狠）、停用词（`isStopToken`）、纯数字；
 *   3. 剩下的当"关键实体"。
 * 重合度 = |交集| / min(|A|, |B|) —— 用 containment 不用 Jaccard：
 * 一条抽象表述常常是另一条的**子集**（"面板否决半透明" ⊂ "记忆面板要有特色、不要半透明"），
 * Jaccard 会因为这个长度差把真命中压死。
 *
 * **kind 只当信号，不当门。** 0.846 那条命中就是 fact 标签 × world 候选；
 * 拿同 kind 做硬门会把刚抓到的跨 kind 盲区原样重现。治理链那边的"同 kind 才查重"
 * 是引擎真实行为，不要在这里改它 —— 那是被观测对象，不是尺子。
 */
import { tokenize } from './text.js';
import { isStopToken } from './rank.js';

export const RECALL_RULER = {
  version: 'entity-v2',
  entity: 'tokenize → 去单字/停用词/纯数字',
  overlap: 'containment：|交集| / min(|A|,|B|)',
  kindHandling: 'kind 只做信号（同 kind +0.05，仅排序参考，不做排除）',
  rare: '稀有证据 = 共享词里 df ≤ rareK 的那些；先剔跨词碎片（见 isJunctionBigram）',
  defaultThreshold: 0.1,
  rareK: 3,
  frequentK: 5,
};

/**
 * 跨词碎片判据：二元组的两半各自被一个「共享的高频词」包着，就是两个词的交界，不是语义共享。
 *
 * 为什么要这一条：`忆架` 来自「记**忆架**构」，它和另一条只共享「记忆」+「架构」两个高频词，
 * 却因为 df=1 被当成稀有证据，把「为 dsh 做可视化记忆插件」错配到了那条 episode 上。
 * 而 `半透`/`帧率`/`绕圈` 这三个真命中载体，两半里至少有一半不被任何共享高频词包住 —— 不是交界。
 *
 * 注意：这条**只剔交界碎片**，不剔词内碎片。`半透` 也是「半透明」的碎片，
 * 但它承载语义（半透明确实是用户明确否决的东西），滤掉它会让三条真命中同时塌掉。
 *
 * @param {string} bigram 待判的共享稀有二元组
 * @param {Set<string>|Array<string>} sharedFrequent 候选与标签共享的、df ≥ frequentK 的词
 */
export function isJunctionBigram(bigram, sharedFrequent) {
  const chars = [...String(bigram ?? '')];
  if (chars.length !== 2) return false;
  const [left, right] = chars;
  const list = sharedFrequent instanceof Set ? [...sharedFrequent] : Array.from(sharedFrequent ?? []);
  const leftCovered = list.some((token) => token !== bigram && [...token].at(-1) === left);
  const rightCovered = list.some((token) => token !== bigram && [...token][0] === right);
  return leftCovered && rightCovered;
}

/** 关键实体：确定性、无随机、与语料无关（同一段文本永远给出同一组词）。 */
export function keyEntities(text) {
  const tokens = tokenize(String(text ?? ''));
  const out = new Set();
  for (const token of tokens) {
    if ([...token].length < 2) continue;
    if (isStopToken(token)) continue;
    if (/^\d+([.]\d+)?$/.test(token)) continue;
    out.add(token);
  }
  return out;
}

/** 两条文本的关键实体重合度。 */
export function entityOverlap(left, right) {
  const a = keyEntities(left);
  const b = keyEntities(right);
  if (a.size === 0 || b.size === 0) return { score: 0, shared: [] };
  const shared = [];
  for (const token of a) if (b.has(token)) shared.push(token);
  return { score: shared.length / Math.min(a.size, b.size), shared };
}

/** 虚词字符：出现在二元组首尾，说明这是"词 + 虚词"拼出来的碎片（如「的面」来自「偏好的面板」）。 */
const FUNCTION_CHARS = new Set([...'的地得了着过是和与也都就才而之其这那个些上中下里在']);

/**
 * 稀有证据：候选与标签共享的稀有词，剔两类分词伪迹。
 *
 * ① **跨词交界**（`忆架` ← 记忆|架构）：两半各自被一个共享高频词包着，语义上没有共享；
 * ② **虚词拼接**（`的面` ← 偏好|的|面板）：首尾是虚词，纯属切分副产物。
 *
 * 这两类都不是"语料里少见的语义"，是分词器的病。滤掉它们，recall 不掉、误配掉。
 * 但别把词内碎片一起滤了：`半透`/`透明` 也是碎片，它们恰恰是真命中的唯一载体。
 *
 * @param {string} candidateText
 * @param {string} labelText
 * @param {{df: Map<string, number>, rareK?: number, frequentK?: number}} context
 * @returns {{shared: string[], rare: string[], junction: string[]}}
 */
export function sharedEvidence(candidateText, labelText, context = {}) {
  const df = context.df ?? new Map();
  const rareK = Number(context.rareK ?? RECALL_RULER.rareK);
  const frequentK = Number(context.frequentK ?? RECALL_RULER.frequentK);
  const left = keyEntities(candidateText);
  const right = keyEntities(labelText);
  const shared = [...left].filter((token) => right.has(token));
  const frequent = shared.filter((token) => (df.get(token) ?? 0) >= frequentK);
  const rare = [];
  const junction = [];
  for (const token of shared) {
    // df 表里没有 = 语料里没有这个词，不能当"稀有"用（未知 ≠ 稀有）
    if (!df.has(token)) continue;
    if (df.get(token) > rareK) continue;
    const chars = [...token];
    const fuzzyEdge = FUNCTION_CHARS.has(chars[0]) || FUNCTION_CHARS.has(chars.at(-1));
    if (fuzzyEdge || isJunctionBigram(token, frequent)) junction.push(token);
    else rare.push(token);
  }
  return { shared, rare, junction };
}

/**
 * entity-v2 匹配：containment ≥ threshold，**且**共享稀有证据（剔跨词碎片后）不少于 rareMin。
 *
 * `df` 必须由调用方给出（整个标签语料上统计），这样尺子与语料版本一起被钉住，可复算。
 */
export function matchByEntitiesV2(candidate, labels, context = {}) {
  const threshold = Number(context.threshold ?? RECALL_RULER.defaultThreshold);
  const rareMin = Number(context.rareMin ?? 1);
  const kind = candidate?.kind ?? null;
  let best = null;
  for (const label of Array.isArray(labels) ? labels : []) {
    const { score } = entityOverlap(candidate?.text, label.text);
    if (score < threshold) continue;
    const evidence = sharedEvidence(candidate?.text, label.text, context);
    if (evidence.rare.length < rareMin) continue;
    const sameKind = kind !== null && label.kind !== undefined && kind === label.kind;
    const ranked = score + (sameKind ? 0.05 : 0);
    if (best === null || ranked > best.ranked) {
      best = { id: label.id, score: Number(ranked.toFixed(3)), rawScore: Number(score.toFixed(3)), rare: evidence.rare, junction: evidence.junction, sameKind, labelText: String(label.text ?? '') };
    }
  }
  if (best === null) return null;
  delete best.ranked;
  return best;
}

/**
 * 在一批标签里找最像的那条（entity-v1：只按重合度，不要求稀有证据）。
 *
 * 保留它是为了对照：v2 的稀有词要求是为了压掉"只靠泛词撞上"的误配，
 * 但那条要求也会漏掉只共享一个高频词的弱样本（见 gold #10）。两个数都要报。
 *
 * @param {{text: string, kind?: string}} candidate
 * @param {Array<{id: string, text: string, kind?: string}>} labels
 * @param {{threshold?: number}} [options]
 * @returns {{id: string, score: number, rawScore: number, shared: string[], sameKind: boolean,
 *   kindAsSignal: number} | null}
 */
export function matchByEntities(candidate, labels, options = {}) {
  const threshold = Number(options.threshold ?? RECALL_RULER.defaultThreshold);
  const kind = candidate?.kind ?? null;
  let best = null;
  for (const label of Array.isArray(labels) ? labels : []) {
    const { score, shared } = entityOverlap(candidate?.text, label.text);
    if (score < threshold) continue;
    const sameKind = kind !== null && label.kind !== undefined && kind === label.kind;
    // kind 只加一点排序分；不加门、不排除
    const kindAsSignal = sameKind ? 0.05 : 0;
    const ranked = score + kindAsSignal;
    if (best === null || ranked > best.ranked) {
      best = { id: label.id, score: Number(ranked.toFixed(3)), rawScore: Number(score.toFixed(3)), shared, sameKind, kindAsSignal };
    }
  }
  if (best === null) return null;
  delete best.ranked;
  return best;
}
