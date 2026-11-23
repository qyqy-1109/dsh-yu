# 审查记录：回放扫描器第一阶段（2026-11-17）

- 审查方：Qoder 侧（按 engine-split-v0 §7 清单）
- 被审物：dsh-yu-user（loom 引擎工作区）lib/replay.js · scripts/replay.mjs · test/replay.test.mjs · out/replay-pairs-2026-11-17.jsonl
- 判决：**打回，修 6 项后重发基线**。核心链路（解码/配对/锚点/分层/红线）全部独立复数通过；
  打回项都是小改，但其中两项不改会让第二阶段的分数不可信。

## 一、独立复数（审查方自己跑，不是读代码读出来的）

| 项 | dsh 报 | 审查方复跑 | 判定 |
|---|---|---|---|
| 测试 | 13 新 / 191 全绿 | 191 pass / 0 fail | ✓ |
| 会话去重 | 231（89/47/95），8 共存 | 同 | ✓ |
| 帧 | 189,358 / 0 失败 / 0 坏行 | 189,376 / 0 / 0 | ✓（+18 帧见 §四.1） |
| 分层 | 15/296 vs 216/1428 | 同 | ✓（审查方早前 294 系定义差：ERR-only 会话 2 轮归无标签，dsh 定义更准，采纳） |
| 注入 | 1569 用户 / 1674 注入（51.6%） | 同 | ✓（口径细分见 §四.2） |
| 分母 | tool 412 / +钩子 415 / ERR 1 | live 414/417/1（+2 见 §四.1）；存档 jsonl 412+1ERR+3hook=416 行 | ✓ |
| 库连接 | 332 逐字相等 / 79 slot / 1 跨库 | **332/332 逐字相等，79 slot，1 跨库**，kind 分布 world174/self77/fact36/choice23/episode14/constraint8 | ✓ 锚点链干净，无模糊匹配 |

红线：零模型调用 ✓（import 仅 node 内置 + git）；只读 ✓（lib 纯读，脚本只写 --out 工件）；
口径单份 ✓（审查方只消费，未建平行扫描器）。

## 二、打回项（6 项，按严重度排）

1. **【第二阶段阻断】查重返回会被误标为新写入。**
   `extractUuids` 对「未新建：与已有记忆重复（id X）」「重复，已累加命中：X」照样提取 uuid，
   配成"新写入"行。当前语料 0 次查重返回，基线不受影响；但第二阶段的核心指标就是 NOOP 率，
   这条不修，NOOP 会被算成覆盖。→ 解析结果状态词，加 `status: created|deduped|error` 字段 + 测试。
2. **【清单 D 项】jsonl 缺 kind / slug / cutoff 三个字段。**
   412 条 tool 行 kind 全 null（rawArgs 里有，parseWriteArgs 只取 text 丢了 kind）；
   pair 行无 workspace slug；全会话无 cutoff（最后 turn/end 时刻）。
   没有 kind，slot 分母排除只能靠库连接，工件自身不可复算；没有 cutoff，第二阶段快照重建要重扫。
   → parseWriteArgs 并行提取 kind；pair 行补 slug；会话统计收 cutoff 并落进工件。
3. **【清单 D 项】工件自身无表头，代码版本无钉。**
   表头只在 stdout 报告里，jsonl 脱离报告即失去全部溯源；engineGit='no-git'（loom 目录无 git）；
   rulesDigest 只哈希规则文本，**代码改了规则没改 → 摘要不变**（dsh 自报风险三，答案：不够）。
   → jsonl 首行 meta（或同名 .meta.json）：generatedAt/scannerVersion/rulesDigest/
   replay.js 内容哈希/engineGit；loom 仓库 git init（P1 本来就该有历史）。
4. **【清单 C 项】快照语义未落地。**
   332 连接是对**当前库**做的（验锚点足够），但 §7 C 要求匹配池按 cutoff 截断、
   archivedAt/relaxedAt > cutoff 的行按当时活跃重建。第一阶段可以不跑匹配，
   但工件必须带 cutoff（第 2 项）让第二阶段能消费。→ 随第 2 项修，补一条快照重建的单测。
5. **【测试缺口】伪魔数重试路径无回归。**
   splitZstdFrames 的吞帧重试经逐行推演是健全的：单帧跨度优先试，合法帧不会走进"两帧合并"分支
   （Node 只解第一帧 + 首跨度成功即停）；丢帧路径全部计入 failed，不静默。
   但测试只覆盖尾部垃圾帧，没覆盖**合法帧载荷内嵌伪魔数**。→ 补两条测试：
   内嵌伪魔数全帧恢复且 failed=0；中段坏帧 failed>0 且后续帧仍恢复。
6. **【小项】ids/texts 长度不等时静默回落 texts[0]。**
   形状对不上是该报警的事，不该悄悄补。→ 加 mismatch 标记字段。

## 三、slot 分母裁决（dsh 提请，审查方裁定，用户 approve 后生效）

**排除 slot。** slot 写是状态覆盖不是新事实，79/412=19.2% 混进分母会把召回率稀释成
"我改了几次当前版本"。第 0 档召回分母 = kind≠slot ∧ 落在本库 memories = **332**。
报告漏斗：412（tool 成功）→ 333（非 slot）→ 332（本库）；1 条跨库单列不静默丢；
slot 行留在 jsonl（kind 修好后）供审计。

## 四、观察项（不阻断，记录在案）

1. **日志是活的**：审查方复跑比 dsh 报多 18 帧 / 2 对，top 会话不变，差异与 dsh 扫描后
   继续写入一致（其审计会话 session-07d41339 仍在活动）。不是 bug，但工件必须带 generatedAt
   （第 3 项）才能给两份快照排序。修后复跑确认差异来源。
2. **51.6% 是全部非 user 口径**：其中记忆插件专属（plugin:dsh-memory-loom 291 + plugin 172）
   = 463 条，其余是 time-context/skill-catalog/runtime-context 等宿主样板。
   系统性抬高论点针对的是记忆注入（463/(1569+463)=22.8%），报告应把两类分开列，
   过滤判据不变（非 user 全滤）。
3. **钩子口径漏 decision**：buildHookPairs 只认 explicit；而 store.js 把 decision 写入
   折叠成 source:'tool'（write() 的 source 三目），库里根本认不出定稿捕获。本库 0 条 decision，
   暂不影响；这是**引擎侧溯源缺口**，另立条目修（source 保留 'decision'），不混进扫描器。
4. jsonl 内容里看到 dsh 对 loom P1 的审计记忆（D4 透传测试假绿、D3 扩展点三缺陷）——
   属 P1 审查范围，审查方将独立对代码验证，不在此判决内。

## 五、重发要求

修完 6 项 → 全量测试绿 → 重扫出**新日期文件**（旧 416 行工件保留不动，只增不改）→
审查方复核 6 项 + 复数 → 用户 approve → 新工件才算基线。