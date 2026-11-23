/**
 * 断言层（规则版，确定性）：剥掉措辞，比"决定"。
 *
 * 判据来源：labels/labeling-criterion-v1.3-draft.md 的规则 A–E。
 * 12 条双标正例的共同形状是"同一个决定被说成不同的命题类型"，所以这层不判类型，
 * 只做两件事：**把情态剥掉还原取值**，然后**比三元组**。
 *
 * 零模型：尺子是量具，模型是被测对象，两者不能混（这条在 type-rules 那轮已经付过学费）。
 *
 * E（可复用性前置）只**读**冻结的 verdict，不重判 —— 否则"该不该记"会变成配对失败的后门。
 *
 * ⚠️ 停用说明（2026-11-19）：`extractDecision` 的取值抽取与 `sameDecision` 的规则归一**已标停**。
 * 它们在 12 条双标正例上只覆盖 0.333 / 0.25 / 0.000（三种取值口径），gold-20 上一条也捞不回。
 * 根因：让规则去中文多子句里定位"决定内容在哪一段"——那是理解的活，规则不擅长。
 * 保留的是**判等原语**（`polarityOf` 的 ¬X、`attrOf` 的 10 维度、`valueEntities`），
 * 供 labels/labeling-criterion-v1.4-schema-draft.md 里的确定性判等复用。
 */
import { tokenize } from './text.js';
import { isStopToken } from './rank.js';

export const ASSERTION_VERSION = 'assertion-rules-v1（规则归一已停用，见下）';

/** 情态词（规则 A）：剥掉之后剩下的才是取值内容。 */
const MODALS = ['要与', '必须', '应有', '要有', '须有', '应当', '需要在', '需要', '应该', '得先'];

/** 极性词（规则 C）：出现即把取值翻成 ¬X。 */
const NEGATORS = ['不允许', '否决', '不再', '不要', '不准', '禁止', '不得', '拒绝', '去掉', '别再', '不能', '不许'];

/** 定案词（规则 B）：后面的部分是取值。 */
const DECIDED = ['最终定为', '定案', '已定', '采用', '选定', '确定为', '定为'];

/**
 * 属性维度（原则化归类，不收录原句）：12 个"决定的维度"（见 ATTR_CLASSES，判据 v1.4 同源）。
 * 顺序有意义：先具体维度、后泛维度，避免"形态"吃掉"位置"这种更具体的信息。
 */
/**
 * attr 闭集：判据、代码、网输出**三方同一份**。
 * 12 类 —— v1.4 草案里"命名"漏过一次，闭集不一致会让 attr 相等这个判据失去可比性。
 */
export const ATTR_CLASSES = ['归属', '关系', '底线', '口径', '顺序', '排障', '风格', '位置', '存留', '命名', '选型', '结论'];

const ATTR_DIMENSIONS = [
  ['位置', ['位置', '入口', '摆在', '放在', '右上角', '左侧', '导航']],
  ['存留', ['保留', '存留', '留档', '放在哪里', '自己决定']],
  ['归属', ['归', '归属', '属于', '放在人格层', '归人格层', '引擎只']],
  ['选型', ['更适合', '选型', '采用哪种', '走哪条', '方案']],
  ['顺序', ['先做', '再接入', '顺序', '先方案', '先成长', '接其他']],
  ['排障', ['换思路', '绕圈', '反复调', '先换方案', '调试']],
  ['底线', ['不编造', '不假装', '底线', '不许', '禁止', '缺一不可']],
  ['口径', ['判断起点', '先量', '直说', '先给理由', '分寸', '说话']],
  ['风格', ['半透明', '星图', '风格', '视觉', '廉价感', '帧率', '动效']],
  ['命名', ['命名', '取名', '名字', '自称', '称呼']],
  ['结论', ['结论', '实验', '做不到', '生硬', '没达预期', '效果']],
];

const FUNC_CHARS = new Set([...'的了着过和与也都就才而之其这那个些上中下里在']);

/** 句子切到句读为止 —— 只做字面切分，不猜结构。 */
function firstClause(text) {
  return String(text ?? '').split(/[。；;，,！!？?\n]/).find((part) => part.trim().length > 0) ?? '';
}

export function attrOf(text) {
  const raw = String(text ?? '');
  for (const [name, markers] of ATTR_DIMENSIONS) {
    const hit = markers.find((marker) => raw.includes(marker));
    if (hit !== undefined) return { attr: name, evidence: hit };
  }
  return { attr: 'unknown', evidence: null };
}

export function polarityOf(text) {
  const raw = String(text ?? '');
  const hit = NEGATORS.find((word) => raw.includes(word));
  return { negative: hit !== undefined, evidence: hit ?? null };
}

/**
 * 抽决定：{ subject, attr, value, negative, decided, degraded }。
 *
 * 抽不出属性 → `degraded: true`，此时 value 退化为"整句归一后的内容串"，
 * 由比较方走降级路径（归一取值串的实体重合）。降级占比本身是读数，必须报。
 */
export function extractDecision(text) {
  const raw = String(text ?? '').trim();
  const clause = firstClause(raw);
  const { attr, evidence } = attrOf(raw);
  const { negative, evidence: negWord } = polarityOf(raw);
  const decided = DECIDED.find((word) => raw.includes(word)) ?? null;

  /**
   * 取值 = 去掉情态词与极性词之后的整句内容。
   *
   * 踩过：早期实现取"属性词/定案词之后的片段"，结果「半透明已被否决」的取值变成了空串或"已被"——
   * 而否定的**宾语**（半透明）恰恰在否定词之前。判据里 C 条写的是"被否定的东西记成 ¬X"，
   * 所以取值必须包含否定宾语本身，不能只取否定词之后。
   */
  // 判据 C：否定的宾语常在否定词之前，也可能落在另一个子句里 —— 所以取值用整段，不切首句
  let value = raw;
  for (const modal of MODALS) value = value.split(modal).join('');
  for (const word of NEGATORS) value = value.split(word).join('');
  value = value.replace(/^[把将的了是有要能会]+/, '').trim();

  return {
    subject: null, // 主语这里不抽（中文无句法，见判据：不堆主语规则）
    attr,
    attrEvidence: evidence,
    value: value.length === 0 ? clause : value,
    negative,
    negativeEvidence: negWord,
    decided,
    degraded: attr === 'unknown',
    version: ASSERTION_VERSION,
  };
}

/** 归一取值串的实体集合（降级路径用；也用于"取值包含"的比较）。 */
export function valueEntities(value) {
  const out = new Set();
  for (const token of tokenize(String(value ?? ''))) {
    if ([...token].length < 2) continue;
    if (isStopToken(token)) continue;
    if (FUNC_CHARS.has([...token][0]) || FUNC_CHARS.has([...token].at(-1))) continue;
    out.add(token);
  }
  return out;
}

/**
 * 同一决定：属性同 ∧ 取值相同或包含（**不是裸串包含**）∧ 极性一致。
 *
 * 降级（任一方属性 unknown）时只比归一取值串的包含度，并标 `degraded: true`，
 * 这种情况单独统计，不与正常路径混算。
 */
export function sameDecision(leftText, rightText) {
  const left = extractDecision(leftText);
  const right = extractDecision(rightText);
  const base = { left, right };

  // 规则 C：极性必须一致 —— 否决 X 与采用 X 不是同一个决定
  if (left.negative !== right.negative) {
    return { ...base, same: false, degraded: left.degraded || right.degraded, reason: 'polarity-mismatch' };
  }

  const degraded = left.degraded || right.degraded;
  if (!degraded && left.attr !== right.attr) {
    return { ...base, same: false, degraded, reason: 'attr-mismatch' };
  }

  // 规则 D：取值比较 —— 实体集合的包含关系，不是字符串包含
  const a = valueEntities(left.value);
  const b = valueEntities(right.value);
  if (a.size === 0 || b.size === 0) {
    return { ...base, same: false, degraded, reason: 'value-empty' };
  }
  let inter = 0;
  for (const token of a) if (b.has(token)) inter += 1;
  const containment = inter / Math.min(a.size, b.size);
  const same = containment >= 0.5;
  return { ...base, same, degraded, containment: Number(containment.toFixed(3)), reason: same ? 'value-contained' : 'value-mismatch' };
}
