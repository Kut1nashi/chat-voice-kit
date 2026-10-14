'use strict';
/**
 * 跨平台路径解析自测：node test/platform-paths.cjs （或 npm test）
 *
 * 在任意平台上模拟 process.platform = win32 / linux / darwin，检查两个核心模块解析出来的
 * python / ffmpeg 路径带对了平台特征（Windows 要 .exe，其它平台不要），以及环境变量覆盖优先。
 * 没有 mac 机器时，这是唯一能覆盖 darwin 分支的办法；linux 另有真机验证。
 *
 * 注意：在 Windows 上模拟 linux 时，path.join 仍用 Windows 的分隔符（这是 node 限制，不是被测逻辑的问题），
 * 所以断言只看平台特征，不看分隔符。
 */
const path = require('path');
const assert = require('assert');

const TRUE_PLATFORM = process.platform;
const ENV_KEYS = ['VOICE_TTS_PY', 'VOICE_TTS_FFMPEG', 'VOICE_STT_FFMPEG', 'VOICE_TTS_GSV_DIR', 'VOICE_STT_MODEL_DIR'];

function setPlatform(platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/** 在指定平台上重新加载两个模块（清 require 缓存，让模块顶层的路径常量重算）。 */
function load(platform) {
  setPlatform(platform);
  for (const m of ['../src/tts-core.cjs', '../src/stt-core.cjs']) delete require.cache[require.resolve(m)];
  return { tts: require('../src/tts-core.cjs'), stt: require('../src/stt-core.cjs') };
}

const isExe = (p) => /\.exe$/i.test(String(p));
let failed = 0;

for (const key of ENV_KEYS) delete process.env[key];

for (const platform of ['win32', 'linux', 'darwin']) {
  try {
    const { tts, stt } = load(platform);
    if (platform === 'win32') {
      assert.ok(isExe(tts.PY), `win32 tts.PY 应为 .exe，实为 ${tts.PY}`);
      assert.ok(isExe(tts.FFMPEG), `win32 tts.FFMPEG 应为 .exe，实为 ${tts.FFMPEG}`);
      assert.ok(isExe(stt.FFMPEG), `win32 stt.FFMPEG 应为 .exe，实为 ${stt.FFMPEG}`);
    } else {
      assert.ok(!isExe(tts.PY), `${platform} tts.PY 不该是 .exe，实为 ${tts.PY}`);
      assert.ok(!isExe(tts.FFMPEG), `${platform} tts.FFMPEG 不该是 .exe，实为 ${tts.FFMPEG}`);
      assert.ok(!isExe(stt.FFMPEG), `${platform} stt.FFMPEG 不该是 .exe，实为 ${stt.FFMPEG}`);
      assert.ok(/python/.test(tts.PY), `${platform} tts.PY 应指向 python，实为 ${tts.PY}`);
    }
    console.log(`ok   ${platform.padEnd(6)} py=${tts.PY}\n${' '.repeat(12)}tts-ffmpeg=${tts.FFMPEG}\n${' '.repeat(12)}stt-ffmpeg=${stt.FFMPEG}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${platform}: ${e.message}`);
  } finally {
    setPlatform(TRUE_PLATFORM);
  }
}

// 环境变量覆盖必须优先于平台推断
process.env.VOICE_TTS_PY = path.join(path.sep, 'custom', 'py39');
process.env.VOICE_TTS_FFMPEG = path.join(path.sep, 'custom', 'ffmpeg-7');
process.env.VOICE_STT_FFMPEG = path.join(path.sep, 'custom', 'ffmpeg-7');
try {
  const { tts, stt } = load('linux');
  assert.strictEqual(tts.PY, process.env.VOICE_TTS_PY, 'VOICE_TTS_PY 覆盖未生效');
  assert.strictEqual(tts.FFMPEG, process.env.VOICE_TTS_FFMPEG, 'VOICE_TTS_FFMPEG 覆盖未生效');
  assert.strictEqual(stt.FFMPEG, process.env.VOICE_STT_FFMPEG, 'VOICE_STT_FFMPEG 覆盖未生效');
  console.log('ok   env-override 优先于平台推断');
} catch (e) {
  failed++;
  console.error(`FAIL env-override: ${e.message}`);
} finally {
  for (const key of ENV_KEYS) delete process.env[key];
  setPlatform(TRUE_PLATFORM);
}

if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
