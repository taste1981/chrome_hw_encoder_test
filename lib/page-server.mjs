// lib/page-server.mjs — ephemeral HTTP server on 127.0.0.1 that serves the
// WebCodecs test page (lib/test-page.js) with the case matrix embedded as
// window.__D3D12_ENC_CI_CONFIG__.
//
// Why a local server instead of a data: URL or a file: URL: WebCodecs is a
// [SecureContext] API. Chrome is launched with
// --unsafely-treat-insecure-origin-as-secure=http://127.0.0.1:<port>, which
// makes this origin a secure context without any external network access or
// certificates — the right default for air-gapped driver CI.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_PAGE_PATH = path.join(__dirname, 'test-page.js');

export async function startPageServer({ config, pageSource }) {
  const testPageSource = pageSource || (await readFile(TEST_PAGE_PATH, 'utf8'));
  const html = [
    '<!DOCTYPE html>',
    '<html>',
    '<head><meta charset="utf-8"><title>D3D12 Video Encode Test Suite</title></head>',
    '<body><h1>D3D12 Video Encode Test Suite</h1></body>',
    '<script>',
    `window.__D3D12_ENC_CI_CONFIG__ = ${JSON.stringify(config)};`,
    '</scr' + 'ipt>',
    '<script>',
    testPageSource,
    '</scr' + 'ipt>',
    '</html>',
    '',
  ].join('\n');

  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
