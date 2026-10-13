'use strict';
/**
 * 合成示例：node examples/say.cjs "要合成的文本" [输出目录]
 * 环境变量与 src/tts-core.cjs 一致。
 */
const path = require('path');
const tts = require(path.join(__dirname, '..', 'src', 'tts-core.cjs'));

(async () => {
  const args = process.argv.slice(2);
  const text = args.filter((a) => !a.startsWith('--')).join(' ').trim()
    || 'これはローカル音声合成のテストです。';
  if (!tts.available() && !tts.needsReference()) {
    console.error('环境不完整：检查 VOICE_TTS_GSV_DIR 是否指向 GPT-SoVITS 整合包。');
    console.error(JSON.stringify({ gsvDir: tts.GSV_DIR, python: tts.PY, ffmpeg: tts.FFMPEG }, null, 2));
    process.exit(2);
  }
  if (tts.needsReference()) {
    console.error(`缺少参考音频：${tts.DEFAULT_REF}`);
    console.error('放一段你有权使用的人声进去，或用 VOICE_TTS_REF 指定。');
    process.exit(2);
  }
  try {
    const out = await tts.synthesize(text, { log: console.log });
    console.log(JSON.stringify(out, null, 2));
  } catch (error) {
    console.error('FAIL', error?.message ?? error);
    process.exit(1);
  }
})();
