'use strict';
/**
 * 本地语音转写核心：SILK / 普通音频 → 16k 单声道 WAV → sherpa-onnx SenseVoice → 文本。
 *
 * 依赖与模型都放本目录下（node_modules/ 与 model/），宿主项目通过绝对路径 require 本文件，
 * 这样宿主项目里不需要安装任何东西。
 *
 * 两个实测坑：
 *   1. QQ 语音文件后缀常是 .amr，内容其实是 SILK（头部 02 + "#!SILK_V3"）。
 *   2. silk-wasm 必须吃**原始缓冲区**（保留 0x02 前缀）；去掉前缀会 silk decoding failure。
 *
 * 已知限制：SenseVoice 的 language 参数若固定成 'zh'，片假名密集的日语会转出乱码；
 * 平假名为主或纯中文/英文正常。用 VOICE_STT_LANG 按语种切换（zh / ja / en / ko / yue / auto）。
 *
 * 环境变量：
 *   VOICE_STT_MODEL_DIR 模型目录（默认 <项目根>/model，需含 model.int8.onnx + tokens.txt）
 *   VOICE_STT_LANG      SenseVoice language（默认 zh）
 *   VOICE_STT_FFMPEG    ffmpeg 可执行文件路径（默认用 node_modules 里装的）
 *   VOICE_STT_THREADS   推理线程数（默认 2）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const MODEL_DIR = process.env.VOICE_STT_MODEL_DIR || path.join(PROJECT_ROOT, 'model');
const FFMPEG = process.env.VOICE_STT_FFMPEG
  || path.join(PROJECT_ROOT, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
const MODEL = path.join(MODEL_DIR, 'model.int8.onnx');
const TOKENS = path.join(MODEL_DIR, 'tokens.txt');
const SAMPLE_RATE = 16000;
const LANGUAGE = process.env.VOICE_STT_LANG || 'zh';
const SILK_MAGIC = Buffer.from('#!SILK_V3');

let _silk = null;
let _sherpa = null;
let _recognizer = null;
let _loadError = null;

function deps() {
  if (_loadError) throw _loadError;
  try {
    if (!_silk) _silk = require(path.join(PROJECT_ROOT, 'node_modules', 'silk-wasm'));
    if (!_sherpa) _sherpa = require(path.join(PROJECT_ROOT, 'node_modules', 'sherpa-onnx-node'));
  } catch (error) {
    _loadError = error;
    throw error;
  }
  return { silk: _silk, sherpa: _sherpa };
}

function available() {
  try {
    return [FFMPEG, MODEL, TOKENS].every((f) => fs.existsSync(f));
  } catch {
    return false;
  }
}

function recognizer() {
  if (_recognizer) return _recognizer;
  const { sherpa } = deps();
  for (const f of [FFMPEG, MODEL, TOKENS]) {
    if (!fs.existsSync(f)) throw new Error(`缺少文件：${f}`);
  }
  _recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: MODEL, language: LANGUAGE, useInverseTextNormalization: 1 },
      tokens: TOKENS,
      numThreads: Number(process.env.VOICE_STT_THREADS || 2),
      provider: 'cpu',
      debug: 0
    }
  });
  return _recognizer;
}

/** 预热：提前把模型读进内存，避免第一条语音多等 1~2 秒。返回是否可用。 */
function warmup() {
  try {
    recognizer();
    return true;
  } catch {
    return false;
  }
}

function isSilk(buf) {
  return Buffer.isBuffer(buf) && buf.length > 9 && buf.indexOf(SILK_MAGIC) >= 0;
}

function runFfmpeg(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stderr: String(error?.message ?? error) });
      return;
    }
    let stderr = '';
    let timer = null;
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (error) => { resolve({ code: -1, stderr: String(error?.message ?? error) }); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stderr });
    });
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ code: -2, stderr: `ffmpeg 超时（${timeoutMs}ms）` });
    }, timeoutMs);
  });
}

/** 任意音频缓冲区 → 16k 单声道 wav 文件路径（写进 tmpDir）。 */
async function toWav16k(buf, tmpDir) {
  const rawPath = path.join(tmpDir, 'in.raw');
  const wavPath = path.join(tmpDir, 'out.wav');
  fs.writeFileSync(rawPath, buf);
  if (isSilk(buf)) {
    const { silk } = deps();
    const decoded = await silk.decode(buf, 24000);
    const pcm = decoded?.data ?? decoded;
    if (!pcm || !pcm.length) throw new Error('SILK 解码结果为空');
    const pcmPath = path.join(tmpDir, 'in.pcm');
    fs.writeFileSync(pcmPath, Buffer.from(pcm));
    const r = await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath,
      '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 'wav', wavPath
    ]);
    if (!fs.existsSync(wavPath)) throw new Error(`SILK→wav 失败：${r.stderr.trim().slice(0, 200)}`);
    return wavPath;
  }
  const r = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y', '-i', rawPath,
    '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'wav', wavPath
  ]);
  if (!fs.existsSync(wavPath)) throw new Error(`音频解码失败：${r.stderr.trim().slice(0, 200)}`);
  return wavPath;
}

/**
 * 音频缓冲区 → { text, lang, ms }。
 * 抛错表示这次转写失败（调用方自己决定退回占位符）。
 */
async function transcribeBuffer(buf, { keepTemp = false } = {}) {
  if (!buf || !buf.length) throw new Error('音频为空');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-'));
  const started = Date.now();
  try {
    const wavPath = await toWav16k(buf, tmpDir);
    const { sherpa } = deps();
    const rec = recognizer();
    const wave = sherpa.readWave(wavPath);
    const stream = rec.createStream();
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
    rec.decode(stream);
    const out = rec.getResult(stream);
    return { text: String(out?.text ?? '').trim(), lang: out?.lang ?? '', ms: Date.now() - started };
  } finally {
    if (!keepTemp) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
}

/** 音频文件 → 文本（方便命令行/脚本直接用）。 */
async function transcribeFile(file) {
  return transcribeBuffer(fs.readFileSync(file));
}

module.exports = {
  transcribeBuffer, transcribeFile, warmup, available, isSilk,
  SAMPLE_RATE, MODEL_DIR, FFMPEG, ROOT: PROJECT_ROOT
};

// 命令行自测：node src/stt-core.cjs <音频文件>   /   node src/stt-core.cjs --check
if (require.main === module) {
  (async () => {
    if (process.argv.includes('--check')) {
      console.log(JSON.stringify({
        ffmpeg: FFMPEG, model: MODEL, tokens: TOKENS, language: LANGUAGE, available: available()
      }, null, 2));
      return;
    }
    const file = process.argv[2];
    if (!file) {
      console.error('用法：node src/stt-core.cjs <音频文件>');
      process.exit(2);
    }
    try {
      console.log('available =', available());
      console.log(JSON.stringify(await transcribeFile(file), null, 2));
    } catch (error) {
      console.error('FAIL', error?.message ?? error);
      process.exit(1);
    }
  })();
}
