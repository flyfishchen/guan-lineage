#!/usr/bin/env node
// guanlineage：观远 BI 血缘图命令行。查询直接读本地 SQLite（无需启动服务）。
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// 屏蔽 node:sqlite 的实验特性警告。不用 shebang 的 `env -S node --no-warnings`：
// Windows 的 npm 命令包装与部分 Linux 的 env 不支持 -S。须在加载 graph.mjs 之前设置，故下面用动态 import
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...a) => {
  const type = typeof a[0] === 'string' ? a[0] : a[0]?.type;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(String(w?.message ?? w))) return;
  return emitWarning.call(process, w, ...a);
};
const { createGraph, ROOT, DATA_DIR } = await import('../src/graph.mjs');


const HELP = `guanlineage — 观远 BI 数据集 / ETL / 卡片 / 页面 / 字段 血缘

用法: guanlineage <命令> [参数] [--json] [--db <lineage.db>]

数据
  crawl [--workers 6] [--limit N]     全量抓取（只读调用 guands/guancli），完成后自动推导字段血缘
  rebuild-fields                       基于缓存的 ETL / 页面配置重算字段血缘（秒级）
  serve [--port 4000] [--host 127.0.0.1]  启动关系图页面与 GraphQL（/ 与 /graphql）；默认仅本机
  stats                                抓取时间与节点、边、字段统计
  install-skill [--project] [--agents claude,codex] [--dir <目录>]
                                       把 AI skill 安装到本机已安装的助手（Claude Code / Codex / Cursor /
                                       Gemini CLI / CodeBuddy / WorkBuddy），助手即可在对话中查询血缘；
                                       默认用户级（~/.<助手>/skills），--project 仅本项目（链接，不入 git）
  uninstall-skill [--project]          从上述助手中移除该 skill（--project 移除项目级）

资源
  search <关键字> [--type T] [--limit 30]   按名称搜索；T = DATASET|ETL|CARD|PAGE|SOURCE|FIELD
  show <资源>                         资源详情（类型、路径、字段数、所在页面等）
  lineage <资源> [--dir up|down|both] [--depth 3] [--types DATASET,ETL,PAGE]
                                       资源血缘，按方向与层级列出
  impact <资源> [--depth 10]           下游影响分析（受影响的 ETL / 数据集 / 卡片 / 页面汇总）
  path <起点> <终点>                   沿数据流向的最短路径
  orphans [--type DATASET] [--limit 100]    无任何上下游的资源
  sql <ETL>                            ETL 中的 SQL 算子全文

字段
  fields <数据集> [--keyword k]        数据集字段（名称、类型、计算表达式）
  field <数据集> <字段> [--dir both] [--depth 3]   字段血缘：上游来源与下游去向（含卡片）
  explain <数据集或卡片> <字段>       字段计算说明：输入字段、经由 ETL/页面、计算步骤、SQL

其它
  gql '<GraphQL>' [--vars '<json>']    执行任意 GraphQL 查询

<资源> 可以是 ID，也可以是唯一的名称（精确匹配）。`;

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const opts = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) opts[k] = true;
    else opts[k] = v, i++;
  } else pos.push(a);
}
const cmd = pos.shift();
const asJson = !!opts.json;

const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};
const out = (data, text) => console.log(asJson ? JSON.stringify(data, null, 2) : text());

if (!cmd || cmd === 'help' || opts.help || opts.h) {
  console.log(HELP);
  process.exit(0);
}

// ---------- 不需要数据库的命令 ----------
// Python 解释器：GUAN_LINEAGE_PYTHON 优先；Windows 通常只有 py / python，macOS 与 Linux 为 python3
function findPython() {
  const env = process.env.GUAN_LINEAGE_PYTHON;
  const cands = env ? [[env]] : process.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']];
  for (const [cmd, ...pre] of cands) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; sys.exit(sys.version_info < (3, 8))'], { stdio: 'ignore' });
    if (r.status === 0) return [cmd, ...pre];
  }
  die(`找不到 Python 3（已尝试 ${cands.map((c) => c.join(' ')).join(' / ')}）；可用环境变量 GUAN_LINEAGE_PYTHON 指定解释器路径`);
}
const py = (script, extra) => {
  const [cmd, ...pre] = findPython();
  // PYTHONUTF8：Windows 中文系统默认 GBK，统一按 UTF-8 读写缓存与子进程输出
  const r = spawnSync(cmd, [...pre, path.join(ROOT, 'crawler', script), ...extra], { stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' } });
  process.exit(r.status ?? 1);
};
if (cmd === 'crawl') {
  const extra = [];
  if (opts.workers) extra.push('--workers', String(opts.workers));
  if (opts.limit) extra.push('--limit', String(opts.limit));
  if (opts.db) extra.push('--db', String(opts.db));
  py('crawl.py', extra);
}
if (cmd === 'rebuild-fields') py('field_lineage.py', opts.db ? ['--db', String(opts.db)] : []);
if (cmd === 'install-skill' || cmd === 'uninstall-skill') {
  const { installSkill, uninstallSkill, AGENTS } = await import('../src/skill.mjs');
  let rs;
  try {
    const o = { agents: opts.agents, dir: opts.dir, project: !!opts.project };
    rs = cmd === 'install-skill' ? installSkill(o) : uninstallSkill(o);
  } catch (e) {
    die(e.message);
  }
  const label = { installed: '已安装', linked: '已链接', skipped: '已链接到本仓库，跳过', removed: '已移除', failed: '失败' };
  if (asJson) console.log(JSON.stringify(rs, null, 2));
  else if (!rs.length)
    console.log(cmd === 'install-skill'
      ? `未检测到支持的 AI 助手（${AGENTS.map((a) => a.name).join(' / ')}）。可用 --agents 指定，或 --dir 指定 skills 目录`
      : '没有已安装的 guan-lineage skill');
  else for (const r of rs) console.log(`${label[r.status]}  ${r.name}  ${r.dest}${r.error ? `  (${r.error})` : ''}`);
  if (cmd === 'install-skill' && rs.some((r) => r.status !== 'failed') && !asJson) console.log('重启 AI 助手或新开对话后生效。');
  process.exit(rs.some((r) => r.status === 'failed') ? 1 : 0);
}
if (cmd === 'serve') {
  const { serve } = await import('../src/server.mjs');
  serve({ port: Number(opts.port || process.env.PORT || 4000), host: String(opts.host || '127.0.0.1'), dbPath: opts.db });
  await new Promise(() => {});
}

// ---------- 查询命令 ----------
let graph;
try {
  graph = createGraph(opts.db ? { dbPath: String(opts.db) } : {});
} catch (e) {
  die(`无法打开数据库：${e.message}\n先运行 guanlineage crawl（数据目录 ${DATA_DIR}）`);
}
const gql = async (q, v) => {
  const r = await graph.query(q, v);
  if (r.errors) die('GraphQL 错误：' + r.errors.map((e) => e.message).join('; '));
  return r.data;
};

const TYPE_CN = { DATASET: '数据集', ETL: 'ETL', CARD: '卡片', PAGE: '页面', SOURCE: '源表', OTHER: '其他', FIELD: '字段' };
const KIND_CN = { direct: '透传', derived: '计算', view: '视图', calc: '计算字段', card: '卡片使用' };
const REL_CN = { INPUT_OF: '输入', OUTPUTS: '产出', FEEDS: '视图', USED_BY: '被卡片使用', ON_PAGE: '所在页面', USED_BY_PAGE: '被页面使用', SOURCE_OF: '源表' };

/** 资源参数：ID 或唯一名称 */
async function resolve(ref, type) {
  if (!ref) die('缺少资源参数');
  const { node } = await gql('query($id: ID!) { node(id: $id) { id type name } }', { id: ref });
  if (node) return node;
  const { nodes } = await gql('query($k: String, $t: NodeType) { nodes(keyword: $k, type: $t, limit: 50) { id type name path } }', { k: ref, t: type || null });
  const exact = nodes.filter((n) => n.name === ref);
  if (exact.length === 1) return exact[0];
  const cands = exact.length ? exact : nodes;
  if (!cands.length) die(`找不到资源：${ref}`);
  die(`「${ref}」对应多个资源，请改用 ID：\n` + cands.slice(0, 20).map((n) => `  ${n.id}  ${TYPE_CN[n.type] || n.type}  ${n.name}  ${n.path || ''}`).join('\n'));
}

// 按跳数分层：从 root 沿边方向 BFS
function hops(rootId, edges, forward) {
  const d = new Map([[rootId, 0]]);
  let frontier = [rootId];
  while (frontier.length) {
    const next = [];
    for (const cur of frontier)
      for (const e of edges) {
        const [a, b] = forward ? [e.src, e.dst] : [e.dst, e.src];
        if (a === cur && !d.has(b)) d.set(b, d.get(cur) + 1), next.push(b);
      }
    frontier = next;
  }
  return d;
}
const line = (n) => `${(TYPE_CN[n.type] || n.type).padEnd(4)}  ${n.name || ''}  [${n.id}]`;

const AGG = /^(SUM|AVG|MAX|MIN|CNT|CNT_DISTINCT|COUNT|MEDIAN|STDDEV|VAR|NUL)$/;
function splitZone(t) {
  const parts = (t || '').split(' · ');
  const zone = [parts.shift()];
  if (parts.length && AGG.test(parts[0])) zone.push(parts.shift());
  return { zone: zone.filter(Boolean).join(' · '), expr: parts.join(' · ') };
}
const steps = (t) => (t || '').split(' → ').map((x) => x.replace(/^CALC: /, '').trim()).filter(Boolean);

const commands = {
  async stats() {
    const { stats } = await gql('{ stats { crawledAt errors nodes { key count } edges { key count } fieldEdges { key count } } }');
    out(stats, () => [
      `抓取时间  ${stats.crawledAt}    抓取错误 ${stats.errors}`,
      `节点      ${stats.nodes.map((n) => `${TYPE_CN[n.key] || n.key} ${n.count}`).join(' · ')}`,
      `资源边    ${stats.edges.map((n) => `${n.key} ${n.count}`).join(' · ')}`,
      `字段血缘  ${stats.fieldEdges.map((n) => `${KIND_CN[n.key] || n.key} ${n.count}`).join(' · ')}`,
    ].join('\n'));
  },

  async search() {
    const kw = pos[0] || die('用法: guanlineage search <关键字> [--type T]');
    const type = opts.type ? String(opts.type).toUpperCase() : null;
    const limit = Number(opts.limit || 30);
    if (type === 'FIELD') {
      const { fields } = await gql('query($k: String!, $n: Int) { fields(name: $k, limit: $n) { name fdType metaType expr dataset { id name } } }', { k: kw, n: limit });
      return out(fields, () => fields.map((f) => `${f.name}  ${f.fdType || ''}  ←  ${f.dataset?.name}  [${f.dataset?.id}]${f.expr ? `\n    = ${f.expr}` : ''}`).join('\n') || '无匹配');
    }
    const { nodes } = await gql('query($k: String, $t: NodeType, $n: Int) { nodes(keyword: $k, type: $t, limit: $n) { id type subtype name path } }', { k: kw, t: type, n: limit });
    out(nodes, () => nodes.map((n) => `${line(n)}${n.path ? `\n    ${n.path}` : ''}`).join('\n') || '无匹配');
  },

  async show() {
    const r = await resolve(pos[0]);
    const { node: n } = await gql(`query($id: ID!) { node(id: $id) { id type subtype name path props crawledAt
      fields { name } usedFields { dst { name } src { dataset { name } } }
      pages: downstream(types: [PAGE]) { id name } up: upstream { id type name } down: downstream { id type name } } }`, { id: r.id });
    let props = {};
    try { props = JSON.parse(n.props || '{}'); } catch {}
    out({ ...n, props }, () => {
      const L = [`${TYPE_CN[n.type] || n.type}  ${n.name}`, `ID        ${n.id}`, `类型      ${n.subtype || '-'}`];
      if (n.path) L.push(`路径      ${n.path}`);
      if (props.rowCount != null) L.push(`行数      ${props.rowCount}    列数 ${props.colCount ?? '-'}`);
      if (props.utime) L.push(`更新时间  ${props.utime}`);
      if (props.lastExecution?.status) L.push(`最近执行  ${props.lastExecution.status}  ${props.lastExecution.endTime || ''}`);
      if (props.cron) L.push(`调度      ${JSON.stringify(props.cron)}`);
      if (n.fields.length) L.push(`字段      ${n.fields.length} 个（guanlineage fields ${n.id}）`);
      if (n.usedFields.length) L.push(`使用字段  ${new Set(n.usedFields.map((e) => e.dst.name)).size} 个，来自 ${[...new Set(n.usedFields.map((e) => e.src.dataset?.name))].join('、')}`);
      if (n.type === 'CARD' && n.pages.length) L.push(`所在页面  ${n.pages.map((p) => p.name).join('、')}`);
      L.push(`直接上游  ${n.up.length}    直接下游 ${n.down.length}`);
      return L.join('\n');
    });
  },

  async lineage(dirOverride) {
    const r = await resolve(pos[0]);
    const dir = String(dirOverride || opts.dir || 'both').toUpperCase();
    const depth = Number(opts.depth || (dirOverride ? 10 : 3));
    const types = opts.types ? String(opts.types).toUpperCase().split(',') : null;
    const { lineage: g } = await gql(`query($id: ID!, $d: Direction, $n: Int, $t: [NodeType!]) {
      lineage(id: $id, direction: $d, depth: $n, types: $t) { nodes { id type subtype name path } edges { rel src { id } dst { id } } } }`,
      { id: r.id, d: dir, n: depth, t: types });
    const edges = g.edges.map((e) => ({ src: e.src.id, dst: e.dst.id, rel: e.rel }));
    const up = hops(r.id, edges, false), down = hops(r.id, edges, true);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const list = (m) => [...m].filter(([id]) => id !== r.id && byId.has(id)).sort((a, b) => a[1] - b[1]).map(([id, h]) => ({ hop: h, ...byId.get(id) }));
    const data = { root: r, upstream: dir === 'DOWN' ? [] : list(up), downstream: dir === 'UP' ? [] : list(down), edges };
    if (dirOverride) return data;
    out(data, () => {
      const sec = (title, arr) => arr.length ? [`${title}（${arr.length}）`, ...arr.map((n) => `  ${String(n.hop).padStart(2)} 层  ${line(n)}`)] : [];
      return [`${line(r)}`, ...sec('上游', data.upstream), ...sec('下游', data.downstream)].join('\n') || '无血缘';
    });
  },

  async impact() {
    const data = await commands.lineage('DOWN');
    const groups = {};
    for (const n of data.downstream) (groups[n.type] ??= []).push(n);
    out({ root: data.root, impacted: groups }, () => {
      const L = [`改动 ${line(data.root)} 的下游影响：`];
      for (const t of ['ETL', 'DATASET', 'CARD', 'PAGE', 'OTHER']) {
        if (!groups[t]) continue;
        L.push(`${TYPE_CN[t]}（${groups[t].length}）`);
        L.push(...groups[t].map((n) => `  ${String(n.hop).padStart(2)} 层  ${n.name}  [${n.id}]`));
      }
      if (L.length === 1) L.push('  无下游');
      return L.join('\n');
    });
  },

  async path() {
    const [a, b] = [await resolve(pos[0]), await resolve(pos[1])];
    const { path: p } = await gql('query($a: ID!, $b: ID!) { path(from: $a, to: $b, maxDepth: 20) { id type name } }', { a: a.id, b: b.id });
    out(p, () => (p ? p.map((n, i) => `${i ? '  → ' : '    '}${line(n)}`).join('\n') : '两者之间没有沿数据流向的路径'));
  },

  async orphans() {
    const type = String(opts.type || 'DATASET').toUpperCase();
    const { orphans } = await gql('query($t: NodeType, $n: Int) { orphans(type: $t, limit: $n) { id type name path } }', { t: type, n: Number(opts.limit || 100) });
    out(orphans, () => [`无上下游的${TYPE_CN[type] || type}：${orphans.length}`, ...orphans.map((n) => `  ${n.name}  [${n.id}]  ${n.path || ''}`)].join('\n'));
  },

  async sql() {
    const r = await resolve(pos[0], 'ETL');
    const { node } = await gql('query($id: ID!) { node(id: $id) { name sqlScripts { id name sql } } }', { id: r.id });
    out(node.sqlScripts, () => node.sqlScripts.length ? node.sqlScripts.map((x) => `-- ${node.name} · ${x.name} (${x.id})\n${x.sql}`).join('\n\n') : `${node.name} 中没有 SQL 算子`);
  },

  async fields() {
    const r = await resolve(pos[0], 'DATASET');
    const { node } = await gql('query($id: ID!, $k: String) { node(id: $id) { name fields(keyword: $k) { name physName fdType metaType calcType expr annotation } } }', { id: r.id, k: opts.keyword || null });
    out(node.fields, () => [`${node.name}  字段 ${node.fields.length}`, ...node.fields.map((f) =>
      `  ${f.name}  ${f.fdType || ''} · ${f.metaType === 'METRIC' ? '度量' : '维度'}${f.calcType && f.calcType !== 'normal' ? ' · 计算' : ''}${f.physName && f.physName !== f.name ? `  (物理名 ${f.physName})` : ''}${f.annotation ? `  # ${f.annotation}` : ''}${f.expr ? `\n      = ${f.expr}` : ''}`)].join('\n'));
  },

  async field() {
    const r = await resolve(pos[0]);
    const name = pos[1] || die('用法: guanlineage field <数据集> <字段>');
    const dir = String(opts.dir || 'both').toUpperCase();
    const { fieldLineage: g } = await gql(`query($ds: ID!, $f: String!, $d: Direction, $n: Int) {
      fieldLineage(dsId: $ds, name: $f, direction: $d, depth: $n) {
        contextIds edges { kind transform via { name } src { name dataset { id type name } } dst { name dataset { id type name } } } } }`,
      { ds: r.id, f: name, d: dir, n: Number(opts.depth || 3) });
    const key = (x) => `${x.dataset?.id}::${x.name}`;
    const rootKey = `${r.id}::${name}`;
    const edges = g.edges.filter((e) => e.src.dataset && e.dst.dataset).map((e) => ({ ...e, s: key(e.src), t: key(e.dst) }));
    const ctx = new Set(g.contextIds);
    const lv = (fwd) => hops(rootKey, edges.map((e) => ({ src: e.s, dst: e.t })), fwd);
    const up = lv(false), down = lv(true);
    const fmt = (e, side) => {
      const o = e[side];
      const z = e.kind === 'card' ? splitZone(e.transform) : null;
      const tail = z ? `${z.zone}${z.expr ? ' · ' + z.expr : ''}` : steps(e.transform).join(' → ');
      return `${o.name}  @${TYPE_CN[o.dataset.type] || ''} ${o.dataset.name}  [${KIND_CN[e.kind] || e.kind}]${e.via ? ` 经 ${e.via.name}` : ''}${tail ? `\n        ${tail}` : ''}`;
    };
    const ups = edges.filter((e) => up.has(e.t) && up.has(e.s) && !ctx.has(e.s)).sort((a, b) => up.get(a.s) - up.get(b.s));
    const downs = edges.filter((e) => down.has(e.s) && down.has(e.t)).sort((a, b) => down.get(a.t) - down.get(b.t));
    out({ root: { dataset: r, field: name }, upstream: ups, downstream: downs, context: [...ctx] }, () => [
      `${name}  @${r.name}`,
      ups.length ? `上游（${ups.length}）` : '上游：无（源头字段）',
      ...ups.map((e) => `  ${String(up.get(e.s)).padStart(2)} 层  ${fmt(e, 'src')}  →  ${e.dst.name}`),
      downs.length ? `下游（${downs.length}）` : '下游：无',
      ...downs.map((e) => `  ${String(down.get(e.t)).padStart(2)} 层  ${e.src.name}  →  ${fmt(e, 'dst')}`),
    ].join('\n'));
  },

  async explain() {
    const r = await resolve(pos[0]);
    const name = pos[1] || die('用法: guanlineage explain <数据集或卡片> <字段>');
    const { field: f } = await gql(`query($ds: ID!, $f: String!) { field(dsId: $ds, name: $f) {
      name physName fdType metaType calcType expr annotation dataset { id type name }
      upstream { kind transform via { id name } src { name dataset { id name } } } } }`, { ds: r.id, f: name });
    // 同一处计算合并：经由 + 类型 + 区域 + 步骤
    const groups = new Map();
    for (const e of f.upstream.filter((x) => x.src.dataset)) {
      const z = e.kind === 'card' ? splitZone(e.transform) : { zone: '', expr: e.transform || '' };
      const k = [e.via?.id, e.kind, z.zone, z.expr].join('\u0000');
      if (!groups.has(k)) groups.set(k, { kind: e.kind, via: e.via, zone: z.zone, steps: steps(z.expr), inputs: [] });
      groups.get(k).inputs.push({ field: e.src.name, dataset: e.src.dataset.name, datasetId: e.src.dataset.id });
    }
    // 涉及的 SQL 算子全文
    const sqlIds = new Map();
    for (const g of groups.values()) for (const s of g.steps) {
      const m = s.match(/^SQL\[(.*?)\]/);
      if (m && g.via) (sqlIds.get(g.via.id) || sqlIds.set(g.via.id, new Set()).get(g.via.id)).add(m[1].split('|').pop());
    }
    const sqls = [];
    for (const [etl, ids] of sqlIds) {
      const { node } = await gql('query($id: ID!) { node(id: $id) { name sqlScripts { id name sql } } }', { id: etl });
      for (const x of node?.sqlScripts || []) if (ids.has(x.id)) sqls.push({ etl: node.name, ...x });
    }
    const data = { field: { ...f, upstream: undefined }, calculations: [...groups.values()], sql: sqls };
    out(data, () => {
      const L = [`${f.name}  @${TYPE_CN[f.dataset?.type] || ''} ${f.dataset?.name}`];
      if (f.fdType) L.push(`类型    ${f.fdType} · ${f.metaType === 'METRIC' ? '度量' : '维度'}${f.calcType && f.calcType !== 'normal' ? ' · 计算字段' : ''}`);
      if (f.physName && f.physName !== f.name) L.push(`物理名  ${f.physName}`);
      if (f.annotation) L.push(`注释    ${f.annotation}`);
      if (f.expr) L.push(`表达式  ${f.expr}`);
      if (!groups.size) L.push('计算说明：源头字段，无上游');
      [...groups.values()].forEach((g, i) => {
        L.push(`${groups.size > 1 ? `计算 ${i + 1}` : '计算说明'}：${KIND_CN[g.kind] || g.kind}${g.zone ? ' · ' + g.zone : ''}${g.via ? `  经 ${g.kind === 'card' ? '页面' : 'ETL'} ${g.via.name}` : ''}`);
        L.push(`  输入  ${g.inputs.map((x) => `${x.field} @${x.dataset}`).join('、')}`);
        g.steps.forEach((s, j) => L.push(`  ${g.steps.length > 1 ? `${j + 1}. ` : ''}${s.replace(/^SQL\[(.*?)\|.*?\]/, 'SQL[$1]')}`));
      });
      for (const x of sqls) L.push(`\n-- 完整 SQL：${x.etl} · ${x.name}\n${x.sql}`);
      return L.join('\n');
    });
  },

  async gql() {
    const q = pos[0] || die("用法: guanlineage gql '<GraphQL>' [--vars '<json>']");
    const r = await graph.query(q, opts.vars ? JSON.parse(String(opts.vars)) : undefined);
    console.log(JSON.stringify(r, null, 2));
  },
};

if (!commands[cmd]) die(`未知命令：${cmd}\n\n${HELP}`);
await commands[cmd]();
graph.close();
