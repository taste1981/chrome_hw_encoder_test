# D3D12 Video Encode Test Suite

Hardware video encoder test suite for **D3D12 video encode driver
functionality** against an
installed Chrome (≥ 158), driven over CDP with WebCodecs. No npm
dependencies; Node.js ≥ 22 only.

## What it is for

Automated validation of basic **D3D12 video encode driver functionality**:
it launches the installed Chrome via CDP, runs hardware WebCodecs encoding
of deterministic test patterns (H.264 / HEVC / AV1, including 10-bit and
4:2:2/4:4:4 variants) with in-page decode-back pixel comparison, verifies
the D3D12 encoder was actually used, and reports an exit code a CI system
can gate on. The D3D12 legs launch Chrome with
`--disable-features=MediaFoundationVideoEncodeAccelerator` (no silent MF
fallback), and all encoding runs with
`hardwareAcceleration:'prefer-hardware'`, which Chromium maps to
`EncoderType::kHardware` unconditionally — software encoders
(libaom/openh264) are never selected; unsupported hardware configs SKIP.

Chrome is located by searching, in order: the `--chrome` argument →
`D3D12_CI_CHROME` / `CHROME_PATH` env vars → registry (`App Paths`,
`StartMenuInternet`) → standard install paths (`%ProgramFiles%`,
`%ProgramFiles(x86)%`, `%LocalAppData%`).

## Machine requirements

- Windows with a **console desktop session** and a GPU with D3D12 video
  encode support (RDP / service sessions report "environment has no
  hardware encode").
- **Chrome ≥ 158** and **Node.js ≥ 22**.

Chrome is expected at `.\chrome_win64\chrome.exe` in the test directory
(the path `run-tests.ps1` passes to `--chrome`); the search order above is the
fallback when that path does not exist.

Node.js ≥ 22 needs no manual step: **run-tests.ps1 checks the installed
version and installs it via winget when missing or too old.** On machines
without winget, install Node ≥ 22 manually (e.g. the portable zip from
nodejs.org) and make sure `node` is on PATH.

## Usage

```powershell
powershell .\run-tests.ps1                       # standard run (preferred)
powershell .\run-tests.ps1 --exclude-hevc-rext   # while HEVC Rext is in driver bug-fix phase
powershell .\run-tests.ps1 --exclude-crop        # while cropped encoding is in driver bug-fix phase
powershell .\run-tests.ps1 --stress-resolution   # + resolution-range detection stress points
```

`run-tests.ps1` is the preferred entry point: it bootstraps Node.js ≥ 22
(installs via winget when missing), cleans `results\`, and runs the full
matrix at 120 frames against `.\chrome_win64\chrome.exe`. Use
`--exclude-hevc-rext` on machines whose driver does not yet pass the HEVC
10-bit 4:2:2/4:4:4 cases; it simply drops them (and their `-screen`
variants) from the matrix. `--exclude-crop` drops the cropped-encoding
cases the same way.

Every run also includes **resolution-range detection cases**
(`<family>-resdetect`, one per unique codec/profile): the page probes the
hardware encoder's advertised min/max resolution through the
**MediaCapabilities API** (`navigator.mediaCapabilities.encodingInfo()`,
gated on `supported && powerEfficient`) with a `VideoEncoder.isConfigSupported`
(`prefer-hardware`) cross-check and fallback. The fallback is needed
because MediaCapabilities cannot express some profiles at all (e.g. AV1
High is rejected at the MIME layer) and Chromium's `powerEfficient` answer
includes a software pixels-per-second shortcut below 720p, so the min edge
always comes from the hardware probe. The detected range is reported per
case. With `--stress-resolution`, each detected range is additionally
exercised by **5 geometric encode+decode-back stress points**
(`<family>-stress-WxH`) spanning min..max, gated with relaxed crop-style
floors (steady-state PSNR ≤ 21). Stress points are aligned to the
profile's chroma sampling: 4:2:0 dimensions are even on both axes, 4:2:2
widths even, 4:4:4 unconstrained. The negative-control and MF comparison
legs run the matrix only.

`run-tests.mjs` can also be invoked directly with different options:

```powershell
node run-tests.mjs --codecs h264 --resolutions 1080p # smoke
node run-tests.mjs --compare-mf                      # + MF VEA A/B
node run-tests.mjs --require-all                     # SKIPs become failures
node run-tests.mjs --all                             # every family + stress +
                                                     # negative controls + MF A/B
node run-tests.mjs --output H:\ci\artifacts\d3d12.json
node run-tests.mjs --help
```

`--all` equals `--codecs all --stress-resolution --negative-control
--l1t3-negative-control --compare-mf` (58 families → 87 matrix cases + 9
resolution-detection + 9 stress groups). SKIPs stay allowed — a machine
without AV1 hardware encode still skips the av1 families rather than
failing; use `--require-all` on top if skips must fail.

Default matrix: h264, hevc, hevc-10b420/10b422/10b444, av1, av1-10b444,
av1-8b444 at 720p + 1080p, plus a **screen-content case for every codec**
(`h264-screen`, `hevc-screen`, `hevc-10b420-screen`, `hevc-10b422-screen`,
`hevc-10b444-screen`, `av1-screen`, `av1-10b444-screen`, `av1-8b444-screen`)
at 1080p — flat UI-style frames with static text and a moving cursor, to
catch sharp-edge/blurry-text regressions that the moving-bars pattern
cannot — plus **cropped-encoding cases** for h264, hevc and hevc-10b420
(`-crop-mb`, `-crop-offset`, `-crop-both`): the input frames carry a
visible rect smaller than the coded canvas and the accelerator must encode
exactly that region. Magenta padding surrounds the visible rect, so the
decode-back can detect padding that gets scaled in instead of cropped
(magenta fraction + edge-band ratio), a shift of the encoded region
(PSNR/MAE), and a missing crop signal (decoded visible rect).

**Temporal-scalability cases** (`h264-l1t2`, `h264-l1t3`, `hevc-l1t2`,
`hevc-l1t3`, `av1-l1t2`, `av1-l1t3`, at 720p + 1080p) encode with
`scalabilityMode:'L1T2'` / `'L1T3'` and validate the temporal structure
with a **structure proof**: the T0-only subsequence (one frame in four) is
decoded on its own and compared against the source. T0 frames reference
only earlier T0 frames, so a silently ignored scalability mode (a flat
stream missing its reference frames) errors out or collapses far below the
21 dB subset floor; a healthy stream decodes the subset at full quality.
The regular full-stream decode-back with per-tier floors (T0/T1 strict, T2
relaxed) is the roundtrip quality gate.

The page also parses every chunk's temporal ID from the codec's signaling
(H.264 prefix NAL SVC extension, HEVC `nuh_temporal_id_plus1`, AV1 OBU
extension header — mirroring Chromium's
`media/parsers/temporal_scalability_id_extractor.cc`) and compares it
against the exact SVCLayers pattern (`[T0,T1]` for L1T2, `[T0,T2,T1,T2]`
for L1T3, `media/gpu/svc_layers.cc`) — **report-only forensics**: drivers
that build the hierarchical structure without signaling the layer IDs
in-band do not fail on that alone (per policy decision), and the mismatch
is recorded as a `signalingGap` finding in the report. Malformed
bitstreams that cannot be parsed at all still fail.

Chromium gates L1T3 behind the `D3D12VideoEncodeAcceleratorL1T3` feature
(L1T2 is advertised unconditionally). The harness **enables that feature by
default on every D3D12 leg**, so the `-l1t3` cases always run against the
real path; an `-l1t3` case that SKIPs while its base family passed fails
the run (`av1-l1t3` is exempt — Chromium gates AV1 L1T3 off via the
`disable_d3d12_av1_multi_ref_encoding` workaround on some drivers; reported
as a note). `run-tests.ps1` also passes `--l1t3-negative-control`: an extra
flag-off leg where every `-l1t3` case must SKIP (proving the flag gates the
mode) while the `-l1t2` cases and base families must keep the main leg's
outcome.

**Dynamic encoded frame size cases** (`h264-resize`, `hevc-resize`,
`av1-resize`) encode a fixed 105-frame schedule: start at 1080p, then cycle
640x360 → 1280x720 → 1920x1080 twice, changing the encoded size every 15
frames (7 segments; `--frames` does not apply to these cases). Each segment
is `configure()`d at its own default bitrate with an explicit keyframe, so
every boundary must carry an in-band SPS change. The gates: exactly one
chunk per frame (reconfiguration must not drop or merge frames), a keyframe
at every segment start, the keyframe SPS's **visible** size matching the
segment (the D3D12 VEA emits macroblock-aligned coded sizes like 1920x1088
with an SPS crop — the coded size is only compared when no crop is
signaled), the decoded frame's display size matching each segment, and the
usual per-frame quality floors (each segment restarts the keyframe/warm-up
tiers, since reconfiguration reinitializes the accelerator's rate control).
Because the D3D12 VEA does not advertise `supports_frame_size_change`
(`video_encode_accelerator_adapter.cc`), every size change tears the
accelerator down and reinitializes it — the case exercises that path at all
three sizes. Verified on a development box: 7/7 keyframes, all segments
decode at the right size, worst 27.1 dB (h264) / 27.6 dB (hevc).

**Bitrate-control-mode cases** (`h264-vbr`, `h264-cqp`, `hevc-vbr`,
`hevc-cqp`, `av1-vbr`, `av1-cqp`, at 720p + 1080p): CBR is the base
family's own mode (`--bitrate-mode`, default `constant`); the `-vbr` and
`-cqp` families cover the other advertised modes. Chromium mapping:
`'variable'` → `VariableBitrate(target, 10×peak)` → `kVariableMode` →
D3D12 VBR — when the driver rejects VBR the delegate logs *"Requested VBR
not supported, falling back to CBR."* and runs CBR; the harness counts that
line from the GPU-process log and reports it (non-gating: the delegate
deliberately advertises `kVariableMode` backed by the CBR path).
`'quantizer'` → `ExternalRateControl()` → `kExternalMode` → D3D12 **CQP at
a fixed QP 26** (blink never sets a per-frame quantizer, so the delegate's
default applies; the configured bitrate is ignored and the output rate is
content-adaptive). The mode families probe **exactly** their mode: an
unsupported mode SKIPs instead of silently running another one. Verified
on a development box: all 8 h264/hevc cases pass at 27.1-28.2 dB with no
VBR-fallback lines (real VBR ran; h264-vbr-1080p delivered 7.4 of 8 Mbps,
where the CBR path historically under-delivers).

**Manual reference buffer control cases** (`h264-manual`, `hevc-manual`,
`av1-manual`, at 720p + 1080p): encode with `scalabilityMode: 'manual'`
and drive the reference structure from the page — `getAllFrameBuffers()`
plus per-frame `referenceBuffers`/`updateBuffer` (round-robin slots, each
frame referencing the previous frame's slot). The API surface
(`VideoEncoderBuffer`) is gated behind the **experimental**
`WebCodecsVideoEncoderBuffers` Blink runtime feature, which is NOT a
base::Feature — the harness enables it via
**`--enable-experimental-web-platform-features`** on every leg (always on,
like the L1T3 gate). Two Chromium facts the cases encode: blink always
hands out 3 buffer handles (a hardcoded hack, TODO crbug.com/347676170)
while the D3D12 delegates accept fewer (H.264 `max_num_ref_frames - 1`,
HEVC `min(max_num_ref_frames, 2)`, AV1 `max_num_ref_frames`), and
non-keyframes with empty reference buffers are rejected by the delegates —
so the page probes the capacity empirically (3-slot → 2-slot → 1-slot, the
first accepted pattern is validated and the discovered capacity is
recorded as a note when it is below the advertised 3). Verified on the
a development box: h264-manual passes with 3 slots (27.1-27.3 dB),
hevc-manual passes with 2 slots (28.2 dB, "accepted only 2 of the 3
advertised buffer handles"), av1-manual SKIPs on GPUs without AV1 hardware
encode.

**GPU-input transcode cases** (`h264-gpu`, `hevc-gpu`, `av1-gpu`, at 720p +
1080p): a first pass encodes CPU frames, then the DECODED frames of that
stream — GPU shared images on Windows — are re-encoded in a pipelined
decode→encode (the decoder's output callback feeds the second encoder, so
the WebCodecs decoder backpressure on unclosed frames is never hit). This
exercises the VEA's **shared-image input path** (`DoEncodeTask`'s
`HasSharedImage` branch hands the resolved picture to the delegate
untouched) instead of the CPU upload path; `kD3D12SharedImageEncode` is
default-enabled so the adapter passes the GMB frames straight through.
Verified on a development box: all four cases pass at 26.8-28.0 dB.

**Rate-only reconfiguration cases** (`h264-ratechange`, `hevc-ratechange`,
`av1-ratechange`, at 720p + 1080p): fixed encoded size, the bitrate cycles
[1x, 0.5x, 2x, 0.5x] of the resolution default every 20 frames through
`configure()`. Rate-only changes take the `ChangeOptions` →
`RequestEncodingParametersChange` path WITHOUT reinitializing the
accelerator, so these cases test the driver's in-place rate control
reconfiguration. Gates: one chunk per frame, per-segment delivered bitrate
in an absolute band [0.35, 1.6] of target, and RELATIVE transitions
between adjacent segments (a rise ≥1.2x when the target doubles, a drop
≤0.85x when it halves) — a driver that ignores the update keeps the old
rate and fails the transitions. The final 0.5x segment drops far below the
pattern's saturation ceiling on purpose: the dither pattern is cheap enough
that the encoder saturates at high targets (an 8M and a 4M target both
delivered ~4.6M on this box), which makes high-to-high downward steps
ambiguous by design. `Failed to update bitrate` log lines are counted as
report-only forensics. Verified: all cases pass; the segments follow the
requested changes.

**Periodic keyframe cases** (`h264-keyframes`, `hevc-keyframes`,
`av1-keyframes`, 1080p only): `keyFrame: true` every 15 frames. Gates: a
key chunk at every interval position, decode-back quality. The combined
`h264-l1t3-keyframes` / `hevc-l1t3-keyframes` cases use an interval of 16 —
a multiple of 4 — so the SVCLayers temporal pattern stays aligned with the
frame index across the keyframe resets; the full SVC validation (T0-subset
structure proof) runs on top. h264-l1t3-keyframes passes; hevc-l1t3-
keyframes correctly inherits the known HEVC L1T3 roundtrip finding on this
box.

**HEVC HDR10 case** (`hevc-hdr10`, 1080p): Main10 encode with frames built
from an RGBA BufferSource carrying BT.2020/PQ color signaling plus
`hdrMetadata` in the frame init (canvas-sourced VideoFrames ignore
`init.colorSpace` — the canvas's own sRGB wins — so the pattern is read
back and rebuilt as a buffer frame; this Chromium's enums use the older
spec spellings `"pq"` and `"bt2020-ncl"`). Hard gates: the keyframe SPS VUI
must carry primaries 9 / transfer 16 / matrix 9 (verified on the dev box),
the decode-back passes with relaxed floors (both sides are pushed through
the same PQ→sRGB canvas conversion so the comparison measures encoder
roundtrip only). The HDR10 SEI presence (payload types 137/144) is a
**report-only finding** until a Chromium build exposes the WebCodecs
`hdrMetadata` dictionary member — the page passes it either way, so the
case upgrades automatically.

**Concurrent dual-encoder cases** (`h264-dual`, `hevc-dual`, `av1-dual`):
two VideoEncoder instances (720p + 1080p) encode simultaneously with
interleaved calls — two VEA instances coexist on one GPU device, catching
driver instance limits and cross-instance state bugs. Gates: both streams
complete with one chunk per frame and both decode-backs pass. Verified:
h264-dual and hevc-dual pass; av1-dual SKIPs on GPUs without AV1 hardware encode.

Known-driver context (a development box): H.264 L1T2/L1T3 streams
carry no SVC prefix NALs and HEVC sets `temporal_id_plus1 = 1` on every
NAL, so any standards-based layer extraction (SFU bitrate adaptation,
Chromium's `TemporalScalabilityIdExtractor`) sees a flat stream even
though the reference structure is correct — that is the `signalingGap`
finding. On the same box the **HEVC L1T3 case fails the full-stream
decode-back**: decoded quality collapses monotonically from ~frame 8
(≈18 dB, deterministic across runs) down to ~13.6 dB at frame 56 with no
decoder error, while the T0-only extraction of the same stream stays at
31-32 dB and HEVC L1T2 passes at 28 dB — the 3-sub-layer stream's
reference signaling trips the decoder once its DPB starts churning
(H.264 L1T3 passes at 28 dB: its sliding-window references survive the
missing prefix NALs). That roundtrip failure is gated, as it should be:
a user decoding this stream sees garbage after ~1/4 second.

Crop cases gate strictly on geometry but use relaxed quality floors
(steady-state PSNR ≥ 21, MAE ≤ 9): on a development box the D3D12 VEA
crop path resamples the input through the video processor instead of
pixel-cropping, costing ~4-5 dB vs the uncropped cases at the same
bitrate (22.4-23.6 dB measured where the uncropped cases reach 27-28).
Default thresholds for everything else: PSNR ≥ 24 dB, MAE ≤ 9
(`--min-psnr` / `--max-mae` to override; `--min-psnr` stricter than 21
also applies to crop cases). In the L1T3 cases the T2 tier (non-reference
frames, smallest CBR share) uses the crop-style relaxation (steady-state
PSNR ≥ min(21, `--min-psnr`), MAE ≤ 12); T0/T1 keep the strict floors.

## CI wiring

```yaml
- name: D3D12 encode driver check
  run: powershell -NoProfile -ExecutionPolicy Bypass -File H:\ci\d3d12-encode-ci\run-tests.ps1
- if: always()
  uses: actions/upload-artifact@v4
  with: { name: d3d12-encode-reports, path: '*.json' }
```

`run-tests.ps1` bootstraps Node.js ≥ 22 (winget if needed), **cleans the
`results\` directory**, then runs
`node run-tests.mjs --frames 120 --chrome .\chrome_win64\chrome.exe --l1t3-negative-control`
(the flag-off leg that proves the L1T3 feature gate).

## Report

Every run writes a **self-contained HTML report by default**
(`results\d3d12-video-encode-test-<stamp>.html`) — overall status FIRST (verdict,
exit code, reason, pass/fail/skip counts, Chrome/GPU/duration/options,
attestation), then section-by-section case tables: resolution detection,
resolution stress, base codecs, screen content, cropped encoding, temporal
scalability, dynamic frame size, bitrate control modes, manual reference
control, GPU shared-image input, rate reconfiguration, periodic keyframes,
HDR, concurrent dual encoders — followed by the negative-control, L1T3
flag-off and MF comparison leg sections. Each case row carries the same
forensics as the console summary (reason, colorimetry, resolution range,
SVC temporal IDs and T0-subset decode, resize boundaries, rate-change
segments, manual slot capacity, HDR10 signaling, dual streams).

The machine-readable **JSON data twin is always written alongside** (same
stem, `.json`) for CI parsing/archiving. `--format json` writes only the
JSON; `--output` may carry either extension (`--format` wins).

## Exit codes


| code | meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| 0    | PASS — cases passed AND D3D12 attestation present                    |
| 1    | FAIL — case failure, silent MF fallback, required skip, no HW encode, L1T2/L1T3 skip while its base family passed |
| 2    | harness error — Chrome not found, launch/CDP failure, bad arguments  |
| 3    | environment has no hardware encode (only with`--allow-no-hw`)         |
| 4    | unsupported Chrome (< 158 without`--force`)                           |
| 5    | negative-control failure — D3D12 attestation seen with the VEA disabled |
| 6    | L1T3 flag-off leg failure — `-l1t3` not skipped / `-l1t2` or base not passed with `D3D12VideoEncodeAcceleratorL1T3` disabled |

The JSON report (`--output`) contains per-case probe results, encode stats,
target/actual bitrate, per-frame PSNR/MAE, SPS VUI ground truth and the
captured attestation lines. `experiments/` holds extra diagnostics
(pattern renderer, encoder isolation checks).
