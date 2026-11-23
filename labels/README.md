# labels/

标注与判据是**证据**，不是产物，所以进版本控制（生成的 jsonl 工件留在 out/，已 gitignore）。

| 文件 | 说明 |
|---|---|
| labeling-criterion-v0.md | 草案（#12 上暴露内部矛盾） |
| labeling-criterion-v1.md | 现行；先过排除条款再定 kind；两条规则已批（2026-11-17） |
| cand-labels-lead-r2-2026-11-17.jsonl | 我的独立标注：15 条（v1 6 + trial 9），含 matchGold |
| cand-labels-qoder-r2-2026-11-17.jsonl | qoder 的独立标注：同 15 条（原样拷贝，未改动） |
| cand-labels-*-2026-11-17.jsonl | 第一轮 16 条的标注（历史留存） |

金标 = 双方独立标注 + 用户裁决分歧后的结果。模型互相同意不算金标。
