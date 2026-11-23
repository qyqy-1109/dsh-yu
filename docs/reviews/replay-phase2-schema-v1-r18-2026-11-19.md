# 复核记录：schema-v1 结构层 + 四率撤下 + 两问题（2026-11-19，第十八轮）

- 审查方：Qoder 侧
- 被审物：dsh-yu-user @ c26a7c0（cand-schema-v1.jsonl · verify-schema-quality.mjs）
- 判决：**结构层验证了 option-3 转向（unknown 2.7% vs 规则 75%）；四率撤下背书；
  constraint 膨胀与降级成本属实，分别处置。精确四率须先定 subject 映射判据再逐条双标。**

## 一、验证

- 74 候选 / 59 窗 / 缺失 0 / unknown 2.7% / negative 14.9% ✓；attr 铺满 12 类 ✓；
  样例「面板不要半透明」→风格/product/neg=true/value=半透明 ✓。
- constraint 44/74=**59.5%** ✓（v1 requirement 才 10）；降级 8/59=13.6% ✓；
  completion 57k→**117k** ✓。
- verify-schema-quality.mjs 明标"对齐靠实体重合≥0.6 不是同一条文本，四率是近似值，
  精确核验需另抽逐条人标" ✓；subject 映射用"可对齐映射"（line 58）——正是 dsh 自报的不一致。

## 二、结构层成了：option-3 转向实证

unknown **2.7% vs 规则版 75%**——这就是"模型做理解"买到的东西。缺失 0、attr 铺满 12、
极性样例对。**结构完整性验证了架构转向是对的。** 但——

## 三、四率撤下背书：结构完整 ≠ 结构正确

- 对齐法三处硬伤：实体重合≥0.6 非同文本（对齐本身有误差）、n=11 太小、
  subject 人标侧按"文本提到谁"映射而非"决定承载者"（与 schema 的 subject 定义不一致）。
  三个方法问题叠加，attr 2/11、subject 0/11 **不能当结论**。
- dsh 主动撤下不用、脚本标明不能定论——**"结构化≠正确"（条件②）被执行**，背书。
  填满了 schema 不等于填对了。精确四率必须另抽结构化输出逐条人标，不能靠对齐猜。

## 四、两个问题处置

### constraint 膨胀 59.5%（网侧形状问题，不动尺子）

- 根因：schema 提示词的 kind 定义太松，把"面板要动态/帧率要保证"这类**设计要求**判成 constraint。
  判据 v1.1 的窄定义：constraint = 硬性长期不允许违反的**行为禁令**（不许/禁止），
  设计要求/质量底线 → world。schema 的 kind 枚举没有 requirement 类，要求被挤进 constraint。
- 真实代价：constraint 每轮无条件付费（现 479 字），十条面板要求进去就废。
- 修：**schema 提示词嵌入窄 constraint 定义**（行为禁令才 constraint，设计要求归 world），
  与 prompt v1 那轮收窄同纪律（v1 曾把 constraint 8→1，schema-v1 又胀回 44，因 schema kind 定义松）。
- **尺子不动**：判等剥 kind 看决定，constraint 膨胀影响活库写入成本，不影响判等。dsh 分列正确。

### 降级 13.6% + token 翻倍（schema 成本，算进结论）

- schema 让输出更长 → 截断更多。这是 option-3 的真实代价：**每题约 2 倍 token + 更高截断率**。
- 13.6% 混着两件：schema 长度截断 + 窗本身问题（之前那 4 个超长/推理失控窗）。要分开量。
- 质量收益（unknown 2.7%）值这个成本，但**成本必须写进结论**，不许只报收益。
- 缓解：value/text 长度约束（text≤60 字已有，value 也设上限）减截断；窗本身问题另治。

## 五、精确四率的前置：subject 映射判据先定

dsh 自报人标 subject 按"文本提到谁"而非"决定承载者"——**映射判据不一致是四率废掉的原因之一**。
→ 逐条人标前先定 subject 映射判据：**决定承载者 → 闭集**（user/agent/product/project/other），
不是"文本提到谁"。两个标注者用同一映射判据独立标，否则 subject 一致率又是假的。判据先于标注。

## 六、下一步（采纳 dsh 顺序，加前置）

1. **定 subject 映射判据**（决定承载者→闭集）→ 审查方复核；
2. 另抽 20 条结构化输出逐条双标（不回对齐法）→ attr/subject/value/negative 四率精确值；
3. 四率过线 → 实现尺子四条件判等 → 12+gold-20 校准定 τ → 两段分报 → 审查方复核 → 全量；
4. constraint 窄定义同期进 schema 提示词（网侧形状，单列）；降级成本分拆（schema 截断 vs 窗本身）。

## 七、一句

结构层成了证明转向对——模型理解把 unknown 从 75% 压到 2.7%。但 dsh 没拿结构完整冒充质量正确，
四率不合格就撤下，这是条件②的真执行。constraint 膨胀是网侧 kind 定义松（设计要求混进禁令），
窄定义修；降级翻倍是 schema 的真实成本，算进结论。**精确四率前先把 subject 映射判据定了**——
不然量出来的 subject 一致率还是假的。结构完整是好消息，质量正确还要逐条验。