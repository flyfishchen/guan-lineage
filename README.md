# guan-lineage

观远 BI 的全量血缘：**源表 → 数据集 → ETL → 数据集 → 卡片 → 页面**，以及**字段级血缘**（字段在 ETL、数据集计算字段、视图、卡片中的流转与计算）。

数据只读抓取自观远（`guands` / `guancli`），存入本地 SQLite；通过 CLI、GraphQL 与关系图页面查询。

## 安装

```bash
cd /home/itcmx/project/guan-lineage
npm install
npm link            # 全局命令 guanlineage
```

依赖：Node ≥ 22.13（内置 `node:sqlite`）、Python 3、已登录的 `guands` / `guancli`。

## 快速开始

```bash
guanlineage crawl                 # 全量抓取（约 8 分钟），完成后自动推导字段血缘
guanlineage serve                 # http://localhost:4000/ 关系图；/graphql GraphiQL
guanlineage stats
```

## CLI

| 命令 | 说明 |
|---|---|
| `crawl [--workers 6] [--limit N]` | 全量抓取（只读），结束后推导字段血缘 |
| `rebuild-fields` | 基于缓存的 ETL / 页面配置重算字段血缘（秒级） |
| `serve [--port 4000]` | 关系图页面与 GraphQL |
| `stats` | 抓取时间与统计 |
| `search <关键字> [--type DATASET\|ETL\|CARD\|PAGE\|SOURCE\|FIELD]` | 按名称搜索资源或字段 |
| `show <资源>` | 资源详情 |
| `lineage <资源> [--dir up\|down\|both] [--depth 3] [--types DATASET,ETL,PAGE]` | 资源血缘，按层级列出 |
| `impact <资源> [--depth 10]` | 下游影响分析，按类型汇总 |
| `path <起点> <终点>` | 最短数据流路径 |
| `orphans [--type DATASET]` | 无上下游的资源 |
| `sql <ETL>` | ETL 中 SQL 算子全文 |
| `fields <数据集> [--keyword k]` | 数据集字段 |
| `field <数据集> <字段> [--dir] [--depth]` | 字段血缘（上游来源 / 下游去向，含卡片） |
| `explain <数据集或卡片> <字段>` | 字段计算说明：输入、经由、步骤、SQL |
| `gql '<GraphQL>' [--vars json]` | 任意 GraphQL |

`<资源>` 可为 ID 或唯一名称；名称重复时会列出候选 ID。所有查询命令支持 `--json`；`--db` 指定数据库。

数据目录默认 `data/`，可用环境变量 `GUAN_LINEAGE_DATA` 指定。

## 目录

```
bin/guanlineage.mjs     CLI
src/graph.mjs           GraphQL schema 与查询实现（CLI 与服务共用）
src/server.mjs          HTTP 服务
web/ui.html             关系图页面（资源血缘 + 字段血缘）
crawler/crawl.py        抓取：数据集、ETL、卡片、页面、字段 → SQLite
crawler/field_lineage.py 字段血缘推导（解析 ETL 算子与卡片配置）
skills/guan-lineage/    Claude Code Skill
data/                   lineage.db、cache/{etl,page}（不入库）
```

## 图模型

资源边方向 = 数据流向：

| rel | 含义 |
|---|---|
| `SOURCE_OF` | 源库表 → 数据集 |
| `INPUT_OF` | 数据集 → ETL |
| `OUTPUTS` | ETL → 数据集 |
| `FEEDS` | 数据集 → 视图数据集 |
| `USED_BY` | 数据集 → 卡片（图表 / 钻取，不含选择器） |
| `ON_PAGE` | 卡片 → 页面 |
| `USED_BY_PAGE` | 数据集 → 页面（观远血缘接口，已剔除仅被筛选器使用的） |

字段血缘 `field_edges(src_ds, src_field, dst_ds, dst_field, via, kind, transform)`：

| kind | 含义 |
|---|---|
| `direct` | 透传：原样、改名、仅行筛选、作为分组维度（字段值未改变） |
| `derived` | 计算：本字段值被改变（空值/值替换、聚合、公式、行列转换、合并列、SQL 表达式） |
| `calc` | 数据集自带计算字段 ← 同数据集被引用字段 |
| `view` | 视图数据集按同名字段对应 |
| `card` | 字段 → 卡片（`dst_ds` 为卡片，`via` 为页面，`transform` 为区域 · 聚合 · 卡片公式） |

`transform` 记录处理步骤，以 ` → ` 连接，如 `筛选: 营运部 = 福州分公司 → SUM(入库数量_采购单位) → 改名: … → 空值→0`；SQL 算子记为 `SQL[节点名|节点ID]: 列表达式`。

## 已知限制

- SQL 算子为启发式解析（select 列表 + 别名回溯），复杂 SQL 可能漏连或多连。
- 卡片关系来自页面配置（草稿页 `_draft` 不计），选择器类卡片不纳入血缘。
- 指标平台、ChatBI、填报、工作流对数据集的引用未抓取，`orphans` 结果用于清理前需人工确认。
