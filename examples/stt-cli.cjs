'use strict';
/**
 * 转写示例：node examples/stt-cli.cjs <音频文件>
 * 支持 SILK（QQ 语音，常见后缀 .amr/.silk）、wav、mp3、m4a、flac 等 ffmpeg 能解的格式。
 */
const path = require('path');
const stt = require(path.join(__dirname, '..', 'src', 'stt-core.cjs'));

(async () => {
  const file = process.argv[2];
  if (!file) {
    console.error('用法：node examples/stt-cli.cjs <音频文件>');
    process.exit(2);
  }
  if (!stt.available()) {
    console.error('环境不完整：需要 ffmpeg + 模型。');
    console.error(JSON.stringify({ ffmpeg: stt.FFMPEG, modelDir: stt.MODEL_DIR }, null, 2));
    process.exit(2);
  }
  try {
    const r = await stt.transcribeFile(file);
    console.log(`text: ${r.text}`);
    console.log(`lang: ${r.lang}   ms: ${r.ms}`);
  } catch (error) {
    console.error('FAIL', error?.message ?? error);
    process.exit(1);
  }
})();
