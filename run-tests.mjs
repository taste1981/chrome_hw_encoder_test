#!/usr/bin/env node
// run-tests.mjs — D3D12 Video Encode Test Suite: a hardware video encoder
// validation suite (CI-runnable, not a CI system itself).
//
// Discovers an installed Chrome, drives WebCodecs hardware-encode tests
// through CDP (encode deterministic patterns, decode back and pixel-compare
// against the source in the page), and attests — via Chrome's GPU-process
// log — that the D3D12 video encode accelerator was the encoder that ran.
//
// Exit codes:
//   0 PASS · 1 FAIL · 2 harness error · 3 environment has no hardware
//   encode (only with --allow-no-hw) · 4 Chrome < 158 · 5 negative-control
//   failure · 6 L1T3 flag-off leg failure.

import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Default location for JSON reports: <project>\results\
const RESULTS_DIR = path.join(__dirname, 'results');

import {
  buildCases,
  parseCodecs,
  parseResolutions,
} from './lib/codecs.mjs';
import {
  findChrome,
  getChromeFileVersion,
  ChromeNotFoundError,
} from './lib/chrome-finder.mjs';
import { launchChrome, CDPSession, CDPError, sleep } from './lib/cdp.mjs';
import { startPageServer } from './lib/page-server.mjs';
import {
  analyzeStderr,
  computeVerdict,
  MIN_SUPPORTED_MAJOR,
} from './lib/attestation.mjs';
import { buildReport, printSummary, writeReport } from './lib/report.mjs';

const USAGE = `usage: node run-tests.mjs [options]

Validates basic D3D12 video encode driver functionality through an installed
Chrome (>= ${MIN_SUPPORTED_MAJOR}), driven over CDP with WebCodecs.

options:
  --chrome <path>           explicit chrome.exe (default: --chrome → env
                            D3D12_CI_CHROME/CHROME_PATH → registry → standard paths)
  --codecs <list>           comma-separated families, e.g. h264,hevc,av1 —
                            every family also has a -screen variant (1080p
                            screen-content pattern); h264/hevc/hevc-10b420
                            also have -crop-* variants (cropped-encoding
                            geometries); h264/hevc/av1 have -l1t2/-l1t3
                            (temporal scalability), -resize (mid-stream
                            encoded size changes), -vbr/-cqp (bitrate
                            control modes; exact-mode probing), -manual
                            (manual reference buffer control; needs
                            --enable-experimental-web-platform-features,
                            which the harness always passes), -gpu
                            (decode-to-encode transcode on the shared-image
                            input path), -ratechange (rate-only reconfigure,
                            no reinit) and -dual (two concurrent encoders)
                            variants; -keyframes variants run periodic
                            keyframes (h264/hevc also have -l1t3-keyframes);
                            hevc-hdr10 checks BT.2020/PQ signaling |
                            all (default: all of them)
  --resolutions <list>      720p,1080p | 1280x720,...    (default: 720p,1080p)
  --frames <n>              frames per case              (default: 30; the
                            -resize cases have a fixed 105-frame schedule)
  --fps <n>                 framerate, clamped to 30     (default: 30)
  --bitrate-mode <m>        constant|variable            (default: constant —
                            the mode of the base families; the -vbr/-cqp
                            families always probe exactly their own mode,
                            'quantizer' is only exercised via -cqp)
  --bitrate <bps>           override per-resolution bitrate defaults
  --min-psnr <dB>           per-frame PSNR floor         (default: 24; crop
                            cases cap the steady-state floor at 21 — their
                            quality is bounded by the VP crop resample)
  --max-mae <v>             per-frame MAE ceiling        (default: 9)
  --all                     everything: --codecs all (every family, see
                            --codecs) plus --stress-resolution,
                            --negative-control, --l1t3-negative-control and
                            --compare-mf. SKIPs stay allowed (a machine
                            without AV1 hardware encode still skips the av1
                            families rather than failing).
  --require-all             any SKIP becomes FAIL
  --exclude-hevc-rext       drop hevc-10b422/hevc-10b444 cases (and their
                            -screen variants; Rext still in driver bug-fix
                            phase; also accepted by run-tests.ps1)
  --exclude-crop            drop the -crop-* cropped-encoding cases (visible
                            rect smaller than the coded frame; h264/hevc/
                            hevc-10b420 x mb/offset/both geometries)
  --stress-resolution       detect each codec/profile's supported resolution
                            range (MediaCapabilities, hardware-gated) and
                            encode+decode 5 geometric points across it
                            (relaxed floors, like the crop cases). Without
                            --all this runs ONLY the resolution detection +
                            stress cases — the rest of the matrix and the
                            comparison legs are skipped
  --output <path>           report path (default: results\ directory; the
                            extension may be .html or .json — --format wins)
  --format <f>              html|json  (default: html — a self-contained
                            section-by-section page, overall status first;
                            the .json data twin is always written too)
  --negative-control        second run with --disable-features=D3D12VideoEncodeAccelerator
  --l1t3-negative-control   extra run with --disable-features=D3D12VideoEncodeAcceleratorL1T3:
                            -l1t3 cases must SKIP (the flag gates L1T3) while
                            -l1t2 cases and the base families must still PASS.
                            The D3D12 legs otherwise always enable
                            D3D12VideoEncodeAcceleratorL1T3 so the -l1t3 cases
                            run against the real path.
  --compare-mf              third run with --enable-features=MediaFoundationVideoEncodeAccelerator
                            + --disable-features=D3D12VideoEncodeAccelerator (informational A/B;
                            all Chrome instances of the D3D12 leg are killed first)
  --allow-no-hw             environment without HW encode → exit 3 instead of 1
  --log-level <n>           vmodule level for d3d12 logs (default: 2)
  --nav-timeout <s>         page load timeout            (default: 20)
  --timeout <s>             per-case timeout override    (default: auto)
  --ignore-gpu-blocklist    pass --ignore-gpu-blocklist to Chrome
  --disable-gpu-driver-bug-workarounds
                            pass --disable-gpu-driver-bug-workarounds to Chrome
  --force                   bypass the Chrome >= ${MIN_SUPPORTED_MAJOR} gate (adds
                            --enable-features=D3D12VideoEncodeAccelerator)
  --keep-profile            do not delete the temp user-data-dir
  --page-external <url>     use an external test page instead of the local server
  --help                    show this help

env:
  D3D12_CI_CHROME           chrome.exe path override
  D3D12_CI_OUTPUT           default for --output
`;

export function parseArgs(argv) {
  const opts = {
    chrome: null,
    codecs:
      'h264,hevc,hevc-10b420,hevc-10b422,hevc-10b444,av1,av1-10b444,av1-8b444,' +
      'av1-screen,av1-10b444-screen,av1-8b444-screen,' +
      'h264-screen,hevc-screen,hevc-10b420-screen,hevc-10b422-screen,' +
      'hevc-10b444-screen,' +
      'h264-crop-mb,h264-crop-offset,h264-crop-both,' +
      'hevc-crop-mb,hevc-crop-offset,hevc-crop-both,' +
      'hevc-10b420-crop-mb,hevc-10b420-crop-offset,hevc-10b420-crop-both,' +
      'h264-l1t2,h264-l1t3,hevc-l1t2,hevc-l1t3,av1-l1t2,av1-l1t3,' +
      'h264-resize,hevc-resize,av1-resize,' +
      'h264-vbr,h264-cqp,hevc-vbr,hevc-cqp,av1-vbr,av1-cqp,' +
      'h264-manual,hevc-manual,av1-manual,' +
      'h264-gpu,hevc-gpu,av1-gpu,' +
      'h264-ratechange,hevc-ratechange,av1-ratechange,' +
      'h264-keyframes,hevc-keyframes,av1-keyframes,' +
      'h264-l1t3-keyframes,hevc-l1t3-keyframes,' +
      'hevc-hdr10,' +
      'h264-dual,hevc-dual,av1-dual',
    resolutions: '720p,1080p',
    frames: 30,
    fps: 30,
    bitrateMode: 'constant',
    bitrateOverride: null,
    requireAll: false,
    excludeHevcRext: false,
    excludeCrop: false,
    output: null,
    format: 'html',
    negativeControl: false,
    l1t3NegativeControl: false,
    compareMf: false,
    allowNoHw: false,
    logLevel: 2,
    navTimeoutSec: 20,
    timeoutSec: null,
    ignoreGpuBlocklist: false,
    disableGpuDriverBugWorkarounds: false,
    stressResolution: false,
    all: false,
    force: false,
    keepProfile: false,
    pageExternal: null,
    minPsnrDb: 24,
    maxMae: 9,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(0, eq) : a;
    const inline = eq >= 0 ? a.slice(eq + 1) : null;
    const need = () => {
      if (inline !== null) return inline;
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${key}`);
      return argv[++i];
    };
    const int = (v) => {
      const n = Number(v);
      if (!Number.isInteger(n)) throw new Error(`${key} must be an integer`);
      return n;
    };
    switch (key) {
      case '--help':
        console.log(USAGE);
        process.exit(0);
        break;
      case '--chrome':
        opts.chrome = need();
        break;
      case '--codecs':
        opts.codecs = need();
        break;
      case '--resolutions':
        opts.resolutions = need();
        break;
      case '--frames':
        opts.frames = int(need());
        break;
      case '--fps':
        opts.fps = int(need());
        break;
      case '--bitrate-mode':
        opts.bitrateMode = need();
        break;
      case '--bitrate':
        opts.bitrateOverride = int(need());
        break;
      case '--require-all':
        opts.requireAll = true;
        break;
      case '--all':
        // Full coverage: every family plus every optional leg. SKIPs stay
        // allowed (environment-dependent support, e.g. no AV1 HW encode on
        // (e.g. a GPU without AV1 encoders still skips the av1 families).
        opts.codecs = 'all';
        opts.stressResolution = true;
        opts.negativeControl = true;
        opts.l1t3NegativeControl = true;
        opts.compareMf = true;
        opts.all = true;
        break;
      case '--exclude-hevc-rext':
        opts.excludeHevcRext = true;
        break;
      case '--exclude-crop':
        opts.excludeCrop = true;
        break;
      case '--output':
        opts.output = need();
        break;
      case '--format':
        opts.format = need();
        if (!['html', 'json'].includes(opts.format)) {
          throw new Error('--format must be html or json');
        }
        break;
      case '--negative-control':
        opts.negativeControl = true;
        break;
      case '--l1t3-negative-control':
        opts.l1t3NegativeControl = true;
        break;
      case '--compare-mf':
        opts.compareMf = true;
        break;
      case '--allow-no-hw':
        opts.allowNoHw = true;
        break;
      case '--log-level':
        opts.logLevel = int(need());
        break;
      case '--nav-timeout':
        opts.navTimeoutSec = int(need());
        break;
      case '--timeout':
        opts.timeoutSec = int(need());
        break;
      case '--ignore-gpu-blocklist':
        opts.ignoreGpuBlocklist = true;
        break;
      case '--disable-gpu-driver-bug-workarounds':
        opts.disableGpuDriverBugWorkarounds = true;
        break;
      case '--stress-resolution':
        opts.stressResolution = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--keep-profile':
        opts.keepProfile = true;
        break;
      case '--page-external':
        opts.pageExternal = need();
        break;
      case '--min-psnr':
        opts.minPsnrDb = Number(need());
        break;
      case '--max-mae':
      case '--min-mae': // deprecated alias
        opts.maxMae = Number(need());
        break;
      default:
        throw new Error(`Unknown option: ${a}\n\n${USAGE}`);
    }
  }

  opts.codecs = parseCodecs(opts.codecs);
  if (opts.excludeHevcRext) {
    opts.codecs = opts.codecs.filter(
      (f) => !f.startsWith('hevc-10b422') && !f.startsWith('hevc-10b444'),
    );
    if (!opts.codecs.length) {
      throw new Error('--exclude-hevc-rext removed all requested codecs');
    }
  }
  if (opts.excludeCrop) {
    opts.codecs = opts.codecs.filter((f) => !f.includes('-crop-'));
    if (!opts.codecs.length) {
      throw new Error('--exclude-crop removed all requested codecs');
    }
  }
  opts.resolutions = parseResolutions(opts.resolutions);
  if (opts.frames < 1) throw new Error('--frames must be a positive integer');
  if (opts.fps < 1) throw new Error('--fps must be a positive integer');
  if (opts.fps > 30) {
    console.warn(
      `warning: the D3D12 VEA advertises a max framerate of 30 — clamping --fps ${opts.fps} to 30`,
    );
    opts.fps = 30;
  }
  if (!['constant', 'variable'].includes(opts.bitrateMode)) {
    throw new Error('--bitrate-mode must be constant or variable');
  }
  if (opts.output === null && process.env.D3D12_CI_OUTPUT) {
    opts.output = process.env.D3D12_CI_OUTPUT;
  }
  if (opts.pageExternal && !/^https?:\/\//.test(opts.pageExternal)) {
    throw new Error('--page-external must be an http(s) URL');
  }
  return opts;
}

// Kills every chrome.exe process whose command line references |userDataDir|
// (i.e. Chrome instances spawned for this harness run). Chrome child
// processes (GPU, renderer, utility) can survive the browser process briefly
// after shutdown; a follow-up leg (e.g. the MF comparison) must not start
// while they are still alive. The user's own Chrome instances are never
// matched, since they do not use this temp profile.
function killChromeInstancesFor(userDataDir) {
  const safe = userDataDir.replace(/'/g, "''");
  const psCmd =
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*${safe}*' } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psCmd],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  );
  if (res.status !== 0 && res.stderr) {
    console.warn(`warning: could not sweep leftover Chrome instances: ${res.stderr.trim()}`);
  }
}

// Reads the shared Chrome debug log written via --log-file (VEA attestation
// lines are emitted by the GPU process into this file).
async function readLogFile(logPath) {
  try {
    const txt = await fs.readFile(logPath, 'utf8');
    const lines = txt.split(/\r?\n/).filter((l) => l.trim());
    return lines.slice(-50_000); // same cap as the stderr ring buffer
  } catch {
    return []; // log file was not created
  }
}

function parseMajor(versionString) {
  if (!versionString) return null;
  const m = String(versionString).match(/(\d+)\.\d+\.\d+\.\d+/);
  return m ? Number(m[1]) : null;
}

// Runs one Chrome leg: launch → CDP → drive the test page → collect
// stderr → attest. Returns a leg object for the report.
//
// |mode| selects the feature configuration:
//   'd3d12'            default (D3D12 VEA on by default in Chrome >= 158;
//                      --enable-features added when < 158 and --force)
//   'negative-control' --disable-features=D3D12VideoEncodeAccelerator
//   'mf'               --enable-features=MediaFoundationVideoEncodeAccelerator
//                      + --disable-features=D3D12VideoEncodeAccelerator
// Every leg terminates its Chrome instance tree before returning; the
// caller additionally sweeps any leftover chrome.exe of the previous leg
// before launching a new one.
async function runLeg({
  chrome,
  pageUrl,
  cases,
  opts,
  mode,
  forceFeatures,
}) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'd3d12-enc-ci-'));
  const flags = [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--noerrdialogs',
    // The suite runs on unsigned/in-development GPU drivers; Chrome's
    // sandbox refuses to load those in the GPU process, so the sandbox is
    // always disabled here. This harness only talks to localhost and runs
    // a self-contained test page.
    '--no-sandbox',
    // Chrome logging is the attestation channel. GPU-process log lines do
    // not reach the browser process's stderr pipe on Windows, so all
    // processes write into a shared log file instead; runLeg() reads it
    // back after the run.
    '--enable-logging',
    `--log-file=${path.join(userDataDir, 'chrome_debug.log')}`,
    `--vmodule=*d3d12*=${opts.logLevel},*media_foundation_video_encode_accelerator_win*=3`,
    // Headed but off-screen: a real GPU process is required for hardware
    // encode, so --headless must never be used here.
    '--window-position=-32000,-32000',
    '--window-size=1280,720',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--no-pings',
    '--no-service-autorun',
    '--disable-sync',
    '--disable-extensions',
    '--password-store=basic',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    // Manual reference buffer control (the -manual cases) is gated behind
    // the experimental WebCodecsVideoEncoderBuffers Blink runtime feature
    // (video_encoder_buffer.idl, status experimental in
    // runtime_enabled_features.json5). Experimental runtime features are
    // NOT base::Features — they are enabled by the "Experimental Web
    // Platform features" switch (render_process_host_impl.cc propagates it
    // to the renderer). Always on, like the L1T3 feature gate.
    '--enable-experimental-web-platform-features',
  ];
  // Feature flags. PlatformHEVCHbdEncoderSupport is ALWAYS enabled: it is
  // required for HEVC high-bit-depth encode (Main10 + 4:2:2/4:4:4 Rext) to
  // be advertised on the D3D12 encoder, even when this run's matrix does
  // not exercise those profiles. All features go into a single
  // --enable-features switch (later occurrences would override earlier).
  const enabledFeatures = ['PlatformHEVCHbdEncoderSupport'];
  const disabledFeatures = [];
  if (mode === 'mf') {
    // MF comparison leg: MF on, D3D12 off.
    enabledFeatures.push('MediaFoundationVideoEncodeAccelerator');
    disabledFeatures.push('D3D12VideoEncodeAccelerator');
  } else {
    // D3D12 legs: kill the MediaFoundation VEA. The factory falls back to
    // MF silently when D3D12 fails, which would mask a broken D3D12
    // encoder; with MF disabled there is no fallback to hide behind.
    disabledFeatures.push('MediaFoundationVideoEncodeAccelerator');
    // L1T3 is gated behind this feature in Chromium
    // (d3d12_video_encode_delegate.cc advertises L1T3 only when it is
    // enabled). The harness enables it BY DEFAULT on every D3D12 leg so the
    // -l1t3 cases always exercise the real path.
    enabledFeatures.push('D3D12VideoEncodeAcceleratorL1T3');
    if (mode === 'l1t3-negative-control') {
      // Flag-off A/B leg: everything identical except the L1T3 gate. The
      // -l1t3 cases must SKIP and the -l1t2 cases must still PASS.
      disabledFeatures.push('D3D12VideoEncodeAcceleratorL1T3');
    } else if (mode === 'negative-control') {
      disabledFeatures.push('D3D12VideoEncodeAccelerator');
    } else if (forceFeatures) {
      enabledFeatures.push('D3D12VideoEncodeAccelerator');
    }
  }
  flags.push(`--enable-features=${enabledFeatures.join(',')}`);
  if (disabledFeatures.length) {
    flags.push(`--disable-features=${disabledFeatures.join(',')}`);
  }
  if (opts.ignoreGpuBlocklist) flags.push('--ignore-gpu-blocklist');
  if (opts.disableGpuDriverBugWorkarounds) {
    flags.push('--disable-gpu-driver-bug-workarounds');
  }
  if (pageUrl.startsWith('http://127.0.0.1:')) {
    flags.push(
      `--unsafely-treat-insecure-origin-as-secure=${new URL(pageUrl).origin}`,
    );
  }
  flags.push('about:blank');

  const proc = launchChrome({ exe: chrome.path, args: flags, userDataDir });
  let browser = null;
  try {
    await proc.waitForDevToolsPort();
    browser = await CDPSession.connect(proc.wsBrowserUrl);

    const version = await browser.send('Browser.getVersion');
    const chromeMajor = parseMajor(version.product);

    // Create the test page target and attach flattened so all page-scoped
    // commands/events are routed through the returned sessionId.
    const { targetId } = await browser.send('Target.createTarget', {
      url: pageUrl,
    });
    const { sessionId } = await browser.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });

    await browser.send('Page.enable', {}, { sessionId });
    await browser.send('Runtime.enable', {}, { sessionId });

    let consoleDone = false;
    const off = browser.on(
      'Runtime.consoleAPICalled',
      (params) => {
        const first = params.args && params.args[0];
        if (first && first.value === '__D3D12_ENC_CI_DONE__') consoleDone = true;
      },
      sessionId,
    );

    // Per-case budget: encode time (frames/fps) × 3 + 60 s of headroom, or
    // the --timeout override.
    const perCaseTimeoutMs = opts.timeoutSec
      ? opts.timeoutSec * 1000
      : Math.ceil((opts.frames / opts.fps) * 3 + 60) * 1000;
    // Stress defs materialize several real encodes each (one per geometric
    // point), so the deadline must weight them by their point count.
    const caseCount = Math.max(
      1,
      cases.reduce((n, c) => n + (c.stressPoints || 1), 0),
    );
    const deadline = Date.now() + perCaseTimeoutMs * caseCount;

    let done = false;
    while (Date.now() < deadline) {
      if (consoleDone) {
        try {
          const r = await browser.send(
            'Runtime.evaluate',
            {
              expression: 'window.__D3D12_ENC_CI_DONE__ === true',
              returnByValue: true,
            },
            { sessionId, timeoutMs: 5000 },
          );
          if (r.result && r.result.value === true) {
            done = true;
            break;
          }
        } catch {
          // Result not ready yet.
        }
      } else {
        try {
          const r = await browser.send(
            'Runtime.evaluate',
            {
              expression: 'window.__D3D12_ENC_CI_DONE__ === true',
              returnByValue: true,
            },
            { sessionId, timeoutMs: 5000 },
          );
          if (r.result && r.result.value === true) {
            done = true;
            break;
          }
        } catch {
          // Page not ready yet — keep polling.
        }
      }
      await sleep(250);
    }
    off();

    let pageResult = null;
    if (done) {
      const r = await browser.send(
        'Runtime.evaluate',
        { expression: 'window.__D3D12_ENC_CI_RESULT__', returnByValue: true },
        { sessionId, timeoutMs: 15_000 },
      );
      pageResult = r.result && r.result.value ? r.result.value : null;
    }

    // Let GPU-process log lines drain before classification, then merge
    // the browser-process stderr with the shared log file (where the VEA
    // attestation lines live).
    await sleep(500);
    const logLines = await readLogFile(path.join(userDataDir, 'chrome_debug.log'));
    const allLines = [...proc.stderrLines, ...logLines];
    const attest = analyzeStderr(allLines);

    try {
      await browser.send('Browser.close', {}, { timeoutMs: 5000 });
    } catch {
      // Fall through to proc.close().
    }
    browser.close();
    await proc.close(5000);
    // Make sure no Chrome process of this leg survives shutdown; the next
    // leg (MF comparison / negative control) must start from a clean slate.
    killChromeInstancesFor(userDataDir);

    return {
      userDataDir,
      spawnArgs: [chrome.path, ...flags],
      stderrLines: allLines,
      chromeProduct: version.product,
      chromeMajor,
      pageResult,
      attest,
      timeout: !done,
    };
  } catch (e) {
    try {
      if (browser) {
        try {
          await browser.send('Browser.close', {}, { timeoutMs: 3000 });
        } catch {
          // Ignore.
        }
        browser.close();
      }
    } catch {
      // Ignore.
    }
    await proc.close(3000);
    throw e;
  } finally {
    try {
      if (!opts.keepProfile) {
        await fs.rm(userDataDir, { recursive: true, force: true });
      }
    } catch {
      // Windows file locks — leave it for the OS to clean up.
    }
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(2);
  }

  let chrome;
  try {
    chrome = findChrome({ explicit: opts.chrome });
  } catch (e) {
    if (e instanceof ChromeNotFoundError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
  chrome.fileVersion = getChromeFileVersion(chrome.path);
  const fileMajor = parseMajor(chrome.fileVersion);

  const finish = async (verdictInfo, mainLeg, negativeLeg, mfLeg, l1t3NegLeg, note) => {
    const finishedAt = new Date().toISOString();
    const report = buildReport({
      startedAt,
      finishedAt,
      opts,
      chrome,
      mainLeg,
      negativeLeg,
      mfLeg,
      l1t3NegLeg,
      verdictInfo,
    });
    const stamp = finishedAt.replace(/[-:TZ.]/g, '').slice(0, 14);
    const outPath =
      opts.output ||
      path.join(RESULTS_DIR, `d3d12-video-encode-test-${stamp}.${opts.format}`);
    try {
      const written = await writeReport(report, outPath, opts.format);
      for (const w of written) console.log(`Report  : ${w}`);
    } catch (e) {
      console.error(`warning: could not write report to ${outPath}: ${e.message}`);
    }
    console.log(printSummary(report));
    if (note) console.error(`note: ${note}`);
    process.exit(verdictInfo.exitCode);
  };

  // Early version gate: the feature is default-enabled only in Chrome >= 158.
  if (fileMajor !== null && fileMajor < MIN_SUPPORTED_MAJOR && !opts.force) {
    await finish(
      {
        verdict: 'UNSUPPORTED_CHROME',
        exitCode: 4,
        reason:
          `Chrome ${fileMajor} < ${MIN_SUPPORTED_MAJOR}: ` +
          'D3D12VideoEncodeAccelerator is not default-enabled in this build. ' +
          'Install Chrome >= 158 or pass --force (adds ' +
          '--enable-features=D3D12VideoEncodeAccelerator).',
      },
      null,
      null,
      null,
    );
  }

  const cases = buildCases(opts);
  // Detection/stress defs run on the D3D12 leg only: with the D3D12 VEA
  // disabled the detection would fail and the stress cases would all SKIP,
  // and the MF comparison expects matrix-shaped rows. Each leg gets its
  // own page server because the config is baked into the served HTML at
  // server creation (lib/page-server.mjs).
  //
  // Stress-only mode: --stress-resolution WITHOUT --all runs the resolution
  // detection + stress cases and nothing else, so the optional comparison
  // legs (which need matrix cases) are skipped too.
  const stressOnly = opts.stressResolution && !opts.all;
  if (stressOnly && (opts.negativeControl || opts.l1t3NegativeControl || opts.compareMf)) {
    console.warn(
      'warning: --stress-resolution without --all runs the resolution ' +
        'stress only — the comparison legs do not apply and are skipped',
    );
  }
  const mainCases = stressOnly ? cases.filter((c) => c.type) : cases;
  const matrixCases = cases.filter((c) => !c.type);
  const serveLeg = async (legCases) => {
    if (opts.pageExternal) {
      return { pageUrl: opts.pageExternal, close: async () => {} };
    }
    const srv = await startPageServer({ config: { cases: legCases } });
    return { pageUrl: srv.url, close: srv.close };
  };

  const forceFeatures = fileMajor !== null && fileMajor < MIN_SUPPORTED_MAJOR && opts.force;

  let mainLeg = null;
  let negativeLeg = null;
  let mfLeg = null;
  let l1t3NegLeg = null;
  let harnessError = null;
  let served = null;
  try {
    served = await serveLeg(mainCases);
    mainLeg = await runLeg({
      chrome,
      pageUrl: served.pageUrl,
      cases: mainCases,
      opts,
      mode: 'd3d12',
      forceFeatures,
    });
  } catch (e) {
    harnessError = e;
  }
  if (served) await served.close();
  if (!harnessError && opts.negativeControl && !stressOnly) {
    try {
      // Start from a clean slate: no Chrome instance of the D3D12 leg may
      // still be alive when the next leg launches.
      if (mainLeg) killChromeInstancesFor(mainLeg.userDataDir);
      served = await serveLeg(matrixCases);
      negativeLeg = await runLeg({
        chrome,
        pageUrl: served.pageUrl,
        cases: matrixCases,
        opts,
        mode: 'negative-control',
        forceFeatures: false,
      });
    } catch (e) {
      harnessError = e;
    }
    if (served) await served.close();
  }
  if (!harnessError && opts.l1t3NegativeControl && !stressOnly) {
    try {
      // Focused A/B leg: the -l1t2/-l1t3 families plus their base families
      // (the hardware control). Runs with
      // --disable-features=D3D12VideoEncodeAcceleratorL1T3.
      const svcBases = new Set(
        opts.codecs
          .filter((f) => /-l1t[23]$/.test(f))
          .map((f) => f.replace(/-l1t[23]$/, '')),
      );
      const legCases = matrixCases.filter(
        (c) => /-l1t[23]$/.test(c.family) || svcBases.has(c.family),
      );
      if (legCases.length === 0) {
        throw new Error(
          '--l1t3-negative-control needs -l1t2/-l1t3 families in --codecs',
        );
      }
      const prevLeg = negativeLeg || mainLeg;
      if (prevLeg) killChromeInstancesFor(prevLeg.userDataDir);
      served = await serveLeg(legCases);
      l1t3NegLeg = await runLeg({
        chrome,
        pageUrl: served.pageUrl,
        cases: legCases,
        opts,
        mode: 'l1t3-negative-control',
        forceFeatures: false,
      });
    } catch (e) {
      harnessError = e;
    }
    if (served) await served.close();
  }
  if (!harnessError && opts.compareMf && !stressOnly) {
    try {
      const prevLeg = negativeLeg || mainLeg;
      if (prevLeg) killChromeInstancesFor(prevLeg.userDataDir);
      served = await serveLeg(matrixCases);
      mfLeg = await runLeg({
        chrome,
        pageUrl: served.pageUrl,
        cases: matrixCases,
        opts,
        mode: 'mf',
        forceFeatures: false,
      });
    } catch (e) {
      harnessError = e;
    }
    if (served) await served.close();
  }

  if (harnessError) {
    const detail =
      harnessError instanceof CDPError
        ? harnessError.message
        : String(harnessError && harnessError.stack) || String(harnessError);
    console.error(`error: ${detail}`);
    if (mainLeg && mainLeg.stderrLines.length) {
      console.error('Chrome stderr tail:\n' + mainLeg.stderrLines.slice(-25).join('\n'));
    }
    await finish(
      { verdict: 'HARNESS_ERROR', exitCode: 2, reason: detail },
      mainLeg,
      negativeLeg,
      mfLeg,
    );
  }

  const verdictInfo = computeVerdict({
    chromeMajor: mainLeg.chromeMajor,
    opts,
    main: {
      cases: mainLeg.pageResult ? mainLeg.pageResult.cases : [],
      secureContext: mainLeg.pageResult ? mainLeg.pageResult.secureContext : null,
      state: mainLeg.pageResult ? mainLeg.pageResult.state : null,
      timeout: mainLeg.timeout,
      attest: mainLeg.attest,
    },
    negativeControl: negativeLeg ? { attest: negativeLeg.attest } : null,
    l1t3NegativeControl: l1t3NegLeg
      ? {
          cases: l1t3NegLeg.pageResult ? l1t3NegLeg.pageResult.cases : [],
          attest: l1t3NegLeg.attest,
        }
      : null,
  });
  await finish(verdictInfo, mainLeg, negativeLeg, mfLeg, l1t3NegLeg);
}

// Run only when executed directly — importing this module (e.g. to unit
// test parseArgs) must not launch the suite.
const isMain =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((e) => {
    console.error(`fatal: ${e && e.stack ? e.stack : e}`);
    process.exit(2);
  });
}
