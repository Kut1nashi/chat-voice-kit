# chat-voice-kit

给聊天机器人（QQ / Discord / 自建 IM 都行）用的**本地语音收发套件**——两条腿：

- **识别（STT）**：QQ SILK / amr / mp3 / wav… → 16k 单声道 → [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) + SenseVoice → 文本
- **合成（TTS）**：文本 → [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) v4 零样本音色克隆 → wav（带首尾留白、尾静音裁剪）

全部离线，不调任何云 API。核心是两个 `*.cjs` 文件，加起来 800 行左右，
**按绝对路径 require 就能用，宿主项目里不用装任何东西**。

```
音频文件 ──► stt-core.cjs ──► 文本 ──►（你的机器人逻辑）──► 文本
                                                              │
   播放/发送 ◄── wav ◄── tts-core.cjs ◄───────────────────────┘
```

---

## 合规：什么能发，什么不能发

**这段比代码重要，先看。**

### ✅ 可以开源的部分（就是本仓库的内容）

| 东西 | 为什么可以 |
| --- | --- |
| `src/tts-core.cjs`、`src/stt-core.cjs` | 我们自己写的胶水代码，MIT 授权 |
| 调用 GPT-SoVITS / sherpa-onnx 的方式 | 两个上游都是 MIT / Apache-2.0，是"调用"不是"再分发" |
| SILK 解析、ffmpeg 调参、切分/种子/留白这些经验 | 事实性技术发现，随便发 |

### ❌ 不能发到 GitHub 的部分

| 东西 | 为什么不行 |
| --- | --- |
| **微调出来的声音模型**（`*.pth` / `*.ckpt`） | 权重是从某个具体人的录音里学出来的音色。**声音人格权（公开权）属于那位本人**，未经书面授权发布权重 = 侵权，和"开源代码"是两回事 |
| **参考音频**（切出来的几秒人声） | 素材通常来自番剧 / 游戏 / 直播，素材本身还有一层版权 |
| **训练集**（`dataset/`、切片 wav） | 同上，且往往是最直接的侵权证据 |
| **和某个具体角色绑定的角色卡 / 人设 / 提示词** | 角色形象属于 IP 方 |
| **配置里的个人信息** | QQ 号、群号、token、绝对路径、聊天记录 |

**结论：这个项目可以发，但必须以「框架 + 你自己提供合法音色」的形态发。**
把 `ref/` 留空、把 `model/` 和 `frozen/` 排除在仓库外、给你的 README 写清
"请使用你有权使用的声音"——这样它就是一个干净的工具项目，而不是一个盗版音色分发包。

`.gitignore` 已经默认挡住 `*.pth` / `*.ckpt` / `*.onnx` / `ref/*.wav` / `out/` / `state/`，
**但推之前还是自己 `git status` 看一遍**，别把不该发的东西带上去。

---

## 安装

```bash
git clone https://github.com/Kut1nashi/chat-voice-kit.git
cd chat-voice-kit
npm install            # 装 sherpa-onnx-node / silk-wasm / ffmpeg（可选依赖）
```

### 合成侧：GPT-SoVITS

1. 下载 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)（本套件在 v4 整合包 `20250529` 上验证）。
2. 用环境变量指向它（默认找 `<项目根>/vendor/GPT-SoVITS`）：

```bash
VOICE_TTS_GSV_DIR=D:/somewhere/GPT-SoVITS-v4-20250529
```

3. 在 `GPT_SoVITS/configs/tts_infer.yaml` 的 `custom:` 段里指定你要用的权重：
   `t2s_weights_path`（GPT 权重）、`vits_weights_path`（SoVITS 权重）、`device: cuda`、`is_half: true`、`version: v4`。
4. 放好参考音频 `ref/reference.wav`（+ 同名 `.txt` 写它的原文）。

### 识别侧：SenseVoice 模型

把模型的 `model.int8.onnx` 和 `tokens.txt` 放进 `model/`，或：

```bash
VOICE_STT_MODEL_DIR=D:/somewhere/sense-voice-model
```

---

## 用法

### 命令行

```bash
# 环境自检
node src/tts-core.cjs --check
node src/stt-core.cjs --check

# 合成一句话
node examples/say.cjs "おはよう。今日もかわいいね。"
# → out/tts-<时间戳>-<随机>.wav

# 转写一个音频文件（自动识别 SILK）
node examples/stt-cli.cjs some-voice.amr
```

### 代码里调

```js
const tts = require('./src/tts-core.cjs');
const stt = require('./src/stt-core.cjs');

// 合成：失败会抛错，自己决定怎么退回文本
const { path, bytes, ms } = await tts.synthesize('ちゃんと聞こえてるよ。', {
  textLang: 'ja',        // 合成文本的语种
  promptLang: 'ja',      // 参考音频的语种
  speed: 0.88,           // 语速
  seed: 123              // 固定种子，语速才不飘
});

// 识别：接缓冲区，SILK 会自动解码
const { text, lang, ms: sttMs } = await stt.transcribeBuffer(buf);
```

两个模块都是**懒启动**：第一次调用时自己把服务拉起来（模型加载几十秒），
之后按 `VOICE_TTS_IDLE_MS`（默认 10 分钟）空闲自动卸载，稳态不占显存。
想一直热着就设 `VOICE_TTS_IDLE_MS=0`。

### 主要环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VOICE_TTS_GSV_DIR` | `<root>/vendor/GPT-SoVITS` | GPT-SoVITS 整合包根目录 |
| `VOICE_TTS_REF` | `<root>/ref/reference.wav` | 参考音频 |
| `VOICE_TTS_HOST` / `VOICE_TTS_PORT` | `127.0.0.1` / `9880` | 合成服务地址（可以复用你已经起好的实例） |
| `VOICE_TTS_IDLE_MS` | `600000` | 空闲卸载毫秒，`0` = 常驻 |
| `VOICE_TTS_TEXT_LANG` / `VOICE_TTS_PROMPT_LANG` | `ja` / `ja` | 文本 / 参考音频语种 |
| `VOICE_TTS_SPEED` | `0.88` | 语速 |
| `VOICE_TTS_SEED` | `123` | 随机种子，`-1` = 每次随机 |
| `VOICE_TTS_PAD_MS` | `300` | 首尾补静音（毫秒） |
| `VOICE_TTS_FADE_MS` | `0` | 淡出（默认关，别开，见调参记录） |
| `VOICE_STT_MODEL_DIR` | `<root>/model` | 识别模型目录 |
| `VOICE_STT_LANG` | `zh` | SenseVoice 语种；片假名密集的日语请改 `ja` |
| `VOICE_STT_FFMPEG` | 依赖包里的 | 自备 ffmpeg 时指定 |

---

## 调参记录（都是实测，不是抄文档）

见 [`docs/tuning-notes.md`](docs/tuning-notes.md)。几句最有用的：

- **`text_split_method` 千万别用 `cut5`**：它按标点把话切成碎片分别合成再拼，
  短句开头会被念歪甚至吃掉；用 `cut2`（约 50 字才切）。
- **固定 `seed`**：同一句话不同种子的净语音时长能差 12%，语速会飘。
- **别用输出侧淡出**治"最后一音仓促"：根因在参考音频的结尾本身是硬切，
  该去修参考，不是压输出振幅。
- **`super_sampling` 在 v4 上是空操作**（输出字节完全一致）；`sample_steps` 32→96 只变慢不变好。
- **首静音要补**：api_v2 的输出尾静音有 0.2~0.27s，但首静音很短，播放器容易削掉第一个字。

## 接到聊天机器人上

见 [`docs/qq-bridge-integration.md`](docs/qq-bridge-integration.md)（以 QQ 桥接为例，别的平台同理）：

- 什么时机该回语音（对方发语音 / 模型自己写了标记），什么时机回落文本；
- 限流（`maxPerMinute` / `maxPerHour`）为什么必须有；
- 怎么在提示词里要求模型输出「日文原句 || 中文翻译」，让它既能合成又能给人看翻译。

## 许可

本仓库代码：MIT（见 [LICENSE](LICENSE)）。
第三方组件与它们的许可：见 [NOTICE.md](NOTICE.md)——**注意 ffmpeg 是 GPLv3**，
你要把 ffmpeg 二进制打进自己的发行包，就得按 GPLv3 办事。
