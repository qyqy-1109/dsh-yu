# 复核记录：回放扫描器 0.2.0（2026-11-17，第二轮）

- 审查方：Qoder 侧
- 被审物：dsh-yu-user @ 2e25821，lib/replay.js（542 行）· test/replay.test.mjs（19 条）·
  out/replay-pairs-2026-11-17-v0.2.0.jsonl（表头 + 418 行）
- 判决：**6 项打回全部修复，独立验证通过；新发现 2 项小修（不阻断数字，阻断工件定稿）。
  修完即可提交用户 approve 为基线。**

## 一、6 项打回逐条复核

| # | 项 | 验证方式 | 结果 |
|---|---|---|---|
| 1 | 查重误标 | 读 parseWriteResult + 探针（单条/批量+note 三种形状）+ 测试 | ✓ deduped 带 id 不进 created；新形状落 unknown 不被猜（探针实测） |
| 2 | kind/slug/cutoff | 工件逐行扫描 | ✓ tool 行 0 缺 kind / 0 缺 slug；**hook 3 行缺 cutoff（见 §三.2）** |
| 3 | 表头 + 代码钉 | 独立复算 sha256 | ✓ codeDigest b6fa7e9d236a 逐字一致；engineGit 2e25821 = HEAD；generatedAt/storePath 在；jsonl 首行 header |
| 4 | 快照语义 | snapshotAt 探针（5 记忆行/2 slot/3 loop） | ✓ a,b,e / s1 / l1,l2 全对；单测在 |
| 5 | 伪魔数回归 | 读测试断言 | ✓ 帧+裸魔数+帧 → 2 帧、内容都在、failedCandidates=1 |
| 6 | 长度不等不回落 | 读码 + 测试 | ✓ text:null + textMissing:true，断言第二条非第一条复制 |

## 二、dsh 自报的两处新修复，验证

- **note 行白名单**：探针单条+note → 1 行 created；批量+note → created,deduped，note 不成行。
  31 次写入 144 行 unknown 的病灶已除（当前工件 unknown=0）。
- **空输出判失败**：代码 `out.length === 0 → continue`，伪魔数测试覆盖该机制。
  "静默失败比报错难查"——这条记进审查记录，是对的。

## 三、独立复数（审查方自跑）

- 197 测试全绿（19 回放）。
- 漏斗：**created 414 → slot 79（79/79 id 在 state.slots）→ 非 slot 335 →
  本库 334，334/334 逐字相等 → 跨库 1**（id 6a597475，与第一轮同一条）。
- failedCandidates=1 定位：session-aa705813（v3），255 帧 / 533 行，行帧比 2.09 与全库一致，
  非丢帧。字段改名 failedCandidates 正确。
- live 全库总轮数 1725 = 工件 297+1428，逐字吻合（审查方粗探针把 labeled 数错成 23，
  因未查工具名——审查方自己的 bug，已纠，不影响判决）。
- 旧工件 416 行原样未动 ✓。注入拆分：插件 464 / 宿主样板 1212 / 真用户 1570 ✓。

## 四、新发现（2 项小修，修完工件定稿）

1. **旧工件在 git 里**：`git ls-files out/` 显示 replay-pairs-2026-11-17.jsonl 已被
   5ce0f7f 跟踪——"产物不入库"目前对旧工件不成立。ignore 本身生效
   （审查方第一轮"BOM 破坏 pattern"的判断**有误**，check-ignore 对已跟踪文件恒 exit 1，
   用 --no-index 复测确认 pattern 命中；自纠）。
   → `git rm --cached out/replay-pairs-2026-11-17.jsonl` + 提交，文件留盘。
2. **hook 3 行 cutoff:null**：buildHookPairs 不带 cutoff，scanRoot 合并时也没补。
   → 按 sessionId 从会话统计继承 cutoff（钩子只有会话级坐标，cutoff 是可继承的）。

## 五、观察项（不阻断，记录在案）

- cutoff 实现 = 全会话最大 row.time，spec 写的是"最后 turn/end 时刻"。实现更准
  （尾部元数据事件也在会话生命内），**偏离有据，文档注明即可**。
- snapshotAt 重建的是"当时存在且活跃"，不是"当时生效"：relaxed 约束恒为 active，
  relaxedAt ≤ cutoff 的也在快照里。对内容匹配无害；第二阶段若要"生效"语义，
  消费侧自行按 relaxedAt 滤。文档注明。
- results 与 submitted 条数不等时只标 textMissing，不报 countMismatch——
  未来新形状可能静默丢提交条目，建议加标记（非阻断）。
- denominators.toolPlusHook 现在 = 非 slot + 钩子（338），与第一轮口径（415）不同名同义，
  报告里注明定义。
- rawArgs 不再进 jsonl（text/kind/resultText 已够审计），接受。

## 六、待用户 approve

- **slot 排除裁决**（第一轮 §三）：召回分母 = 非 slot ∧ 本库 = 334（本轮数）。
  代码现状"报漏斗、不删行"正确。用户 approve 后此定义钉进 SCAN_RULES。
- 两项小修完成 + 用户 approve → v0.2.0 工件（或修后重扫的新日期工件）即为写侧基线。