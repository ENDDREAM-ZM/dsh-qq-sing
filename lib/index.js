// dsh-qq-sing —— 点歌插件（QQ / OneBot v11）
//
// 设计要点：
//   · 零硬编码凭据：所有 cookie / token / 地址都来自插件设置（Config schema），代码里没有任何密钥。
//   · 三源可独立降级：QQ音乐 / 酷狗 / 网易云，谁有就用谁，全没有就如实说。
//   · 排序完全听平台的：不重排、不猜原唱，只剔除 DJ/改编/伴奏、时长不合、歌名不含搜索词。
//   · 两条入口：QQ 里的确定性指令（点歌 → 选音源 → 选歌）+ 给 agent 用的工具（qq_sing_search / qq_sing_send）。

import { createAdapter } from './onebot.js';
import { registerTool, defineConfig, compatLine, compatReport } from './dsh-compat.js';
import { createQqMusic, LEVELS as QQ_LEVELS, sessionFromCookie } from './qqmusic.js';
import { createKugou, KUGOU_LEVELS } from './kugou.js';
import { createNetease, NETEASE_LEVELS } from './netease.js';

export const name = 'dsh-qq-sing';
export const inject = ['tools'];

// 搜索屏蔽词表：**可配置文本**（设置项 banWords），默认就是下面这份。
// 分发场景下每个人的口味不一样，所以默认只保留最普适的，用户自己在设置里增删。
// 分隔符：换行 / 逗号 / 中文逗号 / 分号 / 竖线 / 顿号 / 空格 都认，随便怎么粘。
// 注意：remix 不在默认名单里（remix 不算 DJ 版，默认放行）；想屏蔽就自己加进去。
export const DEFAULT_BAN_WORDS = [
  'dj', '混音', '电音', '慢摇', '车载', '串烧', '鬼畜', '电摇', '摇摆', '蹦迪',
  '鼓点', '重低音', '加速版', '降速版', '减速版', '降调', '升调', '变速',
  '改编', '抖音版', '节奏版', '旋律版', '钢琴版', '吉他版', '伴奏', '纯音乐',
  '铃声', 'karaoke', 'instrumental',
].join('\n');

export function splitBanWords(text) {
  return String(text || '')
    .split(/[\n\r,，;；|｜、\s]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 纯 ASCII 词（如 dj、remix）要求前面不是字母，避免 "dj" 命中 "adj"；中文词直接子串匹配。 */
export function buildBanRegex(words) {
  const list = (Array.isArray(words) ? words : splitBanWords(words)).filter(Boolean);
  if (!list.length) return null;
  const parts = list.map((w) => {
    const ascii = /^[\x20-\x7e]+$/.test(w);
    return ascii ? `(?:^|[^a-z0-9])${escapeRe(w)}` : escapeRe(w);
  });
  return new RegExp(parts.join('|'), 'i');
}

function makeBanner() {
  let lastText = null;
  let lastRe = null;
  return (item, banText) => {
    if (banText !== lastText) { lastText = banText; lastRe = buildBanRegex(banText); }
    if (!lastRe) return false;
    return lastRe.test(`${item?.title || ''} ${item?.album || ''} ${item?.alias || ''}`);
  };
}
export const Config = defineConfig({
  onebotHttpUrl: { type: 'string', default: 'http://127.0.0.1:3000', description: 'OneBot v11 HTTP 地址（NapCat / Lagrange / LLOneBot / snowluma 都在这个口）' },
  onebotWsUrl: { type: 'string', default: 'ws://127.0.0.1:3001', description: '正向 WebSocket 地址，例如 ws://127.0.0.1:3001；留空则只响应工具调用、不主动收 QQ 消息' },
  onebotToken: { type: 'string', default: '', description: 'OneBot HTTP token（没有就留空）' },
  onebotWsToken: { type: 'string', default: '', description: 'OneBot WebSocket token（留空=与 HTTP token 相同）。有些实现两个 token 不一样，例如 SnowLuma 的 WS 用 accessToken、HTTP 用 httpAccessToken' },
  selfId: { type: 'string', default: '', description: '机器人自己的 QQ 号，用来忽略自己发的消息、识别群里有没有 @' },
  ownerQQ: { type: 'string', default: '', description: '主人 QQ（只影响权限判断，可留空）' },
  qqMusicCookie: { type: 'string', default: '', description: 'QQ音乐 cookie（可留空）。关键字段 qm_keyst / qqmusic_key + uin，有它才能拿 320k/无损' },
  kugouCookie: { type: 'string', default: '', description: '酷狗 cookie（可留空，只有会员曲才需要）' },
  neteaseCookie: { type: 'string', default: '', description: '网易云 cookie（可留空，形如 MUSIC_U=...; __csrf=...）' },
  topN: { type: 'number', default: 6, description: '候选表最多几行' },
  minSeconds: { type: 'number', default: 20, description: '短于这个秒数的结果不要（片段/试听）' },
  maxSeconds: { type: 'number', default: 480, description: '长于这个秒数的结果不要' },
  maxMB: { type: 'number', default: 14, description: '单个音频文件上限（MB），超了自动降一档音质' },
  sendMode: { type: 'string', default: 'voice', description: '发送方式：voice=只发语音条 / file=只发文件 / both=语音条+文件' },
  chooseTtlSeconds: { type: 'number', default: 300, description: '选音源/选歌等回复的时限（秒）' },
  allowGroupWithoutAt: { type: 'boolean', default: false, description: '群里不 @ 机器人也响应点歌（默认关，免得吵）' },
  banWords: { type: 'string', default: DEFAULT_BAN_WORDS, description: '搜索屏蔽词（歌名/专辑/别名命中就整条剔除）。换行、逗号、竖线、空格分隔都行；留空 = 不屏蔽任何词。默认包含 dj/混音/伴奏/纯音乐 等，不含 remix' },
});

const SOURCES = [
  { key: 'qq', label: 'QQ音乐', alias: ['qq', 'qq音乐', 'qqmusic'] },
  { key: 'kugou', label: '酷狗', alias: ['酷狗', '酷狗音乐', 'kugou', 'kg'] },
  { key: 'netease', label: '网易云', alias: ['网易云', '网易云音乐', 'netease', '163'] },
];
const LABEL = Object.fromEntries(SOURCES.map((s) => [s.key, s.label]));

const OTHER_COMMAND_RE = /^(?:生图|画图|绘图|画一张|生视频|生成视频|封面|图片|视频|短片|生成|语音说|念一下|说一句|用.{1,10}话说|发.{0,8}语音|来段语音)/;

const int = (v, d, lo, hi) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const mmss = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');

export function cleanText(text) {
  return String(text || '')
    .replace(/^(\s*@[^\s@]{1,24}\s*)+/g, '')
    .replace(/^[\s，,。.：:、]+/, '')
    .trim();
}

function normKey(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[()\[\]{}（）【】《》<>"'`’“”·、,，.。!！?？~～\-_—:：;；/\\|+&]/g, '');
}

export function parseSingCommand(text) {
  const s = cleanText(text);
  const m = s.match(/^(?:点歌|点一首|点首|唱一首|唱个|唱|来一首|来首|放一首|放首|想听)\s*[:：,，、]?\s*(.*)$/);
  if (!m) return { hit: false, query: '' };
  const query = String(m[1] || '')
    .replace(/^(?:歌曲?|一首|首歌)\s*[:：]?\s*/, '')
    .replace(/^[《「"']|[》」"']$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { hit: true, query };
}

export function parseChoice(text) {
  const s = cleanText(text);
  if (!s) return 0;
  const cn = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  let m = s.match(/^(\d{1,2})\s*(?:首|个|号|\.|、)?$/);
  if (m) return Number(m[1]);
  m = s.match(/^第([0-9一二两三四五六七八九十]{1,2})\s*(?:首|个|号)?$/);
  if (m) return /^\d+$/.test(m[1]) ? Number(m[1]) : cn[m[1]] || 0;
  return 0;
}

function sourceByAlias(text) {
  const s = cleanText(text).toLowerCase();
  for (const src of SOURCES) if (src.alias.some((a) => s === a || s.includes(a))) return src.key;
  return '';
}

export function apply(ctx, config = {}) {
  const cfg = () => ({
    onebotHttpUrl: 'http://127.0.0.1:3000',
    onebotWsUrl: '',
    onebotToken: '',
    onebotWsToken: '',
    selfId: '',
    ownerQQ: '',
    qqMusicCookie: '',
    kugouCookie: '',
    neteaseCookie: '',
    topN: 6,
    minSeconds: 20,
    maxSeconds: 480,
    maxMB: 14,
    sendMode: 'voice',
    chooseTtlSeconds: 300,
    allowGroupWithoutAt: false,
    ...config,
  });
  const log = (msg) => console.log('[dsh-qq-sing]', msg);
  const fetchImpl = (...args) => globalThis.fetch(...args);

  const adapter = createAdapter({
    get httpUrl() { return cfg().onebotHttpUrl; },
    get wsUrl() { return cfg().onebotWsUrl; },
    get token() { return cfg().onebotToken; },
    get wsToken() { return cfg().onebotWsToken; },
    get selfId() { return cfg().selfId; },
    log,
  });

  const qq = createQqMusic({ fetchImpl, log });
  const kg = createKugou({ fetchImpl, log });
  const ne = () => createNetease({ fetchImpl, log, cookie: cfg().neteaseCookie });
  const qqSession = () => sessionFromCookie(cfg().qqMusicCookie);
  const hasSession = (src) => (src === 'qq' ? Boolean(qqSession()?.musickey) : src === 'netease' ? Boolean(cfg().neteaseCookie) : Boolean(cfg().kugouCookie));

  const isBanned = makeBanner();
  const banText = () => String(cfg().banWords ?? DEFAULT_BAN_WORDS);

  const stages = new Map();
  const ttl = () => int(cfg().chooseTtlSeconds, 300, 30, 3600) * 1000;
  const setStage = (key, data) => stages.set(key, { ...data, at: Date.now() });
  const readStage = (key) => {
    const st = stages.get(key);
    if (!st) return null;
    if (Date.now() - st.at > ttl()) { stages.delete(key); return null; }
    return st;
  };
  const clearStage = (key) => stages.delete(key);

  // ───────────── 搜索 ─────────────
  async function searchOne(source, query, limitRaw) {
    const limit = int(limitRaw, cfg().topN, 1, 20);
    const maxSec = int(cfg().maxSeconds, 480, 30, 3600);
    const minSec = int(cfg().minSeconds, 20, 1, 600);
    let items = [];
    if (source === 'qq') {
      const sess = qqSession();
      const raw = await qq.search(query, limit * 4, sess);
      items = raw.map((s) => ({ title: s.name, artist: s.singer, album: s.album, seconds: s.seconds, ref: s.mid, paid: Number(s.pay?.pay_play) === 1, src: 'qq' }));
    } else if (source === 'kugou') {
      const raw = await kg.search(query, limit * 4);
      items = raw.map((s) => ({ title: s.name, artist: s.singer, album: s.album, seconds: s.seconds, ref: s, paid: Number(s.privilege) === 5, src: 'kugou' }));
    } else {
      const raw = await ne().search(query, limit * 4);
      items = raw.map((s) => ({ title: s.name, artist: s.singer, album: s.album, seconds: s.seconds, alias: s.alias, ref: s.id, paid: s.fee === 1 || s.fee === 4, src: 'netease' }));
    }
    const qn = normKey(query);
    const parts = String(query).toLowerCase().split(/\s+/).map(normKey).filter(Boolean);
    const hit = (it) => {
      if (!qn) return true;
      const nameHay = `${normKey(it.title)}|${normKey(it.alias)}`;
      if (nameHay.includes(qn)) return true;
      if (parts.length > 1) {
        const hay = `${nameHay}|${normKey(it.artist)}|${normKey(it.album)}`;
        return parts.every((p) => hay.includes(p));
      }
      return false;
    };
    const kept = items.filter((it) => {
      if (!it.title) return false;
      if (isBanned(it, banText())) return false;
      if (it.seconds && (it.seconds < minSec || it.seconds > maxSec)) return false;
      return hit(it);
    });
    // 顺序：平台给什么顺序就是什么顺序，只做同名同歌手去重
    const seen = new Set();
    const picked = [];
    for (const it of kept) {
      const key = `${normKey(it.title)}|${normKey(it.artist)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(it);
      if (picked.length >= limit) break;
    }
    return { items: picked, total: items.length };
  }

  // ───────────── 取链 / 下载 ─────────────
  async function resolveAudio(source, item, keys) {
    if (source === 'qq') return { ...(await qq.getUrl(item.ref, qqSession(), keys)), source };
    if (source === 'kugou') return { ...(await kg.getUrl(item.ref, keys)), source };
    return { ...(await ne().getUrl(item.ref, keys)), source };
  }

  /** 这一首在别的音源上找同款：歌名越接近、歌手对得上、时长越像，分越高；只用来补「原音源放不出来」。 */
  const normText = (v) => String(v || '').replace(/[\s\-_()（）\[\]【】·、,，.。'"“”]/g, '').toLowerCase();
  function matchScore(target, cand) {
    const t = normText(target.title);
    const c = normText(cand.title);
    const singer = normText(String(target.artist || '').split('/')[0]);
    const candSinger = normText(cand.artist);
    let score = 0;
    if (c === t) score += 50;
    else if (c.startsWith(t)) score += 35;
    else if (c.includes(t)) score += 20;
    else return -1;
    if (singer && candSinger.includes(singer)) score += 40;
    else if (singer && singer.includes(candSinger)) score += 20;
    if (target.seconds && cand.seconds && Math.abs(target.seconds - cand.seconds) <= 15) score += 12;
    // 同款优先要干净的：现场/改编/翻唱版扣分
    if (/live|现场|演唱会|dj|remix|伴奏|改编|翻唱|钢琴|吉他/i.test(cand.title)) score -= 18;
    return score;
  }
  async function findElsewhere(item, excludeSource) {
    const query = `${item.title} ${String(item.artist || '').split('/')[0]}`.trim();
    const pool = [];
    const alts = SOURCES.map((x) => x.key).filter((k) => k !== excludeSource);
    for (const alt of alts) {
      try {
        const r = await searchOne(alt, query, 20);
        for (const x of r.items) {
          const score = matchScore(item, x);
          if (score >= 35) pool.push({ source: alt, item: x, score });
        }
        if (!pool.some((x) => x.source === alt)) log(`${LABEL[alt]} 没找到「${item.title}」的同款`);
      } catch (error) {
        log(`${LABEL[alt]} 补搜失败：${error?.message || error}`);
      }
    }
    if (!pool.length) return null;
    // 分数优先，同分按 SOURCES 里的先后（酷狗在网易云前面）
    pool.sort((a, b) => b.score - a.score || alts.indexOf(a.source) - alts.indexOf(b.source));
    const best = pool[0];
    log(`${LABEL[excludeSource]} 放不了，在 ${LABEL[best.source]} 找到同款（${best.score} 分）：${best.item.title} — ${best.item.artist}`);
    return { source: best.source, item: best.item };
  }

  async function download(url, ext, label) {
    const maxMB = int(cfg().maxMB, 14, 1, 200);
    const maxBytes = maxMB * 1048576;
    let lastError = null;
    for (let i = 1; i <= 3; i += 1) {
      try {
        const res = await fetchImpl(url, { headers: { Referer: 'https://www.kugou.com/', 'Accept-Encoding': 'identity' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const size = Number(res.headers.get('content-length') || 0);
        if (size && size > maxBytes) throw new Error(`文件 ${(size / 1048576).toFixed(1)}MB 超过上限 ${maxMB}MB（${label}）`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) throw new Error('下到空文件');
        if (buf.length > maxBytes) throw new Error(`文件 ${(buf.length / 1048576).toFixed(1)}MB 超过上限 ${maxMB}MB（${label}）`);
        return buf;
      } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 500 * i));
      }
    }
    throw lastError || new Error('下载失败');
  }

  const safeName = (item) => `${item.title}${item.artist ? ` - ${item.artist}` : ''}`.replace(/[\\/:*?"<>|\n\r]/g, ' ').slice(0, 60).trim();

  const levelsFor = (keys, wantFile) => {
    if (!Array.isArray(keys) || !keys.length) return [];
    if (wantFile) return keys;
    const lossless = (k) => /^(flac|lossless|sq)$/i.test(String(k.key)) || /无损/.test(String(k.label || ''));
    const noLossless = keys.filter((k) => !lossless(k));
    return noLossless.length ? noLossless : keys;
  };

  // ───────────── 文案 ─────────────
  const sourceMenu = (query) => `🎤 点歌：${query}\n用哪个音源？（回数字）\n${SOURCES.map((s, i) => `${i + 1}. ${s.label}`).join('\n')}\n\n回「0」取消`;

  const candidateTable = (source, query, items) => {
    const rows = items.map((x, i) => {
      const meta = [mmss(x.seconds), x.paid ? '会员' : ''].filter(Boolean).join('，');
      return `${i + 1}. ${x.title}${x.artist ? ` — ${x.artist}` : ''}${meta ? `（${meta}）` : ''}`;
    });
    const hint = source === 'qq' && !qqSession()?.musickey
      ? '\n（QQ音乐没登录：只能搜不能放，选完会自动去酷狗/网易云找同一首）'
      : '';
    return `${LABEL[source]} · 「${query}」搜到这些（回数字发歌，0 取消）：\n${rows.join('\n')}${hint}`;
  };

  // ───────────── 流程 ─────────────
  async function startSing(chat, key, query) {
    if (!query) { await adapter.sendText(chat, '想听什么歌？说「点歌 歌名」就行（歌手可加可不加），比如：点歌稻香'); return; }
    setStage(key, { stage: 'source', query });
    await adapter.sendText(chat, sourceMenu(query));
  }

  async function chooseSource(chat, key, source, query) {
    await adapter.sendText(chat, `正在 ${LABEL[source]} 搜「${query}」…（大概 3~6 秒）`);
    const topN = int(cfg().topN, 6, 1, 20);
    try {
      let r = { items: [], total: 0 };
      let used = source;
      let note = '';
      // 首选音源：抛错（未登录/限速）和「搜到但全被剔除」都算失败，统一走换源
      try {
        r = await searchOne(source, query, topN * 3);
      } catch (error) {
        log(`${LABEL[source]} 搜索失败，准备换源：${error?.message || error}`);
        note = `${LABEL[source]} 暂时用不了（${error?.message || error}），换成别的音源：\n`;
        r = { items: [], total: 0 };
      }
      if (!r.items.length) {
        for (const alt of SOURCES.map((x) => x.key).filter((k) => k !== source)) {
          try {
            const r2 = await searchOne(alt, query, topN);
            if (r2.items.length) {
              r = r2; used = alt;
              if (!note) note = `${LABEL[source]} 没有能用的「${query}」，换成 ${LABEL[alt]} 找到这些：\n`;
              break;
            }
          } catch (error) { log(`${LABEL[alt]} 兜底搜索失败：${error?.message || error}`); }
        }
      }
      if (!r.items.length) {
        clearStage(key);
        await adapter.sendText(chat, `三个音源都没搜到能用的「${query}」${r.total ? `（${r.total} 条结果里全是 DJ/改编/伴奏版或时长不合）` : ''}\n可能是歌名写法不同，带上歌手名再试一次`);
        return;
      }
      const items = r.items.slice(0, topN);
      setStage(key, { stage: 'song', query, source: used, items });
      await adapter.sendText(chat, `${note}${candidateTable(used, query, items)}`);
    } catch (error) {
      clearStage(key);
      await adapter.sendText(chat, `${LABEL[source]} 搜索失败：${error?.message || error}`);
    }
  }

  async function sendSong(chat, key, index, st) {
    const items = st.items || [];
    const item = items[index - 1];
    if (!item) { await adapter.sendText(chat, `只有 ${items.length} 首可选，回 1~${items.length}`); return; }
    const src = item.src || st.source;
    const mode = String(cfg().sendMode || 'voice');
    const wantVoice = mode !== 'file';
    const wantFile = mode !== 'voice';
    const eta = src === 'kugou' ? 8 : src === 'netease' ? 7 : 5;
    await adapter.sendText(chat, `⏳ 收到：${item.title}${item.artist ? ` — ${item.artist}` : ''}（${LABEL[src]}）\n正在取音频，预计 ${eta} 秒左右发出来`);

    const keys = src === 'kugou' ? KUGOU_LEVELS : src === 'netease' ? NETEASE_LEVELS : QQ_LEVELS;
    const levels = levelsFor(keys, wantFile);
    const chain = [item, ...items.filter((x) => x !== item && x.title === item.title).slice(0, 2)];
    const errors = [];
    const deadline = Date.now() + 30000;
    let audio = null;
    let buf = null;
    let switched = null;
    // QQ 音乐匿名已经拿不到直链了：别白试三档，直接去别家找同一首
    const skipSelf = src === 'qq' && !qqSession()?.musickey;
    if (skipSelf) errors.push('QQ音乐未登录，匿名拿不到直链');
    for (const cand of skipSelf ? [] : chain) {
      if (Date.now() > deadline) { errors.push('取链超时（30 秒）'); break; }
      for (let i = 0; i < levels.length; i += 1) {
        try {
          const a = await resolveAudio(cand.src || src, cand, levels.slice(i));
          const b = await download(a.url, a.ext, a.label);
          audio = a; buf = b;
          break;
        } catch (error) {
          errors.push(error?.message || String(error));
        }
      }
      if (buf) break;
    }
    // 这首在原音源放不出来（未登录/无版权/超体积）→ 去别家找同款，别让用户白点
    if (!buf && Date.now() < deadline) {
      const alt = await findElsewhere(item, src);
      if (alt) {
        const altKeys = alt.source === 'kugou' ? KUGOU_LEVELS : NETEASE_LEVELS;
        const altLevels = levelsFor(altKeys, wantFile);
        for (let i = 0; i < altLevels.length; i += 1) {
          try {
            const a = await resolveAudio(alt.source, alt.item, altLevels.slice(i));
            const b = await download(a.url, a.ext, a.label);
            audio = a; buf = b; switched = alt; break;
          } catch (error) { errors.push(error?.message || String(error)); }
        }
      }
    }
    if (!buf || !audio) {
      clearStage(key);
      const memberish = chain.some((c) => c.paid) || errors.some((e) => /会员|付费|无版权|需要登录|VIP/i.test(String(e)));
      const why = errors.length ? `（${errors.slice(-2).join('；')}）` : '';
      const tip = memberish
        ? `这首歌在${LABEL[src]}需要会员才能播。${hasSession(src) ? '当前登录的账号可能没有会员' : '现在没登录'}，登录一个有会员的账号（插件设置里的 ${LABEL[src]} cookie）后重试。`
        : `这首歌在${LABEL[src]}拿不到能播的音频`;
      await adapter.sendText(chat, `${tip}${why}`);
      return;
    }
    try {
      if (switched) {
        await adapter.sendText(chat, `${LABEL[src]}${src === 'qq' ? '未登录放不了' : '这首放不了'}，改用 ${LABEL[switched.source]} 的同一首（${switched.item.title} — ${switched.item.artist}）`);
      }
      const segs = [];
      if (wantVoice) segs.push({ type: 'record', data: { file: `base64://${buf.toString('base64')}` } });
      if (wantFile) segs.push({ type: 'file', data: { file: `base64://${buf.toString('base64')}`, name: `${safeName(item)}.${audio.ext || 'mp3'}` } });
      await adapter.send(chat, segs);
      clearStage(key);
      log(`点歌完成：${st.query} → ${index}. ${item.title}（${LABEL[switched?.source || src]} ${audio.label}）`);
    } catch (error) {
      clearStage(key);
      await adapter.sendText(chat, `发送失败：${error?.message || error}`);
    }
  }

  // ───────────── 指令入口 ─────────────
  async function handleMessage(msg) {
    const key = `${msg.kind}:${msg.chatId}`;
    const text = cleanText(msg.text);
    if (!text) return;
    if (msg.kind === 'group' && !msg.atMe && !cfg().allowGroupWithoutAt && !readStage(key)) {
      const cmd = parseSingCommand(text);
      if (!cmd.hit) return;
    }
    const cmd = parseSingCommand(text);
    if (cmd.hit) {
      if (msg.kind === 'group' && !msg.atMe && !cfg().allowGroupWithoutAt) return;
      clearStage(key);
      await startSing(msg.chat, key, cmd.query);
      return;
    }
    const st = readStage(key);
    if (!st) return;
    if (OTHER_COMMAND_RE.test(text)) { clearStage(key); return; }
    const choice = parseChoice(text);
    if (choice === 0 && /^(?:取消|算了|不点了|0)$/.test(text)) { clearStage(key); return; }
    if (st.stage === 'source') {
      const byName = sourceByAlias(text);
      const idx = byName ? SOURCES.findIndex((s) => s.key === byName) + 1 : choice;
      const src = SOURCES[idx - 1];
      if (!src) { await adapter.sendText(msg.chat, `回 1~${SOURCES.length} 选音源，或回 0 取消`); return; }
      await chooseSource(msg.chat, key, src.key, st.query);
      return;
    }
    if (st.stage === 'song') {
      if (choice < 1 || choice > (st.items?.length || 0)) { await adapter.sendText(msg.chat, `回 1~${st.items?.length || 0} 选歌，或回 0 取消`); return; }
      await sendSong(msg.chat, key, choice, st);
    }
  }

  const disposeWs = adapter.onEvent((msg) => { handleMessage(msg).catch((error) => log(`处理消息出错：${error?.message || error}`)); });
  ctx.effect?.(() => () => { disposeWs?.(); stages.clear(); }, 'dsh-qq-sing-ws');

  // ───────────── 工具 ─────────────
  const chatArg = {
    kind: { type: 'string', enum: ['private', 'group'], description: 'chat 类型', required: true },
    id: { type: 'integer', description: 'QQ 号（private）或群号（group）', required: true },
  };

  registerTool(ctx, {
    name: 'qq_sing_search',
    description: '在 QQ音乐 / 酷狗 / 网易云 搜索歌曲，返回候选列表（含时长、是否会员曲）。只搜不发。',
    parameters: {
      query: { type: 'string', description: '歌名，可带歌手', required: true },
      source: { type: 'string', enum: ['qq', 'kugou', 'netease'], description: '音源，默认 qq' },
      limit: { type: 'integer', description: '返回条数，默认 6' },
    },
    output: { schema: { type: 'object', additionalProperties: true } },
    async execute(args) {
      const source = SOURCES.some((s) => s.key === args.source) ? args.source : 'qq';
      const r = await searchOne(source, args.query, args.limit || cfg().topN);
      return { source, query: args.query, total: r.total, items: r.items.map((x) => ({ title: x.title, artist: x.artist, seconds: x.seconds, paid: x.paid })) };
    },
  });

  registerTool(ctx, {
    name: 'qq_sing_send',
    description: '按搜索结果发歌到 QQ（语音条/文件按插件设置）。source + index 来自 qq_sing_search 的结果序号（从 1 开始）。',
    parameters: {
      chat: { type: 'object', description: '发送目标', required: true, additionalProperties: false, properties: chatArg },
      query: { type: 'string', description: '原始搜索词', required: true },
      source: { type: 'string', enum: ['qq', 'kugou', 'netease'], description: '音源', required: true },
      index: { type: 'integer', description: '候选序号（从 1 开始）', required: true },
    },
    output: { schema: { type: 'object', additionalProperties: true } },
    async execute(args) {
      const chat = { kind: args.chat?.kind === 'group' ? 'group' : 'private', id: Number(args.chat?.id) };
      const topN = int(cfg().topN, 6, 1, 20);
      const r = await searchOne(args.source, args.query, topN * 3);
      const items = r.items.slice(0, topN);
      const key = `${chat.kind}:${chat.id}`;
      await sendSong(chat, key, args.index, { query: args.query, source: args.source, items });
      return { ok: true, sent: items[args.index - 1]?.title ?? null };
    },
  });

  registerTool(ctx, {
    name: 'qq_sing_status',
    description: '查看点歌插件状态：OneBot 连接、三个音源的登录态（有 cookie 且有效才算登录）、发送方式。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true } },
    async execute() {
      let self = null;
      try { self = await adapter.getSelfInfo(); } catch (error) { self = { error: String(error?.message || error) }; }
      return {
        onebotHttpUrl: cfg().onebotHttpUrl,
        wsConfigured: Boolean(cfg().onebotWsUrl),
        wsConnected: adapter.connected,
        self,
        sources: SOURCES.map((s) => ({ key: s.key, label: s.label, loggedIn: hasSession(s.key) })),
        sendMode: cfg().sendMode,
        banWords: splitBanWords(banText()),
      };
    },
  });

  // 调试/测试用挂载点（生产无害，自测脚本靠它直接喂消息）
  ctx.__qqSing = { handleMessage, searchOne, adapter, cfg };

  log(`点歌插件就绪（音源：${SOURCES.map((s) => s.label).join(' / ')}；WebSocket ${cfg().onebotWsUrl ? '已配置' : '未配置'}）`);
}

export const _internal = { parseSingCommand, parseChoice, cleanText, SOURCES, splitBanWords, buildBanRegex, DEFAULT_BAN_WORDS };
