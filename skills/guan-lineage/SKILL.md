---
name: guan-lineage
description: 查询观远 BI（Guandata）的资源血缘与字段血缘 —— 数据集 / ETL / 卡片 / 页面 / 源表之间的上下游、改动影响分析、字段来源与计算口径（经过哪些 ETL 算子、SQL、卡片公式）。当用户问"某数据集/ETL 被谁用""改这个会影响哪些页面""这个字段从哪来、怎么算的""卡片用了哪些字段""哪些数据集没人用"，或需要在改 ETL / 删数据集前评估影响时使用。
---

# guan-lineage：观远血缘查询

本地血缘库由 `guanlineage crawl` 只读抓取观远生成（SQLite），查询不访问观远、无副作用。`guanlineage` 为全局命令（在仓库根目录 `npm link` 安装），可在任意目录运行；数据默认位于仓库 `data/`，可用环境变量 `GUAN_LINEAGE_DATA` 指定。

## 先确认数据新鲜度

```bash
guanlineage stats        # 看「抓取时间」；过旧或刚改过 ETL/页面时提醒用户重抓
```

重抓（约 8 分钟，只读）：`guanlineage crawl`。只改了字段血缘解析逻辑时用 `guanlineage rebuild-fields`（秒级）。

## 常用命令

`<资源>` 可传 ID 或唯一名称；名称重复时命令会列出候选 ID，再用 ID 重试。需要结构化结果加 `--json`。

| 问题 | 命令 |
|---|---|
| 找资源 / 字段 | `guanlineage search 采购主题` · `guanlineage search 人效 --type FIELD` |
| 资源基本信息 | `guanlineage show <资源>` |
| 上下游 | `guanlineage lineage <资源> --dir up\|down\|both --depth 3 [--types DATASET,ETL,PAGE]` |
| 改动影响（下游 ETL / 数据集 / 卡片 / 页面） | `guanlineage impact <资源>` |
| 两资源间链路 | `guanlineage path <起点> <终点>` |
| 数据集有哪些字段 | `guanlineage fields <数据集> [--keyword 金额]` |
| 字段从哪来、流向哪（含卡片） | `guanlineage field <数据集> <字段> --dir up\|down\|both --depth 3` |
| 字段怎么算的（口径） | `guanlineage explain <数据集或卡片> <字段>` |
| ETL 里的 SQL | `guanlineage sql <ETL>` |
| 没有上下游的数据集 | `guanlineage orphans --type DATASET` |
| 全局参数被哪些字段 / 卡片使用 | `guanlineage field 全局参数 <参数名> --dir down`（参数列表：`guanlineage fields 全局参数`） |
| 失效卡片（引用的数据集 / 字段已不存在） | `guanlineage broken [--reason dataset\|field]` |
| 其它 | `guanlineage gql '<GraphQL>'`（schema 见 `src/graph.mjs`） |

## 读结果要点

- 资源边方向 = 数据流向：源表 → 数据集 → ETL → 数据集 → 卡片 → 页面。
- 字段血缘类型：**透传**（原样 / 改名 / 仅行筛选，值未变）、**计算**（聚合、公式、空值替换、行列转换、SQL 表达式等改变了值）、**计算字段**（数据集自带）、**视图**、**卡片使用**。
- `explain` 的步骤按 ETL 中的先后顺序列出，包含筛选条件，可直接用于核对口径；`SQL[节点]` 步骤附完整 SQL。
- 多个输入共同算出一个字段时，`explain` 会把它们列在同一组"输入"里，公式只出现一次。

## 注意

- 结果来自上次抓取的快照；结论涉及删除或修改资源时，先用 `guancli` / `guands` 实时复核（如 `guands dataset cards <dsId>`）。
- `orphans` 不含指标平台、ChatBI、填报、工作流的引用，不能单凭它删除数据集；删除须遵守项目红线（先展示影响范围并获得用户明确确认）。
- SQL 算子的字段血缘是启发式解析，复杂 SQL 可能有遗漏，需要时用 `guanlineage sql` 看原文确认。
- 可视化：`guanlineage serve` 后打开 http://localhost:4000/（资源血缘 + 字段血缘），适合给用户演示。
