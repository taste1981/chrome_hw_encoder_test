// lib/chrome-finder.mjs — locate an installed Chrome/Chromium executable.
//
// Discovery order:
//   1. --chrome CLI argument
//   2. D3D12_CI_CHROME / CHROME_PATH environment variables
//   3. Registry "App Paths" keys (HKLM 64-bit, HKLM 32-bit view, HKCU)
//   4. Registry StartMenuInternet command key (Google Chrome)
//   5. Standard install locations (%ProgramFiles%, %ProgramFiles(x86)%, LocalAppData)
//
// All registry access is read-only (reg.exe query). The harness never writes
// registry keys.

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

export class ChromeNotFoundError extends Error {
  constructor(tried) {
    super(
      'Could not find chrome.exe. Pass --chrome <path> or set D3D12_CI_CHROME.\n' +
        tried.map((t) => `  [${t.source}] ${t.path}`).join('\n'),
    );
    this.name = 'ChromeNotFoundError';
    this.tried = tried;
  }
}

// Returns the default (unnamed) value of a registry key, or null.
function regQueryDefaultValue(key) {
  for (const view of ['/reg:64', '/reg:32']) {
    const res = spawnSync('reg.exe', ['query', key, '/ve', view], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    if (res.status !== 0 || !res.stdout) continue;
    for (const line of res.stdout.split(/\r?\n/)) {
      const m = line.match(/REG_SZ\s+(.+)$/i);
      if (m) {
        const value = m[1].trim();
        if (value && value !== '(value not set)') return value;
      }
    }
  }
  return null;
}

// StartMenuInternet command values look like:
//   "C:\Program Files\Google\Chrome\Application\chrome.exe" -- "%1"
function commandKeyToPath(cmd) {
  const m = cmd.match(/"([^"]+\.exe)"/i);
  return m ? m[1] : null;
}

export function findChrome({ explicit } = {}) {
  const tried = [];
  const candidates = [];
  const push = (source, p) => {
    if (p) candidates.push({ source, path: p });
  };

  push('--chrome', explicit);
  push('env', process.env.D3D12_CI_CHROME);
  push('env', process.env.CHROME_PATH);

  push(
    'registry:HKCU App Paths',
    regQueryDefaultValue(
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    ),
  );
  push(
    'registry:HKLM App Paths',
    regQueryDefaultValue(
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    ),
  );
  push(
    'registry:HKLM App Paths (WOW6432Node)',
    regQueryDefaultValue(
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    ),
  );
  push(
    'registry:StartMenuInternet',
    commandKeyToPath(
      regQueryDefaultValue(
        'HKLM\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome\\shell\\open\\command',
      ) || '',
    ),
  );

  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local =
    process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Local');
  push('standard', path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  push('standard', path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  push('standard', path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));

  for (const c of candidates) {
    try {
      if (statSync(c.path).isFile()) return { path: c.path, source: c.source };
    } catch {
      // Keep looking.
    }
    tried.push(c);
  }
  throw new ChromeNotFoundError(tried);
}

// Reads the executable's file version via PowerShell (Get-Item). Used for the
// Chrome >= 158 gate before launching; the CDP Browser.getVersion value
// remains authoritative for the report.
export function getChromeFileVersion(exe) {
  const psCmd = `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.FileVersion`;
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psCmd],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
  );
  if (res.status !== 0) return null;
  const v = (res.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  return v || null;
}
