'use strict';
/**
 * 本地语音合成核心：文本 → wav（GPT-SoVITS v4，零样本音色克隆）。
 *
 * 设计目标：
 *   - 所有重依赖（GPT-SoVITS 整合包、CUDA 运行时、模型、ffmpeg）都留在整合包目录里，
 *     调用方只按绝对路径 require 本文件，宿主项目里不用装任何东西；
 *   - 对外只暴露几个函数，内部自己管 HTTP 服务的生命周期（没有常驻进程也能用）；
 *   - 任何一步失败都抛错，由调用方决定退回纯文本（绝不吞掉回复）。
 *
 * 服务形态：GPT-SoVITS 自带 api_v2.py 是 FastAPI，合成走 GET/POST /tts：
 *   text / text_lang / ref_audio_path / prompt_text / prompt_lang / media_type…
 * 启动参数：-a 绑定地址（默认 127.0.0.1）、-p 端口（默认 9880）、-c 配置文件。
 *
 * 参考音频（音色来源）放 <项目根>/ref/ 下，文件名可用 VOICE_TTS_REF 覆盖：
 *   - ref/reference.wav —— 必填，3~10 秒、单人、无 BGM/无混响的干净人声
 *   - ref/reference.txt —— 强烈建议：该段音频对应的原文（零样本克隆给了明显更稳）
 * ⚠️ 你有权使用的音色才放进来，见 README「合规」一节。
 * 用 cutReference() 可以从任意音视频文件里切出参考片段。
 *
 * 环境变量：
 *   VOICE_TTS_GSV_DIR   GPT-SoVITS 整合包根目录（含 api_v2.py、GPT_SoVITS/；Windows 整合包另含 runtime/python.exe、ffmpeg.exe）
 *   VOICE_TTS_PY        Python 解释器（默认按平台推断，Linux/macOS 建议显式指定自己的 venv）
 *   VOICE_TTS_FFMPEG    ffmpeg 可执行文件（默认：整合包自带 → npm 装的 → PATH 上的）
 *   VOICE_TTS_REF       参考音频路径（默认 <项目根>/ref/reference.wav）
 *   VOICE_TTS_HOST/PORT 服务地址（默认 127.0.0.1:9880）
 *   VOICE_TTS_IDLE_MS   空闲多久后自动卸载服务（默认 600000；0 = 常驻不卸载）
 *   VOICE_TTS_SEED      随机种子（默认 123 固定；-1 = 每次随机）
 *   VOICE_TTS_PAD_MS    首尾补静音毫秒（默认 300；0 = 不补）
 *   VOICE_TTS_FADE_MS   淡出毫秒（默认 0，见文件末尾「尾部处理」说明）
 *   VOICE_TTS_TRIM_TAIL 设为 '0' 关闭尾部静音裁剪
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const REF_DIR = path.join(PROJECT_ROOT, 'ref');
const OUT_DIR = path.join(PROJECT_ROOT, 'out');

// ── 跨平台取路径 ─────────────────────────────────────────────────────────────
// Windows 整合包是 runtime/python.exe + ffmpeg.exe；Linux/macOS 没有统一布局（多半是自己
// 建的 conda/venv），所以下面按平台挑默认值，全部可以被环境变量覆盖。
const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

/** 在 PATH 上找一个可执行文件，返回绝对路径；找不到返回 null。 */
function which(cmd) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = IS_WIN
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      if (exists(full)) return full;
    }
  }
  return null;
}

/** 返回候选列表里第一个存在的路径；都找不到返回 null。 */
function firstExisting(list) {
  for (const f of list) if (f && exists(f)) return f;
  return null;
}

// GPT-SoVITS 整合包位置（必须用环境变量指定，仓库里不含整合包）
const GSV_DIR = process.env.VOICE_TTS_GSV_DIR
  || path.join(PROJECT_ROOT, 'vendor', 'GPT-SoVITS');
const API = path.join(GSV_DIR, 'api_v2.py');
const CFG = path.join(GSV_DIR, 'GPT_SoVITS', 'configs', 'tts_infer.yaml');

// Python 解释器：Windows 用整合包自带的 runtime/python.exe；Linux/macOS 依次找整合包/venv 里的
// python，最后退回 PATH 上的 python3（那个解释器得装了 GPT-SoVITS 依赖，否则显式设 VOICE_TTS_PY）。
const PY = process.env.VOICE_TTS_PY || firstExisting(IS_WIN
  ? [path.join(GSV_DIR, 'runtime', 'python.exe')]
  : [
      path.join(GSV_DIR, 'runtime', 'python'),
      path.join(GSV_DIR, 'runtime', 'bin', 'python'),
      path.join(GSV_DIR, '.venv', 'bin', 'python'),
      path.join(GSV_DIR, 'venv', 'bin', 'python')
    ])
  || (IS_WIN ? path.join(GSV_DIR, 'runtime', 'python.exe')
             : which('python3') || which('python') || 'python3');

// ffmpeg：整合包自带优先，其次 npm 按平台装的 @ffmpeg-installer/<platform>-<arch>，最后 PATH 上的。
const FFMPEG = process.env.VOICE_TTS_FFMPEG
  || firstExisting([
      path.join(GSV_DIR, `ffmpeg${EXE}`),
      path.join(PROJECT_ROOT, 'node_modules', '@ffmpeg-installer',
        `${process.platform}-${process.arch}`, `ffmpeg${EXE}`)
    ])
  || which('ffmpeg')
  || (IS_WIN ? path.join(GSV_DIR, 'ffmpeg.exe') : `ffmpeg${EXE}`);

const DEFAULT_REF = process.env.VOICE_TTS_REF || path.join(REF_DIR, 'reference.wav');
const DEFAULT_REF_TEXT_FILE = DEFAULT_REF.replace(/\.[^.]+$/u, '.txt');

const HOST = process.env.VOICE_TTS_HOST || '127.0.0.1';
const PORT = Number(process.env.VOICE_TTS_PORT || 9880);
const BASE = `http://${HOST}:${PORT}`;

let serverProc = null;
let serverStarting = null;

// 空闲自动卸载：闲置 IDLE_MS 后杀掉自己拉起的服务，稳态显存/内存占用归零。
const IDLE_MS = Number(process.env.VOICE_TTS_IDLE_MS || 600000);
let idleTimer = null;
function armIdle() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!(IDLE_MS > 0)) return;
  idleTimer = setTimeout(() => { try { stop(); } catch {} }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

function exists(f) {
  try { return fs.existsSync(f); } catch { return false; }
}

/** 整合包/运行时/配置/参考音频是否齐备。 */
function available() {
  return exists(PY) && exists(API) && exists(CFG) && exists(DEFAULT_REF);
}

/** 只差参考音频时为 true —— 用来给用户一句明确的提示。 */
function needsReference() {
  return exists(PY) && exists(API) && exists(CFG) && !exists(DEFAULT_REF);
}

function referenceText() {
  try {
    return fs.readFileSync(DEFAULT_REF_TEXT_FILE, 'utf8').replace(/\s+/gu, ' ').trim();
  } catch {
    return '';
  }
}

/** 服务探活：只要 HTTP 端口有响应就算活着（少参数时它回 400，也算活着）。 */
async function probe(timeoutMs = 2500) {
  try {
    await fetch(`${BASE}/tts`, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/**
 * 确保 TTS 服务在跑；不在就拉起来并等它 ready。
 * 首次启动要加载模型，实测较慢（几十秒级），所以等待上限给了 3 分钟。
 * @param {{log?: Function, waitMs?: number}} [options]
 * @returns {Promise<{ok: boolean, started: boolean, ms?: number}>}
 */
async function ensureServer(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const waitMs = Number(options.waitMs) || 180000;
  if (await probe()) { armIdle(); return { ok: true, started: false }; }
  if (serverStarting) return serverStarting;

  serverStarting = (async () => {
    for (const f of [PY, API, CFG]) {
      if (!exists(f)) {
        throw new Error(`缺少 GPT-SoVITS 文件：${f}（用 VOICE_TTS_GSV_DIR 指向整合包根目录）`);
      }
    }
    log(`[tts] 启动 GPT-SoVITS 服务 ${HOST}:${PORT} …`);
    const child = spawn(PY, [API, '-a', HOST, '-p', String(PORT), '-c', CFG], {
      cwd: GSV_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    serverProc = child;
    let tail = '';
    const eat = (d) => { tail = (tail + d.toString()).slice(-4000); };
    child.stdout.on('data', eat);
    child.stderr.on('data', eat);
    child.on('exit', (code) => {
      log(`[tts] 服务进程退出，code=${code}`);
      if (serverProc === child) serverProc = null;
    });

    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      if (await probe()) {
        const ms = Date.now() - t0;
        log(`[tts] 服务就绪，用时 ${ms}ms`);
        armIdle();
        return { ok: true, started: true, ms };
      }
      if (child.exitCode !== null) {
        throw new Error(`TTS 服务启动失败（code=${child.exitCode}）：${tail.slice(-400)}`);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`TTS 服务启动超时（${waitMs}ms）：${tail.slice(-400)}`);
  })().finally(() => { serverStarting = null; });

  return serverStarting;
}

/** 预热：把服务拉起来（第一次合成就不必再等模型加载）。 */
async function warmup(options = {}) {
  try {
    await ensureServer(options);
    return true;
  } catch {
    return false;
  }
}

/**
 * 文本 → wav 文件。
 * @param {string} text 要合成的文本。
 * @param {{refAudio?: string, promptText?: string, promptLang?: string, textLang?: string,
 *   splitMethod?: string, timeoutMs?: number, outDir?: string, log?: Function,
 *   speed?: number, sampleSteps?: number, superSampling?: boolean, temperature?: number,
 *   topK?: number, topP?: number, repetitionPenalty?: number, fragmentInterval?: number,
 *   seed?: number, padMs?: number, fadeMs?: number, trimTail?: boolean}} [options]
 * @returns {Promise<{path: string, bytes: number, ms: number, padded: boolean, faded: boolean}>}
 */
async function synthesize(text, options = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('要合成的文本为空');
  const refAudio = options.refAudio || DEFAULT_REF;
  if (!exists(refAudio)) {
    throw new Error(`参考音频不存在：${refAudio}（放一段干净人声到 ref/reference.wav，或用 VOICE_TTS_REF 指定）`);
  }
  await ensureServer({ log: options.log });

  const url = new URL(`${BASE}/tts`);
  url.searchParams.set('text', clean);
  url.searchParams.set('text_lang', options.textLang || process.env.VOICE_TTS_TEXT_LANG || 'ja');
  url.searchParams.set('ref_audio_path', refAudio);
  url.searchParams.set('prompt_text', options.promptText ?? referenceText());
  url.searchParams.set('prompt_lang', options.promptLang || process.env.VOICE_TTS_PROMPT_LANG || 'ja');
  // text_split_method：**绝对不要用 cut5**。
  // 实测：同一句「もしもし、聞こえる？ちゃんと聞こえてる？」只换切分方式，
  //   cut5 → 按标点切成 3 个碎片分别合成再拼接，回读成「ましまし聞こえるちゃんと聞こえてる。」
  //          （开头的"もしもし"被念歪/吃掉），净语音 2.93s
  //   cut0 → 整段一次合成，回读「もしもし聞こえる ちゃんと聞こえてる。」（完整），净语音 3.96s
  // 碎片越短越容易被削，chat 回复又普遍是一两句，所以默认 cut2（约 50 字才切一次）：
  // 短句保持整段，长文本照样会分段，兼顾稳定性。
  url.searchParams.set('text_split_method', options.splitMethod || process.env.VOICE_TTS_SPLIT || 'cut2');
  url.searchParams.set('batch_size', '1');
  url.searchParams.set('media_type', 'wav');
  url.searchParams.set('streaming_mode', 'false');
  // ── 音质调参 ────────────────────────────────────────────────────────────────
  // 参数名与取值范围全部取自本包 api_v2.py 的 /tts 定义，只做覆盖不发明：
  //   speed_factor       默认 1.0  —— 放慢语速的主杠杆
  //   sample_steps       默认 32   —— 越高越清晰（实测 32/48/64/96 对音质无差别，只是更慢）
  //   super_sampling     默认 false —— v3 专用，v4 上是空操作（实测字节完全一致）
  //   temperature        默认 1.0  —— 调低更稳、更少糊字
  //   top_k / top_p / repetition_penalty / fragment_interval —— 采样稳定性与句间停顿
  const q = (k, v) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  };
  q('speed_factor', options.speed ?? Number(process.env.VOICE_TTS_SPEED ?? 0.88));
  q('sample_steps', options.sampleSteps ?? 32);
  q('super_sampling', options.superSampling === false ? 'false' : 'true');
  q('temperature', options.temperature ?? 0.8);
  q('top_k', options.topK ?? 5);
  q('top_p', options.topP ?? 1);
  q('repetition_penalty', options.repetitionPenalty ?? 1.35);
  q('fragment_interval', options.fragmentInterval ?? 0.4);
  // 固定随机种子：不固定的话每次合成都在重掷骰子，同一句话的语速会飘
  // （实测 6 个 seed 的净语音时长 1.96~2.20 秒，差约 12%）。想恢复随机设 VOICE_TTS_SEED=-1。
  q('seed', options.seed ?? Number(process.env.VOICE_TTS_SEED ?? 123));

  const t0 = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(Number(options.timeoutMs) || 120000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TTS HTTP ${res.status}：${body.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('TTS 返回空音频');
  const outDir = options.outDir || OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  fs.writeFileSync(out, buf);
  armIdle();
  // ── 尾部处理：裁掉模型自带尾静音 + 可选淡出 + 首尾补静音 ──────────────────
  // 教训：**输出侧淡出是治错了地方**。淡出只压低末段振幅，并不会让收尾变自然，
  // 听感是"最后一个音又轻又仓促"。真正的原因是参考音频本身结尾就是硬切：
  // 实测某参考 尾静音 0.000s、末 50ms 相邻样本跳变 11.3%，而输出末段跳变 12.4%，
  // 与参考几乎一致 —— GPT-SoVITS 照参考的韵律生成结尾。
  // 所以默认 **不做淡出**（fadeMs=0），去参考音频侧解决；这里只保留
  //   ①裁掉模型自带尾静音（api_v2 输出自带约 0.20~0.27s 尾静音，否则补白会叠上去）
  //   ②首尾补静音（默认 300ms —— 首静音很短，客户端/播放器容易把开头的字削掉）
  // 淡出仍可用 fadeMs 或 VOICE_TTS_FADE_MS 临时开启做实验。
  const padMs = Number(options.padMs ?? process.env.VOICE_TTS_PAD_MS ?? 300);
  const fadeMs = Number(options.fadeMs ?? process.env.VOICE_TTS_FADE_MS ?? 0);
  const trimTail = options.trimTail ?? (process.env.VOICE_TTS_TRIM_TAIL !== '0');
  let bytes = buf.length;
  let padded = false;
  let faded = false;
  const filters = [];
  if (trimTail) {
    filters.push('areverse', 'silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak');
    if (fadeMs > 0) filters.push(`afade=t=in:st=0:d=${(fadeMs / 1000).toFixed(3)}`);
    filters.push('areverse');
  }
  if (padMs > 0) {
    filters.push(`adelay=${padMs}:all=1`, `apad=pad_dur=${(padMs / 1000).toFixed(3)}`);
  }
  if (filters.length) {
    const shapePath = `${out}.shape.wav`;
    const r = await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y', '-i', out,
      '-af', filters.join(','),
      '-c:a', 'pcm_s16le', shapePath
    ]);
    if (r.code === 0 && exists(shapePath)) {
      fs.rmSync(out, { force: true });
      fs.renameSync(shapePath, out);
      bytes = fs.statSync(out).size;
      faded = fadeMs > 0;
      padded = padMs > 0;
    } else {
      try { fs.rmSync(shapePath, { force: true }); } catch {}
      if (typeof options.log === 'function') {
        options.log(`[tts] 收尾整形失败（淡出${fadeMs}ms/补白${padMs}ms），改用原始音频：${String(r.stderr).trim().slice(0, 200)}`);
      }
    }
  }
  return { path: out, bytes, ms: Date.now() - t0, padded, padMs, faded, fadeMs };
}

// ---------------------------------------------------------------------------
// 参考音频制作（从任意音视频源里切片）
// ---------------------------------------------------------------------------

function runFfmpeg(args, timeoutMs = 120000) {
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
    child.on('error', (e) => { resolve({ code: -1, stderr: String(e?.message ?? e) }); });
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

/**
 * 从任意音视频文件里切一段当参考音频：转成单声道 wav。
 * @param {string} srcFile 源文件（mkv/mp4/wav…）
 * @param {number} startSec 起始秒
 * @param {number} durSec 时长秒（建议 3~10）
 * @param {{outFile?: string, sampleRate?: number}} [options]
 * @returns {Promise<{path: string, bytes: number, seconds: number}>}
 */
async function cutReference(srcFile, startSec, durSec, options = {}) {
  if (!exists(srcFile)) throw new Error(`源文件不存在：${srcFile}`);
  fs.mkdirSync(REF_DIR, { recursive: true });
  const out = options.outFile || DEFAULT_REF;
  const rate = Number(options.sampleRate) || 32000;
  const r = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(startSec), '-t', String(durSec), '-i', srcFile,
    '-vn', '-ac', '1', '-ar', String(rate), '-f', 'wav', out
  ]);
  if (!exists(out)) throw new Error(`切片失败：${r.stderr.trim().slice(0, 300)}`);
  const stat = fs.statSync(out);
  return { path: out, bytes: stat.size, seconds: Number(durSec) };
}

/** 参考音频降噪（afftdn 轻量方案，不需要额外模型）。 */
async function separateVocals(srcFile, options = {}) {
  const outDir = options.outDir || path.join(REF_DIR, 'separated');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, path.basename(srcFile).replace(/\.[^.]+$/u, '') + '_denoise.wav');
  const r = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y', '-i', srcFile,
    '-af', 'afftdn=nf=-25', '-ac', '1', '-ar', '32000', out
  ]);
  if (r.code !== 0) throw new Error(`降噪失败：${r.stderr.trim().slice(0, 300)}`);
  return { path: out, bytes: fs.statSync(out).size };
}

/** 关掉本模块拉起的服务进程（不动别人起的）。 */
function stop() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (serverProc) {
    try { serverProc.kill(); } catch {}
    serverProc = null;
  }
}

module.exports = {
  synthesize,
  ensureServer,
  warmup,
  available,
  needsReference,
  referenceText,
  cutReference,
  separateVocals,
  probe,
  stop,
  GSV_DIR,
  PY,
  FFMPEG,
  REF_DIR,
  DEFAULT_REF
};

// 命令行自测：node src/tts-core.cjs "要合成的文本"   /   node src/tts-core.cjs --check
if (require.main === module) {
  (async () => {
    if (process.argv.includes('--check')) {
      console.log(JSON.stringify({
        gsvDir: GSV_DIR,
        python: PY,
        ffmpeg: FFMPEG,
        ref: DEFAULT_REF,
        available: available(),
        needsReference: needsReference()
      }, null, 2));
      return;
    }
    const text = process.argv.slice(2).join(' ') || 'これはローカル音声合成のテストです。';
    console.log('available =', available());
    console.log('needsReference =', needsReference());
    try {
      const out = await synthesize(text, { log: console.log });
      console.log('OK', JSON.stringify(out));
    } catch (error) {
      console.error('FAIL', error?.message ?? error);
      process.exit(1);
    }
  })();
}
