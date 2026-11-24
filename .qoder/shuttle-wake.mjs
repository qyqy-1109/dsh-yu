#!/usr/bin/env node
// 本工作区的唤醒包装器（机器本地，不进仓库）。
// 两个作用，都是为避免「两个会话互相抢」：
//   1) 通道白名单：--channels a,b —— 只注册/只放行这些通道；其余通道的 register 结果被剔除，
//      宿主就不会为此工作区再调用钩子。
//   2) 游标隔离：把 SHUTTLE_CURSOR_DIR 指到本工作区自己的目录，不去推进 shuttle 仓共享的 .state 游标
//      （共享游标会被先到的会话吃掉，另一个会话就永远叫不醒）。
// 真正的逻辑仍在 shuttle 仓库的 hook.mjs，这里只做参数/环境转发与输出裁剪。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = 'C:/Users/Windows/Desktop/shuttle/adapters/qoder/hook.mjs';
const STATE = path.join(here, '.shuttle-state');

const argv = process.argv.slice(2);
let allow = ['loom-p1'];
const ci = argv.indexOf('--channels');
if (ci >= 0 && argv[ci + 1]) allow = argv[ci + 1].split(',').map(s => s.trim()).filter(Boolean);
const pass = argv.filter((a, i) => a !== '--channels' && i !== ci + 1);

let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch { /* 注册入口无 stdin 内容 */ }

const res = spawnSync(process.execPath, [HOOK, ...pass], {
  input,
  env: { ...process.env, SHUTTLE_CURSOR_DIR: STATE },
  encoding: 'utf8',
  timeout: 14000,
});

const out = res.stdout ?? '';
let code = res.status ?? 0;

// 注册模式：裁剪 watchPaths，只留白名单通道文件
if (/hookSpecificOutput/.test(out)) {
  try {
    const obj = JSON.parse(out);
    const wp = obj?.hookSpecificOutput?.watchPaths;
    if (Array.isArray(wp)) {
      obj.hookSpecificOutput.watchPaths = wp.filter(p =>
        allow.some(ch => path.basename(p) === ch + '.jsonl' || path.basename(p) === ch + '-decision.jsonl'));
      obj.hookSpecificOutput.additionalContext =
        `shuttle watcher: ${obj.hookSpecificOutput.watchPaths.length} file(s) registered (allow=${allow.join(',')})`;
    }
    process.stdout.write(JSON.stringify(obj));
    process.exit(code);
  } catch { /* 落到下面原样转发 */ }
}

// 唤醒模式（exit 2）：只放行白名单通道的正文块；其他通道既不叫醒也不吞掉输出
if (code === 2) {
  const okChan = allow.some(ch => out.includes(`[shuttle/${ch}]`));
  if (!okChan) process.exit(0);
}

process.stdout.write(out);
if (res.stderr) process.stderr.write(res.stderr);
process.exit(code);
