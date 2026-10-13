# NOTICE — 第三方组件与许可

本仓库**只包含自己写的胶水代码**（`src/`、`examples/`），不含任何语音模型、参考音频或第三方二进制。
以下组件由使用者自行获取，各自遵循其原始许可：

| 组件 | 用途 | 许可 | 获取方式 |
| --- | --- | --- | --- |
| [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) | 文本→语音（api_v2.py，HTTP 调用） | MIT (© 2024 RVC-Boss) | 自行下载整合包，用 `VOICE_TTS_GSV_DIR` 指向它 |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（`sherpa-onnx-node` 1.13.8） | 语音识别推理引擎 | Apache-2.0 | `npm i sherpa-onnx-node` |
| SenseVoice 模型（`model.int8.onnx` + `tokens.txt`） | 识别模型权重 | 上游未见随包许可文件，**请以 FunAudioLLM/SenseVoice 官方仓库的许可为准，本仓库不转售不分发** | 从上游 / sherpa-onnx 模型发布页自行下载 |
| [silk-wasm](https://github.com/idranme/silk-wasm) 3.7.1 | QQ SILK 语音解码 | MIT | `npm i silk-wasm` |
| [ffmpeg](https://ffmpeg.org/)（`@ffmpeg-installer/win32-x64` 4.1.0） | 音频转码 | **GPLv3**（该 npm 包声明） | `npm i @ffmpeg-installer/win32-x64`，或自备 ffmpeg 用 `VOICE_STT_FFMPEG` / `VOICE_TTS_FFMPEG` 指定 |

## 分发 ffmpeg 时的注意点

`@ffmpeg-installer/*` 分发的 ffmpeg 二进制在包元数据里声明为 **GPLv3**。以 npm 依赖方式安装
（本仓库的做法）不构成"再分发"，但如果你的发行版把 ffmpeg 二进制打包进去一起发，就需要
遵守 GPLv3（提供对应源码/构建信息等）。想省事就让使用者自己装 ffmpeg，并通过环境变量指路径。

## 关于音色

本仓库不含、也不会替你获取任何人的声音模型。你放进 `ref/` 的参考音频、以及你在 GPT-SoVITS 上
微调出来的权重，其权利与合规责任完全在你——见 README「合规：什么能发，什么不能发」。
