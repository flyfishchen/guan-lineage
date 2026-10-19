// 血缘图 Web 服务：/ 关系图页面，/graphql GraphQL（GET 无参数时为 GraphiQL）
//
//   guanlineage serve [--port 4000] [--host 127.0.0.1] [--db data/lineage.db]
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createGraph, ROOT } from './graph.mjs';

const GRAPHIQL = `<!doctype html><html><head><meta charset="utf-8"><title>BI 血缘图 GraphQL</title>
<link rel="stylesheet" href="https://unpkg.com/graphiql@3.7.1/graphiql.min.css"></head>
<body style="margin:0"><div id="g" style="height:100vh"></div>
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/graphiql@3.7.1/graphiql.min.js"></script>
<script>ReactDOM.createRoot(document.getElementById('g')).render(React.createElement(GraphiQL,{
fetcher:GraphiQL.createFetcher({url:location.pathname}),
defaultQuery:'{ stats { crawledAt nodes { key count } edges { key count } errors } }'}));</script></body></html>`;

// 默认只监听本机；需局域网访问时显式 --host 0.0.0.0（服务无鉴权）
export function serve({ port = 4000, host = '127.0.0.1', dbPath } = {}) {
  const graph = createGraph(dbPath ? { dbPath } : {});
  const ui = path.join(ROOT, 'web', 'ui.html');
  const server = http.createServer(async (req, res) => {
    // 兜底：async 回调中的异常会成为未处理的 Promise 拒绝并使进程退出
    try {
      await handle(req, res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e?.message || e));
    }
  });
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/' || url.pathname === '/ui')
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(ui));
    if (url.pathname !== '/graphql') return res.writeHead(404).end('use / or /graphql');
    if (req.method === 'GET' && !url.searchParams.get('query'))
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(GRAPHIQL);
    let body = {};
    if (req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return res.writeHead(400).end('bad json');
      }
    } else {
      try {
        body = { query: url.searchParams.get('query'), variables: JSON.parse(url.searchParams.get('variables') || 'null') };
      } catch {
        return res.writeHead(400).end('bad variables json');
      }
    }
    const result = await graph.query(body.query, body.variables);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(result));
  }
  server.on('error', (e) => {
    const hint = e.code === 'EADDRINUSE' ? `端口 ${port} 已被占用（可能已有 guanlineage serve 在运行），换端口：--port <端口>`
      : e.code === 'EACCES' ? `无权限监听 ${host}:${port}` : e.message;
    console.error(`启动失败：${hint}`);
    process.exit(1);
  });
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  server.listen(port, host, () =>
    console.log(`血缘图: http://${shown}:${port}/   GraphQL: http://${shown}:${port}/graphql   (监听 ${host}，db: ${graph.dbPath})`));
  return server;
}
