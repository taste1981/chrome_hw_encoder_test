// lib/report.mjs — JSON report assembly, human-readable summary and exit
// code mapping.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Assemblies the full report object written to --output (and shown on the
// console). |mainLeg| and |negativeLeg| are the objects returned by runLeg()
// in run-ci.mjs; |verdictInfo| comes from computeVerdict().
export function buildReport({
  startedAt,
  finishedAt,
  opts,
  chrome,
  mainLeg,
  negativeLeg,
  mfLeg,
  l1t3NegLeg,
  verdictInfo,
}) {
  const attestationOf = (leg) =>
    leg
      ? {
          d3d12InitCount: leg.attest.d3d12Init.length,
          d3d12Init: leg.attest.d3d12Init.slice(0, 50),
          driverSuspect: leg.attest.driverSuspect.slice(0, 50),
          mfInitCount: leg.attest.mfInit.length,
          mfInit: leg.attest.mfInit.slice(0, 50),
          vbrFallbackCount: (leg.attest.vbrFallback || []).length,
          vbrFallback: (leg.attest.vbrFallback || []).slice(0, 20),
          rateUpdateFailCount: (leg.attest.rateUpdateFail || []).length,
          rateUpdateFail: (leg.attest.rateUpdateFail || []).slice(0, 20),
        }
      : null;

  const page = mainLeg ? mainLeg.pageResult : null;
  return {
    schemaVersion: 1,
    tool: 'd3d12-video-encode-test-suite',
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    verdict: verdictInfo.verdict,
    exitCode: verdictInfo.exitCode,
    reason: verdictInfo.reason,
    options: {
      codecs: opts.codecs,
      resolutions: opts.resolutions.map((r) => r.nick),
      frames: opts.frames,
      fps: opts.fps,
      bitrateMode: opts.bitrateMode,
      requireAll: opts.requireAll,
      excludeHevcRext: opts.excludeHevcRext,
      negativeControl: opts.negativeControl,
      l1t3NegativeControl: opts.l1t3NegativeControl,
      compareMf: opts.compareMf,
      allowNoHw: opts.allowNoHw,
      force: opts.force,
      stressResolution: opts.stressResolution,
      minPsnrDb: opts.minPsnrDb,
      maxMae: opts.maxMae,
    },
    chrome: mainLeg
      ? {
          path: chrome.path,
          source: chrome.source,
          fileVersion: chrome.fileVersion,
          product: mainLeg.chromeProduct,
          major: mainLeg.chromeMajor,
          spawnArgs: mainLeg.spawnArgs,
          userDataDir: mainLeg.userDataDir,
          stderrLineCount: mainLeg.stderrLines.length,
        }
      : { path: chrome.path, source: chrome.source, fileVersion: chrome.fileVersion },
    environment: page
      ? { renderer: page.renderer, secureContext: page.secureContext }
      : null,
    cases: mainLeg && page ? page.cases : [],
    page: mainLeg
      ? {
          state: page ? page.state : null,
          timeout: mainLeg.timeout,
          ua: page ? page.ua : null,
        }
      : null,
    attestation: attestationOf(mainLeg),
    negativeControl: negativeLeg
      ? {
          attestation: attestationOf(negativeLeg),
          cases: negativeLeg.pageResult ? negativeLeg.pageResult.cases : [],
        }
      : null,
    // Flag-off A/B for temporal scalability: with
    // D3D12VideoEncodeAcceleratorL1T3 disabled, -l1t3 cases must SKIP and
    // -l1t2 cases must PASS (gates the verdict, exit 6).
    l1t3NegativeControl: l1t3NegLeg
      ? {
          attestation: attestationOf(l1t3NegLeg),
          cases: l1t3NegLeg.pageResult ? l1t3NegLeg.pageResult.cases : [],
        }
      : null,
    // MF VEA comparison leg (informational A/B; does not gate the verdict).
    mfComparison: mfLeg
      ? {
          attestation: attestationOf(mfLeg),
          cases: mfLeg.pageResult ? mfLeg.pageResult.cases : [],
        }
      : null,
    platform: {
      os: `${process.platform} ${os.release()}`.trim(),
      node: process.version,
    },
  };
}

// Writes the report in |format| ('html' default, 'json' for the raw data
// only). In html mode the machine-readable JSON is ALWAYS written alongside
// (same stem, .json) — the HTML is the human-facing artifact, the JSON is
// what CI parses/archives. |outputPath| may carry either extension; the
// chosen format wins. Returns the written paths in order.
export async function writeReport(report, outputPath, format = 'html') {
  // Create the parent directory (e.g. results/) if it does not exist yet.
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const stem = outputPath.replace(/\.(html?|json)$/i, '');
  const jsonPath = `${stem}.json`;
  if (format === 'json') {
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    return [jsonPath];
  }
  const { renderHtml } = await import('./report-html.mjs');
  const htmlPath = `${stem}.html`;
  await fs.writeFile(htmlPath, renderHtml(report), 'utf8');
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  return [htmlPath, jsonPath];
}

// Human-readable summary printed to stdout.
export function printSummary(report) {
  const lines = [];
  lines.push('=== D3D12 Video Encode Test Suite ===');
  const chrome = report.chrome || {};
  lines.push(
    `Chrome : ${chrome.path || '?'} (${chrome.product || chrome.fileVersion || '?'})`,
  );
  if (report.environment) {
    lines.push(`GPU    : ${report.environment.renderer}`);
  }
  lines.push('');
  lines.push(
    'Case                  Status   Codec            Frames  Key  Bytes       Bitrate tgt/act  PSNR dB  MAE',
  );
  for (const c of report.cases || []) {
    const dec = c.decode || {};
    const enc = c.encode || {};
    const worst = dec.worst;
    // Actual bitrate derived from the encoded bytes over the frame duration.
    const actualMbps =
      typeof enc.bytes === 'number' && c.frames && c.fps
        ? (enc.bytes * 8) / (c.frames / c.fps) / 1e6
        : null;
    const bitrateCell =
      actualMbps !== null
        ? `${(c.targetBitrate / 1e6).toFixed(1)}/${actualMbps.toFixed(1)}`
        : '-';
    lines.push(
      `${(c.id || '').padEnd(22)} ${(c.status || '').padEnd(8)} ` +
        `${(c.codecUsed || '-').padEnd(16)} ${String(enc.count ?? '-').padEnd(7)} ` +
        `${String(enc.keyframes ?? '-').padEnd(4)} ${String(enc.bytes ?? '-').padEnd(11)} ` +
        `${bitrateCell.padEnd(16)} ` +
        `${worst ? worst.psnrDb.toFixed(1).padStart(6) : '-'.padEnd(9)} ` +
        `${worst ? worst.mae.toFixed(2) : '-'}`,
    );
    if (c.reason && c.status !== 'pass') {
      lines.push(`${''.padEnd(20)}  reason: ${c.reason}`);
    }
    if (c.svc && c.svc.requested) {
      const v = c.svc;
      const t0 = v.t0Subset || {};
      const tids = Object.entries(v.tidCounts || {})
        .sort((a, b) => a[0] - b[0])
        .map(([t, n]) => `T${t}:${n}`)
        .join(' ');
      lines.push(
        `${''.padEnd(20)}  svc ${v.requested}: tids ${tids || '-'}` +
          `${v.firstMismatch ? ' MISMATCH' : ''}; ` +
          `T0-subset decode ${t0.framesDecoded ?? '-'}/${t0.chunks ?? '-'}` +
          (t0.worst ? `, worst ${t0.worst.psnrDb.toFixed(1)} dB` : ''),
      );
      if (v.signalingGap) {
        lines.push(
          `${''.padEnd(20)}  svc signaling gap: ${v.signalingGap}`,
        );
      }
    }
    if (c.colorimetry && c.colorimetry.ok === false && !c.colorimetry.error) {
      lines.push(
        `${''.padEnd(20)}  colorimetry: slope ${c.colorimetry.slope}, ` +
          `intercept ${c.colorimetry.intercept}, maxErr ${c.colorimetry.maxErr} ` +
          '— color-range signaling mismatch suspected',
      );
    }
    if (c.resolutionRange) {
      const r = c.resolutionRange;
      const dims =
        r.minW !== null
          ? `${r.minW}x${r.minH} .. ${r.maxW}x${r.maxH}`
          : 'unavailable';
      lines.push(`${''.padEnd(20)}  resolution range: ${dims} (${r.source || '-'})`);
    }
  }
  lines.push('');
  if (report.attestation) {
    lines.push(
      `Attestation: ${report.attestation.d3d12InitCount} x "Initializing D3D12VEA with config"`,
    );
    if (report.attestation.driverSuspect.length) {
      lines.push(
        `Driver-suspect log lines: ${report.attestation.driverSuspect.length} (see report)`,
      );
    }
    if (report.attestation.mfInit.length) {
      lines.push(
        `MF VEA init lines: ${report.attestation.mfInit.length} (forensics, see report)`,
      );
    }
    if (report.attestation.vbrFallbackCount) {
      lines.push(
        `VBR fallback: ${report.attestation.vbrFallbackCount} x "Requested VBR ` +
          `not supported, falling back to CBR" — the -vbr cases ran as CBR ` +
          '(report-only: the delegate advertises kVariableMode backed by the CBR path)',
      );
    }
    if (report.attestation.rateUpdateFailCount) {
      lines.push(
        `Rate update failures: ${report.attestation.rateUpdateFailCount} x ` +
          '"Failed to update bitrate" (report-only — the -ratechange ' +
          'delivery gates are the verdict)',
      );
    }
  }
  if (report.negativeControl) {
    lines.push(
      `Negative control: ${report.negativeControl.attestation.d3d12InitCount} D3D12 init line(s) ` +
        `(must be 0)`,
    );
  }
  if (report.l1t3NegativeControl) {
    const leg = report.l1t3NegativeControl;
    const l1t3 = (leg.cases || []).filter((c) => /-l1t3$/.test(c.family));
    const l1t2 = (leg.cases || []).filter((c) => /-l1t2$/.test(c.family));
    const skipped = l1t3.filter((c) => c.status === 'skip').length;
    const passed = l1t2.filter((c) => c.status === 'pass').length;
    lines.push(
      `L1T3 flag-off leg: ${skipped}/${l1t3.length} -l1t3 skipped, ` +
        `${passed}/${l1t2.length} -l1t2 passed (both must be all)`,
    );
  }
  if (report.mfComparison) {
    const mfCases = report.mfComparison.cases || [];
    const d3d12ById = new Map((report.cases || []).map((c) => [c.id, c]));
    // Per-case cell: status / worst PSNR @ actual bitrate (Mbps).
    const stat = (c) => {
      if (!c) return '-';
      const worst = c.decode && c.decode.worst;
      const enc = c.encode || {};
      const actualMbps =
        typeof enc.bytes === 'number' && c.frames && c.fps
          ? ((enc.bytes * 8) / (c.frames / c.fps) / 1e6).toFixed(1)
          : null;
      return `${c.status}/${worst ? worst.psnrDb.toFixed(1) + 'dB' : '-'}@` +
        `${actualMbps ?? '-'}`;
    };
    lines.push('');
    lines.push('MF VEA comparison (informational):');
    lines.push('  Case                  D3D12                 MF');
    for (const mf of mfCases) {
      lines.push(
        `  ${mf.id.padEnd(22)} ${stat(d3d12ById.get(mf.id)).padEnd(21)} ${stat(mf)}`,
      );
    }
    lines.push(
      `  MF leg: ${report.mfComparison.attestation.d3d12InitCount} D3D12 init line(s) ` +
        `(must be 0); MF init log lines (forensics only): ` +
        `${report.mfComparison.attestation.mfInitCount}`,
    );
  }
  lines.push(`Verdict: ${report.verdict} (exit ${report.exitCode})`);
  if (report.reason) lines.push(`Reason : ${report.reason}`);
  return lines.join('\n');
}
