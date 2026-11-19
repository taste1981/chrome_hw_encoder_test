// lib/cdp.mjs — minimal Chrome DevTools Protocol (CDP) client and Chrome
// process management. Zero dependencies: uses Node's built-in WebSocket
// (available globally since Node 22) plus node:child_process / node:fs.
//
// What this module provides:
//   - launchChrome(): spawn a headed Chrome instance with a fresh
//     --user-data-dir and capture its stderr line-by-line (used for launch
//     diagnostics). The D3D12 attestation lines are emitted by the GPU
//     process into the shared chrome_debug.log (--enable-logging
//     --log-file=... --vmodule=*d3d12*=2,...), which run-ci.mjs reads back.
//   - ChromeProcess: waits for <user-data-dir>\DevToolsActivePort (written
//     when Chrome is launched with --remote-debugging-port=0), exposes the
//     browser WebSocket URL, and handles shutdown.
//   - CDPSession: request/response correlation with per-message timeouts,
//     event subscriptions, and flattened-target (sessionId) support.

import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DEVTOOLS_PORT_POLL_MS = 100;
export const DEVTOOLS_PORT_TIMEOUT_MS = 30_000;
export const STDERR_RING_LIMIT = 50_000;

export class CDPError extends Error {}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Chrome process management
// ---------------------------------------------------------------------------

export class ChromeProcess {
  constructor(child, userDataDir) {
    this.child = child;
    this.userDataDir = userDataDir;
    this.stderrLines = [];
    this.wsBrowserUrl = null;
    this.port = null;
    this._exitPromise = null;
  }

  get exitPromise() {
    return this._exitPromise;
  }

  // Polls <userDataDir>\DevToolsActivePort, which Chrome writes shortly after
  // startup when launched with --remote-debugging-port=0. Line 1 is the port,
  // line 2 is the browser-level WebSocket path (/devtools/browser/<id>).
  async waitForDevToolsPort(timeoutMs = DEVTOOLS_PORT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    const portFile = path.join(this.userDataDir, 'DevToolsActivePort');
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new CDPError(
          `Chrome exited before DevTools came up (code ${this.child.exitCode}). ` +
            `Last stderr lines:\n${this.stderrTail(20).join('\n')}`,
        );
      }
      try {
        const txt = await fs.readFile(portFile, 'utf8');
        const [portLine, wsPath] = txt.split(/\r?\n/);
        const port = Number(portLine);
        if (
          Number.isInteger(port) &&
          port > 0 &&
          typeof wsPath === 'string' &&
          wsPath.startsWith('/devtools/browser/')
        ) {
          this.port = port;
          this.wsBrowserUrl = `ws://127.0.0.1:${port}${wsPath}`;
          return this.wsBrowserUrl;
        }
      } catch {
        // File not written yet — keep polling.
      }
      await sleep(DEVTOOLS_PORT_POLL_MS);
    }
    throw new CDPError(
      `Timed out after ${timeoutMs} ms waiting for ${portFile}`,
    );
  }

  stderrTail(n) {
    return this.stderrLines.slice(-n);
  }

  // Kills Chrome (TerminateProcess on Windows) and force-kills the process
  // tree if it does not exit within |graceMs|.
  async close(graceMs = 5000) {
    if (this.child.exitCode !== null) return this.exitPromise;
    this.child.kill();
    const result = await Promise.race([
      this.exitPromise,
      sleep(graceMs).then(() => null),
    ]);
    if (result === null && this.child.exitCode === null) {
      spawnSync('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      await Promise.race([this.exitPromise, sleep(2000).then(() => null)]);
    }
    return this.exitPromise;
  }
}

export function launchChrome({ exe, args, userDataDir }) {
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const proc = new ChromeProcess(child, userDataDir);

  // Capture stderr line-by-line into a ring buffer. Browser-process lines
  // land here; the VEA attestation lines live in the shared log file
  // (chrome_debug.log), which run-ci.mjs reads back after the run.
  let buf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      proc.stderrLines.push(buf.slice(0, idx).replace(/\r$/, ''));
      if (proc.stderrLines.length > STDERR_RING_LIMIT) {
        proc.stderrLines.splice(0, proc.stderrLines.length - STDERR_RING_LIMIT);
      }
      buf = buf.slice(idx + 1);
    }
  });
  // stdout is not parsed; drain it so Chrome never blocks on a full pipe.
  child.stdout.resume();

  proc._exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      if (buf.trim()) proc.stderrLines.push(buf.replace(/\r$/, ''));
      resolve({ code, signal });
    });
  });
  return proc;
}

// ---------------------------------------------------------------------------
// CDP session (request/response + events)
// ---------------------------------------------------------------------------

export class CDPSession {
  constructor(ws) {
    this._ws = ws;
    this._nextId = 0;
    this._pending = new Map(); // id → {resolve, reject, timer, method}
    this._listeners = new Map(); // `${sessionId}|${method}` → [fn]
    this._closed = false;
    ws.addEventListener('message', (ev) => this._onMessage(ev));
    ws.addEventListener('close', () => this._onClose());
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener(
        'error',
        () => reject(new CDPError(`WebSocket error connecting to ${url}`)),
        { once: true },
      );
    });
    return new CDPSession(ws);
  }

  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new CDPError(`${p.method} failed: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === 'string') {
      const key = `${msg.sessionId ?? ''}|${msg.method}`;
      const fns = this._listeners.get(key);
      if (fns) {
        for (const fn of [...fns]) {
          try {
            fn(msg.params);
          } catch {
            // Listener errors must not break message dispatch.
          }
        }
      }
    }
  }

  _onClose() {
    this._closed = true;
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CDPError('CDP connection closed'));
    }
    this._pending.clear();
  }

  // Sends a CDP command. |sessionId| routes the command to a flattened
  // (Target.attachToTarget) session. Rejects on protocol error or timeout.
  send(method, params = {}, { sessionId, timeoutMs = 15_000 } = {}) {
    if (this._closed) {
      return Promise.reject(new CDPError('CDP connection closed'));
    }
    const id = ++this._nextId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new CDPError(`Timeout waiting for ${method} (${timeoutMs} ms)`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, method });
      this._ws.send(JSON.stringify(msg));
    });
  }

  // Subscribes to a CDP event; returns an unsubscribe function.
  on(method, fn, sessionId) {
    const key = `${sessionId ?? ''}|${method}`;
    if (!this._listeners.has(key)) this._listeners.set(key, []);
    this._listeners.get(key).push(fn);
    return () => {
      const fns = this._listeners.get(key);
      if (fns) {
        const i = fns.indexOf(fn);
        if (i >= 0) fns.splice(i, 1);
      }
    };
  }

  close() {
    if (!this._closed) {
      try {
        this._ws.close();
      } catch {
        // Ignore.
      }
    }
  }
}
