# chat-voice-kit

Local, offline **speech in / speech out** kit for chat bots:

- **STT** — QQ SILK / amr / mp3 / wav → 16 kHz mono → [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) + SenseVoice → text
- **TTS** — text → [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) v4 zero-shot voice cloning → wav, with leading/trailing padding and trailing-silence trim

Two CommonJS files, ~800 lines, no cloud APIs. `require` them by absolute path; the host
project installs nothing.

```bash
git clone https://github.com/Kut1nashi/chat-voice-kit.git
cd chat-voice-kit
npm install   # sherpa-onnx-node / silk-wasm / ffmpeg (per-platform package, all optional)
```

Deployment is per platform. **STT (SenseVoice) is the same everywhere**: drop `model.int8.onnx` and
`tokens.txt` into `model/`, or set `VOICE_STT_MODEL_DIR`. Only the TTS side differs.

**Windows** — use the GPT-SoVITS v4 integration package (verified on `20250529`); it bundles
`runtime\python.exe` and `ffmpeg.exe`, so python and ffmpeg need no extra setup:

```bat
set VOICE_TTS_GSV_DIR=D:\GPT-SoVITS-v4-20250529
```

**Linux** — no integration package; clone the source and make a venv, then **point `VOICE_TTS_PY` at
that venv's python** (if the venv lives at `<GSV_DIR>/venv` the module finds it automatically):

```bash
git clone https://github.com/RVC-Boss/GPT-SoVITS.git ~/GPT-SoVITS
cd ~/GPT-SoVITS && python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt
export VOICE_TTS_GSV_DIR=$HOME/GPT-SoVITS
export VOICE_TTS_PY=$HOME/GPT-SoVITS/venv/bin/python
```

**macOS** — same as Linux, but GPT-SoVITS runs CPU/MPS only (much slower). STT works fine on CPU.

Then edit `GPT_SoVITS/configs/tts_infer.yaml` (`custom:` section: weights, `device`, `is_half`,
`version: v4`) and put a reference clip at `ref/reference.wav`. Verify the resolved paths with
`npm run check` (or `npm test` for the win32/linux/darwin path resolution). TTS needs an NVIDIA GPU
+ CUDA on Windows/Linux. Quick try afterwards:

```bash
node examples/say.cjs "こんにちは"
node examples/stt-cli.cjs voice.amr
```

See [`README.md`](README.md) (Chinese) for the full setup, environment-variable table, and the tuning
notes in [`docs/tuning-notes.md`](docs/tuning-notes.md).

## Before you publish anything

This repository ships **no voice models, no reference audio, no third-party binaries** — and
you should keep it that way:

- ✅ Publishable: the glue code (MIT), and the empirical findings about GPT-SoVITS parameters.
- ❌ Not publishable: fine-tuned voice checkpoints (`*.pth` / `*.ckpt`) and reference clips cut
  from anime / games / streams. A cloned voice of a real person touches that person's
  **voice/likeness rights** and the source material's copyright — that is a separate problem
  from code licensing, and "it is technically possible" does not make it distributable.
- ⚠️ `@ffmpeg-installer/*` ships a binary declared **GPLv3**; depending on it via npm is fine,
  bundling it into your own release is not without complying with the GPL.

Use it with your own voice, a licensed voice actor's voice, or a dataset that explicitly
permits reuse. See [NOTICE.md](NOTICE.md).

License: MIT for this repository's code.
