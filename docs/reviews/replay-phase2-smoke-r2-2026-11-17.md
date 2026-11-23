# 复核记录：抽取网 v1 + 标签管线修复（2026-11-17，第二轮）

- 审查方：Qoder 侧
- 被审物：dsh-yu-user @ ba6a6e6 + cand-v1-smoke.jsonl + cand-labels-lead-2026-11-17.jsonl
- 判决：**修复全部验证通过；#12 审查方认账；全量前还差 3 件（用户裁决 / 新尺子验证 / 表头补全）。**

## 一、独立复数

- 标签集 **342 = tool 339 + hook 3** ✓（v0.2.2 工件 ∩ 当前库，复算一致）。
- 0.846 那条（3f43656c，explicit）已进标签集 ✓；钩子 createdAt→轮次映射、
  映射不上单报 turnMapped，不静默消失 ✓。
- v1 同 6 窗：候选 16→6，constraint 8→0，UI 细节/过期要求全除 ✓；
  降级计数 degradedCalls=1 ✓；0 字节 cand-smoke.jsonl 已删 ✓。
- 双标独立性：lead 文件注明"未参考 qoder 逐条结论，最后一步才对比" ✓。
  实质分歧仅 #12（#6 双方收敛 world）。

## 二、标注裁决（审查方意见）

- **#12 认账**：README 669 行确有「详情就地展开…再点同一条收起」。
  审查方原判"该记/world"误用 kind 表、漏过排除条款。lead 的剔除正确。
  判据 v0 内部矛盾（kind 表示例 vs 排除条款）→ v1 修复：**排除优先，再定 kind**。
- **#6 收敛 world**：双方同结论，规则"设计否决→world 不进 constraint"请用户批准。
- 两条裁决草案已写进 out/labeling-criterion-v0.md §v1，**待用户批准后才算尺子**。
- 一致率 87.5% 不是证据（lead 自己也这么提醒，对的）；用户裁完那两条才是金标。

## 三、新尺子（同 kind + 关键实体重合）——同意实验，三个条件

1. **信息召回不得硬卡同 kind**。0.846 那条正是 fact 标签 × world 候选——
   同 kind 硬门会 reproduces 刚抓到的跨 kind 盲区。kind 当信号不当门；
   治理召回保持字面同 kind（那是引擎真实行为，不动）。
2. **尺子自身要报精确率/召回率**：在 v0(16)+v1(6) 上对双标+用户裁决后的金标验，
   捞回 0.516、不给 v1 抽象候选乱加分，两个方向都验。新尺子是代理不是金标。
3. **关键实体抽取方法写明**（中文无分词器，用 rank.js 的 IDF 内容词还是别的），
   确定性、可测试，不许手调阈值凑数。

## 四、表头缺口（全量前必修）

v1 工件表头 10 字段含运行统计（windows/candidates/degraded/failed/tokens），好；
但 D5 要求的比较性钉只到 3/10：缺 **temperature / seed / engineGit /
scannerVersion / rulesDigest / codeDigest / storePath**。
温度现在代码里固定 0，但不记录就等于没人钉住它。engineGit 现在有仓库了，
scannerVersion/rulesDigest/codeDigest 从 replay.js import 即可。补齐才许全量。

## 五、全量放行条件（审查方点头 + 用户 approve）

1. 用户批准 #6/#12 两条裁决 → 判据 v1 定稿；
2. 新尺子按 §三 三条件验过，报告尺子自身的精确/召回；
3. 表头 D5 十字段补全；
4. 先 3 有标签 + 16 无标签长会话试跑报数 → 用户 approve → 全量 59 窗。