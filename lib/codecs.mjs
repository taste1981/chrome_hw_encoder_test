// lib/codecs.mjs — codec string tables and case construction for the
// WebCodecs encode matrix.
//
// The codec strings follow the parsing rules in Chromium's
// media/base/video_codec_string_parsers.cc (avc1 is the 11-character form,
// hvc1/av01 use the dotted profile/level forms) and the profile set
// advertised by the D3D12 video encode delegates
// (media/gpu/windows/d3d12_video_encode_delegate.cc):
//   H264 Baseline/Main/High, HEVC Main, AV1 Main — no VP9.

// Cropped-encoding geometries. Frames are handed to the encoder with a
// visibleRect smaller than the coded canvas, which the accelerator must
// crop to (not scale the padding into). The geometries mirror the manual
// encode_visible_rect_test.html page:
//   mb      coded size has decoder-style macroblock padding below the
//           visible rect (1920x1088 coded, 1920x1080 visible at origin) —
//           catches "squash instead of crop".
//   offset  visible rect at a non-zero origin — catches encoders that
//           ignore the rect origin and encode from the texture origin.
//   both    non-zero origin plus coded padding.
// All values must be even: 4:2:0 chroma is shared between pixel pairs, so
// an odd crop origin does not name a chroma sample.
export const CROP_GEOMETRIES = {
  mb: {
    width: 1920,
    height: 1088,
    crop: { x: 0, y: 0, width: 1920, height: 1080 },
  },
  offset: {
    width: 1920,
    height: 1080,
    crop: { x: 16, y: 8, width: 1888, height: 1064 },
  },
  both: {
    width: 1920,
    height: 1088,
    crop: { x: 32, y: 16, width: 1856, height: 1048 },
  },
};

// Crop cases relax the steady-state PSNR floor: the D3D12 VEA crop path
// resamples the input instead of pixel-cropping (~4-5 dB below the
// uncropped cases at the same bitrate), so a 24 dB default floor would
// fail them for the wrong reason. A --min-psnr override stricter than
// this cap still applies.
const CROP_MIN_PSNR_DB = 21;

// --stress-resolution: number of geometric stress points per detected
// resolution range (min, max and 3 intermediates). Each point is also
// tested in its mirrored portrait orientation when the transposed
// resolution falls inside the detected range.
const STRESS_POINTS = 5;

// A crop family reuses its base family's codec strings, config and decode
// preferences; cropGeom supplies the coded canvas size and the visible rect.
function h264CropFamily(geom) {
  return {
    candidates: ['avc1.42E01E', 'avc1.42001E', 'avc1.640028'], // Main, Baseline, High
    extraConfig: { avc: { format: 'annexb' } },
    decodePrefs: ['no-preference', 'prefer-hardware', 'prefer-software'],
    chroma: '420',
    cropGeom: geom,
  };
}

function hevcCropFamily(geom) {
  return {
    candidates: ['hvc1.1.6.L120.90', 'hvc1.1.6.L93.B0'], // Main
    extraConfig: { hevc: { format: 'annexb' } },
    decodePrefs: ['prefer-hardware', 'no-preference', 'prefer-software'],
    chroma: '420',
    cropGeom: geom,
  };
}

function hevc10CropFamily(geom) {
  return {
    candidates: ['hvc1.2.4.L120.90'], // Main10
    extraConfig: { hevc: { format: 'annexb' } },
    decodePrefs: ['prefer-hardware', 'no-preference', 'prefer-software'],
    bitrateScale: 1.5, // 10-bit carries more bits than 8-bit
    chroma: '420',
    cropGeom: geom,
  };
}

export const FAMILIES = {
  h264: {
    candidates: ['avc1.42E01E', 'avc1.42001E', 'avc1.640028'], // Main, Baseline, High
    chroma: '420',
    // D3D12 VEA emits AnnexB (in-band SPS/PPS with start codes). Encoding
    // and decoding in annexb format avoids the VideoDecoderConfig
    // "description" requirement (a decoder error otherwise).
    extraConfig: { avc: { format: 'annexb' } },
    // Software H.264 decode exists in Chrome (FFmpeg), so try software
    // first for the decode-back comparison: it works on every GPU.
    decodePrefs: ['no-preference', 'prefer-hardware', 'prefer-software'],
  },
  hevc: {
    candidates: ['hvc1.1.6.L120.90', 'hvc1.1.6.L93.B0'], // Main
    chroma: '420',
    extraConfig: { hevc: { format: 'annexb' } },
    // Chrome on Windows has NO software HEVC decode; decode-back needs
    // hardware decode. Unavailable decoder ⇒ decode validation skipped.
    decodePrefs: ['prefer-hardware', 'no-preference', 'prefer-software'],
  },
  av1: {
    candidates: ['av01.0.04M.08'], // Main, 8-bit
    chroma: '420',
    extraConfig: {},
    decodePrefs: ['no-preference', 'prefer-hardware', 'prefer-software'], // dav1d SW decode
  },
  // HEVC Main10: 10-bit 4:2:0 (profile_idc 2 in the codec string).
  'hevc-10b420': {
    candidates: ['hvc1.2.4.L120.90'],
    chroma: '420',
    extraConfig: { hevc: { format: 'annexb' } },
    decodePrefs: ['prefer-hardware', 'no-preference', 'prefer-software'],
    bitrateScale: 1.5, // 10-bit carries more bits than 8-bit
  },
  // HEVC range extensions: the codec string's constraint bytes select the
  // sub-profile (Chromium's kHEVCRextCodecStringParsing in
  // media/base/video_codec_string_parsers.cc): cf0 low bits carry
  // max_bits_flag (0b110 = 10-bit) and max_422_flag; no 422/420 flag set
  // means 4:4:4. The D3D12 VEA maps those to HEVC_MAIN10_422 (P210LE input)
  // and HEVC_MAIN10_444 (P410LE input).
  'hevc-10b422': {
    candidates: ['hvc1.4.10.L153.0D'], // Rext, 10-bit 4:2:2
    chroma: '422',
    extraConfig: { hevc: { format: 'annexb' } },
    decodePrefs: ['prefer-hardware', 'no-preference', 'prefer-software'],
    bitrateScale: 1.5, // 4:2:2 carries more chroma than 4:2:0
  },
  'hevc-10b444': {
    candidates: ['hvc1.4.10.L153.0C'], // Rext, 10-bit 4:4:4
    chroma: '444',
    extraConfig: { hevc: { format: 'annexb' } },
    decodePrefs: ['prefer-hardware', 'no-preference', 'prefer-software'],
    bitrateScale: 2, // 4:4:4 doubles the chroma samples
  },
  // AV1 High profile = 4:4:4 (av01 profile digit 1; dav1d decodes it in SW).
  // NOTE: the AV1 codec-string level field is seq_level_idx (0-31), NOT the
  // decimal level number — "13" = level 5.1. Values > 31 (e.g. "51") fail
  // Chromium's ParseAv1CodecId and the probe rejects the string outright.
  'av1-10b444': {
    candidates: ['av01.1.13M.10'],
    chroma: '444',
    extraConfig: {},
    decodePrefs: ['no-preference', 'prefer-hardware', 'prefer-software'],
    bitrateScale: 2,
  },
  'av1-8b444': {
    candidates: ['av01.1.13M.08'],
    chroma: '444',
    extraConfig: {},
    decodePrefs: ['no-preference', 'prefer-hardware', 'prefer-software'],
    bitrateScale: 2,
  },
  // Screen-content variants of the AV1 families: flat UI-style frames with
  // static text-like detail and a moving cursor, at 1080p only. These catch
  // blurry-text / sharp-edge regressions that the moving-bars pattern cannot.
  'av1-screen': {
    candidates: ['av01.0.08M.08'],
    chroma: '420',
    extraConfig: {},
    decodePrefs: ['no-preference', 'prefer-hardware', 'prefer-software'],
    pattern: 'screen',
    resolutions: ['1080p'],
  },
  'av1-10b444-screen': {
    candidates: ['av01.1.13M.10'],
    chroma: '444',
    extraConfig: {},
    decodePrefs: ['no-preference', 'prefer-hardware', 'prefer-software'],
    bitrateScale: 2,
    pattern: 'screen',
    resolutions: ['1080p'],
  },
  'av1-8b444-screen': {
    candidates: ['av01.1.13M.08'],
    chroma: '444',
    extraConfig: {},
    decodePrefs: ['no-preference', 'prefer-hardware', 'prefer-software'],
    bitrateScale: 2,
    pattern: 'screen',
    resolutions: ['1080p'],
  },
  // Screen-content variants of the H.264/HEVC families: same codec strings,
  // formats and decode preferences as the base family, but the flat
  // UI-style pattern at 1080p only. Screen capture is the dominant
  // real-world use of H.264/HEVC hardware encoders, and the 4:4:4 Rext
  // variant is the profile most sensitive to text-sharpness regressions
  // (no chroma subsampling blur on colored glyphs).
  'h264-screen': {
    candidates: ['avc1.42E01E', 'avc1.42001E', 'avc1.640028'], // Main, Baseline, High
    chroma: '420',
    extraConfig: { avc: { format: 'annexb' } },
    decodePrefs: ['no-preference', 'prefer-hardware', 'prefer-software'],
    pattern: 'screen',
    resolutions: ['1080p'],
  },
  'hevc-screen': {
    candidates: ['hvc1.1.6.L120.90', 'hvc1.1.6.L93.B0'], // Main
    chroma: '420',
    extraConfig: { hevc: { format: 'annexb' } },
    decodePrefs: ['prefer-hardware', 'no-preference', 'prefer-software'],
    pattern: 'screen',
    resolutions: ['1080p'],
  },
  'hevc-10b420-screen': {
    candidates: ['hvc1.2.4.L120.90'], // Main10
    chroma: '420',
    extraConfig: { hevc: { format: 'annexb' } },
    decodePrefs: ['prefer-hardware', 'no-preference', 'prefer-software'],
    bitrateScale: 1.5,
    pattern: 'screen',
    resolutions: ['1080p'],
  },
  'hevc-10b422-screen': {
    candidates: ['hvc1.4.10.L153.0D'], // Rext, 10-bit 4:2:2
    chroma: '422',
    extraConfig: { hevc: { format: 'annexb' } },
    decodePrefs: ['prefer-hardware', 'no-preference', 'prefer-software'],
    bitrateScale: 1.5,
    pattern: 'screen',
    resolutions: ['1080p'],
  },
  'hevc-10b444-screen': {
    candidates: ['hvc1.4.10.L153.0C'], // Rext, 10-bit 4:4:4
    chroma: '444',
    extraConfig: { hevc: { format: 'annexb' } },
    decodePrefs: ['prefer-hardware', 'no-preference', 'prefer-software'],
    bitrateScale: 2,
    pattern: 'screen',
    resolutions: ['1080p'],
  },
  // Cropped-encoding variants of the base H.264/HEVC families: the input
  // frames carry a visibleRect smaller than the coded canvas and the
  // accelerator must encode exactly that region — not scale the coded
  // padding into the picture (squash) and not encode from the texture
  // origin (wrong region). Fixed geometry (one case per family; the
  // resolution cross product does not apply). AV1 has no crop family yet:
  // decoding its sequence header OBU for the stream's coded size (needed to
  // configure the decode-back) is not implemented in the test page.
  'h264-crop-mb': h264CropFamily(CROP_GEOMETRIES.mb),
  'h264-crop-offset': h264CropFamily(CROP_GEOMETRIES.offset),
  'h264-crop-both': h264CropFamily(CROP_GEOMETRIES.both),
  'hevc-crop-mb': hevcCropFamily(CROP_GEOMETRIES.mb),
  'hevc-crop-offset': hevcCropFamily(CROP_GEOMETRIES.offset),
  'hevc-crop-both': hevcCropFamily(CROP_GEOMETRIES.both),
  'hevc-10b420-crop-mb': hevc10CropFamily(CROP_GEOMETRIES.mb),
  'hevc-10b420-crop-offset': hevc10CropFamily(CROP_GEOMETRIES.offset),
  'hevc-10b420-crop-both': hevc10CropFamily(CROP_GEOMETRIES.both),
};

// Temporal-scalability (L1T2/L1T3) variants of the base families: same codec
// strings, formats and decode preferences, plus a scalabilityMode.
// Chromium's D3D12 VEA advertises L1T2 unconditionally and L1T3 only when the
// D3D12VideoEncodeAcceleratorL1T3 feature is enabled — the harness enables it
// by default on the D3D12 legs (d3d12_video_encode_delegate.cc
// GetSupportedProfiles()). The frame->layer pattern is fixed by Chromium's
// SVCLayers (media/gpu/svc_layers.cc): L1T2 = [T0,T1] repeating, L1T3 =
// [T0,T2,T1,T2] repeating from the keyframe. The test page validates the
// bitstream temporal IDs against that pattern and decodes the T0-only
// subsequence, which must be self-contained (a T0 frame references only
// earlier T0 frames — a silently ignored scalability mode cannot pass this).
for (const [base, layers] of [
  ['h264', [2, 3]],
  ['hevc', [2, 3]],
  ['av1', [2, 3]],
]) {
  for (const n of layers) {
    FAMILIES[`${base}-l1t${n}`] = {
      ...FAMILIES[base],
      temporalLayers: n,
      scalabilityMode: `L1T${n}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Dynamic encoded frame size (mid-stream reconfiguration) variants of the
// base families: start at 1080p, then cycle through 640x360 / 1280x720 /
// 1920x1080 twice, changing the encoded size every RESIZE_SEGMENT_FRAMES
// frames — 7 segments x 15 frames = 105 frames total, each segment starting
// with a keyframe at its own default bitrate. The encoder must survive
// reinitialization at every size (the D3D12 VEA does not advertise
// supports_frame_size_change, so Chromium tears the accelerator down and
// reinitializes it on each size change — video_encode_accelerator_adapter.cc
// ChangeOptionsOnAcceleratorThread), the bitstream must carry an in-band SPS
// change at every boundary, and the decode-back must follow it.
const RESIZE_SEGMENT_FRAMES = 15;

export function resizeSchedule(bitrateScale = 1, bitrateOverride = null) {
  // Start at 1080p, then iterate 360p -> 720p -> 1080p twice.
  const cycle = [
    RESOLUTION_PRESETS['1080p'],
    RESOLUTION_PRESETS['360p'],
    RESOLUTION_PRESETS['720p'],
    RESOLUTION_PRESETS['1080p'],
    RESOLUTION_PRESETS['360p'],
    RESOLUTION_PRESETS['720p'],
    RESOLUTION_PRESETS['1080p'],
  ];
  return cycle.map((p) => ({
    width: p.width,
    height: p.height,
    frames: RESIZE_SEGMENT_FRAMES,
    bitrate: bitrateOverride
      ? Math.round(
          (defaultBitrate(p) * bitrateOverride) /
            defaultBitrate(RESOLUTION_PRESETS['1080p']),
        )
      : Math.round(defaultBitrate(p) * bitrateScale),
  }));
}

for (const base of ['h264', 'hevc', 'av1']) {
  FAMILIES[`${base}-resize`] = {
    ...FAMILIES[base],
    resize: true,
  };
}

// Bitrate-control-mode variants (VBR / CQP) of the h264/hevc/av1 base
// families. CBR is the base family's own mode (--bitrate-mode, default
// constant), so only the other advertised modes get dedicated families.
// Chromium mapping (blink video_encoder.cc / d3d12_video_encode_delegate.cc):
//   'variable'  -> VariableBitrate(target, 10x peak) -> kVariableMode ->
//                  D3D12 VBR; when the driver rejects VBR the delegate logs
//                  "Requested VBR not supported, falling back to CBR." and
//                  runs CBR (the harness reports that from the GPU log).
//   'quantizer' -> ExternalRateControl() -> kExternalMode -> D3D12 CQP at a
//                  fixed QP 26 (blink never sets a per-frame quantizer, so
//                  the delegate's default applies; bitrate is content-
//                  adaptive and the config bitrate is ignored).
// The mode families probe EXACTLY their mode: an unsupported mode SKIPs
// instead of silently running another one.
for (const [mode, nick] of [['variable', 'vbr'], ['quantizer', 'cqp']]) {
  for (const base of ['h264', 'hevc', 'av1']) {
    FAMILIES[`${base}-${nick}`] = {
      ...FAMILIES[base],
      bitrateMode: mode,
      bitrateModes: [mode],
    };
  }
}

// Manual reference buffer control variants of the h264/hevc/av1 base
// families: scalabilityMode 'manual' switches the encoder to
// manual_reference_buffer_control — Chromium stops driving the reference
// pattern (SVCLayers) and the page picks per-frame references via
// getAllFrameBuffers() + EncodeOptions.referenceBuffers/updateBuffer. The
// API surface (VideoEncoderBuffer) is gated behind the EXPERIMENTAL
// WebCodecsVideoEncoderBuffers Blink runtime feature, which the harness
// enables through --enable-experimental-web-platform-features (not a
// base::Feature — see run-ci.mjs). The D3D12 delegates resolve the buffer
// ids into D3D12_VIDEO_ENCODE_REFERENCE_FRAMES
// (d3d12_video_encode_delegate.cc manual path) and reject non-keyframes
// with empty reference buffers, so the page never requests the
// empty-refs-intra form.
for (const base of ['h264', 'hevc', 'av1']) {
  FAMILIES[`${base}-manual`] = {
    ...FAMILIES[base],
    scalabilityMode: 'manual',
  };
}

// GPU-input (decode-to-encode transcode) variants: the source frames for
// the encode are the VideoDecoder OUTPUT of a first-pass encode — GPU
// shared images on Windows — so the VEA takes its shared-image input path
// (DoEncodeTask's HasSharedImage branch: the frame's resolved picture is
// handed to the delegate untouched, visible_rect preserved), not the CPU
// upload path. kD3D12SharedImageEncode is default-enabled, so the adapter
// passes GMB frames straight through when the profile advertises shared
// image support.
for (const base of ['h264', 'hevc', 'av1']) {
  FAMILIES[`${base}-gpu`] = {
    ...FAMILIES[base],
    frameSource: 'transcode',
  };
}

// Rate-only reconfiguration variants: same encoded size throughout, the
// bitrate changes every RATE_SEGMENT_FRAMES frames through configure()
// ([1x, 0.5x, 2x, 1x] of the resolution default). Chromium routes
// rate-only changes through ChangeOptions ->
// RequestEncodingParametersChange WITHOUT tearing the accelerator down
// (unlike the -resize cases), so these cases test the driver's in-place
// rate control reconfiguration. The page gates on per-segment delivered
// bitrate (relative transitions + absolute band) — a driver that ignores
// the update keeps the old rate and fails the transitions.
export const RATE_SEGMENT_FRAMES = 20;

export function rateSchedule(resolution, bitrateScale = 1, bitrateOverride = null) {
  const base =
    bitrateOverride ?? Math.round(defaultBitrate(resolution) * bitrateScale);
  // [1x, 0.5x, 2x, 0.5x]: the FINAL drop goes far below the pattern's
  // saturation ceiling, where an ignored rate update separates cleanly
  // from an applied one. The dither pattern is cheap enough that the
  // encoder saturates at the higher targets (e.g. both an 8M and a 4M
  // target deliver the same ~4.6M content ceiling on this box), so a
  // high-to-high downward step is ambiguous by design.
  return [1, 0.5, 2, 0.5].map((f) => ({
    frames: RATE_SEGMENT_FRAMES,
    bitrate: Math.round(base * f),
  }));
}

for (const base of ['h264', 'hevc', 'av1']) {
  FAMILIES[`${base}-ratechange`] = {
    ...FAMILIES[base],
    rateChange: true,
  };
}

// Periodic keyframes: keyFrame: true every |keyFrameInterval| frames (in
// addition to frame 0). The -l1t3-keyframes combined cases use an interval
// of 16 — a multiple of 4 — so the SVCLayers temporal pattern stays
// aligned with the frame index across the keyframe resets
// (GetPictureParamAndMetadata restarts at T0 on every keyframe).
for (const base of ['h264', 'hevc', 'av1']) {
  FAMILIES[`${base}-keyframes`] = {
    ...FAMILIES[base],
    keyFrameInterval: 15,
    resolutions: ['1080p'],
  };
}
for (const base of ['h264', 'hevc']) {
  FAMILIES[`${base}-l1t3-keyframes`] = {
    ...FAMILIES[`${base}-l1t3`],
    keyFrameInterval: 16,
    resolutions: ['1080p'],
  };
}

// HDR10: HEVC Main10 with BT.2020/PQ color signaling on every frame and
// hdrMetadata (SMPTE ST 2086 + CTA-861-3) in the frame init. The
// hdrMetadata dictionary member is a no-op until a Chromium build exposes
// it (WebCodecs VideoFrameMetadata has no hdrMetadata field in this tree —
// the page passes it anyway so the case upgrades automatically), so the
// HDR10 SEI presence is a report-only finding; the hard gates are the SPS
// VUI BT.2020/PQ signaling and the decode-back.
FAMILIES['hevc-hdr10'] = {
  candidates: ['hvc1.2.4.L120.90'], // Main10
  chroma: '420',
  extraConfig: { hevc: { format: 'annexb' } },
  decodePrefs: ['prefer-hardware', 'no-preference', 'prefer-software'],
  bitrateScale: 1.5,
  pattern: 'video',
  resolutions: ['1080p'],
  hdr10: true,
  // The BT.2020/PQ decode-back roundtrip goes through color conversion on
  // the comparison canvas, so the quality floors are relaxed like the crop
  // cases; the hard gate is the SPS VUI signaling.
  relaxedQuality: true,
};

// Concurrent dual encoders: two VideoEncoder instances running
// simultaneously in one case (one 720p, one 1080p stream, interleaved
// encode) — two VEA instances share the GPU/device, so this catches driver
// instance limits and cross-instance state bugs.
for (const base of ['h264', 'hevc', 'av1']) {
  FAMILIES[`${base}-dual`] = {
    ...FAMILIES[base],
    dual: true,
  };
}

export const RESOLUTION_PRESETS = {
  '360p': { width: 640, height: 360 },
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '2160p': { width: 3840, height: 2160 },
};

// "h264,hevc,av1" or "all" → validated family name list.
export function parseCodecs(str) {
  const wanted =
    String(str).toLowerCase() === 'all'
      ? Object.keys(FAMILIES)
      : String(str)
          .toLowerCase()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
  const unknown = wanted.filter((f) => !FAMILIES[f]);
  if (unknown.length) {
    throw new Error(
      `Unknown codec(s): ${unknown.join(', ')} (known: ${Object.keys(FAMILIES).join(', ')})`,
    );
  }
  if (!wanted.length) throw new Error('No codecs specified');
  return wanted;
}

// "720p,1080p" or "1280x720,1920x1080" → [{width, height, nick}].
export function parseResolutions(str) {
  const out = [];
  for (const tok of String(str)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const preset = RESOLUTION_PRESETS[tok.toLowerCase()];
    if (preset) {
      out.push({ ...preset, nick: tok.toLowerCase() });
      continue;
    }
    const m = tok.match(/^(\d{2,5})x(\d{2,5})$/i);
    if (!m) {
      throw new Error(
        `Unknown resolution "${tok}" (use e.g. 720p,1080p or 1280x720)`,
      );
    }
    const width = Number(m[1]);
    const height = Number(m[2]);
    if (width < 64 || height < 64 || width % 2 || height % 2) {
      throw new Error(`Resolution "${tok}" must be even and >= 64x64`);
    }
    out.push({ width, height, nick: `${width}x${height}` });
  }
  if (!out.length) throw new Error('No valid resolutions specified');
  return out;
}

export function defaultBitrate({ height }) {
  if (height <= 480) return 2_000_000;
  if (height <= 720) return 4_000_000;
  if (height <= 1080) return 8_000_000;
  return 16_000_000;
}

export function buildCases({
  codecs,
  resolutions,
  frames,
  fps,
  bitrateMode,
  bitrateOverride,
  minPsnrDb,
  maxMae,
  stressResolution = false,
}) {
  const cases = [];
  for (const family of codecs) {
    const f = FAMILIES[family];
    // Resize families encode at one fixed schedule (start 1080p, cycle
    // 360p/720p/1080p twice, 15 frames per segment): the resolution cross
    // product does not apply and the frame count is the schedule's total.
    if (f.resize) {
      const schedule = resizeSchedule(f.bitrateScale ?? 1, bitrateOverride);
      cases.push({
        id: family,
        family,
        codecCandidates: f.candidates,
        extraConfig: f.extraConfig,
        decodePrefs: f.decodePrefs,
        pattern: f.pattern ?? 'video',
        resize: true,
        resizeSchedule: schedule,
        width: schedule[0].width,
        height: schedule[0].height,
        frames: schedule.reduce((n, s) => n + s.frames, 0),
        fps,
        bitrate: schedule[0].bitrate,
        bitrateMode,
        minPsnrDb,
        maxMae,
      });
      continue;
    }
    // Crop families encode at one fixed geometry: the coded canvas and the
    // visible rect come from the family, so the resolution cross product
    // does not apply. The bitrate targets the visible content.
    if (f.cropGeom) {
      const { width, height, crop } = f.cropGeom;
      cases.push({
        id: family,
        family,
        codecCandidates: f.candidates,
        extraConfig: f.extraConfig,
        decodePrefs: f.decodePrefs,
        pattern: f.pattern ?? 'video',
        crop,
        width,
        height,
        frames,
        fps,
        bitrate:
          bitrateOverride ??
          Math.round(defaultBitrate({ height: crop.height }) * (f.bitrateScale ?? 1)),
        bitrateMode,
        minPsnrDb: Math.min(minPsnrDb, CROP_MIN_PSNR_DB),
        maxMae,
      });
      continue;
    }
    // Dual-encoder case: the two concurrent streams (720p + 1080p) live
    // inside the case itself, so the resolution cross product does not
    // apply.
    if (f.dual) {
      cases.push({
        id: family,
        family,
        codecCandidates: f.candidates,
        extraConfig: f.extraConfig,
        decodePrefs: f.decodePrefs,
        pattern: f.pattern ?? 'video',
        dual: true,
        width: RESOLUTION_PRESETS['1080p'].width,
        height: RESOLUTION_PRESETS['1080p'].height,
        frames,
        fps,
        bitrate:
          bitrateOverride ??
          Math.round(
            defaultBitrate(RESOLUTION_PRESETS['1080p']) *
              (f.bitrateScale ?? 1),
          ),
        bitrateMode,
        minPsnrDb,
        maxMae,
      });
      continue;
    }
    // A family may restrict itself to specific resolutions (e.g. the
    // screen-content variants run at 1080p only).
    const resList = f.resolutions
      ? f.resolutions.map((nick) => ({
          ...RESOLUTION_PRESETS[nick],
          nick,
        }))
      : resolutions;
    for (const res of resList) {
      // Rate-only reconfiguration: fixed encoded size, the bitrate changes
      // every segment through configure() — Chromium routes rate-only
      // changes through ChangeOptions / RequestEncodingParametersChange
      // without reinitializing the accelerator (unlike -resize).
      if (f.rateChange) {
        const schedule = rateSchedule(
          res, f.bitrateScale ?? 1, bitrateOverride);
        cases.push({
          id: `${family}-${res.nick}`,
          family,
          codecCandidates: f.candidates,
          extraConfig: f.extraConfig,
          decodePrefs: f.decodePrefs,
          pattern: f.pattern ?? 'video',
          rateChange: true,
          rateSchedule: schedule,
          width: res.width,
          height: res.height,
          frames: schedule.reduce((n, s) => n + s.frames, 0),
          fps,
          bitrate: schedule[0].bitrate,
          bitrateMode,
          minPsnrDb,
          maxMae,
        });
        continue;
      }
      cases.push({
        id: `${family}-${res.nick}`,
        family,
        codecCandidates: f.candidates,
        extraConfig: f.extraConfig,
        decodePrefs: f.decodePrefs,
        pattern: f.pattern ?? 'video',
        width: res.width,
        height: res.height,
        frames,
        fps,
        bitrate:
          bitrateOverride ??
          Math.round(defaultBitrate(res) * (f.bitrateScale ?? 1)),
        bitrateMode: f.bitrateMode ?? bitrateMode,
        minPsnrDb: f.relaxedQuality
          ? Math.min(minPsnrDb, CROP_MIN_PSNR_DB)
          : minPsnrDb,
        maxMae,
        ...(f.relaxedQuality ? { relaxedQuality: true } : {}),
        // Mode families probe EXACTLY their mode (no fallback to another
        // bitrate-control mode); everything else probes constant then
        // variable.
        ...(f.bitrateModes ? { bitrateModes: f.bitrateModes } : {}),
        // Periodic keyframes / GPU-frame source (transcode) / HDR10 frame
        // metadata — carried into the page's encode path.
        ...(f.keyFrameInterval ? { keyFrameInterval: f.keyFrameInterval } : {}),
        ...(f.frameSource ? { frameSource: f.frameSource } : {}),
        ...(f.hdr10 ? { hdr10: true } : {}),
        // Temporal-scalability families request the SVC mode in every probe
        // and configure() call; the page validates the resulting structure
        // (T0-subset decode proof gates; bitstream temporal-ID signaling is
        // report-only forensics).
        ...(f.scalabilityMode
          ? { scalabilityMode: f.scalabilityMode, temporalLayers: f.temporalLayers }
          : {}),
      });
    }
  }
  // Resolution-range detection and stress cases (below) run once per unique
  // codec string; see the comment on the dedupe key.
  const detectDefs = [];
  const stressDefs = [];
  const seen = new Set();
  for (const family of codecs) {
    const f = FAMILIES[family];
    if (f.cropGeom) continue; // crop variants share their base family's codec
    const key = `${f.candidates[0]}:${f.chroma}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const resList = f.resolutions
      ? f.resolutions.map((nick) => ({
          ...RESOLUTION_PRESETS[nick],
          nick,
        }))
      : resolutions;
    // Baseline = the smallest matrix resolution for this family: the page
    // cross-checks MediaCapabilities against it and seeds the max/min
    // searches from it. Smallest by area — CLI resolution order is not
    // guaranteed sorted.
    const base = resList.reduce((a, b) =>
      b.width * b.height < a.width * a.height ? b : a,
    );
    detectDefs.push({
      type: 'resdetect',
      id: `${family}-resdetect`,
      family,
      codecCandidates: f.candidates,
      extraConfig: f.extraConfig,
      chroma: f.chroma,
      baselineWidth: base.width,
      baselineHeight: base.height,
      fps,
      baselineBitrate:
        bitrateOverride ??
        Math.round(defaultBitrate({ height: base.height }) * (f.bitrateScale ?? 1)),
    });
    if (!stressResolution) continue;
    stressDefs.push({
      type: 'resstress',
      id: `${family}-resstress`,
      family,
      codecCandidates: f.candidates,
      extraConfig: f.extraConfig,
      decodePrefs: f.decodePrefs,
      chroma: f.chroma,
      pattern: 'video',
      baselineWidth: base.width,
      baselineHeight: base.height,
      stressPoints: STRESS_POINTS,
      frames,
      fps,
      bitrateMode,
      maxMae,
      // Stress cases gate on resolution coverage, not rate-control tuning:
      // same relaxed steady-state floor as the crop cases.
      minPsnrDb: Math.min(minPsnrDb, CROP_MIN_PSNR_DB),
      relaxedQuality: true,
      // Bitrate reference for a 1280x720 pivot; per-point targets scale by
      // pixel area in the page.
      refBitrate:
        bitrateOverride ??
        Math.round(
          defaultBitrate(RESOLUTION_PRESETS['720p']) * (f.bitrateScale ?? 1),
        ),
    });
  }
  return [...detectDefs, ...cases, ...stressDefs];
}
