// 血缘图 Web 服务：/ 关系图页面，/graphql GraphQL（GET 无参数时为 GraphiQL）
//
//   guanlineage serve [--port 4000] [--db data/lineage.db]
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

export function serve({ port = 4000, dbPath } = {}) {
  const graph = createGraph(dbPath ? { dbPath } : {});
  const ui = path.join(ROOT, 'web', 'ui.html');
  const server = http.createServer(async (req, res) => {
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
      body = { query: url.searchParams.get('query'), variables: JSON.parse(url.searchParams.get('variables') || 'null') };
    }
    const result = await graph.query(body.query, body.variables);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(result));
  });
  server.listen(port, () => console.log(`血缘图: http://localhost:${port}/   GraphQL: http://localhost:${port}/graphql   (db: ${graph.dbPath})`));
  return server;
}
