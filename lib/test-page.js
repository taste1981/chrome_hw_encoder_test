// test-page.js — WebCodecs hardware-encode functional test. Runs inside
// Chrome; the d3d12-encode-ci harness serves this script on a page with
// window.__D3D12_ENC_CI_CONFIG__ pre-set.
//
// For every case in the config the page:
//   1. probes VideoEncoder.isConfigSupported() with
//      hardwareAcceleration:'prefer-hardware' over the family's codec
//      string candidates,
//   2. encodes N frames of a deterministic, frame-index-dependent test
//      pattern (noise + moving color bars + checkerboard strip) and
//      snapshots the output chunks,
//   3. decodes the bitstream back with VideoDecoder, renders each decoded
//      frame to a canvas and compares it pixel-by-pixel (PSNR + MAE)
//      against the regenerated source pattern — this in-page comparison is
//      the "was the encoding actually successful" detector.
//
// Communication with the harness:
//   window.__D3D12_ENC_CI_RESULT__  (final result object)
//   window.__D3D12_ENC_CI_DONE__    (true once the run finished)
//   console.log('__D3D12_ENC_CI_DONE__', ...) (early-completion marker)

(function () {
  'use strict';
  if (window.__D3D12_ENC_CI_STARTED__) return;
  window.__D3D12_ENC_CI_STARTED__ = true;

  const CONFIG = window.__D3D12_ENC_CI_CONFIG__ || { cases: [] };
  // The first frame is a keyframe with in-band headers; give it a softer
  // floor than the steady-state frames.
  const F0_MIN_PSNR_DB = 23;
  // CBR rate control needs a few frames to converge after the keyframe;
  // frames 1..WARMUP_FRAMES-1 use a dedicated warm-up floor.
  const WARMUP_FRAMES = 5;
  const WARMUP_MIN_PSNR_DB = 24;
  const WARMUP_MAX_MAE = 12;
  // Cropped-encoding cases relax the quality floors: the D3D12 VEA crop
  // path resamples the input (video processor) instead of pixel-cropping,
  // which costs ~4-5 dB at the same bitrate even though the geometry is
  // correct (measured 22.4-23.6 dB where the uncropped cases reach 27-28).
  // The geometry gates (magenta leak, edge bands, decoded visible rect)
  // stay strict; these floors only bound gross corruption.
  const CROP_F0_MIN_PSNR_DB = 20;
  const CROP_WARMUP_MIN_PSNR_DB = 21;
  // Temporal-scalability cases (scalabilityMode L1T2/L1T3):
  //   - the frame->layer pattern is fixed by Chromium's SVCLayers
  //     (media/gpu/svc_layers.cc): L1T2 = [T0,T1], L1T3 = [T0,T2,T1,T2]
  //     repeating from the keyframe;
  //   - the T0-only subsequence must decode on its own (T0 frames reference
  //     only earlier T0 frames) — the structural proof that the stream is
  //     really temporally layered. Its frames get a dedicated soft floor:
  //     above concealment garbage (a flat stream decoded without its
  //     reference frames collapses far below 21 dB on the moving pattern),
  //     below the steady-state floors (T0 quality varies with the layer
  //     bitrate split);
  //   - T2, the non-reference tier of L1T3, is quality-relaxed like the
  //     crop cases: it receives the smallest share of the CBR allocation;
  //   - the bitstream temporal IDs are REPORT-ONLY forensics (drivers that
  //     build the structure without signaling the layer IDs in-band are
  //     common enough that the signaling is not gated — user decision).
  //     The structural and quality gates above still apply.
  const SVC_MIN_FRAMES = 4;
  const SVC_T0_MIN_PSNR_DB = 21;
  const SVC_T2_MAX_MAE = 12;
  const OUTPUT_BYTE_CAP = 64 * 1024 * 1024;
  // Resolution-range detection (resdetect): upper bound for the max-dim
  // search and the hardware-encode probe bitrate budget.
  const RESDETECT_MAX_DIM = 16384;
  // Stress points must stay large enough for the test pattern and
  // psnrMae()'s 2 px comparison margin to remain meaningful.
  const STRESS_MIN_PX = 16;
  // Chromium's MediaCapabilities smoothness threshold (pixels per second):
  // at or below it powerEfficient is reported via the software pps
  // shortcut, not a hardware check (EncodingInfo() in
  // media_recorder_handler.cc) — probe records flag the shortcut region.
  const MC_PPS_THRESHOLD = 1280 * 720 * 30;

  // Resolution ranges detected by the resdetect cases, keyed by primary
  // codec string. The run is strictly sequential: resdetect defs precede
  // the matrix and the resstress defs, so stress runners always find the
  // range their detection sibling stored here.
  const detectedRanges = new Map();

  const result = {
    state: 'running',
    ua: navigator.userAgent,
    secureContext: self.isSecureContext,
    renderer: 'unknown',
    startedAt: new Date().toISOString(),
    cases: [],
  };
  window.__D3D12_ENC_CI_DONE__ = false;
  window.__D3D12_ENC_CI_RESULT__ = result;

  function rendererString() {
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    } catch (e) {
      // Ignore.
    }
    return 'unknown';
  }

  // Deterministic pseudo-random generator (mulberry32), seeded per pixel so
  // the pattern is reproducible for the decode-back comparison.
  function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  // The test pattern. Properties:
  //   - frame-index dependent: moving bars mean a decoder stuck on frame 0
  //     fails the per-frame comparison on later frames;
  //   - chroma-rich: 4:2:0 color-conversion bugs show up in the MAE metric;
  //   - temporally stable background (static gradient + noise texture):
  //     P-frames can exploit it, so a healthy encoder at the default
  //     bitrates passes the PSNR/MAE thresholds with large margin while
  //     corrupt output still fails hard.
  const bgCache = new Map(); // `${w}x${h}` → OffscreenCanvas

  function backgroundCanvas(w, h) {
    const key = `${w}x${h}`;
    let canvas = bgCache.get(key);
    if (canvas) return canvas;
    canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        // Low-frequency deterministic dither: one value per 8×8 block
        // (±16) over a slow diagonal gradient. Cheap for any encoder,
        // reproducible on both sides, chroma-rich.
        const bx = x >> 3;
        const by = y >> 3;
        const n =
          (mulberry32((bx * 0x85ebca6b + by * 0x27d4eb2f) >>> 0)() * 32) | 0;
        const gx = Math.round((140 * x) / w);
        const gy = Math.round((100 * y) / h);
        d[o] = gx + 30 + n - 16;
        d[o + 1] = gy + 50 + n - 16;
        d[o + 2] = 120 - gx / 2 + gy / 2 + n - 16;
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    bgCache.set(key, canvas);
    return canvas;
  }

  function drawPattern(ctx, w, h, frameIndex) {
    ctx.drawImage(backgroundCanvas(w, h), 0, 0);
    // Three vertical bars (red/green/blue) that move 5 px per frame.
    const shift = (frameIndex * 5) % 64;
    const barColors = ['rgb(180,90,90)', 'rgb(90,170,90)', 'rgb(90,90,180)'];
    for (let band = 0; band < 3; band++) {
      ctx.fillStyle = barColors[band];
      for (let x = band * 16 + shift; x < w; x += 64) {
        ctx.fillRect(x, 0, 16, h);
      }
    }
    // Static cyan checkerboard strip along the bottom.
    ctx.fillStyle = 'rgb(90,180,190)';
    for (let y = h - 96; y < h; y += 32) {
      for (let x = ((y / 32) % 2) * 32; x < w; x += 64) {
        ctx.fillRect(x, y, 32, 32);
      }
    }
  }

  // Screen-content pattern: flat UI-style frame with static text-like glyph
  // blocks and a moving cursor. Static between frames except the cursor —
  // like a real desktop capture. Catches blurry-text / sharp-edge
  // regressions that the moving-bars pattern cannot.
  function drawScreenPattern(ctx, w, h, frameIndex) {
    ctx.fillStyle = 'rgb(235,235,235)';
    ctx.fillRect(0, 0, w, h);
    // Window panel with a 1 px border.
    ctx.fillStyle = 'rgb(255,255,255)';
    ctx.fillRect(24, 24, w - 48, h - 48);
    ctx.strokeStyle = 'rgb(60,60,60)';
    ctx.lineWidth = 1;
    ctx.strokeRect(24.5, 24.5, w - 49, h - 49);
    // Static pseudo-text: deterministic glyph blocks on a 14×24 px grid.
    const rows = Math.floor((h - 80) / 24);
    const cols = Math.floor((w - 80) / 14);
    for (let ty = 0; ty < rows; ty++) {
      const y = 40 + ty * 24;
      for (let tx = 0; tx < cols; tx++) {
        const s = mulberry32((tx * 0x27d4eb2f + ty * 0x85ebca6b) >>> 0)();
        if (s >= 0.6) continue; // blank cell
        const x = 40 + tx * 14;
        ctx.fillStyle = 'rgb(20,20,20)';
        ctx.fillRect(x, y, 8, 12);
        if (s < 0.3) ctx.fillRect(x + 2, y + 2, 4, 8);
      }
    }
    // Moving cursor (frame-index dependent; the only per-frame change).
    const cx = 30 + ((frameIndex * 7) % Math.max(64, w - 60));
    const cy = 60 + ((frameIndex * 3) % Math.max(64, h - 120));
    ctx.strokeStyle = 'rgb(200,30,30)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy + 16);
    ctx.lineTo(cx + 4, cy + 13);
    ctx.lineTo(cx + 9, cy + 17);
    ctx.stroke();
  }

  // Crop pattern: the coded canvas is filled with saturated magenta outside
  // the visible rect and the standard video pattern inside it. Nothing in
  // the video pattern ever has a high red AND high blue channel, so magenta
  // in the decoded output can only come from the padding region: an encoder
  // that scales the padding in instead of cropping blends it into the
  // picture, which the magenta-fraction check catches.
  function drawCropPattern(ctx, w, h, frameIndex, crop) {
    ctx.fillStyle = 'rgb(255,0,255)';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(crop.x, crop.y, crop.width, crop.height);
    ctx.clip();
    drawPattern(ctx, w, h, frameIndex);
    ctx.restore();
  }

  function patternFor(caseDef) {
    if (caseDef.pattern === 'screen') return drawScreenPattern;
    if (caseDef.crop) {
      const c = caseDef.crop;
      return (ctx, w, h, frameIndex) => drawCropPattern(ctx, w, h, frameIndex, c);
    }
    return drawPattern;
  }

  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label)), ms);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  // Luma-dimension alignment for a chroma sampling (mirrors the rules in
  // lib/codecs.mjs): 4:2:0 needs both axes even, 4:2:2 needs width even,
  // 4:4:4 is unconstrained. Every probe and stress dimension goes through
  // this — an unaligned 4:2:0/4:2:2 size is not a valid encoder config.
  function alignForChroma(dim, chroma, axis) {
    const needEven = chroma === '420' || (chroma === '422' && axis === 'w');
    return needEven ? dim - (dim % 2) : dim;
  }

  // Per-frame PSNR (dB) and mean absolute error over RGB, cropped by a 2 px
  // margin to ignore 4:2:0 chroma edge effects.
  function psnrMae(srcData, dstData, w, h) {
    const margin = 2;
    let sumSq = 0;
    let sumAbs = 0;
    let n = 0;
    for (let y = margin; y < h - margin; y++) {
      for (let x = margin; x < w - margin; x++) {
        const o = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const diff = srcData[o + c] - dstData[o + c];
          sumSq += diff * diff;
          sumAbs += Math.abs(diff);
          n++;
        }
      }
    }
    const mse = sumSq / n;
    const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
    return { psnrDb: psnr, mae: sumAbs / n };
  }

  // Crop-aware comparison: like psnrMae() but also reports the magenta
  // fraction and the mean error of each 4% edge band. Magenta in the output
  // can only come from the padding outside the visible rect, so it detects
  // padding leaking in; a crop that scales instead of trims concentrates
  // its error along one edge, so the band ratio catches what the frame
  // average misses. Thresholds follow the manual encode_visible_rect_test.
  const MAX_MAGENTA_FRAC = 0.0005;
  const MAX_BAND_RATIO = 3;
  const MIN_BAND_ERR = 12;

  function analyzeCrop(srcData, dstData, w, h) {
    const margin = 2;
    let sumSq = 0;
    let sumAbs = 0;
    let magenta = 0;
    let n = 0;
    const bandY = Math.max(1, Math.round(h * 0.04));
    const bandX = Math.max(1, Math.round(w * 0.04));
    const bands = { top: [0, 0], bottom: [0, 0], left: [0, 0], right: [0, 0] };
    for (let y = margin; y < h - margin; y++) {
      for (let x = margin; x < w - margin; x++) {
        const o = (y * w + x) * 4;
        const r = dstData[o], g = dstData[o + 1], b = dstData[o + 2];
        if (r > 140 && b > 140 && g < 90) magenta++;
        const err =
          (Math.abs(r - srcData[o]) +
            Math.abs(g - srcData[o + 1]) +
            Math.abs(b - srcData[o + 2])) / 3;
        sumAbs += err;
        for (let c = 0; c < 3; c++) {
          const diff = srcData[o + c] - dstData[o + c];
          sumSq += diff * diff;
        }
        n++;
        if (y < bandY) { bands.top[0] += err; bands.top[1]++; }
        if (y >= h - bandY) { bands.bottom[0] += err; bands.bottom[1]++; }
        if (x < bandX) { bands.left[0] += err; bands.left[1]++; }
        if (x >= w - bandX) { bands.right[0] += err; bands.right[1]++; }
      }
    }
    const mse = sumSq / n;
    const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
    const bandMean = (k) => (bands[k][1] ? bands[k][0] / bands[k][1] : 0);
    return {
      psnrDb: psnr,
      mae: sumAbs / n,
      magentaFrac: magenta / n,
      bands: {
        top: bandMean('top'), bottom: bandMean('bottom'),
        left: bandMean('left'), right: bandMean('right'),
      },
    };
  }

  // Colorimetry probe: encodes a 256×64 luma ramp (0..255) with the same
  // codec and decodes it back, then fits the per-column error against the
  // input luma. A healthy path shows slope≈1, intercept≈0, maxErr≤3. A
  // full/limited-range signaling mismatch shows up as slope≈1.164,
  // intercept≈-18 (data stored full-range but flagged limited, or vice
  // versa). Report-only: it explains PSNR failures; it does not gate.
  async function colorimetryCheck(caseDef, codecUsed, decodePref) {
    const W = 256;
    const H = 64;
    const out = { width: W, height: H, samples: {} };
    try {
      const drawRamp = (ctx) => {
        const img = ctx.createImageData(W, H);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const o = (y * W + x) * 4;
            img.data[o] = img.data[o + 1] = img.data[o + 2] = x;
            img.data[o + 3] = 255;
          }
        }
        ctx.putImageData(img, 0, 0);
      };
      const chunks = [];
      const encoder = new VideoEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          chunks.push({ type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration, data });
        },
        error: (e) => { throw e; },
      });
      const cvs = new OffscreenCanvas(W, H);
      const ctx = cvs.getContext('2d');
      const dur = Math.round(1e6 / 30);
      encoder.configure({
        codec: codecUsed,
        width: W,
        height: H,
        bitrate: 2_000_000,
        framerate: 30,
        bitrateMode: 'constant',
        latencyMode: 'quality',
        hardwareAcceleration: 'prefer-hardware',
        ...caseDef.extraConfig,
      });
      for (let i = 0; i < 3; i++) {
        drawRamp(ctx);
        const frame = new VideoFrame(cvs, { timestamp: i * dur, duration: dur });
        try { encoder.encode(frame, { keyFrame: i === 0 }); } finally { frame.close(); }
      }
      await encoder.flush();
      encoder.close();

      const decCvs = new OffscreenCanvas(W, H);
      const decCtx = decCvs.getContext('2d');
      const sampleXs = [0, 16, 32, 64, 96, 128, 160, 192, 224, 235, 255];
      const profile = {};
      const decoder = new VideoDecoder({
        output: (frame) => {
          decCtx.drawImage(frame, 0, 0);
          const d = decCtx.getImageData(0, 0, W, H).data;
          for (const x of sampleXs) {
            let sum = 0;
            for (let y = 0; y < H; y++) {
              const o = (y * W + x) * 4;
              sum += d[o] - x;
            }
            profile[x] = (profile[x] || 0) + sum / H;
          }
          frame.close();
        },
        error: (e) => { throw e; },
      });
      decoder.configure({
        codec: codecUsed,
        codedWidth: W,
        codedHeight: H,
        hardwareAcceleration: decodePref || 'prefer-hardware',
        optimizeForLatency: false,
        ...caseDef.extraConfig,
      });
      for (const ch of chunks) {
        decoder.decode(new EncodedVideoChunk({
          type: ch.type,
          timestamp: ch.timestamp,
          duration: ch.duration,
          data: ch.data,
        }));
      }
      await decoder.flush();
      decoder.close();

      // Least-squares fit over the unclamped mid-range samples (32..224).
      let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
      for (const x of [32, 64, 96, 128, 160, 192, 224]) {
        const decoded = x + profile[x] / 3;
        sx += x; sy += decoded; sxx += x * x; sxy += x * decoded; n++;
      }
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      const intercept = (sy - slope * sx) / n;
      let maxErr = 0;
      for (const x of sampleXs) {
        out.samples[x] = Number((profile[x] / 3).toFixed(2));
        maxErr = Math.max(maxErr, Math.abs(profile[x] / 3));
      }
      out.slope = Number(slope.toFixed(4));
      out.intercept = Number(intercept.toFixed(2));
      out.maxErr = Number(maxErr.toFixed(2));
      // The range-mismatch signature is a slope/intercept distortion
      // (~1.164/-18 for full-vs-limited); residual CBR compression error on
      // a ramp is a few levels, so maxErr uses a loose ceiling.
      out.ok =
        Math.abs(slope - 1) < 0.02 && Math.abs(intercept) < 3 && maxErr <= 6;
      if (!out.ok) {
        out.note =
          'color-range signaling mismatch suspected: data range does not ' +
          'match the bitstream flags (full vs limited range)';
      }
    } catch (e) {
      out.error = String(e);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Bitstream-level color signaling inspection: parses the SPS VUI of the
  // first keyframe (ground truth for the colorimetry probe — reads
  // video_full_range_flag and colour_description straight from the
  // bitstream instead of inferring them from decoded pixels).

  class BitReader {
    constructor(bytes) {
      this.b = bytes;
      this.pos = 0;
    }
    bit() {
      // Bounds check: a misaligned parse must throw, never spin.
      if (this.pos >= this.b.length * 8) throw new Error('bitstream overrun');
      const v = (this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
      this.pos++;
      return v;
    }
    u(n) {
      let v = 0;
      for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
      return v;
    }
    ue() {
      let z = 0;
      while (this.bit() === 0) {
        z++;
        if (z > 32) throw new Error('ue() overrun');
      }
      let v = 1;
      for (let i = 0; i < z; i++) v = (v << 1) | this.bit();
      return v - 1;
    }
    se() {
      const u = this.ue();
      return u & 1 ? (u + 1) >> 1 : -(u >> 1);
    }
  }

  // AnnexB start codes: 00 00 01 or 00 00 00 01.
  function findNalUnits(data) {
    const nals = [];
    let i = 0;
    while (i + 3 < data.length) {
      let sc = 0;
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) sc = 3;
      else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) sc = 4;
      if (sc) {
        if (nals.length) nals[nals.length - 1].end = i;
        nals.push({ start: i, header: i + sc, type: data[i + sc] & 0x1f });
        i += sc;
      } else {
        i++;
      }
    }
    if (nals.length) nals[nals.length - 1].end = data.length;
    return nals;
  }

  function skipScalingList(br, size) {
    if (br.u(1)) {
      // scaling_list_pred_mode_flag == 1: delta-coded coefficients.
      let last = 8;
      let next = 8;
      for (let i = 0; i < size; i++) {
        if (next !== 0) next = (last + br.se() + 256) % 256;
        last = next === 0 ? last : next;
      }
    } else {
      br.ue(); // scaling_list_pred_matrix_id_delta (copy mode)
    }
  }

  // H.264 SPS (payload after the 1-byte NAL header).
  function parseH264SpsVui(sps) {
    const br = new BitReader(sps);
    const out = {};
    out.profileIdc = br.u(8);
    out.constraintFlags = br.u(8);
    out.levelIdc = br.u(8);
    br.ue(); // seq_parameter_set_id
    const highProfiles = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];
    if (highProfiles.includes(out.profileIdc)) {
      out.chromaFormatIdc = br.ue();
      if (out.chromaFormatIdc === 3) br.u(1); // separate_colour_plane_flag
      out.bitDepthLuma = br.ue() + 8;
      out.bitDepthChroma = br.ue() + 8;
      br.u(1); // qpprime_y_zero_transform_bypass_flag
      if (br.u(1)) {
        const numLists = out.chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < numLists; i++) skipScalingList(br, i < 6 ? 16 : 64);
      }
    }
    br.ue(); // log2_max_frame_num_minus4
    const pocType = br.ue();
    if (pocType === 0) {
      br.ue(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (pocType === 1) {
      br.u(1); // delta_pic_order_always_zero_flag
      br.se(); // offset_for_non_ref_pic
      br.se(); // offset_for_top_to_bottom_field
      const n = br.ue();
      for (let i = 0; i < n; i++) br.se();
    }
    br.ue(); // max_num_ref_frames
    br.u(1); // gaps_in_frame_num_value_allowed_flag
    const picWidthMbs = br.ue() + 1; // pic_width_in_mbs_minus1
    const picHeightMapUnits = br.ue() + 1; // pic_height_in_map_units_minus1
    const frameMbsOnly = br.u(1);
    if (!frameMbsOnly) br.u(1); // mb_adaptive_frame_field_flag
    br.u(1); // direct_8x8_inference_flag
    out.codedWidth = picWidthMbs * 16;
    out.codedHeight = picHeightMapUnits * 16 * (2 - (frameMbsOnly ? 1 : 0));
    if (br.u(1)) {
      // frame_cropping_flag: offsets in units of SubWidthC/SubHeightC luma
      // samples (2 for 4:2:0 frame coding, 1 for 4:4:4).
      const cropLeft = br.ue();
      const cropRight = br.ue();
      const cropTop = br.ue();
      const cropBottom = br.ue();
      // This encoder always emits 4:2:0 (chromaFormatIdc absent from the
      // SPS means 4:2:0 for Baseline/Main profiles), so the units are 2x2.
      const subW = out.chromaFormatIdc === 3 ? 1 : 2;
      const subH = out.chromaFormatIdc === 3 ? 1 : 2;
      out.frameCrop = { left: cropLeft, right: cropRight, top: cropTop, bottom: cropBottom };
      out.visibleWidth = out.codedWidth - (cropLeft + cropRight) * subW;
      out.visibleHeight = out.codedHeight - (cropTop + cropBottom) * subH;
    }
    out.vuiPresent = !!br.u(1);
    if (!out.vuiPresent) return out;
    if (br.u(1)) {
      // aspect_ratio_info_present_flag
      const idc = br.u(8);
      if (idc === 255) {
        br.u(16);
        br.u(16);
      }
    }
    if (br.u(1)) br.u(1); // overscan_info_present_flag + overscan_appropriate_flag
    out.videoSignalTypePresent = !!br.u(1);
    if (out.videoSignalTypePresent) {
      br.u(3); // video_format
      out.fullRange = !!br.u(1); // video_full_range_flag
      out.colourDescPresent = !!br.u(1);
      if (out.colourDescPresent) {
        out.primaries = br.u(8);
        out.transfer = br.u(8);
        out.matrix = br.u(8);
      }
    }
    return out;
  }

  // HEVC SPS (payload after the 2-byte NAL header, nal_unit_type == 33).
  function parseHevcSpsVui(sps) {
    const br = new BitReader(sps);
    const out = {};
    br.u(4); // sps_video_parameter_set_id
    const maxSubLayers = br.u(3); // sps_max_sub_layers_minus1
    br.u(1); // sps_temporal_id_nesting_flag
    // profile_tier_level(profilePresentFlag = 1, maxSubLayers)
    out.profileSpace = br.u(2);
    out.tier = br.u(1);
    out.profileIdc = br.u(5);
    out.compatFlags = br.u(32);
    out.progressive = !!br.u(1);
    out.interlaced = !!br.u(1);
    out.nonPacked = !!br.u(1);
    out.frameOnly = !!br.u(1);
    br.u(44); // general_reserved_zero_44bits
    out.levelIdc = br.u(8);
    const subLayerProfile = [];
    const subLayerLevel = [];
    for (let i = 0; i < maxSubLayers; i++) {
      subLayerProfile.push(br.u(1));
      subLayerLevel.push(br.u(1));
    }
    if (maxSubLayers > 0) for (let i = maxSubLayers; i < 8; i++) br.u(2);
    for (let i = 0; i < maxSubLayers; i++) {
      if (subLayerProfile[i]) {
        br.u(2); br.u(1); br.u(5); br.u(32);
        br.u(1); br.u(1); br.u(1); br.u(1);
        br.u(44);
      }
      if (subLayerLevel[i]) br.u(8);
    }
    br.ue(); // sps_seq_parameter_set_id
    out.chromaFormatIdc = br.ue();
    if (out.chromaFormatIdc === 3) br.u(1); // separate_colour_plane_flag
    out.codedWidth = br.ue(); // pic_width_in_luma_samples
    out.codedHeight = br.ue(); // pic_height_in_luma_samples
    if (br.u(1)) {
      // conformance_window_flag: offsets in units of SubWidthC/SubHeightC
      // luma samples (2 for 4:2:0, 1 for 4:4:4).
      const winLeft = br.ue();
      const winRight = br.ue();
      const winTop = br.ue();
      const winBottom = br.ue();
      const subW = out.chromaFormatIdc === 1 || out.chromaFormatIdc === 2 ? 2 : 1;
      const subH = out.chromaFormatIdc === 1 ? 2 : 1;
      out.confWin = { left: winLeft, right: winRight, top: winTop, bottom: winBottom };
      out.visibleWidth = out.codedWidth - (winLeft + winRight) * subW;
      out.visibleHeight = out.codedHeight - (winTop + winBottom) * subH;
    }
    out.bitDepthLuma = br.ue() + 8;
    out.bitDepthChroma = br.ue() + 8;
    const picOrderCntLsbBits = br.ue() + 4; // log2_max_pic_order_cnt_lsb_minus4
    const orderingInfoPresent = !!br.u(1);
    for (let i = orderingInfoPresent ? 0 : maxSubLayers; i <= maxSubLayers; i++) {
      br.ue(); // sps_max_dec_pic_buffering_minus1
      br.ue(); // sps_max_num_reorder_pics
      br.ue(); // sps_max_latency_increase_plus1
    }
    br.ue(); // log2_min_luma_coding_block_size_minus3
    br.ue(); // log2_diff_max_min_luma_coding_block_size
    br.ue(); // log2_min_luma_transform_block_size_minus2
    br.ue(); // log2_diff_max_min_luma_transform_block_size
    br.ue(); // max_transform_hierarchy_depth_inter
    br.ue(); // max_transform_hierarchy_depth_intra
    if (br.u(1)) {
      // scaling_list_enabled_flag
      if (br.u(1)) {
        // scaling_list_data_present_flag
        for (let sizeId = 0; sizeId < 4; sizeId++) {
          const numMatrices = sizeId === 3 ? 2 : 6;
          for (let m = 0; m < numMatrices; m++) {
            skipScalingList(br, Math.min(64, 1 << (4 + (sizeId << 1))));
          }
        }
      }
    }
    br.u(1); // amp_enabled_flag
    br.u(1); // sample_adaptive_offset_enabled_flag
    if (br.u(1)) {
      // pcm_enabled_flag
      br.u(4); // pcm_sample_bit_depth_luma_minus1
      br.u(4); // pcm_sample_bit_depth_chroma_minus1
      br.ue(); // log2_min_pcm_luma_coding_block_size_minus3
      br.ue(); // log2_diff_max_min_pcm_luma_coding_block_size
      br.u(1); // pcm_loop_filter_disabled_flag
    }
    const numRps = br.ue(); // num_short_term_ref_pic_sets
    for (let i = 0; i < numRps; i++) {
      if (br.u(1)) {
        // inter_ref_pic_set_prediction_flag
        br.ue(); // delta_idx_minus1
        br.u(1); // delta_rps_sign
        br.ue(); // abs_delta_rps_minus1
      } else {
        const numNeg = br.ue();
        const numPos = br.ue();
        for (let j = 0; j < numNeg; j++) {
          br.ue();
          br.u(1);
        }
        for (let j = 0; j < numPos; j++) {
          br.ue();
          br.u(1);
        }
      }
    }
    if (br.u(1)) {
      // long_term_ref_pics_present_flag
      const n = br.ue();
      for (let i = 0; i < n; i++) {
        br.u(picOrderCntLsbBits); // lt_ref_pic_poc_lsb_sps
        br.u(1); // used_by_curr_pic_lt_sps_flag
      }
    }
    br.u(1); // sps_temporal_mvp_enabled_flag
    br.u(1); // strong_intra_smoothing_enabled_flag
    out.vuiPresent = !!br.u(1);
    if (!out.vuiPresent) return out;
    if (br.u(1)) {
      const idc = br.u(8); // aspect_ratio_idc
      if (idc === 255) {
        br.u(16);
        br.u(16);
      }
    }
    if (br.u(1)) br.u(1); // overscan
    out.videoSignalTypePresent = !!br.u(1);
    if (out.videoSignalTypePresent) {
      br.u(3); // video_format
      out.fullRange = !!br.u(1); // video_full_range_flag
      out.colourDescPresent = !!br.u(1);
      if (out.colourDescPresent) {
        out.primaries = br.u(8);
        out.transfer = br.u(8);
        out.matrix = br.u(8);
      }
    }
    return out;
  }

  // Removes emulation prevention bytes (00 00 03) from a NAL payload —
  // required before parsing, otherwise escaped sequences desync the reader.
  function removeEmulationPrevention(payload) {
    const out = [];
    let zeros = 0;
    for (let i = 0; i < payload.length; i++) {
      const b = payload[i];
      if (zeros >= 2 && b === 3) {
        zeros = 0; // skip the emulation_prevention_three_byte
        continue;
      }
      out.push(b);
      zeros = b === 0 ? zeros + 1 : 0;
    }
    return new Uint8Array(out);
  }

  // Extracts SPS VUI ground truth from the first keyframe chunk.
  // Note: H.264 NAL type is 5 bits (header byte & 0x1f); HEVC NAL type is
  // 6 bits ((header byte >> 1) & 0x3f), so the type stored by findNalUnits
  // (5-bit) is only valid for H.264.
  function inspectBitstream(family, data) {
    if (!family.startsWith('h264') && !family.startsWith('hevc')) return null;
    const nals = findNalUnits(data);
    const out = { codec: family };
    for (const nal of nals) {
      if (family.startsWith('h264') && nal.type === 7) {
        const payload = removeEmulationPrevention(data.subarray(nal.header + 1, nal.end));
        out.h264SpsVui = parseH264SpsVui(payload);
        out.h264SpsVui.spsHex = Array.from(payload.slice(0, 16))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        return out;
      }
      if (family.startsWith('hevc')) {
        const hevcType = (data[nal.header] >> 1) & 0x3f;
        if (hevcType === 33) {
          const payload = removeEmulationPrevention(data.subarray(nal.header + 2, nal.end));
          out.hevcSpsVui = parseHevcSpsVui(payload);
          out.hevcSpsVui.spsHex = Array.from(payload.slice(0, 16))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
          return out;
        }
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Temporal-scalability (L1T2/L1T3) validation.

  function svcPatternOf(caseDef) {
    const pattern = caseDef.scalabilityMode === 'L1T2' ? [0, 1] : [0, 2, 1, 2];
    return {
      pattern,
      expectedTid: (frameIdx) => pattern[frameIdx % pattern.length],
    };
  }

  // Temporal ID of one encoded chunk, mirroring Chromium's
  // media/parsers/temporal_scalability_id_extractor.cc:
  //   H.264  prefix NAL unit (type 14): svc_extension_flag = byte1 bit7,
  //          temporal_id = (byte3 & 0xE0) >> 5 (G.7.3.2.1);
  //   HEVC   VCL NAL unit header (type 0..31): temporal_id =
  //          (byte1 & 7) - 1 (nuh_temporal_id_plus1 is the low 3 bits of
  //          the SECOND byte of the 2-byte NAL header);
  //   AV1    frame OBU (type 6) extension byte: temporal_id = (ext & 0xE0)
  //          >> 5; without an extension byte the temporal id is 0.
  // Returns {tid, source} or null when the codec does not signal it.
  function temporalIdFromChunk(family, data) {
    if (family.startsWith('h264')) {
      for (const nal of findNalUnits(data)) {
        if (nal.type !== 14) continue; // prefix NAL unit
        if (nal.header + 4 > nal.end) continue; // 1-byte header + 3-byte svc ext
        if (!(data[nal.header + 1] & 0x80)) continue; // svc_extension_flag
        return { tid: (data[nal.header + 3] & 0xe0) >> 5, source: 'prefix-nal' };
      }
      return null;
    }
    if (family.startsWith('hevc')) {
      for (const nal of findNalUnits(data)) {
        if (nal.header + 2 > nal.end) continue; // 2-byte NAL header
        const type = (data[nal.header] >> 1) & 0x3f;
        if (type <= 31) {
          return { tid: (data[nal.header + 1] & 7) - 1, source: 'vcl-nal-header' };
        }
      }
      return null;
    }
    if (family.startsWith('av1')) {
      // OBU walk (spec 5.3.2): byte0 = forbidden(1) type(4) ext(1) size(1)
      // reserved(1); optional extension byte; optional leb128 size. The
      // frame OBU (type 6) carries the frame's temporal id.
      let tid = null;
      let i = 0;
      while (i + 1 < data.length) {
        const b0 = data[i++];
        const type = (b0 >> 3) & 0xf;
        const hasExt = (b0 >> 2) & 1;
        const hasSize = (b0 >> 1) & 1;
        if (hasExt) {
          if (i >= data.length) return null;
          if (type === 6) tid = (data[i] >> 5) & 7;
          i++;
        } else if (type === 6) {
          tid = 0;
        }
        if (hasSize) {
          let b;
          let shift = 0;
          do {
            if (i >= data.length) return null;
            b = data[i++];
            shift += 7;
          } while (b & 0x80 && shift < 35);
        } else if (i === data.length - 1) {
          i = data.length; // last OBU consumes the rest of the chunk
        }
      }
      return tid === null ? null : { tid, source: 'obu-header' };
    }
    return null;
  }

  // HEVC SEI scan of a keyframe chunk: walks the SEI NAL units (type 39)
  // and reports the payload types present. Payload types 137 (mastering
  // display colour volume) and 144 (content light level) are the HDR10
  // static metadata the H.265 delegate writes from gfx::HDRMetadata.
  function inspectHdr10Sei(family, data) {
    if (!family.startsWith('hevc')) return null;
    const out = { payloadTypes: [], masteringDisplay: false, contentLightLevel: false };
    for (const nal of findNalUnits(data)) {
      const type = (data[nal.header] >> 1) & 0x3f;
      if (type !== 39) continue; // PREFIX_SEI
      const br = new BitReader(data.subarray(nal.header + 2, nal.end));
      try {
        for (let n = 0; n < 64; n++) {
          let payloadType = 0;
          let b;
          do {
            b = br.u(8);
            payloadType += b;
          } while (b === 0xff);
          let payloadSize = 0;
          do {
            b = br.u(8);
            payloadSize += b;
          } while (b === 0xff);
          out.payloadTypes.push(payloadType);
          br.pos += payloadSize * 8; // skip the payload
        }
      } catch (e) {
        // Ran off the end of the RBSP — the messages read so far stand.
      }
    }
    out.masteringDisplay = out.payloadTypes.includes(137);
    out.contentLightLevel = out.payloadTypes.includes(144);
    return out;
  }

  // Segment lookup for the resize cases (mid-stream encoded size changes):
  // which schedule entry owns |frameIdx|, with its position within the
  // segment (segment starts restart the keyframe/warm-up quality tiers).
  function resizeSegmentAt(caseDef, frameIdx) {
    if (!caseDef.resize) return null;
    let offset = 0;
    for (let si = 0; si < caseDef.resizeSchedule.length; si++) {
      const seg = caseDef.resizeSchedule[si];
      if (frameIdx < offset + seg.frames) {
        return { ...seg, index: si, startFrame: offset, posInSeg: frameIdx - offset };
      }
      offset += seg.frames;
    }
    return null;
  }

  // First VideoDecoder preference (per caseDef.decodePrefs) that supports
  // this config; null when no decoder is available (e.g. HEVC without
  // hardware decode).
  async function pickDecoderPref(caseDef, codecUsed, codedWidth, codedHeight) {
    for (const pref of caseDef.decodePrefs) {
      try {
        const s = await VideoDecoder.isConfigSupported({
          codec: codecUsed,
          codedWidth,
          codedHeight,
          hardwareAcceleration: pref,
          optimizeForLatency: false,
        });
        if (s.supported) return pref;
      } catch (e) {
        // Try the next preference.
      }
    }
    return null;
  }

  // Decodes the encoded chunks and compares every decoded frame against the
  // regenerated source pattern. Returns {status, reason, ...}.
  async function decodeBack(caseDef, codecUsed, chunks, frameDurUs, bitstreamInfo) {
    const crop = caseDef.crop || null;
    const dec = {
      status: 'skipped',
      reason: '',
      decoderPref: null,
      framesDecoded: 0,
      worst: null,
      frames: [],
    };
    if (typeof VideoDecoder === 'undefined') {
      dec.reason = 'VideoDecoder not defined';
      return dec;
    }

    // Temporal-layer lookup for TID-aware thresholds and per-layer worsts
    // (L1T2/L1T3 only — 'manual' is validated by the decode-back alone).
    const svcTid =
      caseDef.scalabilityMode === 'L1T2' || caseDef.scalabilityMode === 'L1T3'
        ? svcPatternOf(caseDef).expectedTid
        : null;

    // The stream's coded size. A crop case may come out either way: the
    // encoder can emit the canvas coded size with SPS crop offsets, or crop
    // up-front and emit the visible size. The decoder must be configured
    // with the emitted size, so read it from the SPS instead of guessing.
    let codedWidth = caseDef.width;
    let codedHeight = caseDef.height;
    let spsCodedSize = null;
    if (crop && bitstreamInfo) {
      const sps = bitstreamInfo.h264SpsVui || bitstreamInfo.hevcSpsVui;
      if (sps && sps.codedWidth && sps.codedHeight) {
        codedWidth = sps.codedWidth;
        codedHeight = sps.codedHeight;
        spsCodedSize = { width: codedWidth, height: codedHeight };
        dec.spsCodedSize = spsCodedSize;
      }
    }

    const decoderPref = await pickDecoderPref(
      caseDef, codecUsed, codedWidth, codedHeight);
    if (!decoderPref) {
      dec.reason = `no decoder available for ${codecUsed}`;
      return dec;
    }
    dec.decoderPref = decoderPref;

    // Crop cases compare the visible region in display space (crop size);
    // everything else compares the full frame. The decoded frame is drawn
    // at the crop size — the frame's own visible rect is the picture, so
    // drawing it scaled to the crop size normalizes both possible encoder
    // implementations (SPS-crop-signaled or cropped-up-front).
    const cmpW = crop ? crop.width : caseDef.width;
    const cmpH = crop ? crop.height : caseDef.height;
    const dstCvs = new OffscreenCanvas(cmpW, cmpH);
    const dstCtx = dstCvs.getContext('2d');
    const srcCvs = new OffscreenCanvas(caseDef.width, caseDef.height);
    const srcCtx = srcCvs.getContext('2d');
    const srcPatchCvs = crop ? new OffscreenCanvas(cmpW, cmpH) : null;
    const srcPatchCtx = srcPatchCvs ? srcPatchCvs.getContext('2d') : null;

    // Resize cases compare each frame at ITS segment size: the source
    // pattern must be regenerated at that size (a 1080p-drawn pattern
    // cropped to 360p would compare the wrong picture).
    const srcCvsBySize = new Map();
    const srcCanvasFor = (w, h) => {
      const k = `${w}x${h}`;
      let c = srcCvsBySize.get(k);
      if (!c) {
        c = new OffscreenCanvas(w, h);
        srcCvsBySize.set(k, c);
      }
      return c;
    };
    // HDR comparison scratch: the pq-tagged source frame is drawn through
    // this canvas so both sides undergo the same PQ->sRGB conversion.
    const hdrCvs = caseDef.hdr10
      ? new OffscreenCanvas(caseDef.width, caseDef.height)
      : null;
    const hdrCtx = hdrCvs ? hdrCvs.getContext('2d') : null;
    const sizeMismatches = [];
    const metrics = new Map(); // frameIndex → {psnrDb, mae, ...}
    let firstVisible = null;
    let decodeError = null;
    const decoder = new VideoDecoder({
      output: (frame) => {
        try {
          const idx = Math.round(frame.timestamp / frameDurUs);
          if (crop && !firstVisible) {
            const vr = frame.visibleRect;
            firstVisible = {
              x: vr.x, y: vr.y, width: vr.width, height: vr.height,
              displayWidth: frame.displayWidth,
              displayHeight: frame.displayHeight,
            };
          }
          if (crop) {
            dstCtx.drawImage(frame, 0, 0, cmpW, cmpH);
            const dstData = dstCtx.getImageData(0, 0, cmpW, cmpH).data;
            patternFor(caseDef)(srcCtx, caseDef.width, caseDef.height, idx);
            srcPatchCtx.drawImage(
              srcCvs, crop.x, crop.y, crop.width, crop.height,
              0, 0, cmpW, cmpH);
            const srcData = srcPatchCtx.getImageData(0, 0, cmpW, cmpH).data;
            metrics.set(idx, analyzeCrop(srcData, dstData, cmpW, cmpH));
          } else if (caseDef.hdr10) {
            // HDR: the decoded frame is BT.2020/PQ; drawing it to the sRGB
            // comparison canvas applies the PQ->sRGB conversion. The source
            // must go through the SAME conversion: rebuild it as a
            // bt2020/PQ-tagged frame and draw that through the same canvas
            // path, so both sides carry the identical color transform and
            // the comparison measures the encoder roundtrip error only.
            dstCtx.drawImage(frame, 0, 0);
            const dstData = dstCtx.getImageData(
              0, 0, caseDef.width, caseDef.height).data;
            patternFor(caseDef)(srcCtx, caseDef.width, caseDef.height, idx);
            const img = srcCtx.getImageData(0, 0, caseDef.width, caseDef.height);
            const buf = new Uint8Array(caseDef.width * caseDef.height * 4);
            buf.set(img.data);
            const tagged = new VideoFrame(buf, {
              format: 'RGBA',
              codedWidth: caseDef.width,
              codedHeight: caseDef.height,
              timestamp: 0,
              colorSpace: {
                primaries: 'bt2020',
                transfer: 'pq',
                matrix: 'bt2020-ncl',
                fullRange: false,
              },
            });
            try {
              hdrCtx.drawImage(tagged, 0, 0);
            } finally {
              tagged.close();
            }
            const srcData = hdrCtx.getImageData(
              0, 0, caseDef.width, caseDef.height).data;
            metrics.set(
              idx, psnrMae(srcData, dstData, caseDef.width, caseDef.height));
          } else {
            const seg = caseDef.resize ? resizeSegmentAt(caseDef, idx) : null;
            const cw = seg ? seg.width : caseDef.width;
            const chH = seg ? seg.height : caseDef.height;
            dstCtx.drawImage(frame, 0, 0);
            const dstData = dstCtx.getImageData(0, 0, cw, chH).data;
            const scvs = seg ? srcCanvasFor(cw, chH) : srcCvs;
            const sctx = scvs.getContext('2d');
            patternFor(caseDef)(sctx, cw, chH, idx);
            const srcData = sctx.getImageData(0, 0, cw, chH).data;
            metrics.set(idx, psnrMae(srcData, dstData, cw, chH));
            if (seg &&
                (frame.displayWidth !== seg.width ||
                 frame.displayHeight !== seg.height)) {
              sizeMismatches.push({
                frameIdx: idx,
                expected: `${seg.width}x${seg.height}`,
                got: `${frame.displayWidth}x${frame.displayHeight}`,
              });
            }
          }
        } catch (e) {
          decodeError = e;
        } finally {
          try {
            frame.close();
          } catch (e) {
            // Ignore.
          }
        }
      },
      error: (e) => {
        decodeError = e;
      },
    });

    try {
      decoder.configure({
        codec: codecUsed,
        codedWidth,
        codedHeight,
        hardwareAcceleration: decoderPref,
        optimizeForLatency: false,
        // Mirror the encoder's annexb format selection so in-band SPS/PPS
        // in the first keyframe satisfies the decoder.
        ...caseDef.extraConfig,
      });
      for (const ch of chunks) {
        if (decodeError) break;
        const chunk = new EncodedVideoChunk({
          type: ch.type,
          timestamp: ch.timestamp,
          duration: ch.duration,
          data: ch.data,
        });
        decoder.decode(chunk);
      }
      await withTimeout(decoder.flush(), 120_000, 'decoder flush timed out');
    } catch (e) {
      if (!decodeError) decodeError = e;
    } finally {
      try {
        if (decoder.state !== 'closed') decoder.close();
      } catch (e) {
        // Ignore.
      }
    }

    dec.framesDecoded = metrics.size;
    dec.frames = [...metrics.entries()]
      .map(([frameIdx, m]) => ({
        frameIdx,
        psnrDb: Number(m.psnrDb.toFixed(2)),
        mae: Number(m.mae.toFixed(3)),
        ...(m.magentaFrac !== undefined
          ? { magentaFrac: Number(m.magentaFrac.toFixed(6)) }
          : {}),
        ...(m.bands
          ? {
              bands: {
                top: Number(m.bands.top.toFixed(2)),
                bottom: Number(m.bands.bottom.toFixed(2)),
                left: Number(m.bands.left.toFixed(2)),
                right: Number(m.bands.right.toFixed(2)),
              },
            }
          : {}),
      }))
      .sort((a, b) => a.frameIdx - b.frameIdx);
    if (firstVisible) dec.firstVisible = firstVisible;
    // Per-temporal-layer worst quality (forensics for the L1T2/L1T3 cases).
    if (svcTid !== null) {
      const tidWorst = {};
      for (const f of dec.frames) {
        const tid = svcTid(f.frameIdx);
        if (!tidWorst[tid] || f.psnrDb < tidWorst[tid].psnrDb) tidWorst[tid] = f;
      }
      dec.tidWorst = tidWorst;
    }

    if (decodeError) {
      const msg = String(
        decodeError && decodeError.message ? decodeError.message : decodeError,
      );
      // Stress points gate on ENCODER resolution coverage: when the encode
      // succeeded but the verification decoder rejects this resolution
      // (e.g. hardware HEVC decode has a minimum size), pass with an
      // encode-only note instead of failing the encoder case.
      if (caseDef.stressPoint && /Unsupported configuration/i.test(msg)) {
        dec.status = 'skipped';
        dec.reason =
          'decoder does not support this resolution — encode-only verification';
        return dec;
      }
      dec.status = 'fail';
      dec.reason = `decoder error: ${decodeError}`;
      return dec;
    }
    if (dec.framesDecoded !== chunks.length) {
      dec.status = 'fail';
      dec.reason =
        `decoded ${dec.framesDecoded} frames but ${chunks.length} chunks were encoded`;
      return dec;
    }

    // Thresholds per frame tier:
    //   frame 0          keyframe + in-band headers: soft floor.
    //   frames 1..WARMUP CBR rate control is still converging after the
    //                    keyframe: dedicated warm-up floor.
    //   later frames     steady state: strict thresholds.
    const thresholdsFor = (frameIdx) => {
      // Stress-resolution cases reuse the crop floors: they gate on
      // resolution coverage, not rate-control tuning. In L1T3 the T2 tier
      // (non-reference frames) gets the same relaxation: it receives the
      // smallest share of the CBR allocation, so a strict steady-state
      // floor would fail it for the wrong reason. L1T2 has no non-reference
      // tier and keeps the strict floors. Resize segments restart the
      // keyframe/warm-up tiers at every boundary: each reconfiguration
      // reinitializes the accelerator and its rate control, so the first
      // frames of a segment converge like a fresh encoder.
      const soft =
        caseDef.crop ||
        caseDef.relaxedQuality ||
        (svcTid !== null && svcTid(frameIdx) === 2);
      const seg = caseDef.resize ? resizeSegmentAt(caseDef, frameIdx) : null;
      const tierIdx = seg ? seg.posInSeg : frameIdx;
      if (tierIdx === 0) {
        return {
          floor: soft ? CROP_F0_MIN_PSNR_DB : F0_MIN_PSNR_DB,
          maxMae: caseDef.maxMae,
        };
      }
      if (tierIdx < WARMUP_FRAMES) {
        return {
          floor: soft ? CROP_WARMUP_MIN_PSNR_DB : WARMUP_MIN_PSNR_DB,
          maxMae: WARMUP_MAX_MAE,
        };
      }
      if (soft && svcTid !== null && svcTid(frameIdx) === 2) {
        return { floor: Math.min(caseDef.minPsnrDb, CROP_WARMUP_MIN_PSNR_DB),
                 maxMae: SVC_T2_MAX_MAE };
      }
      return { floor: caseDef.minPsnrDb, maxMae: caseDef.maxMae };
    };

    let worst = null;
    let cropFailure = null;
    for (const f of dec.frames) {
      const { floor, maxMae } = thresholdsFor(f.frameIdx);
      if (!(f.psnrDb >= floor && f.mae <= maxMae)) {
        if (!worst || f.psnrDb < worst.psnrDb) worst = f;
      }
      if (crop && !cropFailure) {
        if (f.magentaFrac > MAX_MAGENTA_FRAC) {
          cropFailure =
            `frame ${f.frameIdx} leaked padding: magenta fraction ` +
            `${(f.magentaFrac * 100).toFixed(3)}% (max ` +
            `${(MAX_MAGENTA_FRAC * 100).toFixed(3)}%)`;
        } else {
          const bandErr = Math.max(
            f.bands.top, f.bands.bottom, f.bands.left, f.bands.right);
          if (bandErr > MIN_BAND_ERR && bandErr > MAX_BAND_RATIO * f.mae) {
            cropFailure =
              `frame ${f.frameIdx} has an edge band (${bandErr.toFixed(2)}) ` +
              `far worse than the frame average (${f.mae.toFixed(3)}) — the ` +
              'crop scaled the padding in instead of trimming it';
          }
        }
      }
    }
    if (worst) {
      const { floor, maxMae } = thresholdsFor(worst.frameIdx);
      dec.status = 'warn';
      dec.worst = worst;
      dec.reason =
        `frame ${worst.frameIdx} below quality floor: ` +
        `PSNR ${worst.psnrDb.toFixed(2)} dB (min ${floor}), ` +
        `MAE ${worst.mae.toFixed(3)} (max ${maxMae})`;
      return dec;
    }
    if (cropFailure) {
      dec.status = 'fail';
      dec.reason = cropFailure;
      return dec;
    }

    // The decoder's visible rect is the stream's own crop signaling. The
    // visible SIZE must equal the requested crop either way; the origin
    // must equal the requested crop only when the stream kept the canvas
    // coded size (an encoder that cropped up-front emits the visible size
    // as its coded size, with origin 0,0).
    if (crop) {
      const v = firstVisible;
      if (!v) {
        dec.status = 'fail';
        dec.reason = 'no decoded frame reported a visible rect';
        return dec;
      }
      if (v.width !== crop.width || v.height !== crop.height) {
        dec.status = 'fail';
        dec.reason =
          `decoded visible rect is ${v.width}x${v.height}, the requested ` +
          `crop is ${crop.width}x${crop.height} — the stream does not carry ` +
          'the requested crop';
        return dec;
      }
      if (v.displayWidth !== crop.width || v.displayHeight !== crop.height) {
        dec.status = 'fail';
        dec.reason =
          `decoded display size is ${v.displayWidth}x${v.displayHeight}, ` +
          `the requested crop is ${crop.width}x${crop.height}`;
        return dec;
      }
      if (spsCodedSize &&
          spsCodedSize.width === caseDef.width &&
          spsCodedSize.height === caseDef.height &&
          (v.x !== crop.x || v.y !== crop.y)) {
        dec.status = 'fail';
        dec.reason =
          `the stream kept the coded size but the visible origin is ` +
          `${v.x},${v.y} instead of ${crop.x},${crop.y} — the encoder ` +
          'ignored the visible rect origin';
        return dec;
      }
    }
    // Resize geometry: every decoded frame must come out at its segment's
    // size — a decoder (or encoder) that does not follow the in-band size
    // changes fails here even if the pixel comparison at the wrong size
    // somehow still matched.
    if (caseDef.resize) {
      dec.sizeMismatches = sizeMismatches;
      if (sizeMismatches.length) {
        const bad = sizeMismatches[0];
        dec.status = 'fail';
        dec.reason =
          `frame ${bad.frameIdx} decoded at ${bad.got} instead of the ` +
          `segment's ${bad.expected} — the decoder did not follow the ` +
          'in-band size change';
        return dec;
      }
    }

    dec.status = 'pass';
    let w = null;
    for (const f of dec.frames) {
      if (!w || f.psnrDb < w.psnrDb) w = f;
    }
    dec.worst = w;
    return dec;
  }

  // Decodes a subsequence of the encoded chunks and compares every decoded
  // frame against the regenerated source pattern with a soft floor. Used for
  // the T0-only subset of the temporal-scalability cases: the subset must
  // decode cleanly and reproduce the source — a flat (non-layered) stream
  // decoded without its reference frames errors out or falls far below the
  // floor (error concealment on the moving-bars pattern measures ≪ 21 dB
  // while healthy T0 frames measure ≳ 27 dB).
  async function decodeSubset(caseDef, codecUsed, chunks, frameDurUs) {
    const sub = { chunks: chunks.length, framesDecoded: 0, error: null, frames: [] };
    const decoderPref = await pickDecoderPref(
      caseDef, codecUsed, caseDef.width, caseDef.height);
    if (!decoderPref) {
      sub.error = `no decoder available for ${codecUsed}`;
      return sub;
    }
    const dstCvs = new OffscreenCanvas(caseDef.width, caseDef.height);
    const dstCtx = dstCvs.getContext('2d');
    const srcCvs = new OffscreenCanvas(caseDef.width, caseDef.height);
    const srcCtx = srcCvs.getContext('2d');
    const draw = patternFor(caseDef);
    const metrics = [];
    const decoder = new VideoDecoder({
      output: (frame) => {
        try {
          const idx = Math.round(frame.timestamp / frameDurUs);
          dstCtx.drawImage(frame, 0, 0);
          const dstData = dstCtx.getImageData(
            0, 0, caseDef.width, caseDef.height).data;
          draw(srcCtx, caseDef.width, caseDef.height, idx);
          const srcData = srcCtx.getImageData(
            0, 0, caseDef.width, caseDef.height).data;
          metrics.push({
            frameIdx: idx,
            ...psnrMae(srcData, dstData, caseDef.width, caseDef.height),
          });
        } catch (e) {
          sub.error = e;
        } finally {
          try {
            frame.close();
          } catch (e) {
            // Ignore.
          }
        }
      },
      error: (e) => {
        sub.error = e;
      },
    });
    try {
      decoder.configure({
        codec: codecUsed,
        codedWidth: caseDef.width,
        codedHeight: caseDef.height,
        hardwareAcceleration: decoderPref,
        optimizeForLatency: false,
        ...caseDef.extraConfig,
      });
      for (const ch of chunks) {
        if (sub.error) break;
        decoder.decode(new EncodedVideoChunk({
          type: ch.type,
          timestamp: ch.timestamp,
          duration: ch.duration,
          data: ch.data,
        }));
      }
      await withTimeout(decoder.flush(), 120_000, 'subset decoder flush timed out');
    } catch (e) {
      if (!sub.error) sub.error = e;
    } finally {
      try {
        if (decoder.state !== 'closed') decoder.close();
      } catch (e) {
        // Ignore.
      }
    }
    sub.framesDecoded = metrics.length;
    sub.frames = metrics
      .map((m) => ({
        frameIdx: m.frameIdx,
        psnrDb: Number(m.psnrDb.toFixed(2)),
        mae: Number(m.mae.toFixed(3)),
      }))
      .sort((a, b) => a.frameIdx - b.frameIdx);
    let worst = null;
    for (const f of sub.frames) {
      if (f.psnrDb < SVC_T0_MIN_PSNR_DB && (!worst || f.psnrDb < worst.psnrDb)) {
        worst = f;
      }
    }
    sub.worst = worst;
    return sub;
  }

  // Temporal-scalability validation for the L1T2/L1T3 cases. Two
  // independent gates:
  //   1. structure proof — the T0-only subsequence must decode cleanly and
  //      match the source (see decodeSubset);
  //   2. bitstream temporal IDs vs the SVCLayers pattern
  //      ([0,1] / [0,2,1,2] from the keyframe) — REPORT-ONLY forensics
  //      (signalingGap): some drivers build the hierarchical structure
  //      without signaling the layer IDs in-band, which is common enough
  //      that the signaling itself is not gated (user decision). Malformed
  //      bitstreams that cannot be parsed at all still fail.
  async function validateSvc(caseDef, codecUsed, chunks, frameDurUs) {
    const out = {
      requested: caseDef.scalabilityMode,
      pattern: null,
      temporalIds: [],
      tidCounts: {},
      firstMismatch: null,
      // The bitstream does not carry the layer IDs (or carries wrong
      // ones) but the structural checks still gate. Report-only finding.
      signalingGap: null,
      t0Subset: null,
    };
    const { pattern, expectedTid } = svcPatternOf(caseDef);
    out.pattern = pattern.slice();
    if (caseDef.frames < SVC_MIN_FRAMES) {
      out.firstMismatch =
        `at least ${SVC_MIN_FRAMES} frames are needed to validate the ` +
        `temporal pattern (got ${caseDef.frames})`;
      return out;
    }
    const recordSignalingGap = (detail) => {
      out.signalingGap = out.signalingGap || detail;
    };
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const idx = Math.round(c.timestamp / frameDurUs);
      const expected = expectedTid(idx);
      let parsed = null;
      try {
        parsed = temporalIdFromChunk(caseDef.family, c.data);
      } catch (e) {
        if (!out.firstMismatch) {
          out.firstMismatch =
            `frame ${idx}: bitstream parse error: ${e && e.message ? e.message : e}`;
        }
      }
      // H.264 signals the temporal id in a prefix NAL unit. Keyframes carry
      // none (their temporal id is 0 by definition); every other frame must.
      if (parsed === null) {
        if (caseDef.family.startsWith('h264') && idx > 0) {
          out.temporalIds.push({ frameIdx: idx, tid: null, expected, ok: false });
          recordSignalingGap(
            `frame ${idx}: no H.264 prefix NAL with an SVC extension ` +
              '(temporal id not signaled)');
          continue;
        }
        parsed = { tid: 0, source: 'implicit' };
      }
      const ok = parsed.tid === expected;
      out.temporalIds.push({ frameIdx: idx, tid: parsed.tid, expected, ok });
      out.tidCounts[parsed.tid] = (out.tidCounts[parsed.tid] || 0) + 1;
      if (!ok) {
        recordSignalingGap(
          `frame ${idx}: temporal id ${parsed.tid}, expected ${expected}`);
      }
    }
    // Every layer must actually appear in the output — report-only: without
    // the in-band IDs the counts cannot be observed at all.
    for (const tid of pattern) {
      if (!out.tidCounts[tid]) {
        recordSignalingGap(
          `temporal layer T${tid} never appears in the encoded output`);
      }
    }
    out.t0Subset = await decodeSubset(
      caseDef,
      codecUsed,
      chunks.filter((c) => expectedTid(Math.round(c.timestamp / frameDurUs)) === 0),
      frameDurUs,
    );
    return out;
  }

  // Manual reference buffer control encode (scalabilityMode 'manual'): the
  // page drives the reference structure itself via getAllFrameBuffers() +
  // EncodeOptions.referenceBuffers/updateBuffer. The WebCodecs surface
  // always hands out 3 buffer handles (a hardcoded blink hack, TODO
  // crbug.com/347676170) but the D3D12 delegates accept fewer — H.264:
  // max_num_ref_frames - 1, HEVC: min(max_num_ref_frames, 2), AV1:
  // max_num_ref_frames (GetMaxNumOfManualRefBuffers in the delegates) — and
  // reject out-of-range buffer indices with a fatal encoder error. The
  // capacity is therefore probed empirically: try a 3-slot round-robin
  // (each frame references the previous frame, stores into the next slot),
  // then 2-slot, then 1-slot; the first pattern the encoder accepts is the
  // one validated, and the discovered capacity is recorded. The API itself
  // is gated behind the experimental WebCodecsVideoEncoderBuffers runtime
  // feature (enabled via --enable-experimental-web-platform-features).
  async function runManualEncode(caseDef, codecUsed, modeUsed, frameDurUs, chunks) {
    const out = {
      bufferCount: null,
      bufferIds: [],
      slots: null,
      pattern: null,
      attempts: [],
      error: null,
    };
    let lastError = null;
    for (const slots of [3, 2, 1]) {
      const attempt = { slots, error: null, chunks: 0 };
      const chunkStart = chunks.length;
      const encoder = new VideoEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          chunks.push({
            type: chunk.type,
            timestamp: chunk.timestamp,
            duration: chunk.duration,
            data,
          });
        },
        error: (e) => {
          attempt.error = e;
        },
      });
      try {
        encoder.configure({
          codec: codecUsed,
          width: caseDef.width,
          height: caseDef.height,
          bitrate: caseDef.bitrate,
          framerate: caseDef.fps,
          bitrateMode: modeUsed,
          latencyMode: 'quality',
          hardwareAcceleration: 'prefer-hardware',
          ...caseDef.extraConfig,
          scalabilityMode: 'manual',
        });
        const buffers = encoder.getAllFrameBuffers();
        if (!buffers || buffers.length < slots) {
          attempt.error = new Error(
            `getAllFrameBuffers() returned ${buffers ? buffers.length : 'nothing'}, need ${slots} — the WebCodecsVideoEncoderBuffers runtime feature is not enabled (missing --enable-experimental-web-platform-features?)`,
          );
        } else {
          if (!out.bufferCount) {
            out.bufferCount = buffers.length;
            out.bufferIds = buffers.map((b) => b.id);
          }
          const cvs = new OffscreenCanvas(caseDef.width, caseDef.height);
          const ctx = cvs.getContext('2d');
          const draw = patternFor(caseDef);
          for (let i = 0; i < caseDef.frames; i++) {
            if (attempt.error) break;
            draw(ctx, caseDef.width, caseDef.height, i);
            const frame = new VideoFrame(cvs, {
              timestamp: i * frameDurUs,
              duration: frameDurUs,
            });
            try {
              // Frame 0 is a keyframe with no references; every later frame
              // references the previous frame's slot and stores into the
              // next slot. (Non-keyframes with empty reference buffers are
              // rejected by the D3D12 delegates, so the empty-refs intra
              // form is not exercised.)
              encoder.encode(frame, {
                keyFrame: i === 0,
                referenceBuffers: i === 0 ? [] : [buffers[(i - 1) % slots]],
                updateBuffer: buffers[i % slots],
              });
            } finally {
              frame.close();
            }
            if (i % 3 === 2) await new Promise((r) => setTimeout(r, 0));
          }
          await withTimeout(encoder.flush(), 60_000, 'manual encoder flush timed out');
        }
      } catch (e) {
        if (!attempt.error) attempt.error = e;
      } finally {
        try {
          if (encoder.state !== 'closed') encoder.close();
        } catch (e) {
          // Ignore.
        }
      }
      attempt.chunks = chunks.length - chunkStart;
      attempt.error = attempt.error ? String(attempt.error) : null;
      out.attempts.push(attempt);
      if (!attempt.error) {
        out.slots = slots;
        out.pattern =
          `${slots}-slot round-robin; each frame references the previous frame`;
        if (slots < (out.bufferCount || 0)) {
          out.note =
            `the VEA accepted only ${slots} of the ${out.bufferCount} ` +
            'advertised buffer handles';
        }
        return out;
      }
      lastError = attempt.error;
      chunks.length = chunkStart; // drop the partial attempt's chunks
    }
    out.error = lastError;
    return out;
  }

  // contentType candidates per codec family for the MediaRecorder-style
  // encoding types ('record'/'transmission'). The MIME layer accepts
  // mp4/webm for AVC, mp4/matroska for HEVC (webm rejects HEVC) and
  // webm/mp4 for AV1 (CanSupportMimeTypeForCodec in media_recorder_handler.cc).
  function mcContentTypes(codec) {
    if (codec.startsWith('avc1')) {
      return [`video/mp4;codecs=${codec}`, `video/webm;codecs=${codec}`];
    }
    if (codec.startsWith('hvc1')) {
      return [`video/mp4;codecs=${codec}`, `video/matroska;codecs=${codec}`];
    }
    if (codec.startsWith('av01')) {
      return [`video/webm;codecs=${codec}`, `video/mp4;codecs=${codec}`];
    }
    return [];
  }

  // WebRTC-style content types for the 'webrtc' encoding type.
  function webrtcContentTypes(codec) {
    if (codec.startsWith('avc1')) return ['video/H264'];
    if (codec.startsWith('hvc1')) return ['video/H265'];
    if (codec.startsWith('av01')) return ['video/AV1'];
    return [];
  }

  // Resolution-range detection case (one per unique codec string; runs by
  // default). Finds the hardware encoder's advertised min/max resolution
  // and stores it for the matching resstress case.
  //
  // MediaCapabilities is the primary check (per the harness contract), but
  // this Chromium reports powerEfficient === smooth
  // (media_recorder_handler.cc EncodingInfo()), where smooth is also true
  // at or below the 1280x720@30 pixels-per-second shortcut regardless of
  // hardware — so MC's MIN edge is a pps artifact, not a hardware
  // statement, and the min edge is measured with VideoEncoder's HW probe
  // instead. The MAX edge comes from MC (above the shortcut it is the
  // hardware rectangle) and is cross-checked against the HW probe: both
  // APIs read the same per-profile rectangle the D3D12 VEA advertises
  // (d3d12_video_encode_delegate.cc), so a mismatch means one of the two
  // answered from the shortcut/profile-gap and the HW answer wins.
  // Profiles MediaRecorder's MIME layer cannot express at all (e.g. AV1
  // High, av01.1.x) fall back to the HW probe for the whole range.
  async function runResDetect(caseDef) {
    const res = {
      id: caseDef.id,
      family: caseDef.family,
      status: 'pending',
      codecCandidates: caseDef.codecCandidates,
      codecUsed: null,
      codecProbes: [],
      resolutionRange: {
        minW: null,
        maxW: null,
        minH: null,
        maxH: null,
        source: null,
        mcType: null,
        contentType: null,
        baselineWidth: caseDef.baselineWidth,
        baselineHeight: caseDef.baselineHeight,
        probes: [],
        notes: [],
      },
      durationMs: 0,
    };
    const t0 = performance.now();
    try {
      if (typeof VideoEncoder === 'undefined') {
        res.status = 'fail';
        res.reason = 'VideoEncoder is not defined (page is not a secure context)';
        return res;
      }
      const range = res.resolutionRange;
      const candidates = caseDef.codecCandidates;
      const chroma = caseDef.chroma;
      const bw = caseDef.baselineWidth;
      const bh = caseDef.baselineHeight;
      // Grid spacing per axis: even-width axes step by 2 (420 and 422
      // widths), even-height axes step by 2 (420 only); 4:4:4 is a unit
      // grid on both axes.
      const stepW = chroma === '444' ? 1 : 2;
      const stepH = chroma === '420' ? 2 : 1;
      const alignW = (d) => alignForChroma(d, chroma, 'w');
      const alignH = (d) => alignForChroma(d, chroma, 'h');

      // Hardware probe: mirrors the runCase probe (prefer-hardware maps to
      // EncoderType::kHardware unconditionally).
      const veProbe = async (codecStr, w, h) => {
        const cfg = {
          codec: codecStr,
          width: w,
          height: h,
          bitrate: caseDef.baselineBitrate,
          framerate: caseDef.fps,
          bitrateMode: 'constant',
          latencyMode: 'quality',
          hardwareAcceleration: 'prefer-hardware',
          ...caseDef.extraConfig,
        };
        try {
          return (await VideoEncoder.isConfigSupported(cfg)).supported;
        } catch (e) {
          return false;
        }
      };

      // MediaCapabilities probe; every call is recorded for forensics.
      const mcProbe = async (type, contentType, w, h) => {
        const probe = {
          type,
          contentType,
          w,
          h,
          supported: false,
          smooth: null,
          powerEfficient: null,
          // The pps shortcut exists only on the MediaRecorder-style path.
          ppsShortcut: type === 'record' && w * h * caseDef.fps <= MC_PPS_THRESHOLD,
        };
        if (typeof navigator.mediaCapabilities === 'undefined') {
          probe.error = 'navigator.mediaCapabilities is not defined';
          range.probes.push(probe);
          return probe;
        }
        try {
          const info = await withTimeout(
            navigator.mediaCapabilities.encodingInfo({
              type,
              video: {
                contentType,
                width: w,
                height: h,
                bitrate: caseDef.baselineBitrate,
                framerate: caseDef.fps,
              },
            }),
            10_000,
            'MediaCapabilities encodingInfo timed out',
          );
          probe.supported = !!info.supported;
          probe.smooth = !!info.smooth;
          probe.powerEfficient = !!info.powerEfficient;
        } catch (e) {
          probe.error = String(e && e.message ? e.message : e);
        }
        range.probes.push(probe);
        return probe;
      };

      // Baseline: which codec candidate does the hardware support? The
      // matrix runCase probes candidates the same way — a family's profiles
      // may not all be advertised by the driver (e.g. Main unsupported
      // while High works).
      let codec = null;
      for (const c of candidates) {
        if (await veProbe(c, bw, bh)) {
          codec = c;
          break;
        }
      }
      if (!codec) {
        res.status = 'skip';
        res.reason =
          `no hardware encoder supports ${candidates.join('/')} at baseline ${bw}x${bh}`;
        return res;
      }

      // Baseline: can MediaCapabilities express this profile? (AV1 High and
      // some Rext strings are rejected at the MIME layer; newer Chromium
      // renamed the MediaEncodingType enum — Canary 160 rejects 'record' —
      // so the types are tried in order.) Prefer the contentTypes of the
      // hardware-supported candidate so the max search stays comparable
      // with the HW probe; other candidates are fallback.
      const mcTypeCandidates = [
        { type: 'record', ctFor: mcContentTypes },
        { type: 'webrtc', ctFor: webrtcContentTypes },
        { type: 'transmission', ctFor: mcContentTypes },
      ];
      let mcType = null;
      let contentType = null;
      for (const c of [codec, ...candidates.filter((x) => x !== codec)]) {
        for (const { type, ctFor } of mcTypeCandidates) {
          for (const ct of ctFor(c)) {
            const p = await mcProbe(type, ct, bw, bh);
            if (p.supported && p.powerEfficient) {
              mcType = type;
              contentType = ct;
              break;
            }
          }
          if (contentType) break;
        }
        if (contentType) break;
      }
      if (contentType && contentType.indexOf(codec) === -1) {
        range.notes.push(
          `MediaCapabilities contentType from fallback candidate: ${contentType}`,
        );
      }

      // Axis-wise max searches over the aligned grid. The predicate is
      // monotone above the pps shortcut: the driver advertises a per-profile
      // rectangle [minW,maxW] x [minH,maxH] and both APIs read it.
      const searchMax = async (axis, fixedW, fixedH, probeFn) => {
        const step = axis === 'w' ? stepW : stepH;
        const align = axis === 'w' ? alignW : alignH;
        const seed = axis === 'w' ? fixedW : fixedH;
        let lo = align(seed);
        let hi = RESDETECT_MAX_DIM;
        while (hi - lo > step) {
          const mid = align(Math.floor((lo + hi) / 2));
          const ok = await probeFn(mid, fixedW, fixedH);
          if (ok) lo = mid;
          else hi = mid;
        }
        return lo;
      };
      // Axis-wise min searches over the aligned grid, via the HW probe.
      const searchMin = async (axis, fixedW, fixedH) => {
        const step = axis === 'w' ? stepW : stepH;
        const align = axis === 'w' ? alignW : alignH;
        const seed = axis === 'w' ? fixedW : fixedH;
        // Smallest representable dimension per axis and chroma: even axes
        // start at 2, unconstrained axes at 1.
        const minLo =
          axis === 'w' ? (chroma === '444' ? 1 : 2) : (chroma === '420' ? 2 : 1);
        let lo = align(minLo);
        let hi = align(seed); // known supported
        while (hi - lo > step) {
          const mid = align(Math.floor((lo + hi) / 2));
          if (await veProbe(codec, axis === 'w' ? mid : fixedW, axis === 'h' ? mid : fixedH)) {
            hi = mid;
          } else {
            lo = mid;
          }
        }
        return hi;
      };

      const mcW = (mid) =>
        mcProbe(mcType, contentType, mid, bh).then((p) => p.supported && p.powerEfficient);
      const mcH = (mid) =>
        mcProbe(mcType, contentType, bw, mid).then((p) => p.supported && p.powerEfficient);

      if (contentType) {
        // MC path: max edges from MediaCapabilities...
        let maxW = await searchMax('w', bw, bh, mcW);
        let maxH = await searchMax('h', bw, bh, mcH);
        range.mcType = mcType;
        range.contentType = contentType;
        // ...cross-checked against the hardware probe: where MC answered
        // from the pps shortcut or a profile gap, the HW answer wins.
        const mcMaxW = maxW;
        const mcMaxH = maxH;
        if (!(await veProbe(codec, mcMaxW, bh))) {
          maxW = await searchMax('w', bw, bh, (mid) => veProbe(codec, mid, bh));
          range.notes.push(`maxW from VideoEncoder HW probe (MC reported ${mcMaxW} unreachable)`);
        }
        if (!(await veProbe(codec, bw, mcMaxH))) {
          maxH = await searchMax('h', bw, bh, (mid) => veProbe(codec, bw, mid));
          range.notes.push(`maxH from VideoEncoder HW probe (MC reported ${mcMaxH} unreachable)`);
        }
        range.minW = await searchMin('w', bw, bh);
        range.minH = await searchMin('h', bw, bh);
        range.maxW = maxW;
        range.maxH = maxH;
        range.source = 'mediacapabilities';
      } else {
        // Fallback: MediaCapabilities cannot express this profile at all.
        range.minW = await searchMin('w', bw, bh);
        range.minH = await searchMin('h', bw, bh);
        range.maxW = await searchMax('w', bw, bh, (mid) => veProbe(codec, mid, bh));
        range.maxH = await searchMax('h', bw, bh, (mid) => veProbe(codec, bw, mid));
        range.source = 'videoencoder-fallback';
        range.notes.push(
          'MediaCapabilities cannot express this profile (no contentType variant reported supported); range from the hardware VideoEncoder probe',
        );
      }

      // The driver's support region is not guaranteed rectangular: both max
      // edges can probe supported while the corner (maxW, maxH) is rejected
      // (e.g. level/MB limits that couple width and height). Re-fit each
      // max with the other axis held at its max until the corner itself is
      // supported.
      const cornerOk = async () => veProbe(codec, range.maxW, range.maxH);
      let refits = 0;
      while (!(await cornerOk()) && refits < 2) {
        range.maxH = await searchMax('h', range.maxW, bh, (mid) =>
          veProbe(codec, range.maxW, mid),
        );
        range.maxW = await searchMax('w', bw, range.maxH, (mid) =>
          veProbe(codec, mid, range.maxH),
        );
        refits++;
        range.notes.push(
          'max corner unsupported; re-fitted the max edges against each other',
        );
      }
      if (!(await cornerOk())) {
        range.notes.push(
          'max corner still unsupported after re-fit (non-rectangular support region)',
        );
      }

      if (range.minW > range.maxW || range.minH > range.maxH) {
        res.status = 'fail';
        res.reason = 'detected range is empty (min > max)';
        return res;
      }
      if (bw < range.minW || bw > range.maxW || bh < range.minH || bh > range.maxH) {
        res.status = 'fail';
        res.reason = `detected range ${range.minW}x${range.minH}..${range.maxW}x${range.maxH} excludes the baseline ${bw}x${bh}`;
        return res;
      }
      res.status = 'pass';
      res.codecUsed = contentType || codec;
      // Keyed by the family's primary codec string: the matching resstress
      // def carries the same candidates and looks itself up under this key.
      detectedRanges.set(caseDef.codecCandidates[0], {
        minW: range.minW,
        maxW: range.maxW,
        minH: range.minH,
        maxH: range.maxH,
        chroma,
      });
    } catch (e) {
      res.status = 'fail';
      res.reason = `resolution detection error: ${e && e.stack ? e.stack : e}`;
    } finally {
      res.durationMs = performance.now() - t0;
    }
    return res;
  }

  // Geometric stress points for a resstress def across the range detected
  // by its matching resdetect case (which runs earlier in the sequential
  // case loop). Every point is also mirrored to its portrait twin when the
  // transposed resolution falls inside the detected range. Returns null
  // when no range was detected (the def becomes a single skip result).
  function stressPointsFor(caseDef) {
    const codec = caseDef.codecCandidates[0];
    const range = detectedRanges.get(codec);
    if (!range) return null;
    // Geometric interpolation between the detected min and max, snapped to
    // the chroma grid and floored so the pattern and metrics stay
    // meaningful at the small end.
    const alignDim = (dim, axis) =>
      alignForChroma(
        Math.max(STRESS_MIN_PX, Math.min(dim, RESDETECT_MAX_DIM)),
        caseDef.chroma,
        axis,
      );
    const ts = [0, 0.25, 0.5, 0.75, 1].slice(0, caseDef.stressPoints);
    const points = [];
    const push = (w, h) => {
      if (!points.some((p) => p.w === w && p.h === h)) points.push({ w, h });
    };
    for (const t of ts) {
      const w = alignDim(Math.round(range.minW * Math.pow(range.maxW / range.minW, t)), 'w');
      const h = alignDim(Math.round(range.minH * Math.pow(range.maxH / range.minH, t)), 'h');
      push(w, h);
      // Mirrored portrait twin: the range is a per-axis box, so the
      // transposed resolution is just as valid — test both orientations,
      // not only the landscape diagonal. The twin must fall inside the
      // box: the small-end transpose of an elongated landscape point can
      // sit below the detected minW.
      if (h >= range.minW && w <= range.maxH) {
        push(alignDim(h, 'w'), alignDim(w, 'h'));
      }
    }
    return points;
  }

  // Runs ONE resolution-stress point: the standard encode + decode-back
  // pipeline at the given resolution, same per-point budget the harness
  // grants a matrix case.
  async function runStressPoint(caseDef, pt) {
    const t0 = performance.now();
    const perPointMs = Math.ceil((caseDef.frames / caseDef.fps) * 3 + 60) * 1000;
    const sub = {
      id: `${caseDef.family}-stress-${pt.w}x${pt.h}`,
      family: caseDef.family,
      codecCandidates: caseDef.codecCandidates,
      extraConfig: caseDef.extraConfig,
      decodePrefs: caseDef.decodePrefs,
      pattern: 'video',
      width: pt.w,
      height: pt.h,
      frames: caseDef.frames,
      fps: caseDef.fps,
      bitrateMode: caseDef.bitrateMode,
      // Scale the 720p reference bitrate by pixel area so large points
      // keep a comparable bits-per-pixel; clamp to what hardware rate
      // control accepts.
      bitrate: Math.min(
        100_000_000,
        Math.max(
          2_000_000,
          Math.round((caseDef.refBitrate * pt.w * pt.h) / (1280 * 720)),
        ),
      ),
      minPsnrDb: caseDef.minPsnrDb,
      maxMae: caseDef.maxMae,
      relaxedQuality: true,
      // Marks the case as a resolution-stress point: the gate is encoder
      // resolution coverage, so a verification decoder that rejects this
      // resolution passes the case (encode-only, see decodeBack).
      stressPoint: true,
    };
    try {
      const r = await withTimeout(runCase(sub), perPointMs, 'stress point timed out');
      r.stressPoint = { w: pt.w, h: pt.h };
      return r;
    } catch (e) {
      return {
        id: sub.id,
        family: sub.family,
        status: 'fail',
        codecCandidates: sub.codecCandidates,
        codecUsed: null,
        codecProbes: [],
        reason: `stress point error: ${e && e.message ? e.message : e}`,
        stressPoint: { w: pt.w, h: pt.h },
        durationMs: performance.now() - t0,
      };
    }
  }

  // Decode-to-encode transcode (frameSource 'transcode'): pass 1 encodes
  // CPU frames as usual; pass 2 re-encodes the DECODED frames of pass 1.
  // VideoDecoder output frames are GPU shared images on Windows, so pass 2
  // takes the VEA's shared-image input path (DoEncodeTask's HasSharedImage
  // branch hands the frame's resolved picture to the delegate untouched)
  // instead of the CPU upload path.
  async function runTranscode(caseDef, codecUsed, modeUsed, frameDurUs, chunks) {
    const out = { pass1: null, decode: null, error: null };
    const cfg = {
      codec: codecUsed,
      width: caseDef.width,
      height: caseDef.height,
      bitrate: caseDef.bitrate,
      framerate: caseDef.fps,
      bitrateMode: modeUsed,
      latencyMode: 'quality',
      hardwareAcceleration: 'prefer-hardware',
      ...caseDef.extraConfig,
    };
    const p1 = [];
    const encoder1 = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        p1.push({
          type: chunk.type,
          timestamp: chunk.timestamp,
          duration: chunk.duration,
          data,
        });
      },
      error: (e) => {
        out.error = e;
      },
    });
    try {
      encoder1.configure(cfg);
      const cvs = new OffscreenCanvas(caseDef.width, caseDef.height);
      const ctx = cvs.getContext('2d');
      const draw = patternFor(caseDef);
      for (let i = 0; i < caseDef.frames && !out.error; i++) {
        draw(ctx, caseDef.width, caseDef.height, i);
        const frame = new VideoFrame(cvs, {
          timestamp: i * frameDurUs,
          duration: frameDurUs,
        });
        try {
          encoder1.encode(frame, { keyFrame: i === 0 });
        } finally {
          frame.close();
        }
        if (i % 3 === 2) await new Promise((r) => setTimeout(r, 0));
      }
      await withTimeout(encoder1.flush(), 60_000, 'pass1 flush timed out');
    } catch (e) {
      if (!out.error) out.error = e;
    } finally {
      try {
        if (encoder1.state !== 'closed') encoder1.close();
      } catch (e) {
        // Ignore.
      }
    }
    out.pass1 = {
      chunks: p1.length,
      bytes: p1.reduce((n, c) => n + c.data.length, 0),
    };
    if (out.error) return out;
    if (p1.length !== caseDef.frames) {
      out.error = new Error(`pass 1 produced ${p1.length}/${caseDef.frames} chunks`);
      return out;
    }
    // Pass 2 is pipelined into the decode: every decoded frame (a GPU
    // shared image) is fed straight to the second encoder and then closed.
    // WebCodecs decoders apply backpressure until output frames are
    // closed, so holding them open would stall the flush.
    const encoder2 = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({
          type: chunk.type,
          timestamp: chunk.timestamp,
          duration: chunk.duration,
          data,
        });
      },
      error: (e) => {
        out.error = out.error || e;
      },
    });
    let framesFed = 0;
    let decodeError = null;
    const decoderPref = await pickDecoderPref(
      caseDef, codecUsed, caseDef.width, caseDef.height);
    if (!decoderPref) {
      out.error = new Error(`no decoder available for ${codecUsed}`);
      try {
        encoder2.close();
      } catch (e) {
        // Ignore.
      }
      return out;
    }
    const decoder = new VideoDecoder({
      output: (frame) => {
        try {
          encoder2.encode(frame, { keyFrame: framesFed === 0 });
          framesFed++;
        } catch (e) {
          if (!out.error) out.error = e;
        } finally {
          frame.close();
        }
      },
      error: (e) => {
        decodeError = e;
      },
    });
    try {
      encoder2.configure(cfg);
      decoder.configure({
        codec: codecUsed,
        codedWidth: caseDef.width,
        codedHeight: caseDef.height,
        hardwareAcceleration: decoderPref,
        optimizeForLatency: false,
        ...caseDef.extraConfig,
      });
      for (const ch of p1) {
        if (decodeError || out.error) break;
        decoder.decode(new EncodedVideoChunk({
          type: ch.type,
          timestamp: ch.timestamp,
          duration: ch.duration,
          data: ch.data,
        }));
        if (p1.indexOf(ch) % 3 === 2) await new Promise((r) => setTimeout(r, 0));
      }
      await withTimeout(decoder.flush(), 120_000, 'pass1 decode flush timed out');
      await withTimeout(encoder2.flush(), 60_000, 'pass2 flush timed out');
    } catch (e) {
      if (!decodeError && !out.error) {
        decodeError = e;
      }
    } finally {
      try {
        if (decoder.state !== 'closed') decoder.close();
      } catch (e) {
        // Ignore.
      }
      try {
        if (encoder2.state !== 'closed') encoder2.close();
      } catch (e) {
        // Ignore.
      }
    }
    out.decode = { frames: framesFed };
    if (decodeError && !out.error) {
      out.error = new Error(`pass 1 decode error: ${decodeError}`);
      return out;
    }
    if (out.error) return out;
    if (framesFed !== caseDef.frames) {
      out.error = new Error(`decoded ${framesFed}/${caseDef.frames} frames`);
      return out;
    }
    return out;
  }

  // Concurrent dual-encoder case: two VideoEncoder instances (720p and
  // 1080p) run simultaneously with interleaved encode calls — two VEA
  // instances coexist on the same GPU/device, so this catches driver
  // instance limits and cross-instance state bugs.
  async function runDualCase(caseDef) {
    const res = {
      id: caseDef.id,
      family: caseDef.family,
      status: 'pending',
      codecCandidates: caseDef.codecCandidates,
      codecUsed: null,
      codecProbes: [],
      bitrateModeUsed: caseDef.bitrateMode,
      scalabilityModeUsed: null,
      targetBitrate: caseDef.bitrate,
      frames: caseDef.frames,
      fps: caseDef.fps,
      encode: {},
      decode: { status: 'pending' },
      durationMs: 0,
    };
    const t0 = performance.now();
    try {
      if (typeof VideoEncoder === 'undefined') {
        res.status = 'fail';
        res.reason = 'VideoEncoder is not defined (page is not a secure context)';
        return res;
      }
      const modes =
        caseDef.bitrateModes ??
        (caseDef.bitrateMode === 'constant'
          ? ['constant', 'variable']
          : [caseDef.bitrateMode]);
      let codecUsed = null;
      let modeUsed = null;
      for (const codec of caseDef.codecCandidates) {
        for (const mode of modes) {
          const cfg = {
            codec,
            width: 1920,
            height: 1080,
            bitrate: caseDef.bitrate,
            framerate: caseDef.fps,
            bitrateMode: mode,
            latencyMode: 'quality',
            hardwareAcceleration: 'prefer-hardware',
            ...caseDef.extraConfig,
          };
          let supported = false;
          try {
            supported = (await VideoEncoder.isConfigSupported(cfg)).supported;
          } catch (e) {
            // Treated as unsupported.
          }
          res.codecProbes.push({ codec, bitrateMode: mode, supported });
          if (supported) {
            codecUsed = codec;
            modeUsed = mode;
            break;
          }
        }
        if (codecUsed) break;
      }
      if (!codecUsed) {
        res.status = 'skip';
        res.reason = 'no hardware encoder supports any candidate config';
        return res;
      }
      res.codecUsed = codecUsed;
      res.bitrateModeUsed = modeUsed;
      const frameDurUs = Math.round(1e6 / caseDef.fps);
      const streams = [
        {
          width: 1280,
          height: 720,
          bitrate: Math.round((caseDef.bitrate * (1280 * 720)) / (1920 * 1080)),
          chunks: [],
          error: null,
        },
        {
          width: 1920,
          height: 1080,
          bitrate: caseDef.bitrate,
          chunks: [],
          error: null,
        },
      ];
      const encoders = [];
      for (const s of streams) {
        const enc = new VideoEncoder({
          output: (chunk) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            s.chunks.push({
              type: chunk.type,
              timestamp: chunk.timestamp,
              duration: chunk.duration,
              data,
            });
          },
          error: (e) => {
            s.error = e;
          },
        });
        encoders.push(enc);
        enc.configure({
          codec: codecUsed,
          width: s.width,
          height: s.height,
          bitrate: s.bitrate,
          framerate: caseDef.fps,
          bitrateMode: modeUsed,
          latencyMode: 'quality',
          hardwareAcceleration: 'prefer-hardware',
          ...caseDef.extraConfig,
        });
        s.cvs = new OffscreenCanvas(s.width, s.height);
        s.ctx = s.cvs.getContext('2d');
      }
      const draw = patternFor(caseDef);
      for (let i = 0; i < caseDef.frames; i++) {
        if (streams.some((s) => s.error)) break;
        for (let si = 0; si < streams.length; si++) {
          const s = streams[si];
          draw(s.ctx, s.width, s.height, i);
          const frame = new VideoFrame(s.cvs, {
            timestamp: i * frameDurUs,
            duration: frameDurUs,
          });
          try {
            encoders[si].encode(frame, { keyFrame: i === 0 });
          } finally {
            frame.close();
          }
        }
        await new Promise((r) => setTimeout(r, 0));
      }
      for (const enc of encoders) {
        await withTimeout(enc.flush(), 60_000, 'dual encoder flush timed out');
      }
      for (const enc of encoders) {
        try {
          if (enc.state !== 'closed') enc.close();
        } catch (e) {
          // Ignore.
        }
      }
      res.dual = {
        streams: streams.map((s) => ({
          width: s.width,
          height: s.height,
          bitrate: s.bitrate,
          chunks: s.chunks.length,
          bytes: s.chunks.reduce((n, c) => n + c.data.length, 0),
          error: s.error ? String(s.error) : null,
        })),
      };
      res.encode = {
        count: streams.reduce((n, s) => n + s.chunks.length, 0),
        keyframes: streams.reduce(
          (n, s) => n + s.chunks.filter((c) => c.type === 'key').length, 0),
        bytes: streams.reduce(
          (n, s) => n + s.chunks.reduce((m, c) => m + c.data.length, 0), 0),
        frameSizes: [],
      };
      const streamError = streams.find((s) => s.error);
      if (streamError) {
        res.status = 'fail';
        res.reason = `encoder error: ${streamError.error}`;
        return res;
      }
      for (const s of streams) {
        if (s.chunks.length !== caseDef.frames) {
          res.status = 'fail';
          res.reason =
            `stream ${s.width}x${s.height}: ${s.chunks.length}/` +
            `${caseDef.frames} chunks`;
          return res;
        }
      }
      const decodes = [];
      for (const s of streams) {
        const dec = await decodeBack(
          { ...caseDef, width: s.width, height: s.height },
          codecUsed,
          s.chunks,
          frameDurUs,
          null,
        );
        decodes.push({
          width: s.width,
          height: s.height,
          status: dec.status,
          reason: dec.reason || null,
          framesDecoded: dec.framesDecoded,
          worst: dec.worst,
        });
      }
      res.dual.decodes = decodes;
      const badDec = decodes.find(
        (d) => d.status !== 'pass' && d.status !== 'skipped');
      if (badDec) {
        res.status = 'fail';
        res.reason =
          `stream ${badDec.width}x${badDec.height} decode: ${badDec.reason}`;
        return res;
      }
      res.decode = decodes[decodes.length - 1];
      res.status = 'pass';
    } catch (e) {
      res.status = 'fail';
      res.reason = String((e && e.stack) || e);
    } finally {
      res.durationMs = Math.round(performance.now() - t0);
    }
    return res;
  }

  async function runCase(caseDef) {
    if (caseDef.type === 'resdetect') return runResDetect(caseDef);
    // resstress defs never reach runCase: run() expands them into one
    // runStressPoint() call per geometric point.
    if (caseDef.dual) return runDualCase(caseDef);
    const res = {
      id: caseDef.id,
      family: caseDef.family,
      status: 'pending',
      codecCandidates: caseDef.codecCandidates,
      codecUsed: null,
      codecProbes: [],
      bitrateModeUsed: caseDef.bitrateMode,
      scalabilityModeUsed: caseDef.scalabilityMode ?? null,
      targetBitrate: caseDef.bitrate,
      frames: caseDef.frames,
      fps: caseDef.fps,
      encode: {},
      decode: { status: 'pending' },
      durationMs: 0,
    };
    const t0 = performance.now();
    try {
      if (typeof VideoEncoder === 'undefined') {
        res.status = 'fail';
        res.reason = 'VideoEncoder is not defined (page is not a secure context)';
        return res;
      }

      // Cropped-encoding cases configure the encoder with the visible
      // size and hand in frames whose coded size is the full canvas: the
      // accelerator must encode exactly the visible rect, cropping it
      // instead of scaling the padding in (mirrors the manual
      // encode_visible_rect_test page).
      const cfgWidth = caseDef.crop ? caseDef.crop.width : caseDef.width;
      const cfgHeight = caseDef.crop ? caseDef.crop.height : caseDef.height;
      if (caseDef.crop) {
        res.crop = {
          requested: { ...caseDef.crop },
          encodeConfigSize: { width: cfgWidth, height: cfgHeight },
          frameGeometry: null,
          sps: null,
          decodedVisibleRect: null,
          decodedDisplaySize: null,
        };
      }

      // 1) Probe: prefer-hardware over codec candidates × bitrate modes.
      // Chromium maps hardwareAcceleration:'prefer-hardware' to
      // EncoderType::kHardware unconditionally
      // (GetRequiredEncoderType in video_encoder.cc), so this can never
      // fall back to software encoders (libaom/openh264): unsupported
      // hardware configs probe as supported:false and the case SKIPs.
      // The -vbr/-cqp mode families probe EXACTLY their mode (unsupported
      // mode -> skip); everything else prefers constant and falls back to
      // variable.
      const modes =
        caseDef.bitrateModes ??
        (caseDef.bitrateMode === 'constant'
          ? ['constant', 'variable']
          : [caseDef.bitrateMode]);
      let codecUsed = null;
      let modeUsed = null;
      for (const codec of caseDef.codecCandidates) {
        for (const mode of modes) {
          const cfg = {
            codec,
            width: cfgWidth,
            height: cfgHeight,
            bitrate: caseDef.bitrate,
            framerate: caseDef.fps,
            bitrateMode: mode,
            latencyMode: 'quality',
            hardwareAcceleration: 'prefer-hardware',
            ...caseDef.extraConfig,
            ...(caseDef.scalabilityMode
              ? { scalabilityMode: caseDef.scalabilityMode }
              : {}),
          };
          let supported = false;
          try {
            supported = (await VideoEncoder.isConfigSupported(cfg)).supported;
          } catch (e) {
            // Treated as unsupported.
          }
          res.codecProbes.push({ codec, bitrateMode: mode, supported });
          if (supported) {
            codecUsed = codec;
            modeUsed = mode;
            break;
          }
        }
        if (codecUsed) break;
      }
      if (!codecUsed) {
        res.status = 'skip';
        res.reason = 'no hardware encoder supports any candidate config';
        return res;
      }
      res.codecUsed = codecUsed;
      res.bitrateModeUsed = modeUsed;

      // 2) Encode the deterministic pattern frames.
      const frameDurUs = Math.round(1e6 / caseDef.fps);
      const chunks = [];
      let encodeError = null;
      let totalBytes = 0;
      const encoder = new VideoEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          totalBytes += data.length;
          chunks.push({
            type: chunk.type,
            timestamp: chunk.timestamp,
            duration: chunk.duration,
            data,
          });
        },
        error: (e) => {
          encodeError = e;
        },
      });
      try {
        const draw = patternFor(caseDef);
        if (caseDef.resize) {
          // Mid-stream reconfiguration: one configure() + segment per
          // schedule entry; every segment starts with an explicit keyframe
          // so the stream carries a new in-band SPS at each boundary.
          // Chromium's D3D12 VEA does not advertise
          // supports_frame_size_change, so each size change tears the
          // accelerator down and reinitializes it — the driver must survive
          // that at every size.
          res.resize = {
            schedule: caseDef.resizeSchedule.map((s) => ({ ...s })),
            segments: [],
            keyframeBoundaries: null,
          };
          const cvsBySize = new Map();
          const canvasFor = (w, h) => {
            const k = `${w}x${h}`;
            let c = cvsBySize.get(k);
            if (!c) {
              c = new OffscreenCanvas(w, h);
              cvsBySize.set(k, c);
            }
            return c;
          };
          let frameIndex = 0;
          for (let si = 0; si < caseDef.resizeSchedule.length; si++) {
            const seg = caseDef.resizeSchedule[si];
            const start = frameIndex;
            encoder.configure({
              codec: codecUsed,
              width: seg.width,
              height: seg.height,
              bitrate: seg.bitrate,
              framerate: caseDef.fps,
              bitrateMode: modeUsed,
              latencyMode: 'quality',
              hardwareAcceleration: 'prefer-hardware',
              ...caseDef.extraConfig,
            });
            const cvs = canvasFor(seg.width, seg.height);
            const ctx = cvs.getContext('2d');
            for (let j = 0; j < seg.frames; j++, frameIndex++) {
              if (encodeError) break;
              draw(ctx, seg.width, seg.height, frameIndex);
              const frame = new VideoFrame(cvs, {
                timestamp: frameIndex * frameDurUs,
                duration: frameDurUs,
              });
              try {
                encoder.encode(frame, { keyFrame: j === 0 });
              } finally {
                frame.close();
              }
              if (frameIndex % 3 === 2) await new Promise((r) => setTimeout(r, 0));
            }
            res.resize.segments.push({
              index: si,
              width: seg.width,
              height: seg.height,
              startFrame: start,
              frames: frameIndex - start,
              bitrate: seg.bitrate,
            });
          }
          await withTimeout(encoder.flush(), 60_000, 'encoder flush timed out');
        } else if (caseDef.rateChange) {
          // Rate-only reconfiguration: same encoded size throughout, one
          // configure() per segment with a new bitrate. Rate-only changes
          // take the ChangeOptions path —
          // RequestEncodingParametersChange WITHOUT reinitializing the
          // accelerator (unlike -resize) — so this targets the driver's
          // in-place rate control reconfiguration. No keyframe is forced
          // at segment starts.
          res.ratechange = {
            schedule: caseDef.rateSchedule.map((s) => ({ ...s })),
            segments: [],
          };
          const rccvs = new OffscreenCanvas(caseDef.width, caseDef.height);
          const rcctx = rccvs.getContext('2d');
          let rcFrameIndex = 0;
          for (let si = 0; si < caseDef.rateSchedule.length; si++) {
            const seg = caseDef.rateSchedule[si];
            const start = rcFrameIndex;
            encoder.configure({
              codec: codecUsed,
              width: caseDef.width,
              height: caseDef.height,
              bitrate: seg.bitrate,
              framerate: caseDef.fps,
              bitrateMode: modeUsed,
              latencyMode: 'quality',
              hardwareAcceleration: 'prefer-hardware',
              ...caseDef.extraConfig,
            });
            for (let j = 0; j < seg.frames; j++, rcFrameIndex++) {
              if (encodeError) break;
              draw(rcctx, caseDef.width, caseDef.height, rcFrameIndex);
              const frame = new VideoFrame(rccvs, {
                timestamp: rcFrameIndex * frameDurUs,
                duration: frameDurUs,
              });
              try {
                encoder.encode(frame, { keyFrame: rcFrameIndex === 0 });
              } finally {
                frame.close();
              }
              if (rcFrameIndex % 3 === 2) await new Promise((r) => setTimeout(r, 0));
            }
            res.ratechange.segments.push({
              index: si,
              startFrame: start,
              frames: rcFrameIndex - start,
              targetBitrate: seg.bitrate,
            });
          }
          await withTimeout(encoder.flush(), 60_000, 'encoder flush timed out');
        } else if (caseDef.frameSource === 'transcode') {
          // Decode-to-encode transcode: pass 1 encodes CPU frames, pass 2
          // re-encodes the DECODED frames (GPU shared images on Windows),
          // so the VEA takes its shared-image input path.
          res.gpu = await runTranscode(caseDef, codecUsed, modeUsed, frameDurUs, chunks);
          if (res.gpu.error) {
            encodeError = res.gpu.error;
          } else {
            totalBytes = chunks.reduce((n, c) => n + c.data.length, 0);
          }
        } else if (caseDef.scalabilityMode === 'manual') {
          // Manual reference buffer control: the page drives the reference
          // structure itself. runManualEncode probes the capacity the VEA
          // actually accepts (3 -> 2 -> 1 slot round-robin).
          res.manual = await runManualEncode(
            caseDef, codecUsed, modeUsed, frameDurUs, chunks);
          if (res.manual.error) {
            encodeError = res.manual.error;
          } else {
            totalBytes = chunks.reduce((n, c) => n + c.data.length, 0);
          }
        } else {
        encoder.configure({
          codec: codecUsed,
          width: cfgWidth,
          height: cfgHeight,
          bitrate: caseDef.bitrate,
          framerate: caseDef.fps,
          bitrateMode: modeUsed,
          latencyMode: 'quality',
          hardwareAcceleration: 'prefer-hardware',
          ...caseDef.extraConfig,
          ...(caseDef.scalabilityMode
            ? { scalabilityMode: caseDef.scalabilityMode }
            : {}),
        });
        const cvs = new OffscreenCanvas(caseDef.width, caseDef.height);
        const ctx = cvs.getContext('2d');
        for (let i = 0; i < caseDef.frames; i++) {
          if (encodeError) break;
          draw(ctx, caseDef.width, caseDef.height, i);
          let frame;
          if (caseDef.crop) {
            // Two steps on purpose: build the full-texture frame first,
            // then re-wrap it with the smaller visible rect. Passing
            // visibleRect straight to the canvas constructor lets the
            // copy do the cropping upstream, which is exactly what this
            // case is not meant to rely on.
            const full = new VideoFrame(cvs, {
              timestamp: i * frameDurUs,
              duration: frameDurUs,
            });
            try {
              frame = new VideoFrame(full, {
                visibleRect: caseDef.crop,
                displayWidth: caseDef.crop.width,
                displayHeight: caseDef.crop.height,
                timestamp: i * frameDurUs,
                duration: frameDurUs,
              });
            } finally {
              full.close();
            }
            if (i === 0 && res.crop) {
              const vr = frame.visibleRect;
              res.crop.frameGeometry = {
                codedWidth: frame.codedWidth,
                codedHeight: frame.codedHeight,
                visibleRect: { x: vr.x, y: vr.y, width: vr.width, height: vr.height },
                displayWidth: frame.displayWidth,
                displayHeight: frame.displayHeight,
              };
            }
          } else if (caseDef.hdr10) {
            // BufferSource frame: canvas-sourced VideoFrames IGNORE
            // init.colorSpace (the canvas's own sRGB wins), so the drawn
            // pattern is read back and rebuilt as an RGBA buffer frame,
            // which honors the explicit BT.2020/PQ color space. The
            // hdrMetadata member is silently ignored by builds whose
            // VideoFrameMetadata does not expose it (this tree), so the
            // HDR10 SEI check is report-only until the surface lands.
            const imgData = ctx.getImageData(
              0, 0, caseDef.width, caseDef.height);
            const buf = new Uint8Array(caseDef.width * caseDef.height * 4);
            buf.set(imgData.data);
            frame = new VideoFrame(buf, {
              format: 'RGBA',
              codedWidth: caseDef.width,
              codedHeight: caseDef.height,
              timestamp: i * frameDurUs,
              duration: frameDurUs,
              colorSpace: {
                primaries: 'bt2020',
                // This Chromium's enums use the older spec spellings:
                // "pq" for BT.2100 PQ (video_transfer_characteristics.idl)
                // and "bt2020-ncl" (video_matrix_coefficients.idl).
                transfer: 'pq',
                matrix: 'bt2020-ncl',
                fullRange: false,
              },
              metadata: {
                hdrMetadata: {
                  smpteSt2086: {
                    primaries: {
                      R: { x: 0.68, y: 0.32 },
                      G: { x: 0.265, y: 0.69 },
                      B: { x: 0.15, y: 0.06 },
                      whitePoint: { x: 0.3127, y: 0.329 },
                    },
                    luminance: { max: 1000, min: 0.005 },
                  },
                  cta861_3: {
                    maxContentLightLevel: 1000,
                    maxFrameAverageLightLevel: 400,
                  },
                },
              },
            });
          } else {
            frame = new VideoFrame(cvs, {
              timestamp: i * frameDurUs,
              duration: frameDurUs,
            });
          }
          try {
            encoder.encode(frame, {
              keyFrame:
                i === 0 ||
                (caseDef.keyFrameInterval !== undefined &&
                  i % caseDef.keyFrameInterval === 0),
            });
          } finally {
            frame.close();
          }
          if (i % 3 === 2) await new Promise((r) => setTimeout(r, 0));
        }
        await withTimeout(encoder.flush(), 60_000, 'encoder flush timed out');
        }
      } catch (e) {
        if (!encodeError) encodeError = e;
      } finally {
        try {
          if (encoder.state !== 'closed') encoder.close();
        } catch (e) {
          // Ignore.
        }
      }

      res.encode = {
        count: chunks.length,
        keyframes: chunks.filter((c) => c.type === 'key').length,
        bytes: totalBytes,
        frameSizes: chunks.map((c) => ({ type: c.type, size: c.data.length })),
        error: encodeError ? String(encodeError) : null,
      };
      if (encodeError) {
        res.status = 'fail';
        res.reason = `encoder error: ${encodeError}`;
        return res;
      }
      if (chunks.length < Math.ceil(caseDef.frames * 0.6)) {
        res.status = 'fail';
        res.reason = `too few output chunks: ${chunks.length}/${caseDef.frames}`;
        return res;
      }
      if (res.encode.keyframes < 1) {
        res.status = 'fail';
        res.reason = 'no keyframe in output';
        return res;
      }
      if (totalBytes === 0) {
        res.status = 'fail';
        res.reason = 'encoder produced no bytes';
        return res;
      }
      if (totalBytes > OUTPUT_BYTE_CAP) {
        res.status = 'fail';
        res.reason = 'output too large (rate control regression?)';
        return res;
      }
      if (caseDef.resize) {
        // Every reconfiguration must survive: exactly one chunk per frame
        // (no dropped/merged frames across the reinit) and a keyframe with
        // an in-band size change at every segment boundary.
        const byFrameIdx = new Map(
          chunks.map((c) => [Math.round(c.timestamp / frameDurUs), c]),
        );
        if (chunks.length !== caseDef.frames) {
          res.status = 'fail';
          res.reason =
            `reconfiguration dropped or merged frames: ${chunks.length}/` +
            `${caseDef.frames} chunks`;
          return res;
        }
        const boundaries = [];
        for (const seg of res.resize.segments) {
          const ch = byFrameIdx.get(seg.startFrame);
          const spsInfo = (() => {
            try {
              return ch ? inspectBitstream(caseDef.family, ch.data) : null;
            } catch (e) {
              return null;
            }
          })();
          const sps = spsInfo && (spsInfo.h264SpsVui || spsInfo.hevcSpsVui);
          // The D3D12 VEA emits macroblock-aligned coded sizes (e.g.
          // 1920x1088 with an SPS crop to 1920x1080), so the segment must
          // match the SPS VISIBLE size; the coded size only applies when no
          // crop/conformance window is signaled.
          const spsW = sps && (sps.visibleWidth ?? sps.codedWidth);
          const spsH = sps && (sps.visibleHeight ?? sps.codedHeight);
          boundaries.push({
            startFrame: seg.startFrame,
            want: `${seg.width}x${seg.height}`,
            key: ch ? ch.type : 'missing',
            spsCoded: sps && sps.codedWidth
              ? `${sps.codedWidth}x${sps.codedHeight}`
              : null,
            spsVisible: sps && spsW ? `${spsW}x${spsH}` : null,
          });
          if (!ch || ch.type !== 'key') {
            res.status = 'fail';
            res.reason =
              `segment at frame ${seg.startFrame} (${seg.width}x` +
              `${seg.height}) has no keyframe (got ${ch ? ch.type : 'nothing'}) ` +
              '— the encoder did not re-key at the resolution change';
            return res;
          }
          if (sps && spsW &&
              (spsW !== seg.width || spsH !== seg.height)) {
            res.status = 'fail';
            res.reason =
              `segment at frame ${seg.startFrame} wants ${seg.width}x` +
              `${seg.height} but the keyframe SPS is visible ` +
              `${spsW}x${spsH} (coded ${sps.codedWidth}x${sps.codedHeight}) ` +
              '— the encoder kept the previous size';
            return res;
          }
        }
        res.resize.keyframeBoundaries = boundaries;
      }
      if (caseDef.rateChange) {
        // Delivery gates per segment: the bitrate must actually change
        // when configure() asks for it. The absolute band tolerates CBR
        // under/over-delivery; the RELATIVE transitions catch a driver
        // that ignores the rate update (its delivered ratio stays ~1.0
        // regardless of the requested change).
        const byFrameIdx = new Map(
          chunks.map((c) => [Math.round(c.timestamp / frameDurUs), c]),
        );
        if (chunks.length !== caseDef.frames) {
          res.status = 'fail';
          res.reason =
            `rate reconfiguration dropped or merged frames: ` +
            `${chunks.length}/${caseDef.frames} chunks`;
          return res;
        }
        // Compute every segment's delivery first, then apply the gates:
        // an early gate failure must not leave the later segments without
        // numbers (the report would render NaN/undefined for them).
        for (const seg of res.ratechange.segments) {
          let bytes = 0;
          for (let i = seg.startFrame; i < seg.startFrame + seg.frames; i++) {
            const ch = byFrameIdx.get(i);
            if (ch) bytes += ch.data.length;
          }
          if (seg.frames > 0) {
            const actual = (bytes * 8 * caseDef.fps) / seg.frames;
            seg.actualBitrate = actual;
            seg.ratio = Number((actual / seg.targetBitrate).toFixed(3));
          } else {
            // Zero frames means the encode loop broke mid-segment (the
            // case already fails with the encode error) — nothing to gate.
            seg.actualBitrate = null;
            seg.ratio = null;
          }
        }
        let prevActual = null;
        for (const seg of res.ratechange.segments) {
          const actual = seg.actualBitrate;
          if (actual === null) continue;
          const ratio = actual / seg.targetBitrate;
          if (ratio < 0.35 || ratio > 1.6) {
            res.status = 'fail';
            res.reason =
              `segment ${seg.index}: delivered ${(actual / 1e6).toFixed(2)} ` +
              `Mbps of the ${(seg.targetBitrate / 1e6).toFixed(2)} Mbps target`;
            return res;
          }
          if (prevActual !== null) {
            const targetChange =
              seg.targetBitrate /
              caseDef.rateSchedule[seg.index - 1].bitrate;
            const rel = actual / prevActual;
            const ok =
              (targetChange >= 1.5 && rel >= 1.2) ||
              (targetChange <= 0.6 && rel <= 0.85) ||
              (targetChange > 0.6 && targetChange < 1.5);
            if (!ok) {
              res.status = 'fail';
              res.reason =
                `segment ${seg.index}: delivered ${rel.toFixed(2)}x the ` +
                `previous segment's rate for a ${targetChange.toFixed(2)}x ` +
                'target change — the driver ignored the rate update';
              return res;
            }
          }
          prevActual = actual;
        }
      }
      if (caseDef.keyFrameInterval !== undefined) {
        // Every requested interval position must have produced a keyframe.
        const keyIdxs = new Set(
          chunks
            .filter((c) => c.type === 'key')
            .map((c) => Math.round(c.timestamp / frameDurUs)),
        );
        const expected = [];
        for (let i = 0; i < caseDef.frames; i += caseDef.keyFrameInterval) {
          expected.push(i);
        }
        const missing = expected.filter((i) => !keyIdxs.has(i));
        if (missing.length) {
          res.status = 'fail';
          res.reason =
            `keyframe interval ${caseDef.keyFrameInterval}: missing ` +
            `keyframes at frames ${missing.join(',')}`;
          return res;
        }
      }

      // 3) Bitstream ground truth: parse the SPS VUI of the first keyframe.
      const keyChunk = chunks.find((c) => c.type === 'key');
      if (keyChunk) {
        try {
          res.bitstream = inspectBitstream(caseDef.family, keyChunk.data);
        } catch (e) {
          res.bitstream = { parseError: String(e) };
        }
      }

      // 3a) HDR10: the keyframe SPS VUI must signal BT.2020/PQ (primaries
      // 9, transfer 16); the HDR10 SEI presence is report-only (the
      // WebCodecs hdrMetadata surface does not exist in this tree — see
      // inspectHdr10Sei).
      if (caseDef.hdr10) {
        const sps = res.bitstream && res.bitstream.hevcSpsVui;
        res.hdr10 = {
          requested: 'bt2020/smpte2084',
          spsVui: sps
            ? { primaries: sps.primaries ?? null, transfer: sps.transfer ?? null, matrix: sps.matrix ?? null }
            : null,
        };
        if (!sps || sps.primaries !== 9 || sps.transfer !== 16) {
          res.status = 'fail';
          res.reason =
            'HDR10 color signaling missing: SPS VUI primaries=' +
            `${sps ? sps.primaries : '?'} transfer=${sps ? sps.transfer : '?'} ` +
            '(expected 9/16 = BT.2020/PQ)';
          return res;
        }
        res.hdr10.hdr10Sei = keyChunk
          ? inspectHdr10Sei(caseDef.family, keyChunk.data)
          : null;
        const sei = res.hdr10.hdr10Sei;
        if (!sei || !sei.masteringDisplay || !sei.contentLightLevel) {
          res.hdr10.seiNote =
            'HDR10 SEI (mastering display colour volume / content light ' +
            'level) absent — either the WebCodecs hdrMetadata surface is ' +
            'not exposed in this build or the encoder did not emit it';
        }
      }

      // 3b) Temporal-scalability validation: per-chunk bitstream temporal
      // IDs against the SVCLayers pattern + T0-only subsequence decode.
      // (Only for the real L1T2/L1T3 modes — 'manual' drives its own
      // reference pattern and is validated by the decode-back alone.)
      if (caseDef.scalabilityMode === 'L1T2' ||
          caseDef.scalabilityMode === 'L1T3') {
        res.svc = await validateSvc(caseDef, codecUsed, chunks, frameDurUs);
        const v = res.svc;
        if (v.firstMismatch) {
          res.status = 'fail';
          res.reason = `temporal-layer structure mismatch: ${v.firstMismatch}`;
          return res;
        }
        const t = v.t0Subset;
        if (t.error) {
          res.status = 'fail';
          res.reason = `T0-only subset decode error: ${t.error}`;
          return res;
        }
        if (t.framesDecoded !== t.chunks) {
          res.status = 'fail';
          res.reason =
            `T0-only subset: decoded ${t.framesDecoded} of ${t.chunks} ` +
            'chunks (dropped lower-layer references must not break T0)';
          return res;
        }
        if (t.worst) {
          res.status = 'fail';
          res.reason =
            `T0-only subset frame ${t.worst.frameIdx} below floor: ` +
            `PSNR ${t.worst.psnrDb} dB < ${SVC_T0_MIN_PSNR_DB} — the T0 ` +
            'subsequence does not stand alone (temporal structure broken)';
          return res;
        }
      }

      // 4) Decode back and compare against the source pattern.
      res.decode = await decodeBack(caseDef, codecUsed, chunks, frameDurUs, res.bitstream);
      if (res.crop) {
        const sps = res.bitstream &&
          (res.bitstream.h264SpsVui || res.bitstream.hevcSpsVui);
        if (sps) {
          res.crop.sps = {
            codedWidth: sps.codedWidth ?? null,
            codedHeight: sps.codedHeight ?? null,
            visibleWidth: sps.visibleWidth ?? null,
            visibleHeight: sps.visibleHeight ?? null,
            ...(sps.frameCrop ? { frameCrop: sps.frameCrop } : {}),
            ...(sps.confWin ? { confWin: sps.confWin } : {}),
          };
        }
        if (res.decode.firstVisible) {
          const v = res.decode.firstVisible;
          res.crop.decodedVisibleRect = { x: v.x, y: v.y, width: v.width, height: v.height };
          res.crop.decodedDisplaySize = { width: v.displayWidth, height: v.displayHeight };
        }
      }

      // 5) Colorimetry probe (report-only): explains quality failures
      // caused by color-range signaling mismatches.
      res.colorimetry = await colorimetryCheck(
        caseDef,
        codecUsed,
        res.decode.decoderPref,
      );

      // A failed decode comparison fails the case; a decode below the
      // PSNR/MAE quality floor is a warning (non-gating); a skipped decode
      // validation (e.g. HEVC without hardware decode) does not fail.
      res.status =
        res.decode.status === 'fail'
          ? 'fail'
          : res.decode.status === 'warn'
            ? 'warn'
            : 'pass';
      if (res.status === 'fail' || res.status === 'warn') {
        res.reason = res.decode.reason || 'decode validation failed';
      } else if (res.decode.status === 'skipped' && res.decode.reason) {
        // Encode-only pass: carry the skip reason so the report explains
        // why a passing row has no quality numbers.
        res.reason = res.decode.reason;
      }
    } catch (e) {
      res.status = 'fail';
      res.reason = String((e && e.stack) || e);
    } finally {
      res.durationMs = Math.round(performance.now() - t0);
    }
    return res;
  }

  async function run() {
    result.renderer = rendererString();
    // Expand the defs into a flat work list up front: stress defs become
    // one item per geometric point (the resdetect defs precede them, so
    // the detected ranges are already known). A flat list is what makes
    // an exact progress percentage possible.
    const work = [];
    for (const caseDef of CONFIG.cases) {
      if (caseDef.type !== 'resstress') {
        work.push({ caseDef, point: null });
        continue;
      }
      const pts = stressPointsFor(caseDef);
      if (pts === null) work.push({ caseDef, point: null });
      else for (const pt of pts) work.push({ caseDef, point: pt });
    }
    const total = work.length;
    let done = 0;
    for (const item of work) {
      let out;
      if (item.caseDef.type === 'resstress') {
        out = item.point
          ? await runStressPoint(item.caseDef, item.point)
          : {
              id: item.caseDef.id,
              family: item.caseDef.family,
              status: 'skip',
              codecCandidates: item.caseDef.codecCandidates,
              codecUsed: null,
              codecProbes: [],
              reason: 'no resolution range detected for this codec',
              durationMs: 0,
            };
      } else {
        out = await runCase(item.caseDef);
      }
      result.cases.push(out);
      done++;
      // Progress marker consumed by the harness (run-tests.mjs) and printed
      // on its console.
      console.log(
        '__D3D12_ENC_CI_PROGRESS__',
        done,
        total,
        out.id || '?',
        out.status || '?',
      );
    }
    result.state = 'done';
    result.finishedAt = new Date().toISOString();
    window.__D3D12_ENC_CI_DONE__ = true;
    try {
      console.log(
        '__D3D12_ENC_CI_DONE__',
        JSON.stringify({
          state: result.state,
          cases: result.cases.map((c) => ({
            id: c.id,
            status: c.status,
            reason: c.reason,
          })),
        }),
      );
    } catch (e) {
      // Ignore.
    }
  }

  run();
})();
