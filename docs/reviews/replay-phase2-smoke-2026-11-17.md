# 审查记录：抽取网冒烟样张（2026-11-17）

- 审查方：Qoder 侧
- 被审物：dsh-yu-user @ 872347e（extract-candidates.mjs / score-candidates.mjs / replay-extract.js）
  + out/cand-labeled-smoke.jsonl（16 条）
- 判决：**链路通过，指标管线有一处必修（标签集漏钩子），三处改法采纳并加一条。**

## 一、审查方独立发现（dsh 报告未覆盖）

**"召回 0"有两个原因，不是一个。**

- dsh 诊断：字面尺子低估复述（候选#1 vs world 标签 0.516 < 0.65）。✓ 属实，复算一致。
- **审查方复算发现**：候选#1 vs 同会话一条 **fact** 标签相似度 **0.846**
  （"你记住就行，你们现在是两个agent同时在三个工作区…"，source=explicit，id 3f43656c）。
  但 score-candidates.mjs 标签过滤是 `pair.label === 'tool'`——**钩子写入被排除在标签集外**。
  0.846 远超 0.65，若标签集完整，本样张召回 ≥1，不是 0。
- → **必修**：标签集纳入 hook 口径（spec D4 本就要求双口径）。钩子行 turn=null，
  窗口范围判定（inScope 按 turn）会把它们全滤掉——需按 createdAt 映射轮次或会话级范围。
- 附带观察：同一信息在库里以 fact（explicit，0.846）与 world（tool，0.516）两种 kind 并存，
  治理的同 kind 查重不拦跨 kind 近重复。活库真实存在，记录在案（非扫描器问题）。

## 二、dsh 三项提议裁决

1. **召回改口径：采纳，拆成两个指标。**
   - 信息召回（语义等价，人标校准尺子）与治理召回（dedup 命中，预测活库近重复污染）分开报。
   - 0.516 那条同时是测量 miss **和**真实治理缺口（上线会新建近重复条）——两个指标各量一面。
   - 先人标 16 条校准，再定阈值：采纳。
2. **prompt 加三天测试：采纳。** 便宜档模型显式规则有效（Anthropic：steering 帮弱模型最多）。
   加"只提窗口结束时仍成立的结论"——样张#14 是被最终架构推翻的过期要求，
   窗内看不到结局，prompt 层先挡，结构层（候选带轮次溯源 + 后置 supersession 核）后补。
3. **constraint 收窄：采纳，样张证据强烈。** 16 条里 8 条 constraint，
   审查方按窄定义标完后**纯 constraint 留存 0 条**（全是设计要求/UI 细节/过期要求）。
   判据表见 out/labeling-criterion-v0.md。

## 三、标注协议（改进 dsh 的"各标一半"）

- **两个标注者各自独立标全部 16 条**——各标一半没有重叠，算不出分歧率。
- 判据先写（labeling-criterion-v0.md，草案待用户确认），对着同一把尺子标。
- 分歧项 + 争议项交用户裁；**模型互相同意不算金标**（shuttle D2）。
- 审查方已完成独立标注：out/cand-labels-qoder-2026-11-17.jsonl
  （该记 7 / 不该记 9 / 其中 kind 争议 1：设计否决归 world 还是 constraint）。
- dsh 标完后对比分歧，用户裁决 → 裁决结果钉进 prompt 与 SCAN_RULES。

## 四、端点与工程项（记录）

- only_reasoning 模型 + system 角色烧推理预算（3 窗 2400 tokens 换 0 候选）→
  整段 user 消息 + 定界符 + max_tokens 1500 解决。✓ 代码已实现，温度 0，kind 白名单已收窄。
- hy4flash-free 返回空串 → **空 content 应标降级调用**，不得与"合法 0 候选"混淆
  （现脚本静默记 0）。照 llm-summary 空文本重试/留痕模式。
- out/cand-smoke.jsonl 是 0 字节（失败 run 的遗留）→ 清理或标记，别留无名空工件。
- 窗口分母修复（inScope 按轮次范围，不拿整段会话标签考 6 个窗）：dsh 自查自修，✓ 正确。
- previewWrite 与 write 共用 #nearestDuplicate：✓ 读码确认，口径单份。
- 表头：样张工件无 D5 十字段表头（prompt 版本/模型/温度等）→ 全量跑前必须补。

## 五、全量前置条件

1. 标签集纳钩子（必修）+ 钩子轮次映射；
2. 16 条双标 + 用户裁决 → 尺子定稿；
3. prompt 三天测试 + constraint 窄定义 + 空 content 降级标记；
4. 表头十字段；
5. 先 3 有标签会话 + 16 无标签长会话试跑报数，再全量 59 窗。