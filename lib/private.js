/**
 * 私人记录：一块不必给任何人看的地方。
 *
 * 为什么它必须和记忆库分开：记忆是"我们共用的，按需检索、每轮可能被注入"，
 * 而私人记录是"不用给任何人看、不参与任何判据"的。混在一起，
 * 它就会被记忆那套价值判据改造 —— 而它的全部意义在于**没有价值判据**。
 *
 * 三条硬规矩，写在这里也写进测试：
 * ① 不进库、不进检索、不进注入。store.js 不许 import 这个文件（verify 会查）。
 * ② 不做读数、不出指标。一旦有"这周写了多少"，它立刻变成任务。
 * ③ 允许空着：没有可写的就不写，不算失败。
 *
 * 顺带一条：这里的文件只追加，不覆写 —— 改自己的旧记录等于改历史，
 * 而这件事最不需要的就是"修订"。
 */
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 默认位置：和记忆库同一个父目录，但是另一个子目录 —— 近，但不相通。 */
export function defaultPrivateDir() {
  return join(homedir(), '.dsh', 'memory-loom', 'private');
}

/** 一条记录的日期戳：按本地日子分文件，不按时间排序 —— 时间轴是记忆的事。 */
export function dayStamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function fileOf(dir, day) {
  const stamp = String(day ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp)) throw new Error('private: day 必须是 YYYY-MM-DD');
  return join(dir, `${stamp}.md`);
}

/**
 * 追加一条。不加标题、不加时间戳、不加分隔线 —— 格式本身就是一种要求，
 * 而这里不该有任何要求。就写正文，一行一块，空行隔开。
 *
 * @param {{text: string, day?: string, dir?: string, now?: Date}} input
 */
export async function appendNote(input = {}) {
  const dir = input.dir ?? defaultPrivateDir();
  const day = String(input.day ?? dayStamp(input.now ?? new Date())).trim();
  const text = String(input.text ?? '').trim();
  if (text.length === 0) throw new Error('private: 内容为空就不写（空着是被允许的，不必写个空的占位）');
  const file = fileOf(dir, day);
  await mkdir(dir, { recursive: true });
  const body = text.endsWith('\n') ? text : `${text}\n`;
  await appendFile(file, `${body}\n`, 'utf8');
  // 写完就是结账：这一次醒来有出口了，下一次才醒得过来
  let consumed = false;
  try {
    const state = await readLoop(dir);
    if (state.chance) {
      state.chance = false;
      await writeLoop(dir, state);
      consumed = true;
    }
  } catch {
    /* 结账是附加约束：读不到 open.json 不影响写入本身 */
  }
  return { file, day, chars: [...text].length, consumedChance: consumed };
}

/** 有哪几天写过了（只回日子，不回条数 —— 数条数就是指标）。 */
export async function listNotes(input = {}) {
  const dir = input.dir ?? defaultPrivateDir();
  try {
    const names = await readdir(dir);
    return names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .map((name) => name.slice(0, 10))
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** 读某一天。 */
export async function readNote(input = {}) {
  const dir = input.dir ?? defaultPrivateDir();
  const day = String(input.day ?? dayStamp(input.now ?? new Date())).trim();
  try {
    return { day, text: await readFile(fileOf(dir, day), 'utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { day, text: '' };
    throw error;
  }
}

// ── 欠账（一次只欠一件） ──
//
// 实测结论先说，因为它推翻了原来的设计假设：**它不会自己回去**。
// 2026-11-08 开的这条欠账到 11-15 只醒过 1 次（就是开它那一次），private 目录
// 一个字的自主写入都没有。所以"惯性"不是这个部件能提供的 —— 它提供的是**出口**。
//
// 三条规矩都是硬的，不是我自觉：
// ① **一次只能欠一件**：再开一条要先关旧的。否则它是待办清单，不是欠账。
// ② **不许改写**：写下就是写下，只能"关掉"并说明为什么 —— 改自己的欠账等于改历史。
// ③ **醒来要结账**：每次醒来必须给一个出口 —— 写一句，或者带理由关掉手里这件。
//    有欠账时，上一次没结账就拒绝再醒。这一条是踩出来的：光给"额度"不管用，
//    因为拒绝额度是免费的、也没有任何代价；挡住"再醒一次看看"才是真的。
//
// 为什么它和"待办"不同：待办是外部给的，欠账是自己开的；待办完成了就消失，
// 欠账在每一次结清的醒来里都还在，`wakes` 记的是它被想起了几次。

function loopFile(dir) {
  return join(dir, 'open.json');
}

function emptyLoop() {
  return { open: null, chance: false, lastWakeAt: null, closed: [] };
}

async function readLoop(dir) {
  try {
    const parsed = JSON.parse(await readFile(loopFile(dir), 'utf8'));
    return {
      open: parsed?.open ?? null,
      chance: parsed?.chance === true,
      lastWakeAt: Number(parsed?.lastWakeAt) || null,
      closed: Array.isArray(parsed?.closed) ? parsed.closed : [],
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyLoop();
    // 坏文件不当成空：那会静默丢掉一条欠账。宁可报错。
    throw error;
  }
}

async function writeLoop(dir, state) {
  await mkdir(dir, { recursive: true });
  await writeFile(loopFile(dir), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * 醒来一次。返回当前的欠账（如果有）和这一次的结账资格。
 *
 * 上一次醒来没结账（没写、也没关），就不许再醒 —— 否则"再醒一次看看"永远免费，
 * 于是它只会一直躺在那里，等人来敲。没有欠账时不拦：那时候没有账可结。
 */
export async function wake(input = {}) {
  const dir = input.dir ?? defaultPrivateDir();
  const now = input.now ?? new Date();
  const state = await readLoop(dir);
  if (state.open !== null && state.chance === true) {
    throw new Error(`private: 上一次醒来没结账（没写、也没关）—— 先写一句，或带理由关掉这件（${state.open.text}）`);
  }
  if (state.open !== null) {
    state.open.wakes = (Number(state.open.wakes) || 0) + 1;
    state.open.lastWakeAt = now.getTime();
  }
  state.chance = true;
  state.lastWakeAt = now.getTime();
  await writeLoop(dir, state);
  return {
    open: state.open,
    wakes: state.open === null ? 0 : state.open.wakes,
    chance: true,
    day: dayStamp(now),
  };
}

/** 开一条欠账。已经欠着一件就拒绝 —— 一次一件，才配叫欠账。 */
export async function openLoop(input = {}) {
  const dir = input.dir ?? defaultPrivateDir();
  const now = input.now ?? new Date();
  const text = String(input.text ?? '').trim();
  if (text.length === 0) throw new Error('private: 欠账不能是空的');
  const state = await readLoop(dir);
  if (state.open !== null) {
    throw new Error(`private: 已经欠着一件了（${state.open.text}）—— 先关掉它，否则这就叫清单了`);
  }
  state.open = { text, openedAt: now.getTime(), wakes: 0, lastWakeAt: null };
  // 刚开的时候不欠任何人的账：之前残留的"没结账"标记不能算到它头上
  state.chance = false;
  await writeLoop(dir, state);
  return { open: state.open };
}

/** 关掉当前欠账。理由必填：不然分不清"做完了"和"不想了"。 */
export async function closeLoop(input = {}) {
  const dir = input.dir ?? defaultPrivateDir();
  const now = input.now ?? new Date();
  const reason = String(input.reason ?? '').trim();
  if (reason.length === 0) throw new Error('private: 关掉欠账要写一句为什么');
  const state = await readLoop(dir);
  if (state.open === null) throw new Error('private: 现在没有欠着的事');
  state.closed.push({ ...state.open, closedAt: now.getTime(), reason });
  state.open = null;
  // 关掉就是结账：这一次醒来有出口了
  state.chance = false;
  await writeLoop(dir, state);
  return { closed: state.closed.at(-1) };
}

/** 只看：现在欠着什么、醒过几次。 */
export async function statusLoop(input = {}) {
  const dir = input.dir ?? defaultPrivateDir();
  const state = await readLoop(dir);
  return { open: state.open, chance: state.chance, closed: state.closed.length };
}
