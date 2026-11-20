// lib/attestation.mjs — proves (or disproves) that the D3D12 video encode
// accelerator actually ran in Chrome's GPU process.
//
// Why this is needed: on Windows, GpuVideoEncodeAcceleratorFactory::CreateVEA
// tries CreateD3D12VEA first and SILENTLY falls back to the MediaFoundation
// VEA when D3D12 creation or Initialize() fails
// (media/gpu/gpu_video_encode_accelerator_factory.cc). A green WebCodecs
// hardware test is therefore not sufficient evidence on its own.
//
// Chrome's stderr (launched with --enable-logging=stderr
// --vmodule=*d3d12*=2,*media_foundation_video_encode_accelerator_win*=3)
// carries the decisive line from D3D12VideoEncodeAccelerator::Initialize()
// (media/gpu/windows/d3d12_video_encode_accelerator.cc):
//   [pid:tid:...:d3d12_video_encode_accelerator.cc(545)] Initialize():
//       Initializing D3D12VEA with config ...
// MF VEA init lines are captured for fallback forensics (non-gating).

export const RE_D3D12_INIT = /Initializing D3D12VEA with config/;
export const RE_DRIVER_SUSPECT =
  /D3D12CreateDevice failed|CheckFeatureSupport for .* failed|Failed to get D3D12 video device|Failed to get an adapter by LUID|Failed to enum adapter by LUID|Failed to create D3D12 device|D3D12VEA error|Unsupported output profile/;
export const RE_MF_INIT =
  /media_foundation_video_encode_accelerator_win\.cc.*Initialize\(\): /;
// The delegate advertises kVariableMode whenever CBR is supported, then
// falls back to CBR at initialize time when the driver rejects VBR
// (d3d12_video_encode_delegate.cc Create()). Report-only: the -vbr cases
// still pass, they just ran as CBR.
export const RE_VBR_FALLBACK =
  /Requested VBR not supported, falling back to CBR/;
// The -ratechange cases gate on the delivered bitrate, so this is
// report-only forensics: the VEA logs it when the driver does not support
// in-place rate control reconfiguration
// (d3d12_video_encode_accelerator.cc UpdateRateControl).
export const RE_RATE_UPDATE_FAIL = /Failed to update bitrate/;

// Classifies the captured stderr lines.
export function analyzeStderr(lines) {
  const d3d12Init = [];
  const driverSuspect = [];
  const mfInit = [];
  const vbrFallback = [];
  const rateUpdateFail = [];
  for (const line of lines) {
    if (RE_D3D12_INIT.test(line)) d3d12Init.push(line);
    if (RE_DRIVER_SUSPECT.test(line)) driverSuspect.push(line);
    if (RE_MF_INIT.test(line)) mfInit.push(line);
    if (RE_VBR_FALLBACK.test(line)) vbrFallback.push(line);
    if (RE_RATE_UPDATE_FAIL.test(line)) rateUpdateFail.push(line);
  }
  return { d3d12Init, driverSuspect, mfInit, vbrFallback, rateUpdateFail };
}

export const MIN_SUPPORTED_MAJOR = 158;

// Verdict contract (see README):
//   PASS(0): every required case passed (cases below the PSNR/MAE quality
//            floor are 'warn' — reported, non-gating) AND the D3D12 init
//            attestation exists.
//   FAIL(1): any required case failed / a required case was skipped under
//            --require-all / an L1T2/L1T3 case skipped while its base family
//            passed (the advertised temporal-layering mode was not usable) /
//            no D3D12 attestation (silent MF fallback) / environment has no
//            hardware encode (without --allow-no-hw).
//   ENV_NO_HW(3): everything skipped, no attestation — only with --allow-no-hw.
//   UNSUPPORTED_CHROME(4): Chrome < 158 without --force.
//   FAIL(5): negative-control leg found D3D12 attestation when the feature
//            was disabled.
//   FAIL(6): L1T3-negative-control leg — with the
//            D3D12VideoEncodeAcceleratorL1T3 feature disabled, the -l1t3
//            cases must all SKIP (the flag gates them) and the -l1t2 cases
//            must all PASS (L1T2 is not flag-gated).
export function computeVerdict({
  chromeMajor,
  opts,
  main,
  negativeControl,
  l1t3NegativeControl,
}) {
  if (chromeMajor !== null && chromeMajor < MIN_SUPPORTED_MAJOR && !opts.force) {
    return {
      verdict: 'UNSUPPORTED_CHROME',
      exitCode: 4,
      reason:
        `Chrome ${chromeMajor} < ${MIN_SUPPORTED_MAJOR}: ` +
        'D3D12VideoEncodeAccelerator is not default-enabled in this build. ' +
        'Install Chrome >= 158 or pass --force (adds ' +
        '--enable-features=D3D12VideoEncodeAccelerator).',
    };
  }

  if (negativeControl) {
    const ncInit = negativeControl.attest.d3d12Init.length;
    if (ncInit > 0) {
      return {
        verdict: 'FAIL',
        exitCode: 5,
        reason:
          `Negative control failed: ${ncInit} "Initializing D3D12VEA with ` +
          'config" line(s) found in a run launched with ' +
          '--disable-features=D3D12VideoEncodeAccelerator.',
      };
    }
  }

  // The flag-off leg proves the feature gates L1T3: with
  // D3D12VideoEncodeAcceleratorL1T3 disabled, every -l1t3 case must SKIP
  // (isConfigSupported rejects the mode against the advertised profiles),
  // every -l1t2 case must still PASS (L1T2 is advertised unconditionally),
  // and the base families must keep passing (the leg's hardware control).
  if (l1t3NegativeControl) {
    const legCases = l1t3NegativeControl.cases || [];
    const l1t3Cases = legCases.filter((c) => /-l1t3$/.test(c.family));
    const problems = [];
    if (l1t3Cases.length === 0) {
      problems.push('no -l1t3 cases ran in the leg');
    }
    for (const c of l1t3Cases) {
      if (c.status !== 'skip') {
        problems.push(
          `${c.id} ${c.status} with the L1T3 feature disabled (expected skip)`,
        );
      }
    }
    // Parity with the main leg: disabling the L1T3 feature must not change
    // the outcome of anything that is not flag-gated — an L1T2 or base case
    // that PASSED in the main leg must still pass here. 'warn' (below the
    // quality floor) is non-gating everywhere and counts as OK. Cases the
    // main leg failed or skipped (e.g. no hardware encode for this codec at
    // all) are already gated there.
    const mainStatusById = new Map(
      (main.cases || []).map((c) => [c.id, c.status]),
    );
    const okInLeg = (s) => s === 'pass' || s === 'warn';
    for (const c of legCases.filter((x) => /-l1t2$/.test(x.family))) {
      if (mainStatusById.get(c.id) === 'pass' && !okInLeg(c.status)) {
        problems.push(
          `${c.id} ${c.status} with the L1T3 feature disabled while it ` +
            'passed in the main leg (L1T2 is not flag-gated)',
        );
      }
    }
    const byId = new Map(legCases.map((c) => [c.id, c]));
    for (const c of l1t3Cases) {
      const baseId = c.family.slice(0, -5) + c.id.slice(c.family.length);
      const base = byId.get(baseId);
      if (base && mainStatusById.get(baseId) === 'pass' &&
          !okInLeg(base.status)) {
        problems.push(
          `${baseId} ${base.status} in the flag-off leg while it passed in ` +
            'the main leg (hardware must still encode without L1T3)',
        );
      }
    }
    if (!l1t3NegativeControl.attest ||
        l1t3NegativeControl.attest.d3d12Init.length === 0) {
      problems.push('no D3D12 attestation in the flag-off leg');
    }
    if (problems.length) {
      return {
        verdict: 'FAIL',
        exitCode: 6,
        reason: `L1T3 negative control failed: ${problems.join('; ')}`,
      };
    }
  }

  const cases = main.cases || [];
  const failed = cases.filter((c) => c.status === 'fail');
  const passed = cases.filter((c) => c.status === 'pass');
  const warned = cases.filter((c) => c.status === 'warn');
  const skipped = cases.filter((c) => c.status === 'skip');

  if (main.timeout || main.state !== 'done') {
    return {
      verdict: 'FAIL',
      exitCode: 1,
      reason: 'test page did not finish within the timeout',
    };
  }
  if (main.secureContext === false) {
    return {
      verdict: 'FAIL',
      exitCode: 1,
      reason:
        'test page is not a secure context — WebCodecs unavailable ' +
        '(page delivery problem)',
    };
  }
  if (failed.length > 0) {
    return {
      verdict: 'FAIL',
      exitCode: 1,
      reason: `${failed.length} case(s) failed: ${failed.map((c) => c.id).join(', ')}`,
    };
  }
  // Temporal-scalability rule: an L1T2/L1T3 case that SKIPs while its base
  // family PASSED in the same run means the advertised temporal-layering
  // mode was not usable — a driver gap or a harness flag problem. av1-l1t3
  // is exempt: Chromium gates AV1 L1T3 off via the
  // disable_d3d12_av1_multi_ref_encoding workaround on some drivers, so a
  // skip there is not actionable by the driver team (reported as a note).
  const svcProblems = [];
  const svcNotes = [];
  const caseStatusById = new Map(cases.map((c) => [c.id, c.status]));
  for (const c of cases) {
    const m = /^(.+)-(l1t2|l1t3)$/.exec(c.family);
    if (!m) continue;
    const baseId = m[1] + c.id.slice(c.family.length);
    if (c.status !== 'skip' || caseStatusById.get(baseId) !== 'pass') continue;
    if (c.family === 'av1-l1t3') {
      svcNotes.push(
        `${c.id} skipped while ${baseId} passed — AV1 L1T3 may be gated off ` +
          'by the disable_d3d12_av1_multi_ref_encoding workaround',
      );
    } else {
      svcProblems.push(
        `${c.id} skipped while ${baseId} passed — the advertised ` +
          `${m[2]} mode was not usable (feature not applied, or the driver ` +
          'does not support temporal layers)',
      );
    }
  }
  if (svcProblems.length) {
    return {
      verdict: 'FAIL',
      exitCode: 1,
      reason: `temporal-scalability gap: ${svcProblems.join('; ')}`,
    };
  }
  if (opts.requireAll && skipped.length > 0) {
    return {
      verdict: 'FAIL',
      exitCode: 1,
      reason:
        `--require-all: ${skipped.length} case(s) skipped: ` +
        skipped.map((c) => c.id).join(', '),
    };
  }
  if (passed.length === 0 && warned.length === 0) {
    if (skipped.length > 0 && main.attest.d3d12Init.length === 0) {
      if (opts.allowNoHw) {
        return {
          verdict: 'ENV_NO_HW',
          exitCode: 3,
          reason:
            'environment has no hardware encode (all cases skipped, no D3D12 attestation)',
        };
      }
      return {
        verdict: 'FAIL',
        exitCode: 1,
        reason:
          'environment has no hardware encode (all cases skipped, no D3D12 ' +
          'attestation). Use --allow-no-hw to accept this as an environment ' +
          'failure rather than a driver failure.',
      };
    }
    return {
      verdict: 'FAIL',
      exitCode: 1,
      reason: 'no passing cases',
    };
  }
  if (main.attest.d3d12Init.length === 0) {
    const mfNote =
      main.attest.mfInit.length > 0
        ? ' MF VEA init was observed — silent fallback suspected.'
        : '';
    return {
      verdict: 'FAIL',
      exitCode: 1,
      reason:
        'D3D12VEA never initialized (no "Initializing D3D12VEA with config" ' +
        `in the GPU process log) although hardware encode passed.${mfNote}`,
    };
  }
  const notes = [];
  notes.push(...svcNotes);
  if (warned.length) {
    notes.push(
      `${warned.length} case(s) below the quality floor (warning, ` +
        `non-gating): ${warned.map((c) => c.id).join(', ')}`,
    );
  }
  if (main.attest.driverSuspect.length > 0) {
    notes.push(
      `${main.attest.driverSuspect.length} D3D12 driver-suspect log line(s) — see report (non-fatal)`,
    );
  }
  return { verdict: 'PASS', exitCode: 0, reason: notes.length ? notes.join('; ') : null };
}
