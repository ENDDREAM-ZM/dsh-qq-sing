<div align="center">

# dsh-qq-sing

**给 DSH 用的 QQ 点歌插件 · QQ音乐 / 酷狗 / 网易云三源，列表选歌，语音条 + 原文件双发**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![DSH](https://img.shields.io/badge/DSH-%E2%89%A5%200.1-8A2BE2)
![OneBot](https://img.shields.io/badge/OneBot-v11-00A1D6)
![Node](https://img.shields.io/badge/Node-%E2%89%A5%2020-339933)
![QQ音乐](https://img.shields.io/badge/QQ%E9%9F%B3%E4%B9%90-%E2%9C%93-31C27C)
![酷狗](https://img.shields.io/badge/%E9%85%B7%E7%8B%97-%E2%9C%93-2CA2F9)
![网易云](https://img.shields.io/badge/%E7%BD%91%E6%98%93%E4%BA%91-%E2%9C%93-E60026)

</div>

> 群友说「点歌 晴天」→ 选音源 → 选歌 → 收歌。不需要模型参与，零延迟、不会答非所问。

---

在 QQ 里说「点歌 晴天」，机器人先问你用哪个音源，再列候选，你回个序号就把歌发过来（语音条 + 原文件双发）。

- **三音源**：QQ音乐 / 酷狗音乐 / 网易云音乐
- **音质优先**：按未登录/登录状态自动挑最高的那档（无损 → 320k → 128k），超体积自动降档
- **平台顺序不改**：平台给什么顺序就什么顺序，插件只做「屏蔽词 / 时长 / 必须包含搜索词」剔除
- **会员歌也展示**：取不到就直说「这首歌需要会员」

---

## 指令

| 你说 | 它做什么 |
|---|---|
| `点歌 晴天` | 列音源菜单（1 QQ音乐 / 2 酷狗 / 3 网易云） |
| `1` / `第二首` / `0 取消` | 选音源 / 选歌 / 取消 |
| `@机器人 点歌 起风了` | 群里默认要 @，见 `allowGroupWithoutAt` |

支持的前缀：`点歌` `点一首` `点首` `唱一首` `唱个` `唱` `来一首` `来首` `放一首` `放首` `想听`
（冒号、逗号可有可无，中英文都行）

搜索是**包含式**的：搜 `远航星` 能出来 `远航星的告别`；搜 `EZ4ENCE` 能出来 `EZ4ENCE (kannatuslaulu)`。

---

## 设置

| 字段 | 默认 | 说明 |
|---|---|---|
| `onebotHttpUrl` | `http://127.0.0.1:3000` | OneBot HTTP API |
| `onebotWsUrl` | `ws://127.0.0.1:3001` | OneBot 正向 WebSocket |
| `onebotToken` | `""` | HTTP token |
| `onebotWsToken` | `""` | WS token，留空 = 同 HTTP（SnowLuma 两者不同） |
| `selfId` | `""` | 机器人自己的 QQ 号 |
| `ownerQQ` | `""` | 主人 QQ（登录态过期时私聊提醒用，可空） |
| `qqMusicCookie` | `""` | QQ音乐登录态，见下 |
| `kugouCookie` | `""` | 酷狗登录态 |
| `neteaseCookie` | `""` | 网易云登录态 |
| `topN` | `6` | 候选表最多几条 |
| `minSeconds` | `20` | 短于此的当片段剔除 |
| `maxSeconds` | `480` | 长于此的剔除 |
| `maxMB` | `14` | 单个文件上限，超了自动降档 |
| `sendMode` | `voice` | `voice` 语音条+文件 / `file` 只发文件 / `voiceOnly` 只发语音条 |
| `chooseTtlSeconds` | `300` | 候选表几分钟内有效 |
| `allowGroupWithoutAt` | `false` | 群里不 @ 也响应 |
| `banWords` | 29 条 | 搜索屏蔽词，见下 |

### banWords 怎么写

一行一个，或者用 `,` `，` `;` `|` `、` 空格分隔都行，留空 = 不屏蔽：

```yaml
banWords: |
  dj
  混音
  伴奏
  纯音乐
```

默认屏蔽：`dj 混音 电音 慢摇 车载 串烧 鬼畜 电摇 摇摆 蹦迪 鼓点 重低音 加速版 降速版 减速版 降调 升调 变速 改编 抖音版 节奏版 旋律版 钢琴版 吉他版 伴奏 纯音乐 铃声 karaoke instrumental`
（**不含** `remix` / `混音` 之类以外的重混版本；纯 ASCII 词做了词边界，不会把 `adj` 当成 `dj`）

---

## 登录（会员歌 / 高音质）

三个平台的登录态都是 cookie，面板只能填字符串，所以给了一个扫码脚本：

```bash
node tools/login.mjs --platform qq            # QQ音乐 · QQ 扫码
node tools/login.mjs --platform qq --wechat   # QQ音乐 · 微信扫码
node tools/login.mjs --platform kugou         # 酷狗音乐 · App 扫码
node tools/login.mjs --platform netease       # 网易云音乐 · App 扫码（需 npm i qrcode）
```

- 二维码会存成 `qr/*.png`，加 `--serve` 会额外起个本地 http，手机同网段直接打开扫；
- 扫完脚本直接打印一行 cookie，粘到对应设置里；
- 微信那条链路偶尔会先返回 `loginType 2` 失败，脚本会自动再试 `loginType 1`。

| 平台 | 登录后多什么 |
|---|---|
| QQ音乐 | 320k / 无损（绿钻）；不登录只能搜、放不了 |
| 酷狗 | 高音质直链更稳 |
| 网易云 | 会员曲（`fee=1/4`）能放；免费曲不登录也有 320k |

**不登录也能用**：能搜、能放免费歌，会员歌会回「这首歌需要会员，登录有会员的账号后重试」。

---

## 各音源能力对比

| 音源 | 免登录 | 会员曲 | 备注 |
|---|---|---|---|
| QQ音乐 | 只能搜（匿名播放已关） | 需绿钻 cookie | 未登录会自动去另两个源找同一首 |
| 酷狗 | 能搜能放 128k | 标记 `privilege=5` 视为会员 | 华语老歌较全 |
| 网易云 | 能搜能放 320k | `fee=1/4` 需 cookie | 翻唱多，按平台原序展示 |

---

## 自测

```bash
node contract-test.mjs     # 用真 defineTool 校验 3 个工具的 output.render
node smoke-test.mjs        # 假 OneBot 服务跑一遍：搜歌 → 选歌 → 真发语音条
```

---

## 已知边界

- QQ音乐匿名接口随时可能收紧（现在只给搜索不给直链）；
- 三个平台的接口都是内部接口，字段变化会导致搜不到，先跑 `smoke-test.mjs` 定位；
- 语音条音质受 QQ 限制（silk 单声道 ~24kbps），要原音质就选 `sendMode: file`。

---

<!-- siblings -->
## 相关插件

- [dsh-qq-image](https://github.com/ENDDREAM-ZM/dsh-qq-image) · 生图 / 封面 / 视频
- [dsh-qq-voice](https://github.com/ENDDREAM-ZM/dsh-qq-voice) · 9 种方言语音
- [dsh-qq-bundle](https://github.com/ENDDREAM-ZM/dsh-qq-bundle) · 三个一起装

---

## 免责声明

> [!WARNING]
> 本插件通过**非官方接口**访问 QQ，**可能违反腾讯服务条款并导致封号**。请使用**小号**测试。

| 风险 | 说明 |
|---|---|
| 账号 | 可能被限制、封禁或永久封号 |
| 数据 | 封号可能导致好友、群聊、记录不可恢复 |
| 接口 | 上游接口随时变更，功能可能突然失效 |
| 隐私 | 聊天内容会发送给你自行配置的模型服务商 |

**禁止用途**：违法违规、垃圾信息群发、诈骗骚扰、自动化养号、绕过腾讯安全风控、
大规模抓取他人数据、商业代挂代刷、侵犯他人隐私与著作权。

完整条款（含责任限制、合规检查清单、卸载方法）见 **[DISCLAIMER.md](DISCLAIMER.md)**。
