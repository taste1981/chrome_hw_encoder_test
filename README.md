# D3D12 Video Encode Test Suite

A hardware video encoder test suite that validates **D3D12 video encode
driver functionality** through an installed Chrome (≥ 158) using WebCodecs:
it encodes deterministic test patterns, decodes them back and pixel-compares
in the page, and attests from Chrome's GPU-process log that the D3D12 video
encode accelerator — not the MediaFoundation fallback — did the encoding.
No npm dependencies; Node.js ≥ 22 only.

## Requirements

- Windows with a desktop session and a GPU with D3D12 video encode support
  (RDP / service sessions report "environment has no hardware encode").
- Chrome ≥ 158 and Node.js ≥ 22 (`run-tests.ps1` installs Node via winget
  when missing).

## Usage

**Always pass the browser binary path with `--chrome`:**

```powershell
node run-tests.mjs --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
node run-tests.mjs --chrome .\chrome_win64\chrome.exe --frames 120 --all
```

If `--chrome` is omitted, the suite falls back to the `D3D12_CI_CHROME` /
`CHROME_PATH` environment variables, then the registry and standard install
paths.

`run-tests.ps1` is the convenience entry point (bootstraps Node, cleans
`results\`, runs the full matrix at 120 frames):

```powershell
powershell .\run-tests.ps1
powershell .\run-tests.ps1 --chrome "C:\path\to\chrome.exe" --exclude-hevc-rext
```

### Options

| option | meaning |
| --- | --- |
| `--chrome <path>` | **browser binary path (specify it)** |
| `--codecs <list>` | families to run; `all` = every family (default: all) |
| `--resolutions <list>` | `720p,1080p` or `WxH` pairs (default: 720p,1080p) |
| `--frames <n>` · `--fps <n>` | frames per case · framerate (default: 30 · 30; the `-resize` cases have a fixed 105-frame schedule) |
| `--bitrate-mode <m>` | `constant`/`variable` for the base families (default: constant) |
| `--min-psnr <dB>` · `--max-mae <v>` | quality floors (default: 24 dB · 9) |
| `--all` | every family plus `--stress-resolution`, both negative-control legs and the MF comparison |
| `--stress-resolution` | detect each codec's supported-resolution range and encode 5 geometric stress points across it (portrait-mirrored when in range); without `--all`, runs only the detection + stress cases |
| `--resolution-map` | encode-verified per-codec supported-resolution map — probe grid, bisection-refined min/max-height curve, holes, and the encodable W×H frontier, reported in a dedicated map section; opt-in, not part of `--all` |
| `--negative-control` | extra leg with the D3D12 VEA disabled |
| `--l1t3-negative-control` | extra leg with the L1T3 feature gate disabled |
| `--compare-mf` | informational MediaFoundation VEA comparison leg |
| `--exclude-hevc-rext` · `--exclude-crop` | drop those case groups |
| `--require-all` | any SKIP becomes FAIL |
| `--allow-no-hw` | no hardware encode → exit 3 instead of 1 |
| `--disable-gpu-driver-bug-workarounds` | launch Chrome without its driver bug workarounds (off by default) |
| `--format html\|json` | report format (default: html) |
| `--output <path>` | report path (default: `results\`) |

## What the suite covers

| group | families |
| --- | --- |
| Base codecs | `h264`, `hevc`, `av1`, `hevc-10b420/10b422/10b444`, `av1-10b444`, `av1-8b444` (720p + 1080p) |
| Screen content | `<codec>-screen` (1080p) |
| Cropped encoding | `h264`/`hevc`/`hevc-10b420` `-crop-mb/-offset/-both` |
| Temporal scalability | `<codec>-l1t2`, `<codec>-l1t3` |
| Dynamic frame size | `<codec>-resize` (mid-stream size changes, 105-frame schedule) |
| Bitrate control modes | `<codec>-vbr`, `<codec>-cqp` (CBR is the base mode) |
| Manual reference control | `<codec>-manual` |
| GPU shared-image input | `<codec>-gpu` (decode-to-encode transcode) |
| Rate reconfiguration | `<codec>-ratechange` (rate-only changes, no reinit) |
| Periodic keyframes | `<codec>-keyframes`, `h264`/`hevc` `-l1t3-keyframes` |
| HDR signaling | `hevc-hdr10` (BT.2020/PQ) |
| Concurrent encoders | `<codec>-dual` (two simultaneous encoder instances) |
| Resolution detection | one per codec string, always on |
| Resolution map | one per codec string, only with `--resolution-map` (probe-only scan of the supported-resolution region, incl. holes inside the advertised range) |

`<codec>` = `h264` / `hevc` / `av1` wherever listed. Unsupported
configurations SKIP (they never fail unless `--require-all` is set) — e.g. a
GPU without AV1 encoders skips the av1 families. The L1T3 feature gate and
the experimental Web Platform features required by the `-l1t3`/`-manual`
cases are enabled automatically on every run.

## Report

Every run writes a self-contained **HTML report** — overall status first,
then section-by-section case tables — plus the machine-readable **JSON twin**
in `results\`. `--format json` writes only the JSON.

While the suite runs, the console prints one progress line per completed
case — `[n/total] pct% case-id status` (comparison legs are labeled) — so a
run never sits silent.

## Exit codes

| code | meaning |
| --- | --- |
| 0 | PASS — cases passed AND the D3D12 attestation is present |
| 1 | FAIL — case failure, silent MF fallback, SVC gap, or no hardware encode |
| 2 | harness error (Chrome not found, launch/CDP failure, bad arguments) |
| 3 | environment has no hardware encode (only with `--allow-no-hw`) |
| 4 | unsupported Chrome (< 158 without `--force`) |
| 5 | negative-control failure |
| 6 | L1T3 flag-off leg failure |

Cases whose frames fall below the PSNR/MAE quality floors are reported as
**WARN**, not FAIL: they show up in the report and the verdict reason but do
not fail the run (exit 0). Encoding errors, decode failures and structural
gates (crop geometry, resize size, SVC structure, rate-change delivery)
remain FAIL. Resolution-stress points whose encode succeeded but whose
verification decoder rejects the resolution (e.g. tiny HEVC) PASS with an
encode-only note.

## CI wiring example

```yaml
- name: D3D12 encode driver check
  run: powershell -NoProfile -ExecutionPolicy Bypass -File H:\ci\d3d12-encode-ci\run-tests.ps1 --chrome <chrome.exe path>
- if: always()
  uses: actions/upload-artifact@v4
  with: { name: d3d12-encode-reports, path: '*.json' }
```

## License

BSD 3-Clause — see [LICENSE](LICENSE).
