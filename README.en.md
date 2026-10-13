# chat-voice-kit

Local, offline **speech in / speech out** kit for chat bots:

- **STT** — QQ SILK / amr / mp3 / wav → 16 kHz mono → [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) + SenseVoice → text
- **TTS** — text → [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) v4 zero-shot voice cloning → wav, with leading/trailing padding and trailing-silence trim

Two CommonJS files, ~800 lines, no cloud APIs. `require` them by absolute path; the host
project installs nothing.

```bash
npm install
VOICE_TTS_GSV_DIR=/path/to/GPT-SoVITS node examples/say.cjs "こんにちは"
node examples/stt-cli.cjs voice.amr
```

See [`README.md`](README.md) (Chinese) for setup, environment variables, and the tuning notes
in [`docs/tuning-notes.md`](docs/tuning-notes.md).

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
