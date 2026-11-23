/**
 * 命题类型分类器（规则版，确定性）——尺子的一部分，所以**绝不调模型**。
 *
 * 为什么必须规则版：尺子是量具，可复算性是它的命根。模型是被测对象（抽取网），
 * 一旦进尺子，重跑两次分数不同，就分不清变化来自网还是来自尺子，归因链断。
 * 分类器不完美可以，但必须确定、可测、可钉版本（`TYPE_CLASSIFIER_VERSION`）。
 *
 * 词条纪律：**不从 gold-20 里抄词**。试过一轮（加"希望/想要"进 goal、"要与"进 requirement、"决定权"进 strategy），
 * 结果类型准头 0.767→0.833，但配对门的精确率 0.75→0.667 —— 更准的类型不等于更好的配对判定，
 * 而且那是拿 10 条样本在拟合。已撤回，那三条留作待样本外验证的候选补丁。
 *
 * 判据来源：labels/labeling-criterion-v1.2.md「同一命题 = 主语 + 类型 + 断言」。
 * 这里只做前两层：类型门（跨类型直接否）+ 主语门（主语冲突直接否）。
 * 断言层（矛盾）留给 `contradicts` 单独标，不在这里判。
 */

export const TYPE_CLASSIFIER_VERSION = 'type-rules-v1';

/** 六类命题。顺序即匹配优先级：道义模态 > 情感 > 目标 > 策略 > 评价 > 事实（兜底）。 */
export const PROPOSITION_TYPES = ['requirement', 'preference', 'goal', 'strategy', 'evaluation', 'fact'];

const MARKERS = {
  // 要求/禁令：道义模态。判据 v1.2 明确把"要有/必须/保证"归这里
  requirement: ['必须', '不许', '禁止', '不得', '别再', '不要', '不能', '须', '要有', '需要有', '一律', '严禁', '统一要求'],
  // 偏好/特质：情感与稳定取向
  preference: ['喜欢', '偏好', '倾向', '反感', '敏感', '讨厌', '在意', '看重', '不喜欢', '厌恶', '宁可'],
  // 目标/愿景：要做成什么
  goal: ['目标', '愿景', '最终形态', '想做', '要做成', '长期方向', '最终想要', '造一个', '成为一个'],
  // 策略/方法：怎么做、按什么顺序
  strategy: ['策略', '方法', '做法', '顺序', '先做', '先模拟', '步骤', '推进', '一起推进', '换思路', '按此方向', '路线'],
  // 评价：好/差/够不够
  evaluation: ['更适合', '更好', '不够', '太差', '显得', '效果好', '效果差', '有价值', '没意义', '算不算'],
};

const SUBJECTS = {
  // 主语：这条命题讲的是谁/什么东西
  product: ['插件', '面板', '引擎', '记忆库', '判分器', '回放', '库', '接口', '路由', '配置', 'yaml', 'patch'],
  user: ['用户', '他', '你'],
  agent: ['我', '我们', '自己'],
};

const SUBJECT_ORDER = ['user', 'agent', 'product'];

/**
 * 强标记：命中就基本锁定类型，优先级高于弱标记。
 *
 * 教训：“长期目标是造一个有自己倾向的人”被“倾向”判成了偏好 —— 弱标记不许压过强标记。
 */
const STRONG = {
  requirement: ['必须', '不许', '禁止', '不得', '严禁', '须有', '要有'],
  goal: ['目标', '愿景', '最终形态', '要做成', '造一个', '成为一个'],
  strategy: ['策略', '先做', '先模拟', '按此方向', '步骤'],
  evaluation: ['更适合', '不如', '没意义'],
};

/** 判定命题类型（确定性）：先看强标记（按要求>目标>策略>评价），再看弱标记，都没有就是事实。 */
export function classifyType(text) {
  const raw = String(text ?? '');
  for (const type of ['requirement', 'goal', 'strategy', 'evaluation']) {
    const markers = STRONG[type] ?? [];
    const hit = markers.filter((marker) => raw.includes(marker));
    if (hit.length > 0) return { type, evidence: hit, classifier: TYPE_CLASSIFIER_VERSION, strength: 'strong' };
  }
  for (const type of PROPOSITION_TYPES) {
    const markers = MARKERS[type];
    if (markers === undefined) continue;
    const hit = markers.filter((marker) => raw.includes(marker));
    if (hit.length > 0) return { type, evidence: hit, classifier: TYPE_CLASSIFIER_VERSION, strength: 'weak' };
  }
  return { type: 'fact', evidence: [], classifier: TYPE_CLASSIFIER_VERSION, strength: 'default' };
}

/**
 * 判定主语（尽力而为，中文无句法分析）。
 *
 * 只区分三档语义域：用户 / 产品（插件·面板·引擎·库·配置） / agent 自己。
 * 抽不出来就 unknown —— 不猜。unknown 不参与主语门（宁可放过，不可误杀）。
 */
export function classifySubject(text) {
  const raw = String(text ?? '');
  for (const subject of SUBJECT_ORDER) {
    const hit = SUBJECTS[subject].filter((marker) => raw.includes(marker));
    if (hit.length > 0) return { subject, evidence: hit };
  }
  return { subject: 'unknown', evidence: [] };
}

/**
 * 两层门：类型必须同、主语不许冲突。
 *
 * @param {{text: string}} candidate
 * @param {{text: string}} label
 * @returns {{same: boolean, reason: string, candidateType: string, labelType: string,
 *   candidateSubject: string, labelSubject: string, contradicts: boolean}}
 *   `contradicts` 这里恒 false —— 断言矛盾要人/后续判据单独标，不在这层猜。
 */
export function sameProposition(candidate, label) {
  const typeA = classifyType(candidate?.text);
  const typeB = classifyType(label?.text);
  const subjectA = classifySubject(candidate?.text);
  const subjectB = classifySubject(label?.text);
  const base = {
    candidateType: typeA.type,
    labelType: typeB.type,
    candidateSubject: subjectA.subject,
    labelSubject: subjectB.subject,
    contradicts: false,
  };
  if (typeA.type !== typeB.type) {
    return { ...base, same: false, reason: `类型不同：${typeA.type} ≠ ${typeB.type}` };
  }
  // 只拦最清楚的那一种冲突：一边讲人（user），一边讲产物（product）。
  // person 与 agent 之间、“我”与“用户”之间都太模糊，拦了会误杀（实测 #1/#3 就是这么被误杀的）。
  const conflict =
    (subjectA.subject === 'user' && subjectB.subject === 'product') ||
    (subjectA.subject === 'product' && subjectB.subject === 'user');
  if (conflict) {
    return { ...base, same: false, reason: `主语不同：${subjectA.subject} ≠ ${subjectB.subject}` };
  }
  return { ...base, same: true, reason: '类型同、主语不冲突' };
}
