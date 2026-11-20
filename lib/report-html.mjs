// lib/report-html.mjs — self-contained HTML rendering of the CI report.
//
// Layout: overall status block FIRST (verdict, exit code, reason, counts,
// environment), then section-by-section case tables — resolution
// detection, stress, and one section per test group — then the extra legs
// (negative control, L1T3 flag-off, MF comparison) and the attestation.
// No external resources; per-frame arrays are summarized, the full data
// stays in the JSON twin.

const escapeHtml = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );

const STATUS_CLASS = { pass: 'pass', fail: 'fail', warn: 'warn', skip: 'skip' };

function badge(status) {
  const cls = STATUS_CLASS[status] || 'pending';
  return `<span class="badge ${cls}">${escapeHtml(status || '?')}</span>`;
}

function fmtBytes(n) {
  if (typeof n !== 'number') return '-';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

function actualMbps(c) {
  const enc = c.encode || {};
  if (typeof enc.bytes !== 'number' || !c.frames || !c.fps) return null;
  return (enc.bytes * 8) / (c.frames / c.fps) / 1e6;
}

function bitrateCell(c) {
  const m = actualMbps(c);
  if (m === null) return '-';
  const tgt = typeof c.targetBitrate === 'number' ? c.targetBitrate / 1e6 : 0;
  return `${tgt.toFixed(1)}/${m.toFixed(1)}`;
}

function worstCell(c) {
  const w = c.decode && c.decode.worst;
  if (!w) return '<td class="num">-</td><td class="num">-</td>';
  return `<td class="num">${w.psnrDb.toFixed(1)}</td><td class="num">${w.mae.toFixed(2)}</td>`;
}

// Per-case annotation lines (the same forensics the console summary shows).
function caseNotes(c) {
  const notes = [];
  if (c.reason) notes.push(`reason: ${c.reason}`);
  if (c.colorimetry && c.colorimetry.ok === false && !c.colorimetry.error) {
    notes.push(
      `colorimetry: slope ${c.colorimetry.slope}, intercept ` +
        `${c.colorimetry.intercept} — color-range signaling mismatch suspected`,
    );
  }
  if (c.resolutionRange) {
    const r = c.resolutionRange;
    const dims =
      r.minW !== null
        ? `${r.minW}x${r.minH} .. ${r.maxW}x${r.maxH}`
        : 'unavailable';
    notes.push(`resolution range: ${dims} (${r.source || '-'})`);
  }
  if (c.resolutionMap && c.resolutionMap.bounds.maxW !== null) {
    const m = c.resolutionMap;
    const b = m.bounds;
    notes.push(
      `map: ${m.probeCount} probes, bounds ${b.minW}x${b.minH} .. ` +
        `${b.maxW}x${b.maxH}` +
        (m.holes.length ? `, ${m.holes.length} hole(s)` : ''),
    );
    if (m.dimParity) {
      notes.push(`map dim parity: ${m.chroma} — ${m.dimParity} (odd dims outside the rule are not probed)`);
    }
    notes.push(
      `map curve: ${m.curve.map((p) => `${p.w}:${p.minH}..${p.maxH}`).join(' ')}`,
    );
    if (m.verify) {
      const ok = m.verify.filter((v) => v.status !== 'fail').length;
      const bad = m.verify.filter((v) => v.status === 'fail');
      notes.push(
        `map verify: ${ok}/${m.verify.length} points encodable` +
          (bad.length ? ` — ${bad.map((v) => `${v.w}x${v.h}`).join(', ')} fail` : ''),
      );
    }
  }
  if (c.svc && c.svc.requested) {
    const v = c.svc;
    const t0 = v.t0Subset || {};
    const tids = Object.entries(v.tidCounts || {})
      .sort((a, b) => a[0] - b[0])
      .map(([t, n]) => `T${t}:${n}`)
      .join(' ');
    notes.push(
      `svc ${v.requested}: tids ${tids || '-'}` +
        `${v.firstMismatch ? ' MISMATCH' : ''}; T0-subset ` +
        `${t0.framesDecoded ?? '-'}/${t0.chunks ?? '-'}` +
        (t0.worst ? `, worst ${t0.worst.psnrDb.toFixed(1)} dB` : ''),
    );
    if (v.signalingGap) notes.push(`svc signaling gap: ${v.signalingGap}`);
  }
  if (c.resize && c.resize.keyframeBoundaries) {
    const b = c.resize.keyframeBoundaries
      .map(
        (x) =>
          `f${x.startFrame}:${x.key === 'key' ? 'key' : '!'} ` +
          `${x.spsVisible ?? x.spsCoded ?? '?'}`,
      )
      .join(' · ');
    notes.push(`resize boundaries: ${b}`);
  }
  if (c.ratechange && c.ratechange.segments) {
    const segs = c.ratechange.segments
      .map((s) => {
        // Missing/NaN delivery numbers (segments the gate loop never
        // computed) render as '-' instead of "NaNM (undefined)".
        const actual = Number.isFinite(s.actualBitrate)
          ? (s.actualBitrate / 1e6).toFixed(2) + 'M'
          : '-';
        const ratio = Number.isFinite(s.ratio) ? s.ratio : '-';
        return `#${s.index} ${(s.targetBitrate / 1e6).toFixed(1)}M→` +
          `${actual} (${ratio})`;
      })
      .join(' · ');
    notes.push(`ratechange: ${segs}`);
  }
  if (c.manual) {
    notes.push(
      `manual: ${c.manual.slots ?? '?'}-slot round-robin, ` +
        `${c.manual.bufferCount ?? '?'} advertised handles` +
        (c.manual.note ? ` — ${c.manual.note}` : ''),
    );
  }
  if (c.hdr10) {
    const v = c.hdr10;
    const sps = v.spsVui
      ? `primaries ${v.spsVui.primaries} / transfer ${v.spsVui.transfer} / ` +
        `matrix ${v.spsVui.matrix}`
      : 'no SPS VUI';
    notes.push(`hdr10: SPS VUI ${sps}`);
    if (v.seiNote) notes.push(`hdr10: ${v.seiNote}`);
  }
  if (c.dual && c.dual.streams) {
    const s = c.dual.streams
      .map(
        (x) =>
          `${x.width}x${x.height}: ${x.chunks} chunks, ` +
          `${fmtBytes(x.bytes)}${x.error ? `, error: ${x.error}` : ''}`,
      )
      .join(' · ');
    notes.push(`dual: ${s}`);
  }
  if (c.stressPoint) notes.push(`stress point: ${c.stressPoint.w}x${c.stressPoint.h}`);
  return notes;
}

function caseRow(c) {
  const enc = c.encode || {};
  const notes = caseNotes(c);
  const cells = [
    `<td>${escapeHtml(c.id)}</td>`,
    `<td>${badge(c.status)}</td>`,
    `<td>${escapeHtml(c.codecUsed || '-')}</td>`,
    `<td class="num">${enc.count ?? '-'}</td>`,
    `<td class="num">${enc.keyframes ?? '-'}</td>`,
    `<td class="num">${typeof enc.bytes === 'number' ? fmtBytes(enc.bytes) : '-'}</td>`,
    `<td class="num">${bitrateCell(c)}</td>`,
    worstCell(c),
  ];
  let html = `<tr>${cells.join('')}</tr>`;
  for (const n of notes) {
    html += `<tr class="note"><td colspan="9">${escapeHtml(n)}</td></tr>`;
  }
  return html;
}

// Section classification: first match wins; cases fall through in order.
const BASE_FAMILIES = new Set([
  'h264', 'hevc', 'av1',
  'hevc-10b420', 'hevc-10b422', 'hevc-10b444',
  'av1-10b444', 'av1-8b444',
]);

const SECTIONS = [
  // Case RESULTS do not carry the def's |type|, so classify by id shape.
  { title: 'Resolution detection', pick: (c) => /-resdetect$/.test(c.id || '') },
  { title: 'Resolution stress', pick: (c) => !!c.stressPoint || /-stress-\d+x\d+$/.test(c.id || '') },
  { title: 'Resolution map', pick: (c) => /-resmap$/.test(c.id || '') },
  { title: 'Base codecs', pick: (c) => BASE_FAMILIES.has(c.family) && !/-resdetect$/.test(c.id || '') && !c.stressPoint },
  { title: 'Screen content', pick: (c) => c.family.endsWith('-screen') },
  { title: 'Cropped encoding', pick: (c) => c.family.includes('-crop-') },
  { title: 'Temporal scalability', pick: (c) => /-l1t[23]$/.test(c.family) },
  { title: 'Dynamic frame size', pick: (c) => c.family.endsWith('-resize') },
  { title: 'Bitrate control modes', pick: (c) => c.family.endsWith('-vbr') || c.family.endsWith('-cqp') },
  { title: 'Manual reference control', pick: (c) => c.family.endsWith('-manual') },
  { title: 'GPU shared-image input', pick: (c) => c.family.endsWith('-gpu') },
  { title: 'Rate reconfiguration', pick: (c) => c.family.endsWith('-ratechange') },
  { title: 'Periodic keyframes', pick: (c) => c.family.endsWith('-keyframes') },
  { title: 'HDR', pick: (c) => c.family.endsWith('-hdr10') },
  { title: 'Concurrent dual encoders', pick: (c) => c.family.endsWith('-dual') },
];

function caseTable(cases) {
  const rows = [...cases]
    .sort((a, b) => (a.id || '').localeCompare(b.id || ''))
    .map(caseRow)
    .join('\n');
  return `<table class="cases"><thead><tr>
    <th>Case</th><th>Status</th><th>Codec</th>
    <th class="num">Frames</th><th class="num">Key</th>
    <th class="num">Bytes</th><th class="num">Mbps tgt/act</th>
    <th class="num">PSNR dB</th><th class="num">MAE</th>
  </tr></thead><tbody>\n${rows}\n</tbody></table>`;
}

function section(title, cases) {
  const counts = {
    pass: cases.filter((c) => c.status === 'pass').length,
    fail: cases.filter((c) => c.status === 'fail').length,
    warn: cases.filter((c) => c.status === 'warn').length,
    skip: cases.filter((c) => c.status === 'skip').length,
  };
  const subtitle = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ');
  return `<section><h2>${escapeHtml(title)} <span class="counts">${subtitle}</span></h2>
${caseTable(cases)}</section>`;
}

// Compact leg case table (id / status / worst PSNR / actual Mbps).
function legCaseRow(c) {
  const w = c.decode && c.decode.worst;
  const m = actualMbps(c);
  return `<tr>
    <td>${escapeHtml(c.id)}</td><td>${badge(c.status)}</td>
    <td class="num">${w ? w.psnrDb.toFixed(1) : '-'}</td>
    <td class="num">${m === null ? '-' : m.toFixed(1)}</td>
  </tr>`;
}

function legSection(title, leg) {
  if (!leg) return '';
  const att = leg.attestation || {};
  const rows = ((leg.cases || []).slice().sort((a, b) =>
    (a.id || '').localeCompare(b.id || ''))).map(legCaseRow).join('\n');
  const notes = [];
  if (att.d3d12InitCount > 0) {
    notes.push(`${att.d3d12InitCount} D3D12 init line(s)`);
  }
  if (att.vbrFallbackCount) notes.push(`${att.vbrFallbackCount} VBR fallback(s)`);
  if (att.rateUpdateFailCount) notes.push(`${att.rateUpdateFailCount} rate update failure(s)`);
  return `<section><h2>${escapeHtml(title)}</h2>
${notes.length ? `<p class="leg-note">${notes.map(escapeHtml).join(' · ')}</p>` : ''}
<table class="cases"><thead><tr>
  <th>Case</th><th>Status</th><th class="num">Worst PSNR</th><th class="num">Mbps</th>
</tr></thead>
<tbody>${rows}</tbody></table></section>`;
}

function overallStatus(report) {
  const cases = report.cases || [];
  const pass = cases.filter((c) => c.status === 'pass').length;
  const fail = cases.filter((c) => c.status === 'fail').length;
  const warn = cases.filter((c) => c.status === 'warn').length;
  const skip = cases.filter((c) => c.status === 'skip').length;
  const verdict = report.verdict || '?';
  const cls = verdict === 'PASS' ? 'pass' : 'fail';
  const chrome = report.chrome || {};
  const env = report.environment || {};
  const opts = report.options || {};
  const att = report.attestation || {};
  const optBits = [];
  if (opts.stressResolution) optBits.push('stress-resolution');
  if (opts.negativeControl) optBits.push('negative-control');
  if (opts.l1t3NegativeControl) optBits.push('l1t3-negative-control');
  if (opts.compareMf) optBits.push('compare-mf');
  if (opts.excludeHevcRext) optBits.push('exclude-hevc-rext');
  if (opts.excludeCrop) optBits.push('exclude-crop');
  return `<section class="status">
<h2>Overall status <span class="verdict ${cls}">${escapeHtml(verdict)} (exit ${report.exitCode ?? '?'})</span></h2>
${report.reason ? `<p class="reason">${escapeHtml(report.reason)}</p>` : ''}
<table class="status-grid"><tbody>
  <tr><th>Cases</th><td>${cases.length} total — <span class="ok">${pass} pass</span> · <span class="bad">${fail} fail</span> · <span class="warn">${warn} warn</span> · <span class="warn">${skip} skip</span></td></tr>
  <tr><th>Chrome</th><td>${escapeHtml(chrome.path || '?')} (${escapeHtml(chrome.product || chrome.fileVersion || '?')})</td></tr>
  <tr><th>GPU</th><td>${escapeHtml(env.renderer || '?')}</td></tr>
  <tr><th>Duration</th><td>${report.durationMs ? (report.durationMs / 1000).toFixed(0) + ' s' : '-'} (${escapeHtml(report.startedAt || '-')} → ${escapeHtml(report.finishedAt || '-')})</td></tr>
  <tr><th>Options</th><td>${opts.frames} frames · ${opts.fps} fps · ${escapeHtml((opts.resolutions || []).join(', '))} · bitrate-mode ${escapeHtml(opts.bitrateMode || '-')} · min-psnr ${opts.minPsnrDb ?? '-'} · max-mae ${opts.maxMae ?? '-'}${optBits.length ? ' · ' + optBits.join(' · ') : ''}</td></tr>
  <tr><th>Attestation</th><td>${att.d3d12InitCount ?? 0} × "Initializing D3D12VEA with config"${att.vbrFallbackCount ? ` · ${att.vbrFallbackCount} VBR fallback` : ''}${att.rateUpdateFailCount ? ` · ${att.rateUpdateFailCount} rate update failures` : ''}</td></tr>
</tbody></table>
</section>`;
}

// Dedicated resolution-map detail: the map's data volume (per-width sweep
// rows) does not fit the per-case note lines — render one section per map
// case with a summary header and the full encodable-frontier table.
function mapDetailSection(c) {
  const m = c.resolutionMap;
  if (!m || !m.sweep || !m.sweep.length) return '';
  const b = m.bounds;
  const verifyOk = m.verify ? m.verify.filter((v) => v.status !== 'fail').length : 0;
  const verifyBad = m.verify
    ? m.verify.filter((v) => v.status === 'fail').map((v) => `${v.w}x${v.h}`)
    : [];
  const dev = m.sweep.filter((s) => s.error !== null || s.encMaxH < s.advMaxH);
  const rows = m.sweep
    .map((s) => {
      const deviated = s.error !== null || s.encMaxH < s.advMaxH;
      return `<tr${deviated ? ' class="note"' : ''}>
    <td>${s.w}</td><td class="num">${s.advMinH}</td><td class="num">${s.advMaxH}</td>
    <td class="num">${s.encMinH !== null ? s.encMinH : '-'}</td><td class="num">${s.encMaxH !== null ? s.encMaxH : '-'}</td>
    <td>${s.error ? escapeHtml(s.error) : ''}</td></tr>`;
    })
    .join('\n');
  const summary = [
    `codec ${c.codecUsed || '-'}`,
    m.dimParity ? `parity: ${m.chroma} (${m.dimParity})` : null,
    `advertised ${b.minW}x${b.minH} .. ${b.maxW}x${b.maxH}`,
    `${m.probeCount} probes`,
    m.verify ? `geometric verify ${verifyOk}/${m.verify.length}` : null,
    `sweep ${m.sweep.length} widths, ${dev.length} deviate`,
  ]
    .filter(Boolean)
    .join(' · ');
  return `<section>
<h2>Resolution map: ${escapeHtml(c.id)}</h2>
<p class="leg-note">${summary}${
    verifyBad.length ? ` — geometric failures: ${verifyBad.join(', ')}` : ''
  }</p>
<table class="cases"><thead><tr>
  <th>Width</th><th class="num">Advertised minH</th><th class="num">Advertised maxH</th>
  <th class="num">Encodable minH</th><th class="num">Encodable maxH</th><th>Error</th>
</tr></thead><tbody>
${rows}
</tbody></table></section>`;
}

export function renderHtml(report) {
  const cases = report.cases || [];
  const picked = new Set();
  const body = [];
  body.push(overallStatus(report));
  for (const s of SECTIONS) {
    const inSection = cases.filter((c) => {
      if (picked.has(c)) return false;
      if (s.pick(c)) {
        picked.add(c);
        return true;
      }
      return false;
    });
    if (inSection.length) body.push(section(s.title, inSection));
  }
  const unclassified = cases.filter((c) => !picked.has(c));
  if (unclassified.length) body.push(section('Other', unclassified));
  for (const c of cases) body.push(mapDetailSection(c));
  body.push(legSection('Negative control leg', report.negativeControl));
  body.push(legSection('L1T3 flag-off leg', report.l1t3NegativeControl));
  body.push(legSection('MF VEA comparison leg', report.mfComparison));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>D3D12 Video Encode Test Suite — ${escapeHtml(report.verdict || '?')} (exit ${report.exitCode ?? '?'})</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #1c1e21; }
  header { background: #20232a; color: #fff; padding: 16px 28px; }
  header h1 { margin: 0; font-size: 20px; font-weight: 600; }
  header .sub { color: #9aa0a6; font-size: 13px; margin-top: 4px; }
  main { max-width: 1150px; margin: 0 auto; padding: 20px 28px 60px; }
  section { margin: 22px 0; }
  h2 { font-size: 16px; margin: 0 0 10px; }
  h2 .counts { color: #666; font-size: 12px; font-weight: 500; margin-left: 10px; }
  section.status { background: #fff; border: 1px solid #e3e5e8; border-radius: 8px; padding: 16px 20px; }
  .verdict { display: inline-block; border-radius: 6px; padding: 2px 12px; font-weight: 700; }
  .verdict.pass { background: #d4edda; color: #155724; }
  .verdict.fail { background: #f8d7da; color: #721c24; }
  .reason { color: #b02a37; margin: 8px 0 0; }
  .status-grid { margin-top: 10px; border-collapse: collapse; }
  .status-grid th { text-align: left; padding: 4px 14px 4px 0; color: #666; font-weight: 600; vertical-align: top; }
  .status-grid td { padding: 4px 0; }
  .ok { color: #1e7e34; font-weight: 600; }
  .bad { color: #b02a37; font-weight: 600; }
  .warn { color: #b07900; font-weight: 600; }
  table.cases { border-collapse: collapse; width: 100%; background: #fff; border: 1px solid #e3e5e8; border-radius: 8px; overflow: hidden; }
  table.cases th { text-align: left; font-size: 12px; color: #555; background: #eef0f3; padding: 7px 10px; white-space: nowrap; }
  table.cases td { padding: 6px 10px; font-size: 13px; border-top: 1px solid #eceef1; white-space: nowrap; }
  table.cases td:first-child { font-family: Consolas, monospace; font-size: 12.5px; }
  table.cases tr.note td { color: #8a6d3b; background: #fdf8ec; font-size: 12px; white-space: normal; }
  .num { text-align: right; }
  .badge { display: inline-block; min-width: 40px; text-align: center; border-radius: 10px; padding: 1px 8px; font-size: 12px; font-weight: 600; }
  .badge.pass { background: #d4edda; color: #155724; }
  .badge.fail { background: #f8d7da; color: #721c24; }
  .badge.skip { background: #fff3cd; color: #856404; }
  .badge.warn { background: #ffe0c7; color: #8a4d00; }
  .badge.pending { background: #e2e3e5; color: #383d41; }
  .leg-note { color: #666; font-size: 13px; margin: 4px 0 8px; }
</style>
</head>
<body>
<header>
  <h1>D3D12 Video Encode Test Suite</h1>
  <div class="sub">${escapeHtml(report.tool || 'd3d12-video-encode-test-suite')} · ${escapeHtml(report.chrome ? (report.chrome.product || report.chrome.fileVersion || '') : '')} · ${escapeHtml(report.finishedAt || '')}</div>
</header>
<main>
${body.join('\n')}
</main>
</body>
</html>
`;
}
