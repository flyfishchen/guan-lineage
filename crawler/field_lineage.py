#!/usr/bin/env python3
"""从 ETL 定义推导字段级血缘，写入 lineage.db 的 field_edges 表。

输入：data/cache/etl/<etlId>.json（crawl.py 抓取时缓存的 `guancli etl get --raw` 原文）+ lineage.db 的 fields 表。
对每个 ETL，沿算子 DAG 推导每一列来自哪些「输入数据集.字段」，在 OUTPUT_DATASET 处落成边：
  (src_ds, src_field) -> (dst_ds, dst_field)，kind = direct（透传/改名）| derived（计算/聚合/SQL 等）

视图数据集（FEEDS 边）没有算子定义，按同名字段对应，kind = view。

用法: guanlineage rebuild-fields   （或 python3 crawler/field_lineage.py [--db data/lineage.db] [--cache data/cache/etl]）
"""
import argparse
import json
import os
import re
import sqlite3
from pathlib import Path

HERE = Path(__file__).resolve().parent
# 数据目录：环境变量 GUAN_LINEAGE_DATA，默认 <项目>/data
DATA = Path(os.environ.get("GUAN_LINEAGE_DATA") or HERE.parent / "data")

SCHEMA = """
DROP TABLE IF EXISTS field_edges;
CREATE TABLE field_edges (
  src_ds    TEXT NOT NULL,
  src_field TEXT NOT NULL,
  dst_ds    TEXT NOT NULL,
  dst_field TEXT NOT NULL,
  via       TEXT,                    -- ETL id；视图为 NULL
  kind      TEXT,                    -- direct | derived | view | calc（数据集自带计算字段）| card（字段 -> 卡片，dst_ds 为卡片 id，via 为页面 id）
  transform TEXT,                    -- 经过的计算，如 "SUM(现有库存)" / "CALC: [a]-[b]" / "SQL"
  PRIMARY KEY (src_ds, src_field, dst_ds, dst_field, via)
);
CREATE INDEX idx_fe_dst ON field_edges(dst_ds, dst_field);
CREATE INDEX idx_fe_src ON field_edges(src_ds, src_field);
"""

BRACKET = re.compile(r"\[([^\[\]]+)\]")
WORDCH = r"0-9A-Za-z_一-鿿"


class Col:
    """某算子输出中的一列：来源字段集合 + 是否经过变换 + 变换说明。"""

    __slots__ = ("refs", "derived", "notes")

    def __init__(self, refs, derived=False, notes=()):
        self.refs = frozenset(refs)
        self.derived = derived
        # 连续相同的变换（如多层 SUM）只保留一次
        notes = [n for i, n in enumerate(notes) if i == 0 or n != list(notes)[i - 1]]
        self.notes = tuple(notes)[-6:]

    def via(self, note):
        return Col(self.refs, True, self.notes + (note,))

    def note(self, note):
        """附加说明但不改变「透传/计算」判定（筛选、改名、空值替换）。"""
        return Col(self.refs, self.derived, self.notes + (note,))


def merge(cols, note=None):
    refs, notes = set(), []
    for c in cols:
        refs |= c.refs
        notes.extend(c.notes)
    if note:
        notes.append(note)
    return Col(refs, True, dict.fromkeys(notes))


def short(s, n=2000):
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "…"


OPS = {"EQ": "=", "NE": "≠", "GT": ">", "GE": "≥", "LT": "<", "LE": "≤", "IN": "in", "NI": "not in",
       "CONTAINS": "包含", "NOT_CONTAINS": "不包含", "IS_NULL": "为空", "NOT_NULL": "不为空", "BT": "介于"}


def filter_note(a):
    parts = []
    for c in a.get("conditions") or []:
        vals = ["空" if v.get("v") in (None, "") else str(v.get("v")) for v in c.get("filterValue") or [] if isinstance(v, dict)]
        op = OPS.get(c.get("filterType"), c.get("filterType") or "")
        parts.append(f"{c.get('name')} {op} {','.join(vals)}".strip())
    joiner = " 或 " if a.get("combineType") == "OR" else " 且 "
    return "筛选: " + (joiner.join(parts) if parts else (a.get("name") or "条件"))


def formula_col(expr, scope, note):
    used = [scope[n] for n in dict.fromkeys(BRACKET.findall(expr or "")) if n in scope]
    return merge(used, note)


# ---------------- SQL 启发式 ----------------

def _select_lists(sql):
    """返回 SQL 中所有 SELECT ... FROM 之间的列表项 [(alias, expr)]。"""
    s = sql
    low = s.lower()
    items = []
    for m in re.finditer(r"\bselect\b", low):
        i, depth, start = m.end(), 0, m.end()
        parts, cur = [], start
        while i < len(s):
            ch = s[i]
            if ch in "'\"":
                j = s.find(ch, i + 1)
                i = len(s) if j < 0 else j + 1
                continue
            if ch == "(":
                depth += 1
            elif ch == ")":
                if depth == 0:
                    break
                depth -= 1
            elif depth == 0:
                if ch == ",":
                    parts.append(s[cur:i])
                    cur = i + 1
                elif re.match(r"\bfrom\b", low[i:i + 5]) and not re.match(f"[{WORDCH}]", low[i - 1:i] or " "):
                    break
            i += 1
        parts.append(s[cur:i])
        for p in parts:
            p = p.strip()
            if not p:
                continue
            p = re.sub(r"^\s*distinct\s+", "", p, flags=re.I)
            m_as = re.search(r"\bas\s+[`\"]?([^\s`\",()]+)[`\"]?\s*$", p, flags=re.I)
            if m_as:  # expr AS alias
                items.append((m_as.group(1), p[: m_as.start()].strip()))
                continue
            # 无 AS：t.`col` / col / expr alias；取末尾标识符为输出名，整项为表达式
            m_tail = re.search(r"[`\"]?([^\s`\",().]+)[`\"]?\s*$", p)
            items.append((m_tail.group(1) if m_tail else None, p))
    return items


def sql_columns(action, inputs):
    """inputs: [(alias, scope)]；返回输出列 dict。"""
    sql = action.get("sql") or ""
    out_names = [c.get("name") for c in action.get("schema") or []]
    in_cols = {}
    for _, scope in inputs:
        for n, c in scope.items():
            in_cols.setdefault(n, []).append(c)
    defs = {}
    for alias, expr in _select_lists(sql):
        if alias:
            defs.setdefault(alias, []).append(expr)
    known = sorted(set(in_cols) | set(defs), key=len, reverse=True)
    pats = {n: re.compile(f"(?<![{WORDCH}]){re.escape(n)}(?![{WORDCH}])") for n in known}

    def ids_in(expr):
        return [n for n in known if pats[n].search(expr)]

    def resolve(name, depth=0, seen=()):
        refs, direct = set(), True
        exprs = defs.get(name, [])
        trivial = [e for e in exprs if ids_in(e) == [name]] if exprs else []
        if name in in_cols and (not exprs or trivial):
            for c in in_cols[name]:
                refs |= c.refs
                direct &= not c.derived
        if depth > 6 or name in seen:
            return refs, direct
        for e in exprs:
            if e in trivial:
                continue
            direct = False
            for n in ids_in(e):
                if n == name:
                    if n in in_cols:
                        for c in in_cols[n]:
                            refs |= c.refs
                    continue
                r, _ = resolve(n, depth + 1, seen + (name,))
                refs |= r
        return refs, direct

    def expr_of(name):
        # 该输出列在 SQL 中的定义表达式（取第一个非透传定义）
        for e in defs.get(name, []):
            if ids_in(e) != [name]:
                return e
        return None

    tag = f"SQL[{action.get('name') or ''}|{action.get('id')}]"  # 名称可能重复，带上算子 id
    out = {}
    for n in out_names:
        refs, direct = resolve(n)
        e = expr_of(n)
        prev = [c.notes for c in in_cols.get(n, [])]
        notes = () if direct else ((prev[0] if prev else ()) + (f"{tag}: {short(e)}" if e else tag,))
        out[n] = Col(refs, not direct, notes)
    return out


# ---------------- 单个 ETL ----------------

def etl_columns(etl, ds_fields):
    actions = {a["id"]: a for a in etl.get("actions") or []}
    memo = {}

    def cols(aid, stack=()):
        if aid in memo:
            return memo[aid]
        if aid in stack or aid not in actions:
            return {}
        a = actions[aid]
        t = a.get("type")
        srcs = [cols(s, stack + (aid,)) for s in a.get("sources") or []]
        first = srcs[0] if srcs else {}
        out = {}

        if t == "INPUT_DATASET":
            ds = a.get("inputDsId")
            names = dict.fromkeys(ds_fields.get(ds, []) + list((a.get("relativeFieldAlias") or {}).values()))
            out = {n: Col({(ds, n)}) for n in names}
        elif t in ("REMOVE_DUPLICATES", "DATA_EXPLORATION", "OUTPUT_DATASET"):
            out = dict(first)
        elif t == "FILTER_ROWS":
            # 行筛选影响所有列的取值范围，记为说明
            nt = filter_note(a)
            out = {n: c.note(nt) for n, c in first.items()}
        elif t == "SINGLE_VALUE_MAPPER":
            out = dict(first)
            for m in a.get("mappings") or []:
                c = m.get("colName")
                if c in out:
                    out[c] = out[c].note(f"空值→{m.get('toValue')}")
        elif t == "VALUE_MAPPER":
            out = dict(first)
            c = a.get("column")
            if c in out:
                out[c] = out[c].via("值替换")
        elif t == "SELECT_COLUMNS":
            for c in a.get("columns") or []:
                if not c.get("isIgnored") and c.get("name") in first:
                    col = first[c["name"]]
                    out[c.get("newName") or c["name"]] = col.note(f"改名: {c['name']}→{c['newName']}") if c.get("newName") and c["newName"] != c["name"] else col
        elif t == "CALCULATOR":
            out = dict(first)
            for f in a.get("formulas") or []:
                out[f["name"]] = formula_col(f.get("expr"), out, "CALC: " + short(f.get("expr")))
        elif t == "COMBINE_COLUMNS":
            out = dict(first)
            fs = a.get("fields") or []
            out[a.get("targetFieldName")] = merge([first[f] for f in fs if f in first], "合并列")
            if a.get("removeSelectedFields"):
                for f in fs:
                    out.pop(f, None)
        elif t == "JOIN_DATA":
            df = a.get("dataFusion") or {}
            by_key = dict(zip(a.get("sources") or [], srcs))
            for c in df.get("selectedColumns") or []:
                scope = by_key.get(c.get("dsKey"), {})
                if not c.get("isIgnored") and c.get("name") in scope:
                    col = scope[c["name"]]
                    out[c.get("newName") or c["name"]] = col.note(f"改名: {c['name']}→{c['newName']}") if c.get("newName") and c["newName"] != c["name"] else col
        elif t == "APPEND_ROWS":
            df = a.get("dataFusion") or {}
            by_key = dict(zip(a.get("sources") or [], srcs))
            schema_src = by_key.get(df.get("schemaSource")) or first
            names = list(schema_src)
            if df.get("unionType") == "INCLUDE_ALL":
                for s in srcs:
                    names += [n for n in s if n not in names]
            for n in names:
                parts = [s[n] for s in srcs if n in s]
                out[n] = parts[0] if len(parts) == 1 else Col(
                    set().union(*(p.refs for p in parts)), any(p.derived for p in parts),
                    dict.fromkeys(sum((p.notes for p in parts), ())))
        elif t == "GROUP_BY":
            z = a.get("zoneData") or {}
            calc = {f.get("name"): f.get("formula") for k in ("newDim", "newMetric", "newCalculationField")
                    for f in a.get(k) or [] if f.get("formula")}
            for f in (z.get("row") or []) + (z.get("metric") or []):
                name = f.get("name")
                outn = f.get("alias") or name
                formula = f.get("formula") or calc.get(name)
                agg = f.get("aggrType") if f.get("aggrType") not in (None, "NUL") else None
                if formula:
                    col = formula_col(formula, first, (agg + ": " if agg else "") + short(formula))
                elif name in first:
                    col = first[name].via(f"{agg}({name})") if agg else first[name]
                    if outn != name and not agg:
                        col = col.note(f"改名: {name}→{outn}")
                else:
                    continue
                out[outn] = col
        elif t == "UNCOLLAPSE_COLUMNS":
            for g in a.get("groupBy") or []:
                if g in first:
                    out[g] = first[g]
            src = [first[x] for x in (a.get("aggrColumn"), a.get("column")) if x in first]
            for f in a.get("fields") or []:
                out[f.get("targetName")] = merge(src, f"行转列 {a.get('column')}={f.get('keyValue')}")
        elif t == "COLLAPSE_COLUMNS":
            listed = [c.get("name") for c in a.get("columns") or []]
            out = {n: c for n, c in first.items() if n not in listed}
            parts = [first[n] for n in listed if n in first]
            out[a.get("dimName")] = merge(parts, "列转行(列名)")
            out[a.get("metricName")] = merge(parts, "列转行(值)")
        elif t == "SQL_SCRIPT":
            out = sql_columns(a, [(f"input{i + 1}", s) for i, s in enumerate(srcs)])
        else:
            out = dict(first)
        memo[aid] = out
        return out

    for aid, a in actions.items():
        if a.get("type") == "OUTPUT_DATASET":
            ds = (a.get("dataSource") or {}).get("dsId")
            if ds:
                yield ds, cols(aid)


# ---------------- 字段 -> 卡片 ----------------

CARD_TYPES = {"CHART", "DRILL"}  # 选择器类卡片不计入
SELECTOR_TYPES = {"SELECTOR", "TREE_SELECTOR", "MERGE_SELECTOR"}


def _ds_refs(o, out):
    if isinstance(o, dict):
        if isinstance(o.get("dsId"), str):
            out.add(o["dsId"])
        for k, v in o.items():
            if k not in ("dsInfo", "dsInfos"):
                _ds_refs(v, out)
    elif isinstance(o, list):
        for x in o:
            _ds_refs(x, out)


def prune_selector_only_pages(db, page_dir):
    """删掉仅因筛选器而存在的「数据集 -> 页面」边（血缘接口不区分卡片类型）。"""
    n = 0
    for p in Path(page_dir).glob("*.json"):
        try:
            page = json.loads(p.read_text(encoding="utf-8")).get("data") or {}
        except json.JSONDecodeError:
            continue
        sel, other = set(), set()
        for c in page.get("cards") or []:
            refs = set()
            _ds_refs(c.get("content"), refs)
            (sel if c.get("cdType") in SELECTOR_TYPES else other).update(refs)
        for ds in sel - other:
            n += db.execute("DELETE FROM edges WHERE src = ? AND dst = ? AND rel = 'USED_BY_PAGE'",
                            (ds, page.get("pgId") or p.stem)).rowcount
    return n
ZONE = {"row": "行/维度", "column": "列", "metric": "度量", "filters": "筛选", "xAxis": "X 轴", "yAxis": "Y 轴",
        "metric_additional": "辅助度量", "sorting": "排序", "tooltip": "提示", "colorBy": "颜色", "summary": "汇总",
        "mainAxis": "主轴", "baseAxis": "基准轴", "condition": "条件格式"}


def card_fields(content):
    """遍历卡片配置，返回 [(dsId, fdId, 卡片内显示名, 公式, 区域, 聚合)]。"""
    out = []

    def walk(o, ds, zone):
        if isinstance(o, dict):
            ds = o["dsId"] if isinstance(o.get("dsId"), str) else ds
            if o.get("fdId") and o.get("name") and ds and o.get("metaType") != "MPH":
                out.append((ds, o["fdId"], o.get("parentFdName") or o["name"], o.get("alias") or o["name"],
                            o.get("formula"), zone, o.get("aggrType")))
            for k, v in o.items():
                if k in ("dsInfo", "dsInfos"):
                    continue
                walk(v, ds, zone if k in ("meta", "chartMain", "zoneData", "props") or isinstance(v, dict) and zone else k)
        elif isinstance(o, list):
            for x in o:
                walk(x, ds, zone)

    walk(content, None, None)
    return out


def kind_of(col):
    """计算：本字段的值被改变（空值/值替换、聚合、公式、行列转换、合并列、SQL 表达式）；
    透传：原样、改名、仅行筛选（筛选不改变字段值，只作为说明保留）。"""
    if col.derived or any(n.startswith("空值→") for n in col.notes):
        return "derived"
    return "direct"


def build_card_edges(db, page_dir, ds_fields):
    by_fd = {}
    for ds, fd, name in db.execute("SELECT ds_id, fd_id, name FROM fields"):
        by_fd[(ds, fd)] = name
    n = 0
    for p in sorted(Path(page_dir).glob("*.json")):
        if p.stem.endswith("_draft"):
            continue
        try:
            page = json.loads(p.read_text(encoding="utf-8")).get("data") or {}
        except json.JSONDecodeError:
            continue
        pg_id = page.get("pgId") or p.stem
        for c in page.get("cards") or []:
            if c.get("cdType") not in CARD_TYPES:
                continue
            refs = card_fields(c.get("content"))
            # 「数据集 -> 卡片」接口会漏掉部分卡片，这里按页面配置补齐卡片节点及其边
            db.execute("INSERT OR IGNORE INTO nodes (id, type, subtype, name, props) VALUES (?, 'CARD', ?, ?, ?)",
                       (c["cdId"], c.get("cdType"), c.get("name"),
                        json.dumps({"chartType": (c.get("content") or {}).get("chartType"), "pgIds": [pg_id]}, ensure_ascii=False)))
            db.execute("INSERT OR IGNORE INTO edges VALUES (?, ?, 'ON_PAGE')", (c["cdId"], pg_id))
            for ds in dict.fromkeys(r[0] for r in refs):
                if ds in ds_fields:
                    db.execute("INSERT OR IGNORE INTO edges VALUES (?, ?, 'USED_BY')", (ds, c["cdId"]))
            for ds, fd, base, shown, formula, zone, agg in refs:
                name = by_fd.get((ds, fd)) or by_fd.get((ds, fd.split("_")[0])) or base
                note = ZONE.get(zone, zone or "")
                if agg and agg != "NUL":
                    note += f" · {agg}"
                srcs = [name] if name in set(ds_fields.get(ds, [])) else []
                if not srcs and formula:  # 卡片内计算字段
                    own = set(ds_fields.get(ds, []))
                    srcs = [r for r in dict.fromkeys(BRACKET.findall(formula)) if r in own]
                    note += " · " + short(formula)
                for src in srcs:
                    db.execute("INSERT OR IGNORE INTO field_edges VALUES (?,?,?,?,?,'card',?)",
                               (ds, src, c["cdId"], shown, pg_id, note.strip(" ·") or None))
                    n += 1
    return n


def build(db_path, cache_dir, page_dir=None):
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA)
    ds_fields = {}
    for ds, name in db.execute("SELECT ds_id, name FROM fields ORDER BY ds_id, seq"):
        ds_fields.setdefault(ds, []).append(name)
    rows = 0
    etl_ids = {r[0] for r in db.execute("SELECT id FROM nodes WHERE type = 'ETL'")}
    for p in sorted(Path(cache_dir).glob("*.json")):
        etl_id = p.stem
        if etl_id not in etl_ids:  # 缓存里可能有已删除的 ETL
            continue
        try:
            etl = json.loads(p.read_text(encoding="utf-8")).get("data") or {}
        except json.JSONDecodeError:
            continue
        for out_ds, out_cols in etl_columns(etl, ds_fields):
            for name, col in out_cols.items():
                for src_ds, src_f in col.refs:
                    db.execute(
                        "INSERT OR IGNORE INTO field_edges VALUES (?,?,?,?,?,?,?)",
                        (src_ds, src_f, out_ds, name, etl_id, kind_of(col),
                         " → ".join(col.notes) or None),
                    )
                    rows += 1
    # 数据集自带计算字段：表达式中 [字段] 引用同数据集的其它字段
    for ds, name, expr in db.execute("SELECT ds_id, name, expr FROM fields WHERE expr IS NOT NULL").fetchall():
        own = set(ds_fields.get(ds, []))
        for ref in dict.fromkeys(BRACKET.findall(expr)):
            if ref in own and ref != name:
                db.execute("INSERT OR IGNORE INTO field_edges VALUES (?,?,?,?,NULL,'calc',?)",
                           (ds, ref, ds, name, "CALC: " + short(expr)))
    page_dir = Path(page_dir) if page_dir else Path(cache_dir).parent / "page"
    if page_dir.exists():
        build_card_edges(db, page_dir, ds_fields)
        prune_selector_only_pages(db, page_dir)
    # 视图数据集：同名字段对应
    db.execute("""
      INSERT OR IGNORE INTO field_edges
      SELECT fs.ds_id, fs.name, fd.ds_id, fd.name, NULL, 'view', NULL
      FROM edges e
      JOIN fields fs ON fs.ds_id = e.src
      JOIN fields fd ON fd.ds_id = e.dst AND fd.name = fs.name
      WHERE e.rel = 'FEEDS'""")
    db.commit()
    total = db.execute("SELECT count(*) FROM field_edges").fetchone()[0]
    cov = db.execute("""
      SELECT count(*), sum(EXISTS(SELECT 1 FROM field_edges fe WHERE fe.dst_ds = f.ds_id AND fe.dst_field = f.name))
      FROM fields f WHERE f.ds_id IN (SELECT dst FROM edges WHERE rel IN ('OUTPUTS', 'FEEDS'))""").fetchone()
    kinds = db.execute("SELECT kind, count(*) FROM field_edges GROUP BY kind").fetchall()
    db.close()
    return total, kinds, cov


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(DATA / "lineage.db"))
    ap.add_argument("--cache", default=str(DATA / "cache" / "etl"))
    args = ap.parse_args()
    total, kinds, (n, hit) = build(args.db, args.cache)
    print(f"field_edges={total} {kinds}  ETL/视图产出数据集字段覆盖 {hit or 0}/{n}")


if __name__ == "__main__":
    main()
