# guan-lineage

观远 BI 的全量血缘：**源表 → 数据集 → ETL → 数据集 → 卡片 → 页面**，以及**字段级血缘**（字段在 ETL、数据集计算字段、视图、卡片中的流转与计算）。

数据只读抓取自观远（`guands` / `guancli`），存入本地 SQLite；通过 CLI、GraphQL 与关系图页面查询。

## 安装

一键安装（检查 Node / Python / guands / guancli → `npm install` → `npm link` → 自检 → 安装 AI skill）：

| 系统 | 命令 |
|---|---|
| macOS / Linux | `./install.sh`（`--crawl` 装完立即抓取，`--project-skill` AI skill 只装到本项目，`--no-skill` 不装 AI skill） |
| Windows | 双击 `install.cmd`，或加参数 `install.cmd --crawl` / `--project-skill` / `--no-skill` |

脚本不会自动安装 Node / Python，缺失时会给出安装命令。手动安装：

```bash
cd guan-lineage        # 仓库根目录
npm install
npm link            # 全局命令 guanlineage
```

## 依赖

| 依赖 | 版本 | 用途 | 何时需要 |
|---|---|---|---|
| Node.js | ≥ 22.13 | CLI、GraphQL、页面服务（内置 `node:sqlite`） | 始终 |
| Python | ≥ 3.8（仅标准库） | 抓取与字段血缘推导（`crawler/`） | `crawl`、`rebuild-fields` |
| `guancli` / `guands` | 已验证 guancli 1.0.66、guands 0.1.37 | 调用观远 BI 接口读取资源 | 仅 `crawl` |
| npm 包 `graphql` | 16.9.0 | GraphQL 执行 | 始终（`npm install` 安装） |

查询命令（`stats` / `search` / `lineage` / `explain` / `serve` 等）只读本地 `data/lineage.db`，不需要 `guancli` / `guands`，也不访问观远。没有抓取条件的机器可以直接拷贝别处抓好的 `data/` 目录使用。

### guancli / guands

二者是观远官方命令行工具，通过 npm 包 `@guandata/guanskill` 一并安装（同时会装 guanetl、guanwf 等，本项目用不到）：

```bash
npm install -g --foreground-scripts @guandata/guanskill
guancli auth login        # 交互式配置 BI 地址与登录方式，多环境时用 guancli auth use <环境> 切换
guancli status            # 确认「API 连接正常」
```

- **认证**：由 `guancli` 统一管理，`guands` 复用 `guancli` 的当前环境。抓取时临时切换环境可设 `GUANCLI_PROFILE=<环境> guanlineage crawl`。本项目不读取、不保存任何凭据。
- **权限**：抓取结果以登录账号在 BI 中的可见范围为准。账号看不到的数据集、ETL、页面不会入库，相关血缘会缺失，建议使用可见全部资源的账号抓取。
- **调用的命令**（全部为只读查询，见 `crawler/crawl.py`）：

  | 命令 | 取得的数据 |
  |---|---|
  | `guands dataset list --limit N --offset M --raw` | 数据集清单（分页） |
  | `guands dataset cards <数据集ID> --raw` | 使用该数据集的卡片 |
  | `guancli ds get <数据集ID> --raw` | 数据集详情、字段、上游来源 |
  | `guancli etl get <ETL ID> --raw` | ETL 算子 DAG（缓存到 `data/cache/etl/`） |
  | `guancli page get <页面ID> --raw` | 页面卡片配置（缓存到 `data/cache/page/`） |

- **兼容性**：解析依赖上述命令 `--raw` 输出的 JSON 结构。升级 `@guandata/guanskill` 后如抓取报错或字段血缘明显变少，先用 `guanlineage stats` 看抓取错误数，再对照原始输出检查结构是否变化。
- **耗时与失败**：默认 6 并发，全量约 8 分钟（`--workers` 可调）。命令返回非零或输出不是 JSON 时重试 2 次；单次调用超过 180 秒不再重试。仍失败的资源记入 `crawl_errors`（`guanlineage stats` 的「抓取错误」），不中断整体抓取。

支持 Windows、macOS、Linux。Python 按 `py -3` / `python` / `python3` 顺序自动查找（非 Windows 为 `python3` / `python`），也可用环境变量 `GUAN_LINEAGE_PYTHON` 指定解释器路径。Windows 上抓取结束时如 `guanlineage serve` 正在运行，数据库文件被占用无法替换，需先停止服务。

## AI skill：在 AI 对话中查询血缘

`skills/guan-lineage/SKILL.md` 告诉 AI 编码助手何时、如何调用 `guanlineage`。安装后，在助手的对话窗口里直接问「改这个数据集会影响哪些页面」「这个字段怎么算的」，助手会自行运行相应命令并解读结果。

一键安装脚本最后一步会自动安装；也可单独运行：

```bash
guanlineage install-skill                     # 用户级：安装到本机已安装的全部助手
guanlineage install-skill --project           # 项目级：只在本项目中打开助手时可用
guanlineage install-skill --agents claude,codex   # 只装指定助手（未检测到也会创建目录），可与 --project 组合
guanlineage install-skill --dir <skills 目录>  # 装到任意 skills 目录（其它支持 SKILL.md 的工具）
guanlineage uninstall-skill [--project]       # 从所有助手中移除（用户级 / 项目级）
```

| | 用户级（默认） | 项目级（`--project`） |
|---|---|---|
| 位置 | `~/.<助手>/skills/guan-lineage` | 本仓库 `.<助手>/skills/guan-lineage` |
| 生效范围 | 任意目录下打开助手 | 仅在本项目目录下打开助手 |
| 方式 | 复制，`SKILL.md` 更新后需重新安装 | 链接（macOS / Linux 相对软链接，Windows 目录联接，均无需管理员权限），改动即时生效 |
| 版本库 | 不涉及 | 自动写入 `.git/info/exclude`，不出现在 `git status` |

| 助手 | `--agents` | 用户级位置（项目级为仓库下同名目录，如 `.claude/skills/guan-lineage`） |
|---|---|---|
| Claude Code | `claude` | `~/.claude/skills/guan-lineage`（`CLAUDE_CONFIG_DIR` 可覆盖） |
| Codex | `codex` | `~/.codex/skills/guan-lineage`（`CODEX_HOME` 可覆盖） |
| Cursor | `cursor` | `~/.cursor/skills/guan-lineage` |
| Gemini CLI | `gemini` | `~/.gemini/skills/guan-lineage` |
| CodeBuddy | `codebuddy` | `~/.codebuddy/skills/guan-lineage`（与观远 guanskill 一致） |
| WorkBuddy | `workbuddy` | `~/.workbuddy/skills/guan-lineage`（与观远 guanskill 一致） |

Windows 上 `~` 即 `%USERPROFILE%`。

- **检测方式**：助手的配置目录（如 `~/.claude`）存在即视为已安装。之后才装的助手，重新运行 `guanlineage install-skill` 即可。
- **生效**：重启助手或新开对话后生效。
- **更新**：用户级为复制，`SKILL.md` 更新（如 `git pull` 后）需重新运行 `guanlineage install-skill`；项目级为链接，无需重装。目标已是指向本仓库的链接时，`install-skill` 保持不动。
- **只要项目级**：先 `guanlineage uninstall-skill` 移除用户级，再 `guanlineage install-skill --project`；重跑一键安装脚本时加 `--project-skill`，否则会重新装回用户级。
- **前提**：skill 只是使用说明，助手实际执行的是本机的 `guanlineage` 命令，因此助手须运行在装了本项目的同一台机器上。claude.ai 网页版等在云端执行命令的对话窗口无法使用。

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
| `serve [--port 4000] [--host 127.0.0.1]` | 关系图页面与 GraphQL；默认仅本机访问，局域网共享用 `--host 0.0.0.0`（无鉴权） |
| `stats` | 抓取时间与统计 |
| `install-skill [--project] [--agents a,b] [--dir 目录]` / `uninstall-skill [--project]` | 安装 / 移除 AI skill（默认用户级，`--project` 仅本项目） |
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
src/skill.mjs           AI skill 安装 / 移除
web/ui.html             关系图页面（资源血缘 + 字段血缘）
crawler/crawl.py        抓取：数据集、ETL、卡片、页面、字段 → SQLite
crawler/field_lineage.py 字段血缘推导（解析 ETL 算子与卡片配置）
skills/guan-lineage/    AI skill（SKILL.md，由 install-skill 安装到各助手）
install.sh / install.cmd / install.ps1   一键安装（macOS·Linux / Windows）
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
