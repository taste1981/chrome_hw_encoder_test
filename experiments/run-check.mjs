#!/usr/bin/env node
// experiments/run-check.mjs — one-off driver for experiments/roundtrip-check.js.
// Reuses the harness's CDP client and page server. Not part of the CI flow.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findChrome } from '../lib/chrome-finder.mjs';
import { launchChrome, CDPSession, sleep } from '../lib/cdp.mjs';
import { startPageServer } from '../lib/page-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const chrome = findChrome({});
  const pageSource = await fs.readFile(
    path.join(__dirname, 'roundtrip-check.js'),
    'utf8',
  );
  const server = await startPageServer({ config: {}, pageSource });

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'd3d12-exp-'));
  const flags = [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Unsigned test drivers need the sandbox off (see run-ci.mjs).
    '--no-sandbox',
    // Required for HEVC high-bit-depth encode, same as run-ci.mjs.
    '--enable-features=PlatformHEVCHbdEncoderSupport',
    '--window-position=-32000,-32000',
    '--window-size=1280,720',
    `--unsafely-treat-insecure-origin-as-secure=${new URL(server.url).origin}`,
    'about:blank',
  ];

  const proc = launchChrome({ exe: chrome.path, args: flags, userDataDir });
  try {
    await proc.waitForDevToolsPort();
    const browser = await CDPSession.connect(proc.wsBrowserUrl);
    const { targetId } = await browser.send('Target.createTarget', { url: server.url });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    await browser.send('Runtime.enable', {}, { sessionId });

    const deadline = Date.now() + 600_000;
    let done = false;
    while (Date.now() < deadline) {
      try {
        const r = await browser.send(
          'Runtime.evaluate',
          { expression: 'window.__RT_DONE__ === true', returnByValue: true },
          { sessionId, timeoutMs: 5000 },
        );
        if (r.result && r.result.value === true) { done = true; break; }
      } catch { /* not ready */ }
      await sleep(250);
    }
    if (!done) throw new Error('experiment timed out');
    const r = await browser.send(
      'Runtime.evaluate',
      { expression: 'window.__RT_RESULT__', returnByValue: true },
      { sessionId, timeoutMs: 15_000 },
    );
    console.log(JSON.stringify(r.result.value, null, 2));
    try { await browser.send('Browser.close', {}, { timeoutMs: 5000 }); } catch {}
    browser.close();
    await proc.close(5000);
  } finally {
    await server.close();
    try { await fs.rm(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error(`error: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
