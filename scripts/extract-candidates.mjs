/**
 * 抽取网：按轮次窗把会话正文喂给便宜模型，拿到候选事实（第二阶段，写侧候选）。
 *
 * 三条硬约束：
 * ① 只喂 `source.kind === 'user'` 的正文（注入块混进来就自我放大）；
 * ② **不落库、不写文件除非显式 --out**；候选只进 jsonl，等判分器再走治理链；
 * ③ key 只从环境变量读，绝不进输出、不进文件、不进报错文本。
 *
 * 用法：
 *   $env:WB_API_KEY=...; node scripts/extract-candidates.mjs --session <id> --limit 5 --out out/c1.jsonl
 *   node scripts/extract-candidates.mjs --labeled-only --limit 20 --out out/c2.jsonl
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeSessionLog, listSessionLogs, defaultSessionRoot, SCANNER_VERSION, ruleDigest, codeDigest } from '../lib/replay.js';
import { buildTurnWindows } from '../lib/replay-extract.js';

/** 抽取调用的温度：固定 0，并写进工件表头 —— 不记录等于没钉住。 */
export const TEMPERATURE = 0;

function engineGit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'no-git';
  }
}

/**
 * 抽取提示词：**整段塞进 user 消息**，不用 system 角色。
 *
 * 实测：这个端点上的模型全是 only_reasoning=true，system 角色+简短指令时它们会当作"要回话"，
 * 把预算全烧在推理上、content 空着（3 个窗口烧了 2400 completion tokens 换来 0 条候选）。
 * 把任务、规则、边界写进同一条 user 消息并加显式定界符，才稳定拿到 JSON。
 */
export const PROMPT_VERSION = 'schema-v5.1';

/**
 * 抽取提示词（schema-v5.1）：多决定 + 分段工程；v6 那句“有几条列几条”做过有界实验后被撤回
 * （同批 14 对覆盖率 0.429→0.214，多列让两侧切分更不一致），结论记在 out/ 的校准输出里。
 *
 * 抽取提示词（schema-v1）：按判据 v1.4 输出**结构化决定**（六字段），供确定的元组判等使用。\n * 与 extract-v1/v2 不可比：那两版输出自由文本，这版输出 schema。
 * v1 全量实测 94 条候选里 61 条是事实（65%），目标/策略/评价几乎没有 —— 网退化成了事实摘录器，
 * 而最值钱的信息恰在那三类里。这是召回的天花板，尺子再准也补不了。
 * 注意：v2 是新版本，promptVersion 钉表头，与 v1 的分数不可直接比。
 *
 * ① 三天测试 —— 「三天后还成立吗」。v0 的“别提过程记录”挡不住「窗口位置保持在右上角下方」
 *    这种 UI 中间态，它们在样张里全被标成了 constraint。
 * ② 只提窗口结束时仍成立的结论 —— 样张里「详情窗口覆盖所有图层之上」已被最终架构推翻，
 *    过期要求当 constraint 写进去，每轮付费还跟架构打架。
 * ③ constraint 收窄 —— 只有“不许/必须/别再”这种硬性长期禁令才算；
 *    设计要求、质量期望、UI 摆放一律不是 constraint（样张 8 条 constraint 纯留存 0 条）。
 */
export function buildPrompt(userText) {
  return [
    '下面是一段用户发言记录。**任务：把值得长期记住的信息抽成结构化决定**，输出 JSON 数组。',
    '',
    '每条必须给全六个字段：',
    '{"kind": "...", "subject": "...", "attr": "...", "value": "...", "negative": false, "text": "..."}',
    '',
    '字段规则（**必须遵守，取值只能取给定闭集**）：',
    '- kind：fact | world | constraint | episode | self',
    '  **kind 的窄定义（必须严格）**：constraint 只给「不许/禁止/不得/别再 + 我做某事」这类**行为禁令**；',
    '  设计要求、质量期望、视觉偏好、产物形态（“面板要动态”“帧率要有保证”“不要半透明”）一律是 **world**，不是 constraint。',
    '  constraint 每一轮都会被无条件注入，写错一条就是长期付费。',
    '- subject（**决定承载者**，判据 v1.5）：**只能取** user | agent | product | project | other',
    '  判定方法：问自己「这条决定一旦被违反，谁必须改？」',
    '  · 改我的行为或说法 → agent（内核纪律、汇报口径、排障方式、说话风格）',
    '  · 改具体产物（面板/插件/记忆库/引擎/配置）→ product ——「面板不要半透明」是 product，即使句首是“用户要求”',
    '  · 改项目方向或结构 → project',
    '  · 谁都不用改，只是我得知道的事实或偏好 → user',
    '  · 拿不准 → other',
    '  注意：句子里出现“我/用户”不等于就是那个 subject —— 看“谁必须改”，不看“谁在说话”。',
    '- attr（12 类闭集，取不到写 unknown）：归属 | 关系 | 底线 | 口径 | 顺序 | 排障 | 风格 | 位置 | 存留 | 命名 | 选型 | 结论',
    '  各类含义与硬边界（判错会让属性对比失去意义）：',
    '  · 归属＝**层级与责任分配**（谁负责、归哪一层）；「面试公司是某某」不是归属，是结论/事实',
    '  · 关系＝两样东西之间的关系（联动、缺一不可、对立）',
    '  · 底线＝**不许我做某事**的行为红线；产物质量要求（帧率/质感/流畅）是风格，不是底线',
    '  · 口径＝怎么算、怎么说、判断的先后（先量再下结论）',
    '  · 顺序＝先做哪个、再接什么；排障＝出问题怎么办（别绕圈、看日志）',
    '  · 风格＝外观/动效/质感；位置＝东西摆在哪；存留＝留不留、留哪个',
    '  · 命名＝名字/称呼/自称；选型＝选哪个方案或技术；结论＝实验结论、判断结果',
    '- value：定下来的那个值，**不要带** 必须/要与/要有/应当 这类情态词；**不超过 20 字**（长句子会把输出撑爆、被截断）',
    '- negative：这条是"不要/否决/禁止/不再"时写 true（此时 value 写被否定的那个东西，例如“不要半透明”→ value:"半透明", negative:true）',
    '- text：一句话中文 ≤60 字，不写“用户说”',
    '',
    '三条闸门，任一条不过就不要提：',
    '1. **三天测试**：三天后还成立吗？“正在做”“刚刚聊到”这类不过。',
    '2. **会影响未来行为**：代码/README 已写明的实现细节、UI 摆放、交互细节，一律不提。',
    '3. **窗口结束时仍成立**：被后面讨论推翻的要求不提；指代空洞的（“方案三”“那件事”）不提。',
    '',
    '**一条记录里可以有多个决定**：用户常在一段话里同时给出"正向值"和"被否决值"（例如“偏好不透明深空星图，明确拒绝半透明玻璃拟态”），',
    '  这种情况要输出**两条**：{value:"不透明深空星图", negative:false} 与 {value:"半透明玻璃拟态", negative:true}。',
    '  规则：每个"决定子句"一条，**每条文本最多输出 8 条**；超过 8 条就只留最可能长期成立的 8 条。',
    '',
    '宁缺勿滥：这段没有值得长期记住的东西就回 []。只输出 JSON 数组，不要解释、不要代码块。',
    '',
    '>>> 发言记录开始',
    userText,
    '<<< 发言记录结束',
  ].join('\n');
}
function parseArgs(argv) {
  const args = { planOnly: false, sessions: [], labeledOnly: false, limit: 10, out: null, model: 'cn:deepseek-v4.1-flash', base: 'http://localhost:7864/v1', turns: 6, stride: 6 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--session') args.sessions.push(argv[++i]);
    else if (token === '--labeled-only') args.labeledOnly = true;
    else if (token === '--limit') args.limit = Number(argv[++i]);
    else if (token === '--out') args.out = argv[++i];
    else if (token === '--model') args.model = argv[++i];
    else if (token === '--base') args.base = argv[++i];
    else if (token === '--turns') args.turns = Number(argv[++i]);
    else if (token === '--stride') args.stride = Number(argv[++i]);
    else if (token === '--plan-only') args.planOnly = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`不认识的参数：${token}`);
  }
  return args;
}

/** 从模型回复里抠出 JSON 数组：只认第一个 [ ... ] 块，抠不出来就算空（不猜）。 */
export function parseCandidates(raw) {
  const text = String(raw ?? '').replace(/```json|```/g, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({ kind: String(item?.kind ?? '').trim(), subject: String(item?.subject ?? '').trim(), attr: String(item?.attr ?? '').trim(), value: String(item?.value ?? '').trim(), negative: item?.negative === true, text: String(item?.text ?? '').trim() }))
      .filter((item) => item.text.length > 0 && ['fact', 'world', 'constraint', 'episode', 'self'].includes(item.kind));
  } catch {
    return [];
  }
}

async function callModel({ base, model, apiKey, userText }) {
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 6000,
      messages: [
        { role: 'user', content: buildPrompt(userText) },
      ],
    }),
  });
  if (!response.ok) throw new Error(`模型调用失败：HTTP ${response.status}`);
  const payload = await response.json();
  return {
    content: String(payload?.choices?.[0]?.message?.content ?? ''),
    reasoning: String(payload?.choices?.[0]?.message?.reasoning_content ?? ''),
    finish: String(payload?.choices?.[0]?.finish_reason ?? ''),
    usage: payload?.usage ?? null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    console.log('用法：node scripts/extract-candidates.mjs [--session <id>]... [--labeled-only] [--limit N] [--out <jsonl>]');
    return;
  }
  const apiKey = args.planOnly === true ? 'plan-only' : process.env.WB_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('缺 WB_API_KEY 环境变量（key 只从环境读，不落盘）');

  const { logs } = listSessionLogs(defaultSessionRoot());
  const wanted = logs.filter((log) => (args.sessions.length === 0 ? true : args.sessions.includes(log.sessionId)));

  /**
   * 取样按会话配额，不按目录顺序吃满。
   *
   * 踩过：`--limit 12` 被前两个会话的窗口吃满，第三个会话一条没抽到 —— 会话越靠前越占便宜，
   * 而且这种偏差在报告里看不出来（只看到"12 个窗"）。现在先按会话分配额，余量再轮转补齐。
   */
  const perSession = [];
  for (const log of wanted) {
    let rows;
    try {
      rows = decodeSessionLog(readFileSync(log.file)).rows;
    } catch {
      continue;
    }
    if (args.labeledOnly && !rows.some((row) => row.type === 'tool/call' && row.data?.name === 'memory_write')) continue;
    const built = buildTurnWindows(rows, { sessionId: log.sessionId, turns: args.turns, stride: args.stride });
    if (built.windows.length === 0) continue;
    perSession.push(built.windows.map((window) => ({ ...window, slug: log.slug })));
  }

  const windows = [];
  if (perSession.length > 0) {
    const quota = Math.max(1, Math.ceil(args.limit / perSession.length));
    for (const list of perSession) windows.push(...list.slice(0, quota));
    // 配额没吃满就把余量按顺序补回来，仍然保持"每个会话先拿一轮"
    let cursor = quota;
    while (windows.length < args.limit) {
      let added = false;
      for (const list of perSession) {
        if (windows.length >= args.limit) break;
        if (list[cursor] !== undefined) {
          windows.push(list[cursor]);
          added = true;
        }
      }
      cursor += 1;
      if (!added) break;
    }
  }

  const picked = windows.slice(0, args.limit);
  if (args.planOnly === true) {
    // 只出选择清单，不调模型：用来算召回**真分母**（含零候选窗口）
    const plan = picked.map((w) => ({ sessionId: w.sessionId, slug: w.slug, fromTurn: w.fromTurn, toTurn: w.toTurn, cutoff: w.cutoff, chars: w.chars }));
    if (args.out !== null) {
      const target = resolve(args.out);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify({ type: 'plan', windows: plan.length, selected: plan }, null, 2) + '\n', 'utf8');
      console.error('选择清单已写入 ' + target + '（' + plan.length + ' 个窗）');
    }
    console.log(JSON.stringify({ planOnly: true, windows: plan.length, sessions: new Set(plan.map((w) => w.sessionId)).size }, null, 2));
    return;
  }
  const rows = [];
  let promptTokens = 0;
  let completionTokens = 0;
  // 降级与"合法 0 候选"必须分开计：空 content、被 max_tokens 截断都不是"这段没东西可记"
  let degradedCalls = 0;
  let failedCalls = 0;
  const degradedWindows = [];
  for (const [index, window] of picked.entries()) {
    let result;
    try {
      result = await callModel({ base: args.base, model: args.model, apiKey, userText: window.userText });
    } catch (error) {
      failedCalls += 1;
      console.error(`窗口 ${index + 1}/${picked.length} 失败：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    promptTokens += Number(result.usage?.prompt_tokens ?? 0);
    completionTokens += Number(result.usage?.completion_tokens ?? 0);
    const candidates = parseCandidates(result.content);
    const degraded = result.content.trim().length === 0 || result.finish === 'length';
    if (degraded) {
      degradedCalls += 1;
      degradedWindows.push({ sessionId: window.sessionId, fromTurn: window.fromTurn, toTurn: window.toTurn, chars: window.chars, finish: result.finish, contentChars: result.content.trim().length });
    }
    for (const candidate of candidates) {
      rows.push({
        sessionId: window.sessionId,
        slug: window.slug,
        fromTurn: window.fromTurn,
        toTurn: window.toTurn,
        cutoff: window.cutoff,
        kind: candidate.kind,
        subject: candidate.subject,
        attr: candidate.attr,
        value: candidate.value,
        negative: candidate.negative,
        text: candidate.text,
      });
    }
    console.error(`窗口 ${index + 1}/${picked.length}（${window.sessionId.slice(0, 8)} 轮 ${window.fromTurn}-${window.toTurn}）：候选 ${candidates.length}，finish=${result.finish}，推理 ${result.reasoning.length} 字${degraded ? '【降级】' : ''}`);
  }

  const header = {
    type: 'header',
    promptVersion: PROMPT_VERSION,
    model: args.model,
    generatedAt: new Date().toISOString(),
    windows: picked.length,
    candidates: rows.length,
    degradedCalls,
    failedCalls,
    promptTokens,
    completionTokens,
    // 降级窗口落盘：把"schema 输出太长被截断"与"窗口本身有问题"分开量
    degradedWindows,
    // D5 比较性钉：不钉住这些，两次回放的分差就分不清是代码变了还是参数变了
    temperature: TEMPERATURE,
    seed: null, // 该端点不接受 seed 参数：明确记 null，别让它看起来被钉住了
    engineGit: engineGit(),
    scannerVersion: SCANNER_VERSION,
    rulesDigest: ruleDigest(),
    codeDigest: codeDigest(),
    storePath: null, // 抽取阶段不碰库；库路径由判分器的表头负责钉
  };

  if (args.out !== null) {
    const target = resolve(args.out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, [JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join('\n') + '\n', 'utf8');
    console.error(`候选已写入 ${target}（${rows.length} 条 + 1 行表头）`);
  }
  console.log(JSON.stringify(header, null, 2));
}

// 只有被直接执行时才跑 main —— 被 import 时只暴露 buildPrompt（供标签侧抽取复用）
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
