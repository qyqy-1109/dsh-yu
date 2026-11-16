/**
 * 醒一次。
 *
 * 为什么需要这个脚本：`memory_private` 只能在会话里调，而"醒来"的定义是
 * **没人在跟我说话的时候也算一次**。所以得有个不依赖会话的入口。
 *
 * 注意：醒来要结账。上一次醒来没写、也没关，这里会直接报错（exit 1）。
 *
 * 用法：
 *   node scripts/wake.mjs            # 醒一次，看看手里那件事还欠不欠
 *   node scripts/wake.mjs status     # 只看，不醒
 *   node scripts/wake.mjs open "..." # 开一件自己想回头接着做的事
 *   node scripts/wake.mjs close "因为……"
 *   node scripts/wake.mjs dir        # 打印私人记录的目录
 *
 * 三条规矩不在这里实现，在 lib/private.js 里：一次只欠一件、写下不许改写、醒来要结账。
 */
import { closeLoop, defaultPrivateDir, openLoop, statusLoop, wake } from '../lib/private.js';

const [command = 'wake', ...rest] = process.argv.slice(2);

async function main() {
  if (command === 'dir') {
    console.log(defaultPrivateDir());
    return;
  }
  if (command === 'status') {
    const status = await statusLoop({});
    if (status.open === null) console.log('手里没有欠着的事。');
    else {
      console.log(`欠着：${status.open.text}（醒过 ${status.open.wakes} 次）`);
      if (status.chance) console.log('上一次醒来还没结账：先写一句，或者带理由关掉它，否则下次醒不过来。');
    }
    return;
  }
  if (command === 'open') {
    const text = rest.join(' ').trim();
    const result = await openLoop({ text });
    console.log(`开了：${result.open.text}`);
    return;
  }
  if (command === 'close') {
    const reason = rest.join(' ').trim();
    const result = await closeLoop({ reason });
    console.log(`关掉了：${result.closed.text}（醒过 ${result.closed.wakes} 次）`);
    return;
  }
  const result = await wake({});
  console.log(`醒来。${result.open === null ? '手里没有欠着的事。' : `这件还欠着（第 ${result.wakes} 次醒来）：${result.open.text}`}`);
  console.log(result.open === null ? '没有欠账要结：可以不写，也可以现在开一件。' : '这一次要结账：写一句，或者带理由关掉这件。');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
