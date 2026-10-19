#!/usr/bin/env python3
"""抓取观远 BI 全量血缘（数据集 / ETL / 卡片 / 页面），写入 SQLite 图存储。

只读：仅调用 guands dataset list/cards、guancli ds get、guancli etl get。

用法:
  guanlineage crawl [--workers 6] [--limit N]   （或 python3 crawler/crawl.py）

边方向统一为「数据流向」(上游 -> 下游):
  DATASET -INPUT_OF-> ETL -OUTPUTS-> DATASET -USED_BY-> CARD -ON_PAGE-> PAGE
"""
import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import field_lineage

HERE = Path(__file__).resolve().parent
# 数据目录：环境变量 GUAN_LINEAGE_DATA，默认 <项目>/data
DATA = Path(os.environ.get("GUAN_LINEAGE_DATA") or HERE.parent / "data")

SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,          -- DATASET | ETL | CARD | PAGE | SOURCE | OTHER
  subtype    TEXT,                   -- 原始类型，如 DATA_SET_ETL / DATAFLOW / CHART
  name       TEXT,
  path       TEXT,
  props      TEXT,                   -- JSON
  crawled_at TEXT
);
CREATE TABLE IF NOT EXISTS edges (
  src  TEXT NOT NULL,
  dst  TEXT NOT NULL,
  rel  TEXT NOT NULL,                -- INPUT_OF | OUTPUTS | USED_BY | ON_PAGE | USED_BY_PAGE | SOURCE_OF | FEEDS
  PRIMARY KEY (src, dst, rel)
);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE TABLE IF NOT EXISTS crawl_errors (
  id TEXT, step TEXT, error TEXT, at TEXT
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS fields (
  ds_id      TEXT NOT NULL,
  fd_id      TEXT NOT NULL,
  seq        INTEGER,
  name       TEXT,                   -- 展示名：有别名用别名，否则物理名（ETL 中按此引用）
  phys_name  TEXT,                   -- 物理字段名
  fd_type    TEXT,                   -- STRING / INT / DOUBLE / DATE ...
  meta_type  TEXT,                   -- DIM / METRIC
  calc_type  TEXT,                   -- normal / 计算字段类型
  expr       TEXT,                   -- 计算字段表达式（如有）
  annotation TEXT,
  hidden     INTEGER,
  PRIMARY KEY (ds_id, fd_id)
);
CREATE INDEX IF NOT EXISTS idx_fields_name ON fields(name);
"""


def run(cmd, retries=2):
    last = None
    for i in range(retries + 1):
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        if p.returncode == 0:
            try:
                return json.loads(p.stdout)
            except json.JSONDecodeError as e:
                last = f"json: {e}: {p.stdout[:200]}"
        else:
            last = (p.stderr or p.stdout)[:500]
        time.sleep(1 + i * 2)
    raise RuntimeError(f"{' '.join(cmd)} -> {last}")


def unwrap(d):
    return d.get("response", d) if isinstance(d, dict) else d


def node_type(raw):
    raw = raw or ""
    if raw.startswith("DATA_SET"):
        return "DATASET"
    if raw.startswith("DATA_PROCESS") or raw == "ETL":
        return "ETL"
    if raw == "CARD":
        return raw
    if raw.endswith("PAGE") or raw.startswith("DATA_ANALYSIS"):  # DATA_ANALYSIS_PAGE / _CUSTOM_REPORT（复杂报表）
        return "PAGE"
    if raw.startswith("DATASOURCE") or raw.startswith("DATA_ACCOUNT"):
        return "SOURCE"  # 源库表 / 数据连接
    return "OTHER"


def dir_path_str(dp, name=None):
    parts = [x.get("dirName") or x.get("name") for x in (dp or [])]
    if name:
        parts.append(name)
    return ">".join(p for p in parts if p)


class Store:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.executescript(SCHEMA)
        self.now = time.strftime("%Y-%m-%d %H:%M:%S")

    def node(self, id, type, subtype=None, name=None, path=None, props=None, full=False):
        """full=True 表示这是该节点的权威详情，覆盖之前的占位记录。"""
        if not id:
            return
        cur = self.db.execute("SELECT props FROM nodes WHERE id=?", (id,)).fetchone()
        pj = json.dumps(props, ensure_ascii=False) if props is not None else None
        if cur is None:
            self.db.execute(
                "INSERT INTO nodes VALUES (?,?,?,?,?,?,?)",
                (id, type, subtype, name, path, pj, self.now if full else None),
            )
        elif full:
            self.db.execute(
                "UPDATE nodes SET type=?, subtype=?, name=?, path=?, props=?, crawled_at=? WHERE id=?",
                (type, subtype, name, path, pj, self.now, id),
            )
        else:
            # 占位记录只补空字段
            self.db.execute(
                "UPDATE nodes SET subtype=COALESCE(subtype,?), name=COALESCE(name,?), path=COALESCE(path,?) WHERE id=?",
                (subtype, name, path, id),
            )

    def edge(self, src, dst, rel):
        if src and dst:
            self.db.execute("INSERT OR IGNORE INTO edges VALUES (?,?,?)", (src, dst, rel))

    def fields(self, ds_id, columns):
        for c in columns:
            expr = next((c[k] for k in ("expression", "expr", "formula", "calculation") if c.get(k)), None)
            self.db.execute(
                "INSERT OR REPLACE INTO fields VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (ds_id, c.get("fdId") or c.get("name"), c.get("seqNo"), c.get("alias") or c.get("name"), c.get("name"),
                 c.get("fdType"),
                 c.get("metaType"), c.get("calculationType"),
                 json.dumps(expr, ensure_ascii=False) if isinstance(expr, (dict, list)) else expr,
                 c.get("annotation") or None, int(bool(c.get("hidden")))),
            )

    def error(self, id, step, err):
        self.db.execute("INSERT INTO crawl_errors VALUES (?,?,?,?)", (id, step, str(err)[:2000], self.now))


def rel_for(src_type, dst_type):
    if src_type == "DATASET" and dst_type == "ETL":
        return "INPUT_OF"
    if src_type == "ETL" and dst_type == "DATASET":
        return "OUTPUTS"
    if dst_type == "PAGE":
        return "USED_BY_PAGE"
    if src_type == "SOURCE":
        return "SOURCE_OF"
    return "FEEDS"  # 如 数据集 -> 视图数据集(SPARK_VIEW)


def add_lineage(st, me_id, me_type, lineage):
    for item in (lineage or {}).get("upstream") or []:
        t = node_type(item.get("type"))
        st.node(item["id"], t, item.get("type"), item.get("name"))
        st.edge(item["id"], me_id, rel_for(t, me_type))
    for item in (lineage or {}).get("downstream") or []:
        t = node_type(item.get("type"))
        st.node(item["id"], t, item.get("type"), item.get("name"))
        st.edge(me_id, item["id"], rel_for(me_type, t))


def list_datasets(limit_total=None):
    out, offset, page = [], 0, 200
    while True:
        r = unwrap(run(["guands", "dataset", "list", "--limit", str(page), "--offset", str(offset), "--raw"]))
        items = r.get("contents") or []
        out.extend(items)
        total = r.get("count", 0)
        offset += len(items)
        print(f"  dataset list {offset}/{total}", file=sys.stderr)
        if not items or offset >= total or (limit_total and offset >= limit_total):
            break
    return out[:limit_total] if limit_total else out


def fetch_ds(ds_id):
    detail = run(["guancli", "ds", "get", ds_id, "--raw"])
    cards = unwrap(run(["guands", "dataset", "cards", ds_id, "--raw"]))
    return detail, cards


ETL_CACHE = DATA / "cache" / "etl"
# 选择器（筛选器）类卡片不纳入血缘
SELECTOR_TYPES = {"SELECTOR", "TREE_SELECTOR", "MERGE_SELECTOR"}
PAGE_CACHE = DATA / "cache" / "page"


def fetch_page(pg_id):
    r = run(["guancli", "page", "get", pg_id, "--raw"])
    # 缓存原文供 field_lineage.py 解析「字段 -> 卡片」
    PAGE_CACHE.mkdir(parents=True, exist_ok=True)
    (PAGE_CACHE / f"{pg_id}.json").write_text(json.dumps(r, ensure_ascii=False))
    return r


def fetch_etl(etl_id):
    r = run(["guancli", "etl", "get", etl_id, "--raw"])
    # 缓存原文供 field_lineage.py 解析字段级血缘
    ETL_CACHE.mkdir(parents=True, exist_ok=True)
    (ETL_CACHE / f"{etl_id}.json").write_text(json.dumps(r, ensure_ascii=False))
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(DATA / "lineage.db"))
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, help="只抓前 N 个数据集（调试用）")
    args = ap.parse_args()

    tmp = args.db + ".tmp"
    Path(tmp).unlink(missing_ok=True)
    st = Store(tmp)
    t0 = time.time()

    print("[1/5] 列出数据集", file=sys.stderr)
    datasets = list_datasets(args.limit)
    for d in datasets:
        props = {k: d.get(k) for k in ("displayType", "rowCount", "colCount", "status", "ctime", "utime", "uniformResourceType")}
        props["storageType"] = (d.get("config") or {}).get("storageType")
        props["lastExecution"] = (d.get("config") or {}).get("lastExecution")
        st.node(d["dsId"], "DATASET", d.get("uniformResourceType") or d.get("displayType"), d.get("name"),
                dir_path_str(d.get("dirPath"), d.get("name")), props, full=True)
    st.db.commit()

    print(f"[2/5] 抓取 {len(datasets)} 个数据集的血缘与卡片", file=sys.stderr)
    with ThreadPoolExecutor(args.workers) as ex:
        futs = {ex.submit(fetch_ds, d["dsId"]): d["dsId"] for d in datasets}
        for i, f in enumerate(as_completed(futs), 1):
            ds_id = futs[f]
            try:
                detail, cards = f.result()
            except Exception as e:
                st.error(ds_id, "dataset", e)
                continue
            data = detail.get("data") or {}
            row = st.db.execute("SELECT props FROM nodes WHERE id=?", (ds_id,)).fetchone()
            props = json.loads(row[0]) if row and row[0] else {}
            props["parentDirName"] = data.get("parentDirName")
            st.fields(ds_id, (data.get("columns") or []) + (data.get("virtualColumns") or []))
            props["cron"] = data.get("dataCronInfo")
            st.db.execute("UPDATE nodes SET props=? WHERE id=?", (json.dumps(props, ensure_ascii=False), ds_id))
            add_lineage(st, ds_id, "DATASET", detail.get("lineage"))

            for grp in (cards or {}).get("readableCards") or []:
                pg_path = grp.get("pgPath") or []
                page = pg_path[-1] if pg_path else None
                for c in grp.get("cards") or []:
                    if c.get("cdType") in SELECTOR_TYPES:
                        continue
                    content = c.get("content") or {}
                    st.node(c["cdId"], "CARD", c.get("cdType"), c.get("name"), None,
                            {"chartType": content.get("chartType"), "pgIds": c.get("pgIds"),
                             "ctime": c.get("ctime"), "utime": c.get("utime")}, full=True)
                    st.edge(ds_id, c["cdId"], "USED_BY")
                    for pg_id in c.get("pgIds") or ([c["pgId"]] if c.get("pgId") else []):
                        if page and page.get("id") == pg_id:
                            st.node(pg_id, "PAGE", "PAGE", page.get("name"), dir_path_str(pg_path),
                                    {"pgPath": pg_path}, full=True)
                        else:
                            st.node(pg_id, "PAGE", "PAGE")
                        st.edge(c["cdId"], pg_id, "ON_PAGE")
            if i % 50 == 0:
                st.db.commit()
                print(f"  {i}/{len(datasets)}  {time.time() - t0:.0f}s", file=sys.stderr)
    st.db.commit()

    etl_ids = [r[0] for r in st.db.execute("SELECT id FROM nodes WHERE type='ETL'")]
    print(f"[3/5] 抓取 {len(etl_ids)} 个 ETL 详情", file=sys.stderr)
    with ThreadPoolExecutor(args.workers) as ex:
        futs = {ex.submit(fetch_etl, e): e for e in etl_ids}
        for i, f in enumerate(as_completed(futs), 1):
            etl_id = futs[f]
            try:
                r = f.result()
            except Exception as e:
                st.error(etl_id, "etl", e)
                continue
            d = r.get("data") or {}
            le = d.get("lastExecution") or {}
            props = {
                "displayType": d.get("displayType"), "cron": d.get("cron"), "draft": d.get("draft"),
                "ctime": d.get("ctime"), "executionCount": d.get("executionCount"),
                "executionSuccessCount": d.get("executionSuccessCount"),
                "lastExecution": {k: le.get(k) for k in ("status", "startTime", "endTime")},
                "actionTypes": sorted({a.get("type") for a in d.get("actions") or []}),
            }
            st.node(etl_id, "ETL", "DATA_PROCESS_ETL", d.get("name"), dir_path_str(d.get("dirPath"), d.get("name")),
                    props, full=True)
            add_lineage(st, etl_id, "ETL", r.get("lineage"))
            for inp in d.get("inputs") or []:
                st.node(inp.get("dsId"), "DATASET", None, inp.get("name"))
                st.edge(inp.get("dsId"), etl_id, "INPUT_OF")
            for out in d.get("outputs") or []:
                st.node(out.get("dsId"), "DATASET", None, out.get("name"))
                st.edge(etl_id, out.get("dsId"), "OUTPUTS")
            if i % 50 == 0:
                st.db.commit()
                print(f"  {i}/{len(etl_ids)}  {time.time() - t0:.0f}s", file=sys.stderr)

    st.db.execute("INSERT OR REPLACE INTO meta VALUES ('crawled_at', ?)", (st.now,))
    st.db.commit()
    stats = st.db.execute("SELECT type, count(*) FROM nodes GROUP BY type").fetchall()
    estats = st.db.execute("SELECT rel, count(*) FROM edges GROUP BY rel").fetchall()
    errs = st.db.execute("SELECT count(*) FROM crawl_errors").fetchone()[0]
    st.db.close()
    pg_ids = [r[0] for r in sqlite3.connect(tmp).execute("SELECT id FROM nodes WHERE type='PAGE' AND id NOT LIKE '%\\_draft' ESCAPE '\\'")]
    print(f"[4/5] 抓取 {len(pg_ids)} 个页面的卡片配置", file=sys.stderr)
    for f in PAGE_CACHE.glob("*.json") if PAGE_CACHE.exists() else []:
        f.unlink()  # 清掉旧缓存，避免已删除页面残留
    econn = sqlite3.connect(tmp)
    with ThreadPoolExecutor(args.workers) as ex:
        futs = {ex.submit(fetch_page, p): p for p in pg_ids}
        for f in as_completed(futs):
            try:
                f.result()
            except Exception as e:
                econn.execute("INSERT INTO crawl_errors VALUES (?,?,?,datetime('now'))", (futs[f], "page", str(e)[:2000]))
    econn.commit()
    econn.close()

    print("[5/5] 推导字段级血缘", file=sys.stderr)
    total, kinds, (n, hit) = field_lineage.build(tmp, ETL_CACHE, PAGE_CACHE)
    print(f"  field_edges={total} {kinds} 产出字段覆盖 {hit or 0}/{n}", file=sys.stderr)
    Path(tmp).replace(args.db)
    print(f"完成 {time.time() - t0:.0f}s  nodes={stats} edges={estats} errors={errs}", file=sys.stderr)


if __name__ == "__main__":
    main()
