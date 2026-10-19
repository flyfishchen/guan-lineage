# CLAUDE.md

观远 BI 血缘工具：只读抓取观远（`guands` / `guancli`）的数据集、ETL、卡片、页面与字段，存入 SQLite，通过 CLI `guanlineage`、GraphQL 与关系图页面查询资源血缘和字段血缘。用户使用简体中文，回复与代码注释用中文。

## 常用命令

```bash
npm install && npm link                  # 安装全局命令 guanlineage
guanlineage crawl                        # 全量抓取（约 8 分钟）→ data/lineage.db，结束自动推导字段血缘
guanlineage rebuild-fields               # 只重算字段血缘（读 data/cache，秒级）——改 field_lineage.py 后用这个
guanlineage serve --port 4000            # http://localhost:4000/ 页面，/graphql GraphiQL
guanlineage stats | search | show | lineage | impact | path | orphans | sql | fields | field | explain | gql
```

没有测试框架。改动后的检查方式：

```bash
node --check src/graph.mjs src/server.mjs bin/guanlineage.mjs
python3 -c "import ast;[ast.parse(open(f).read()) for f in ('crawler/crawl.py','crawler/field_lineage.py')]"
# ui.html 内联脚本：抽出 <script> 再 node --check
guanlineage stats && guanlineage explain s132435b02e7a485780fff4c 集采/地采   # 冒烟
```

## 架构

- `crawler/crawl.py`：并发调用 `guands dataset list/cards`、`guancli ds get`、`guancli etl get`、`guancli page get`，写入 `<db>.tmp`，成功后原子替换 `lineage.db`；ETL 与页面原文缓存到 `data/cache/{etl,page}/`，最后调用 `field_lineage.build()`。
- `crawler/field_lineage.py`：解析 ETL 算子 DAG（`etl_columns`，每个算子类型一个分支）推导「输出列 ← 输入数据集字段」，SQL 算子用 `sql_columns` 启发式解析；解析页面卡片配置得到「字段 → 卡片」边，并补齐「数据集 → 卡片」接口漏掉的卡片节点、剔除仅被筛选器使用的「数据集 → 页面」边。结果写 `field_edges`（每次 DROP 重建）。
- `src/graph.mjs`：`createGraph()` 内含 GraphQL schema（`buildSchema` SDL）与全部 resolver，CLI 与服务共用；数据库以只读打开。
- `src/server.mjs`：HTTP；`/` 每次请求重新读取 `web/ui.html`（改页面无需重启），`/graphql` 执行查询。
- `bin/guanlineage.mjs`：CLI，进程内调用 `graph.query()`，不依赖服务；`crawl` / `rebuild-fields` 转调 Python（`findPython()` 查找解释器，并设 `PYTHONUTF8=1`）。
- `web/ui.html`：单文件页面，cytoscape + dagre（CDN）画资源血缘；字段血缘为自绘「表卡片 + SVG 连线」视图（`renderFieldView` / `drawFieldLinks`），两种视图共用顶部工具栏。

数据表：`nodes(id,type,subtype,name,path,props)`、`edges(src,dst,rel)`、`fields(ds_id,fd_id,name=展示名,phys_name,...)`、`field_edges(src_ds,src_field,dst_ds,dst_field,via,kind,transform)`、`crawl_errors`、`meta`。

## 约定与口径

- 边方向一律为数据流向（上游 → 下游）。资源类型：SOURCE / DATASET / ETL / CARD / PAGE。
- 字段以「数据集 ID + 展示名」标识；展示名 = 别名优先，ETL 中按展示名引用。
- `field_edges.kind`：`direct` 透传（原样 / 改名 / 仅行筛选 / 分组维度，值未变）；`derived` 计算（聚合、公式、空值/值替换、行列转换、合并列、SQL 表达式）——判定见 `kind_of()`，筛选与改名只作为说明记入 `transform`，不改变判定；`calc` 数据集计算字段；`view`；`card`（`dst_ds` 为卡片，`via` 为页面，`transform` 为「区域 · 聚合 · 卡片公式」）。
- `transform` 为以 ` → ` 连接的步骤；SQL 步骤格式 `SQL[节点名|节点ID]: 列表达式`，页面与 CLI 都按此解析，改格式需同步 `ui.html` 的 `stepsHtml/appendSql` 与 CLI 的 `explain`。
- 选择器类卡片（SELECTOR / TREE_SELECTOR / MERGE_SELECTOR）不纳入血缘；页面草稿 `_draft` 不计。

## 注意事项

- 只读：抓取只调用观远的查询接口。本项目不得调用任何写操作（删除、替换数据、保存 ETL 等）。
- 改 `src/graph.mjs` 或 `src/server.mjs` 后需重启 `guanlineage serve`；改 `web/ui.html` 刷新页面即可；改 `crawler/field_lineage.py` 后运行 `guanlineage rebuild-fields`。
- 调试抓取时不要对正式数据目录用 `--limit`：抓取会清空并重建 `data/cache/page`，小样本会导致字段→卡片关系缺失。改用临时目录：`GUAN_LINEAGE_DATA=/tmp/x guanlineage crawl --limit 5`。
- `node:sqlite` 为实验特性，CLI 在动态 import `graph.mjs` 前改写 `process.emitWarning` 屏蔽该警告；要求 Node ≥ 22.13。
- 跨平台（Windows / macOS / Linux）：shebang 只用 `#!/usr/bin/env node`（不用 `env -S`）；路径一律 `path.join` / `pathlib`；Python 读写文件与子进程输出显式 `encoding="utf-8"`；外部命令经 `shutil.which` 解析（Windows 上是 `.cmd`）；SQLite 连接用完即关，否则 Windows 下最后的原子替换会失败。
- `data/` 不入 git（含 36MB 数据库与缓存）。
