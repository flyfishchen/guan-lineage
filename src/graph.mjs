// 血缘图核心：GraphQL schema + 查询实现（SQLite 只读）。HTTP 服务与 CLI 共用。
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildSchema, graphql } from 'graphql';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.GUAN_LINEAGE_DATA || path.join(ROOT, 'data');

export function createGraph({ dbPath = path.join(DATA_DIR, 'lineage.db'), cacheDir = path.join(DATA_DIR, 'cache') } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });

  const schema = buildSchema(`
    enum NodeType { DATASET ETL CARD PAGE SOURCE OTHER }
    enum Direction { UP DOWN BOTH }

    "图中的一个 BI 资源"
    type Node {
      id: ID!
      type: NodeType!
      "原始类型：DATA_SET_ETL / DATA_SET_DB_EXTRACT / DATA_PROCESS_ETL / CHART / SELECTOR ..."
      subtype: String
      name: String
      path: String
      "原始属性 JSON 字符串（行数、调度、最近执行等）"
      props: String
      crawledAt: String
      "直接上游（数据从哪里来）"
      upstream(types: [NodeType!]): [Node!]!
      "直接下游（数据流向哪里）"
      downstream(types: [NodeType!]): [Node!]!
      inEdges: [Edge!]!
      outEdges: [Edge!]!
      "多跳血缘子图"
      lineage(direction: Direction = BOTH, depth: Int = 3): Subgraph!
      "数据集字段（含计算字段）；keyword 按字段名过滤"
      fields(keyword: String): [Field!]!
      "卡片使用的字段（仅 CARD）：src 为数据集字段，dst.name 为卡片内显示名，transform 为所在区域"
      usedFields: [FieldEdge!]!
      "ETL 中的 SQL 算子（仅 ETL，读取 cache/etl 缓存）"
      sqlScripts: [SqlScript!]!
    }

    "数据集字段"
    type Field {
      id: ID!
      seq: Int
      name: String
      "STRING / INT / DOUBLE / DATE ..."
      fdType: String
      "DIM 维度 / METRIC 度量"
      metaType: String
      "normal 为原始字段，其余为计算字段"
      calcType: String
      "计算字段表达式"
      expr: String
      annotation: String
      hidden: Boolean
      "物理字段名（name 为展示名/别名）"
      physName: String
      dataset: Node
      "直接上游字段（来自哪些字段）"
      upstream: [FieldEdge!]!
      "直接下游字段（流向哪些字段）"
      downstream: [FieldEdge!]!
      "多跳字段血缘"
      lineage(direction: Direction = BOTH, depth: Int = 5): FieldGraph!
    }

    type SqlScript { id: String, name: String, sql: String }

    "字段级血缘边：src -> dst，经由某个 ETL（视图/计算字段时 via 为空）"
    type FieldEdge {
      src: Field!
      dst: Field!
      via: Node
      "direct 透传/改名 | derived 计算/聚合/SQL | view 视图同名 | calc 数据集计算字段 | card 卡片使用（dst 为卡片，via 为页面）"
      kind: String
      "变换说明，如 SUM(金额) / CALC: [a]-[b] / SQL"
      transform: String
    }

    type FieldGraph {
      root: Field
      fields: [Field!]!
      edges: [FieldEdge!]!
      "为补全多输入计算字段而加入的「参与计算」字段 id（只补一跳，不继续展开）"
      contextIds: [ID!]!
    }

    "边方向为数据流向：SOURCE -SOURCE_OF-> DATASET -INPUT_OF-> ETL -OUTPUTS-> DATASET -USED_BY-> CARD -ON_PAGE-> PAGE"
    type Edge {
      rel: String!
      src: Node!
      dst: Node!
    }

    type Subgraph {
      root: Node
      nodes: [Node!]!
      edges: [Edge!]!
    }

    type Count { key: String!, count: Int! }
    type Stats {
      crawledAt: String
      nodes: [Count!]!
      edges: [Count!]!
      "字段级血缘边，按 kind 统计"
      fieldEdges: [Count!]!
      errors: Int!
    }

    type CrawlError { id: String, step: String, error: String }

    type Query {
      node(id: ID!): Node
      "按类型 / 名称关键字 / 路径关键字检索"
      nodes(type: NodeType, keyword: String, pathKeyword: String, limit: Int = 50, offset: Int = 0): [Node!]!
      "多跳血缘；direction=UP 追溯来源，DOWN 影响分析"
      lineage(id: ID!, direction: Direction = BOTH, depth: Int = 3, types: [NodeType!]): Subgraph!
      "两个节点间沿数据流向的最短路径"
      path(from: ID!, to: ID!, maxDepth: Int = 10): [Node!]
      "无上下游的孤立节点（如未被使用的数据集）"
      orphans(type: NodeType = DATASET, limit: Int = 100): [Node!]!
      "按字段名反查数据集；exact=false 时模糊匹配"
      fields(name: String!, exact: Boolean = false, limit: Int = 200): [Field!]!
      "单个字段（dsId + 字段展示名）"
      field(dsId: ID!, name: String!): Field
      "字段级血缘：direction=UP 追溯字段来源，DOWN 看字段影响"
      fieldLineage(dsId: ID!, name: String!, direction: Direction = BOTH, depth: Int = 5): FieldGraph!
      stats: Stats!
      crawlErrors(limit: Int = 50): [CrawlError!]!
    }
  `);

  const q = (sql) => db.prepare(sql);
  const stmt = {
    node: q('SELECT * FROM nodes WHERE id = ?'),
    up: q('SELECT n.* FROM edges e JOIN nodes n ON n.id = e.src WHERE e.dst = ?'),
    down: q('SELECT n.* FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.src = ?'),
    inE: q('SELECT * FROM edges WHERE dst = ?'),
    outE: q('SELECT * FROM edges WHERE src = ?'),
  };

  const cache = new Map();
  const getNode = (id) => {
    if (!cache.has(id)) {
      const r = stmt.node.get(id);
      cache.set(id, r ? wrap(r) : null);
    }
    return cache.get(id);
  };
  // fields 表由新版 crawl.py 生成；旧库没有该表时返回空
  const hasFields = !!q("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fields'").get();
  const hasFieldEdges = !!q("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'field_edges'").get();
  // 字段以 (数据集, 展示名) 标识，与 field_edges 一致
  const fieldObj = (f) => ({
    id: `${f.ds_id}::${f.name}`, seq: f.seq, name: f.name, physName: f.phys_name, fdType: f.fd_type, metaType: f.meta_type,
    calcType: f.calc_type, expr: f.expr, annotation: f.annotation, hidden: !!f.hidden, dataset: () => getNode(f.ds_id),
    upstream: () => fieldEdges('dst', f.ds_id, f.name),
    downstream: () => fieldEdges('src', f.ds_id, f.name),
    lineage: ({ direction, depth }) => fieldLineage({ dsId: f.ds_id, name: f.name, direction, depth }),
  });
  const getField = (ds, name) =>
    (hasFields && q('SELECT * FROM fields WHERE ds_id = ? AND name = ?').get(ds, name)) || { ds_id: ds, name };
  const fieldEdgeObj = (e) => ({
    src: () => fieldObj(getField(e.src_ds, e.src_field)),
    dst: () => fieldObj(getField(e.dst_ds, e.dst_field)),
    via: () => (e.via ? getNode(e.via) : null),
    kind: e.kind,
    transform: e.transform,
  });
  function fieldEdges(side, ds, name) {
    if (!hasFieldEdges) return [];
    return q(`SELECT * FROM field_edges WHERE ${side}_ds = ? AND ${side}_field = ?`).all(ds, name).map(fieldEdgeObj);
  }
  function fieldLineage({ dsId, name, direction = 'BOTH', depth = 5 }) {
    depth = Math.min(Math.max(depth, 0), 30);
    const key = (d, n) => `${d}\u0000${n}`;
    const seen = new Map([[key(dsId, name), [dsId, name]]]);
    const edges = new Map();
    const walk = (side, other) => {
      let frontier = [[dsId, name]];
      for (let i = 0; i < depth && frontier.length && hasFieldEdges; i++) {
        const next = [];
        for (const [d, n] of frontier) {
          for (const e of q(`SELECT * FROM field_edges WHERE ${side}_ds = ? AND ${side}_field = ?`).all(d, n)) {
            edges.set(`${e.src_ds}|${e.src_field}|${e.dst_ds}|${e.dst_field}|${e.via}`, e);
            const o = [e[`${other}_ds`], e[`${other}_field`]];
            if (!seen.has(key(...o))) seen.set(key(...o), o), next.push(o);
          }
        }
        frontier = next;
      }
    };
    if (direction !== 'DOWN') walk('dst', 'src');
    if (direction !== 'UP') walk('src', 'dst');
    // 多输入计算字段：补齐其余输入，否则只看到一条来源会误以为单字段推导
    const context = [];
    if (hasFieldEdges) {
      for (const [d, n] of [...seen.values()]) {
        const ins = q(`SELECT * FROM field_edges WHERE dst_ds = ? AND dst_field = ? AND kind IN ('derived', 'calc', 'card')`).all(d, n);
        if (ins.length < 2) continue;
        for (const e of ins.slice(0, 20)) {
          edges.set(`${e.src_ds}|${e.src_field}|${e.dst_ds}|${e.dst_field}|${e.via}`, e);
          const k = key(e.src_ds, e.src_field);
          if (!seen.has(k)) seen.set(k, [e.src_ds, e.src_field]), context.push(`${e.src_ds}::${e.src_field}`);
        }
      }
      // 上下文字段与图中已有字段之间的边也补上（只连已在图中的字段，不再扩展新节点）
      for (const id of context) {
        const [d, n] = id.split('::');
        for (const e of q('SELECT * FROM field_edges WHERE (dst_ds = ? AND dst_field = ?) OR (src_ds = ? AND src_field = ?)').all(d, n, d, n)) {
          if (seen.has(key(e.src_ds, e.src_field)) && seen.has(key(e.dst_ds, e.dst_field)))
            edges.set(`${e.src_ds}|${e.src_field}|${e.dst_ds}|${e.dst_field}|${e.via}`, e);
        }
      }
    }
    return {
      root: fieldObj(getField(dsId, name)),
      fields: [...seen.values()].map(([d, n]) => fieldObj(getField(d, n))),
      edges: [...edges.values()].map(fieldEdgeObj),
      contextIds: context,
    };
  }
  const dsFields = (id, keyword) =>
    hasFields
      ? q('SELECT * FROM fields WHERE ds_id = ? AND (? IS NULL OR name LIKE ?) ORDER BY seq').all(id, keyword ?? null, `%${keyword ?? ''}%`).map(fieldObj)
      : [];
  const filt = (rows, types) => (types?.length ? rows.filter((r) => types.includes(r.type)) : rows);
  const edgeObj = (e) => ({ rel: e.rel, src: () => getNode(e.src), dst: () => getNode(e.dst) });

  function wrap(r) {
    return {
      ...r,
      crawledAt: r.crawled_at,
      upstream: ({ types }) => filt(stmt.up.all(r.id), types).map(wrap),
      downstream: ({ types }) => filt(stmt.down.all(r.id), types).map(wrap),
      inEdges: () => stmt.inE.all(r.id).map(edgeObj),
      outEdges: () => stmt.outE.all(r.id).map(edgeObj),
      lineage: ({ direction, depth }) => lineage({ id: r.id, direction, depth }),
      fields: ({ keyword }) => dsFields(r.id, keyword),
      sqlScripts: () => {
        if (r.type !== 'ETL') return [];
        try {
          const etl = JSON.parse(readFileSync(path.join(cacheDir, 'etl', `${r.id}.json`), 'utf8')).data || {};
          return (etl.actions || []).filter((a) => a.type === 'SQL_SCRIPT').map((a) => ({ id: a.id, name: a.name, sql: a.sql }));
        } catch {
          return [];
        }
      },
      usedFields: () =>
        r.type === 'CARD' && hasFieldEdges
          ? q("SELECT * FROM field_edges WHERE dst_ds = ? AND kind = 'card' ORDER BY src_ds, rowid").all(r.id).map(fieldEdgeObj)
          : [],
    };
  }

  // BFS 展开；types 只过滤返回结果，不阻断遍历（例如查 DATASET 的最终下游 PAGE 需穿过 CARD）
  function lineage({ id, direction = 'BOTH', depth = 3, types }) {
    depth = Math.min(Math.max(depth, 0), 50);
    const seen = new Set([id]);
    const edges = new Map();
    const walk = (dirStmt, pick) => {
      let frontier = [id];
      for (let d = 0; d < depth && frontier.length; d++) {
        const next = [];
        for (const cur of frontier) {
          for (const e of dirStmt.all(cur)) {
            edges.set(`${e.src}|${e.dst}|${e.rel}`, e);
            const o = pick(e);
            if (!seen.has(o)) {
              seen.add(o);
              next.push(o);
            }
          }
        }
        frontier = next;
      }
    };
    if (direction !== 'DOWN') walk(stmt.inE, (e) => e.src);
    if (direction !== 'UP') walk(stmt.outE, (e) => e.dst);
    let nodes = [...seen].map(getNode).filter(Boolean);
    let es = [...edges.values()];
    if (types?.length) {
      const keep = new Set(nodes.filter((n) => n.id === id || types.includes(n.type)).map((n) => n.id));
      nodes = nodes.filter((n) => keep.has(n.id));
      es = es.filter((e) => keep.has(e.src) && keep.has(e.dst));
    }
    return { root: getNode(id), nodes, edges: es.map(edgeObj) };
  }

  const root = {
    node: ({ id }) => getNode(id),
    nodes: ({ type, keyword, pathKeyword, limit, offset }) => {
      const where = [];
      const params = [];
      if (type) where.push('type = ?'), params.push(type);
      if (keyword) where.push('name LIKE ?'), params.push(`%${keyword}%`);
      if (pathKeyword) where.push('path LIKE ?'), params.push(`%${pathKeyword}%`);
      const sql = `SELECT * FROM nodes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY type, name LIMIT ? OFFSET ?`;
      return db.prepare(sql).all(...params, Math.min(limit, 1000), offset).map(wrap);
    },
    lineage,
    path: ({ from, to, maxDepth }) => {
      const prev = new Map([[from, null]]);
      let frontier = [from];
      for (let d = 0; d < maxDepth && frontier.length && !prev.has(to); d++) {
        const next = [];
        for (const cur of frontier)
          for (const e of stmt.outE.all(cur))
            if (!prev.has(e.dst)) prev.set(e.dst, cur), next.push(e.dst);
        frontier = next;
      }
      if (!prev.has(to)) return null;
      const out = [];
      for (let c = to; c; c = prev.get(c)) out.unshift(getNode(c));
      return out;
    },
    orphans: ({ type, limit }) =>
      q(`SELECT * FROM nodes n WHERE type = ?
           AND NOT EXISTS (SELECT 1 FROM edges WHERE src = n.id)
           AND NOT EXISTS (SELECT 1 FROM edges WHERE dst = n.id)
         ORDER BY name LIMIT ?`).all(type, limit).map(wrap),
    fields: ({ name, exact, limit }) =>
      hasFields
        ? q(`SELECT * FROM fields WHERE name ${exact ? '= ?' : 'LIKE ?'} ORDER BY name, ds_id LIMIT ?`)
            .all(exact ? name : `%${name}%`, Math.min(limit, 2000)).map(fieldObj)
        : [],
    field: ({ dsId, name }) => fieldObj(getField(dsId, name)),
    fieldLineage,
    stats: () => ({
      crawledAt: q("SELECT v FROM meta WHERE k = 'crawled_at'").get()?.v,
      nodes: [
        ...q('SELECT type key, count(*) count FROM nodes GROUP BY type').all(),
        ...(hasFields ? [{ key: 'FIELD', count: q('SELECT count(*) c FROM fields').get().c }] : []),
      ],
      fieldEdges: hasFieldEdges ? q('SELECT kind key, count(*) count FROM field_edges GROUP BY kind').all() : [],
      edges: q('SELECT rel key, count(*) count FROM edges GROUP BY rel').all(),
      errors: q('SELECT count(*) c FROM crawl_errors').get().c,
    }),
    crawlErrors: ({ limit }) => q('SELECT id, step, error FROM crawl_errors LIMIT ?').all(limit),
  };

  return {
    dbPath,
    schema,
    root,
    /** 执行一次 GraphQL 查询；每次查询清空节点缓存 */
    async query(source, variableValues) {
      cache.clear();
      return graphql({ schema, source, rootValue: root, variableValues });
    },
    close: () => db.close(),
  };
}
