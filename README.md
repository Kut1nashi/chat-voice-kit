# chat-voice-kit
给聊天机器人（QQ / Discord / 自建 IM 都行）用的本地语音收发套件
两条腿：
- **识别（STT）**：QQ SILK / amr / mp3 / wav… → 16k 单声道 → [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) + SenseVoice → 文本
- **合成（TTS）**：文本 → [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) v4 零样本音色克隆 → wav（带首尾留白、尾静音裁剪）
全部离线，不调任何云 API。核心是两个 `*.cjs` 文件，加起来 800 行左右，
**按绝对路径 require 就能用，宿主项目里不用装任何东西**。
音频文件 ──► stt-core.cjs ──► 文本 ──►（你的机器人逻辑）──► 文本
                                                              │
   播放/发送 ◄── wav ◄── tts-core.cjs ◄───────────────────────┘
