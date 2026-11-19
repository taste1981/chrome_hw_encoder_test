// experiments/roundtrip-check.js — isolates where the encode-quality loss
// happens on this machine:
//   A) conversion only:  pattern → VideoFrame → drawImage back → compare
//   B) software VP9:     pattern → SW VP9 encode → SW decode → compare
//   C) hardware H.264:   pattern → HW H.264 encode → decode → compare
// Same pattern and compare code as lib/test-page.js.

(function () {
  'use strict';
  if (window.__RT_STARTED__) return;
  window.__RT_STARTED__ = true;

  const W = 1920, H = 1080, FRAMES = 30, FPS = 30;
  const BITRATE = 8_000_000;
  const result = { state: 'running', checks: {} };
  window.__RT_RESULT__ = result;
  window.__RT_DONE__ = false;

  function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  const bgCache = new Map();
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
        const n = (mulberry32((x * 0x85ebca6b + y * 0x27d4eb2f) >>> 0)() * 20) | 0;
        const gx = Math.round((140 * x) / w);
        const gy = Math.round((100 * y) / h);
        d[o] = gx + 30 + n;
        d[o + 1] = gy + 50 + n;
        d[o + 2] = 120 - gx / 2 + gy / 2 + n;
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    bgCache.set(key, canvas);
    return canvas;
  }

  function drawPattern(ctx, w, h, frameIndex) {
    ctx.drawImage(backgroundCanvas(w, h), 0, 0);
    const shift = (frameIndex * 5) % 64;
    const colors = ['rgb(180,90,90)', 'rgb(90,170,90)', 'rgb(90,90,180)'];
    for (let band = 0; band < 3; band++) {
      ctx.fillStyle = colors[band];
      for (let x = band * 16 + shift; x < w; x += 64) ctx.fillRect(x, 0, 16, h);
    }
    ctx.fillStyle = 'rgb(90,180,190)';
    for (let y = h - 96; y < h; y += 32) {
      for (let x = ((y / 32) % 2) * 32; x < w; x += 64) ctx.fillRect(x, y, 32, 32);
    }
  }

  function psnrMae(srcData, dstData, w, h) {
    const margin = 2;
    let sumSq = 0, sumAbs = 0, n = 0;
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
    return {
      psnrDb: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse),
      mae: sumAbs / n,
    };
  }

  function summarize(frames) {
    const ps = frames.map((f) => f.psnrDb);
    return {
      count: frames.length,
      worstDb: Math.min(...ps).toFixed(2),
      bestDb: Math.max(...ps).toFixed(2),
      worstMae: Math.max(...frames.map((f) => f.mae)).toFixed(2),
      frames: frames.map((f) => ({
        i: f.frameIdx,
        p: Number(f.psnrDb.toFixed(1)),
        m: Number(f.mae.toFixed(2)),
      })),
    };
  }

  // A) Conversion-only roundtrip.
  async function checkA() {
    const srcCvs = new OffscreenCanvas(W, H);
    const srcCtx = srcCvs.getContext('2d');
    const dstCvs = new OffscreenCanvas(W, H);
    const dstCtx = dstCvs.getContext('2d');
    const out = [];
    for (let i = 0; i < 5; i++) {
      drawPattern(srcCtx, W, H, i);
      const frame = new VideoFrame(srcCvs, { timestamp: i * 33333 });
      dstCtx.drawImage(frame, 0, 0);
      frame.close();
      const src = srcCtx.getImageData(0, 0, W, H).data;
      const dst = dstCtx.getImageData(0, 0, W, H).data;
      out.push({ frameIdx: i, ...psnrMae(src, dst, W, H) });
    }
    return summarize(out);
  }

  // B) / C) Codec roundtrip.
  async function checkCodec(label, codec, hwPref, extra) {
    const chunks = [];
    let encError = null;
    const encoder = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({ type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration, data });
      },
      error: (e) => { encError = e; },
    });
    const cvs = new OffscreenCanvas(W, H);
    const ctx = cvs.getContext('2d');
    const dur = Math.round(1e6 / FPS);
    encoder.configure({
      codec, width: W, height: H, bitrate: BITRATE, framerate: FPS,
      bitrateMode: 'constant', latencyMode: 'quality',
      hardwareAcceleration: hwPref, ...extra,
    });
    for (let i = 0; i < FRAMES; i++) {
      if (encError) break;
      drawPattern(ctx, W, H, i);
      const frame = new VideoFrame(cvs, { timestamp: i * dur, duration: dur });
      try { encoder.encode(frame, { keyFrame: i === 0 }); } finally { frame.close(); }
      if (i % 3 === 2) await new Promise((r) => setTimeout(r, 0));
    }
    await encoder.flush();
    encoder.close();
    if (encError) throw new Error(`encode error: ${encError}`);

    const srcCvs = new OffscreenCanvas(W, H);
    const srcCtx = srcCvs.getContext('2d');
    const dstCvs = new OffscreenCanvas(W, H);
    const dstCtx = dstCvs.getContext('2d');
    const metrics = new Map();
    let decError = null;
    const decoder = new VideoDecoder({
      output: (frame) => {
        try {
          const idx = Math.round(frame.timestamp / dur);
          dstCtx.drawImage(frame, 0, 0);
          const dst = dstCtx.getImageData(0, 0, W, H).data;
          drawPattern(srcCtx, W, H, idx);
          const src = srcCtx.getImageData(0, 0, W, H).data;
          metrics.set(idx, psnrMae(src, dst, W, H));
        } catch (e) { decError = e; } finally { try { frame.close(); } catch (e) {} }
      },
      error: (e) => { decError = e; },
    });
    decoder.configure({
      codec, codedWidth: W, codedHeight: H,
      hardwareAcceleration: label === 'sw-vp9' ? 'prefer-software' : 'prefer-hardware',
      optimizeForLatency: false, ...extra,
    });
    for (const ch of chunks) {
      decoder.decode(new EncodedVideoChunk({
        type: ch.type, timestamp: ch.timestamp, duration: ch.duration, data: ch.data,
      }));
    }
    await decoder.flush();
    decoder.close();
    if (decError) throw new Error(`decode error: ${decError}`);
    const frames = [...metrics.entries()]
      .map(([frameIdx, m]) => ({ frameIdx, ...m }))
      .sort((a, b) => a.frameIdx - b.frameIdx);
    return { bytes: chunks.reduce((s, c) => s + c.data.length, 0), ...summarize(frames) };
  }

  // D) Luma ramp 0..255 through the HW H.264 codec: reveals full/limited
  // range and color matrix behavior (error vs luma profile).
  async function checkD() {
    const Wr = 256, Hr = 64;
    const drawRamp = (ctx) => {
      const img = ctx.createImageData(Wr, Hr);
      for (let y = 0; y < Hr; y++) {
        for (let x = 0; x < Wr; x++) {
          const o = (y * Wr + x) * 4;
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
    const cvs = new OffscreenCanvas(Wr, Hr);
    const ctx = cvs.getContext('2d');
    const dur = Math.round(1e6 / 30);
    encoder.configure({
      codec: 'avc1.640028', width: Wr, height: Hr, bitrate: 2_000_000,
      framerate: 30, bitrateMode: 'constant', latencyMode: 'quality',
      hardwareAcceleration: 'prefer-hardware', avc: { format: 'annexb' },
    });
    for (let i = 0; i < 3; i++) {
      drawRamp(ctx);
      const frame = new VideoFrame(cvs, { timestamp: i * dur, duration: dur });
      try { encoder.encode(frame, { keyFrame: i === 0 }); } finally { frame.close(); }
    }
    await encoder.flush();
    encoder.close();

    const decCvs = new OffscreenCanvas(Wr, Hr);
    const decCtx = decCvs.getContext('2d');
    const samples = [0, 16, 32, 64, 96, 128, 160, 192, 224, 235, 255];
    const profile = {}; // x → avg error over decoded frames
    const decoder = new VideoDecoder({
      output: (frame) => {
        decCtx.drawImage(frame, 0, 0);
        const d = decCtx.getImageData(0, 0, Wr, Hr).data;
        for (const x of samples) {
          let sum = 0, n = 0;
          for (let y = 0; y < Hr; y++) {
            const o = (y * Wr + x) * 4;
            sum += d[o] - x;
            n++;
          }
          profile[x] = (profile[x] || 0) + sum / n;
        }
        frame.close();
      },
      error: (e) => { throw e; },
    });
    decoder.configure({
      codec: 'avc1.640028', codedWidth: Wr, codedHeight: Hr,
      hardwareAcceleration: 'prefer-hardware', avc: { format: 'annexb' },
    });
    for (const ch of chunks) {
      decoder.decode(new EncodedVideoChunk({
        type: ch.type, timestamp: ch.timestamp, duration: ch.duration, data: ch.data,
      }));
    }
    await decoder.flush();
    decoder.close();
    const out = {};
    for (const x of samples) out[x] = Number((profile[x] / 3).toFixed(2));
    return out;
  }

  // E) Same ramp through SOFTWARE VP9: isolates whether the range mismatch
  // is specific to the hardware encode path or generic to WebCodecs.
  async function checkE() {
    const Wr = 256, Hr = 64;
    const drawRamp = (ctx) => {
      const img = ctx.createImageData(Wr, Hr);
      for (let y = 0; y < Hr; y++) {
        for (let x = 0; x < Wr; x++) {
          const o = (y * Wr + x) * 4;
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
    const cvs = new OffscreenCanvas(Wr, Hr);
    const ctx = cvs.getContext('2d');
    const dur = Math.round(1e6 / 30);
    encoder.configure({
      codec: 'vp09.00.10.08', width: Wr, height: Hr, bitrate: 2_000_000,
      framerate: 30, bitrateMode: 'constant', latencyMode: 'quality',
      hardwareAcceleration: 'prefer-software',
    });
    for (let i = 0; i < 3; i++) {
      drawRamp(ctx);
      const frame = new VideoFrame(cvs, { timestamp: i * dur, duration: dur });
      try { encoder.encode(frame, { keyFrame: i === 0 }); } finally { frame.close(); }
    }
    await encoder.flush();
    encoder.close();

    const decCvs = new OffscreenCanvas(Wr, Hr);
    const decCtx = decCvs.getContext('2d');
    const samples = [0, 16, 32, 64, 96, 128, 160, 192, 224, 235, 255];
    const profile = {};
    const decoder = new VideoDecoder({
      output: (frame) => {
        decCtx.drawImage(frame, 0, 0);
        const d = decCtx.getImageData(0, 0, Wr, Hr).data;
        for (const x of samples) {
          let sum = 0, n = 0;
          for (let y = 0; y < Hr; y++) {
            const o = (y * Wr + x) * 4;
            sum += d[o] - x;
            n++;
          }
          profile[x] = (profile[x] || 0) + sum / n;
        }
        frame.close();
      },
      error: (e) => { throw e; },
    });
    decoder.configure({
      codec: 'vp09.00.10.08', codedWidth: Wr, codedHeight: Hr,
      hardwareAcceleration: 'prefer-software',
    });
    for (const ch of chunks) {
      decoder.decode(new EncodedVideoChunk({
        type: ch.type, timestamp: ch.timestamp, duration: ch.duration, data: ch.data,
      }));
    }
    await decoder.flush();
    decoder.close();
    const out = {};
    for (const x of samples) out[x] = Number((profile[x] / 3).toFixed(2));
    return out;
  }

  // F) Ramp encoded by HW H.264 (D3D12 VEA) but decoded by the SOFTWARE
  // FFmpeg decoder: distinguishes an encoder-side range bug from a
  // decoder-side one.
  async function checkF() {
    const Wr = 256, Hr = 64;
    const drawRamp = (ctx) => {
      const img = ctx.createImageData(Wr, Hr);
      for (let y = 0; y < Hr; y++) {
        for (let x = 0; x < Wr; x++) {
          const o = (y * Wr + x) * 4;
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
    const cvs = new OffscreenCanvas(Wr, Hr);
    const ctx = cvs.getContext('2d');
    const dur = Math.round(1e6 / 30);
    encoder.configure({
      codec: 'avc1.640028', width: Wr, height: Hr, bitrate: 2_000_000,
      framerate: 30, bitrateMode: 'constant', latencyMode: 'quality',
      hardwareAcceleration: 'prefer-hardware', avc: { format: 'annexb' },
    });
    for (let i = 0; i < 3; i++) {
      drawRamp(ctx);
      const frame = new VideoFrame(cvs, { timestamp: i * dur, duration: dur });
      try { encoder.encode(frame, { keyFrame: i === 0 }); } finally { frame.close(); }
    }
    await encoder.flush();
    encoder.close();

    const decCvs = new OffscreenCanvas(Wr, Hr);
    const decCtx = decCvs.getContext('2d');
    const samples = [0, 16, 32, 64, 96, 128, 160, 192, 224, 235, 255];
    const profile = {};
    const decoder = new VideoDecoder({
      output: (frame) => {
        decCtx.drawImage(frame, 0, 0);
        const d = decCtx.getImageData(0, 0, Wr, Hr).data;
        for (const x of samples) {
          let sum = 0, n = 0;
          for (let y = 0; y < Hr; y++) {
            const o = (y * Wr + x) * 4;
            sum += d[o] - x;
            n++;
          }
          profile[x] = (profile[x] || 0) + sum / n;
        }
        frame.close();
      },
      error: (e) => { throw e; },
    });
    decoder.configure({
      codec: 'avc1.640028', codedWidth: Wr, codedHeight: Hr,
      hardwareAcceleration: 'prefer-software', avc: { format: 'annexb' },
    });
    for (const ch of chunks) {
      decoder.decode(new EncodedVideoChunk({
        type: ch.type, timestamp: ch.timestamp, duration: ch.duration, data: ch.data,
      }));
    }
    await decoder.flush();
    decoder.close();
    const out = {};
    for (const x of samples) out[x] = Number((profile[x] / 3).toFixed(2));
    return out;
  }

  async function run() {
    try {
      result.checks['A-conversion-only'] = await checkA();
      result.checks['B-sw-vp9'] = await checkCodec('sw-vp9', 'vp09.00.10.08', 'prefer-software', {});
      result.checks['C-hw-h264'] = await checkCodec('hw-h264', 'avc1.640028', 'prefer-hardware', { avc: { format: 'annexb' } });
      result.checks['D-ramp-hw-h264'] = await checkD();
      result.checks['E-ramp-sw-vp9'] = await checkE();
      result.checks['F-ramp-hw264-swdecode'] = await checkF();
    } catch (e) {
      result.error = String((e && e.stack) || e);
    }
    result.state = 'done';
    window.__RT_DONE__ = true;
    console.log('__RT_DONE__', JSON.stringify(result.checks));
  }
  run();
})();
