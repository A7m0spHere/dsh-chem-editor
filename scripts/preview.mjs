import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const types = { 'index.html': 'text/html', 'editor.js': 'text/javascript', 'editor.css': 'text/css' };
createServer(async (req, res) => {
  const file = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (!(file in types)) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', types[file]); res.end(await readFile(`dist/${file}`));
}).listen(3099, '127.0.0.1', () => console.log('http://127.0.0.1:3099'));
