// QQ音乐音源。登录态从插件设置（qqMusicCookie）读，不落任何文件、不写死任何凭据。
//
// 为什么值得：别的来源往往只有二传的视频音轨，官方原版只在音乐平台。
//   - 搜索：登录后走 musicu.fcg / music.search.SearchCgiService；
//           未登录走老的 c.y.qq.com/soso/fcgi-bin/search_for_qq_cp（匿名可用，字段全），
//           再不行退到 splcloud/fcgi-bin/smartbox_new.fcg（联想接口，最多 4 条）
//   - 直链：musicu.fcg / vkey.GetVkeyServer，filename 前缀决定清晰度
//       F000 → 无损 flac，M800 → 320k mp3，M500 → 128k mp3
//     purl 为空说明没版权/会员不足，逐档降级重试。
// 音质上限仍然受 QQ 语音条的 silk 转码限制，无损只在「发文件」时才有意义。

import dns from 'node:dns';

// 本机 IPv6 出口不通，undici 有时会挑到 AAAA 记录直接 ENETUNREACH/fetch failed
import { parseCookie } from './onebot.js';

try { dns.setDefaultResultOrder('ipv4first'); } catch { /* 老 node 没有这个 API */ }

export const LEVELS = [
  { key: 'flac', prefix: 'F000', ext: 'flac', label: '无损' },
  { key: '320', prefix: 'M800', ext: 'mp3', label: '320k' },
  { key: '128', prefix: 'M500', ext: 'mp3', label: '128k' }
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Referer: 'https://y.qq.com/',
  'Content-Type': 'application/json',
  'Accept-Encoding': 'gzip',
  'Accept-Language': 'zh-CN,zh;q=0.9'
};
const API = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
// 匿名可用的两个老接口（2026-10 实测）：musicu 的搜索对未登录一律回 2001，
// 但这两个还开着，且 search_for_qq_cp 一次能给 20+ 条完整字段（songmid/songname/singer/interval/sizeflac…）。
const LEGACY_SEARCH = 'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp';
const SMARTBOX = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg';
const GET_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://y.qq.com/',
  'Accept-Encoding': 'gzip',
  'Accept-Language': 'zh-CN,zh;q=0.9'
};

/** QQ音乐真正的登录态是 musickey（= cookie qqmusic_key / qm_keyst）；光有 .qq.com 的那堆 cookie 只能拿到 128k。 */
export function sessionCookies(session) {
  if (!session) return '';
  const parts = [];
  if (session.cookieHeader) parts.push(session.cookieHeader);
  if (session.musickey) parts.push(`qqmusic_key=${session.musickey}`, `qm_keyst=${session.musickey}`);
  if (session.uin) parts.push(`uin=o0${session.uin}`, `qqmusic_uin=${session.uin}`);
  return parts.join('; ');
}

export function authComm(session, extra = {}) {
  const uin = String(session?.uin || '0');
  const comm = { ct: 24, cv: 0, format: 'json', uin, ...extra };
  if (session?.musickey) comm.authst = session.musickey;
  return comm;
}

/**
 * 从浏览器复制的 cookie 串里还原登录态。
 * 关键只有两个：`qm_keyst`（或 `qqmusic_key`，就是 musickey）和 `uin`。
 * 没有 musickey 也能用，只是拿不到 320k/无损（匿名只给 128k）。
 */
export function sessionFromCookie(cookieText) {
  const jar = parseCookie(cookieText);
  const musickey = jar.qqmusic_key || jar.qm_keyst || '';
  const uin = String(jar.qqmusic_uin || jar.uin || '').replace(/^o0/, '');
  if (!musickey && !uin) return null;
  return {
    uin,
    musickey,
    cookieHeader: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
    loggedIn: Boolean(musickey),
  };
}

/** "3:44" / "0:03:44" → 秒，QQ 音乐这里给的是数字秒 */
export const songSeconds = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : 0;
};

export function normalizeSong(song = {}) {
  return {
    mid: String(song.mid || song.songmid || ''),
    name: String(song.name || song.title || ''),
    singer: (song.singer || []).map((s) => s.name).filter(Boolean).join('/'),
    album: String(song.album?.name || ''),
    seconds: songSeconds(song.interval),
    pay: song.pay || {},
    sizes: {
      flac: Number(song.file?.size_flac) || 0,
      '320': Number(song.file?.size_320mp3) || 0,
      '128': Number(song.file?.size_128mp3) || 0
    }
  };
}

/** 老搜索接口（search_for_qq_cp）的字段名跟 musicu 不一样，先摊平再走统一归一化。 */
export function normalizeLegacySong(song = {}) {
  return normalizeSong({
    mid: song.songmid || song.mid,
    name: song.songname || song.name,
    singer: song.singer,
    album: { name: song.albumname },
    interval: song.interval,
    pay: song.pay,
    file: { size_flac: song.sizeflac, size_320mp3: song.size320, size_128mp3: song.size128 }
  });
}

/** 官方原版优先：同名 + 歌手对得上 + 有专辑 + 时长像一首歌；试听版/remix/伴奏往后排。 */
export function scoreSong(song, query = '') {
  let score = 0;
  const q = String(query || '').replace(/\s+/g, '').toLowerCase();
  const name = song.name.replace(/\s+/g, '').toLowerCase();
  const singer = song.singer.replace(/\s+/g, '').toLowerCase();
  if (q && name && q.includes(name)) score += 60;
  if (q && name && name.includes(q)) score += 50;
  if (singer && q.includes(singer.split('/')[0])) score += 40;
  if (song.album) score += 20;
  if (song.sizes.flac) score += 15;
  if (song.seconds >= 150 && song.seconds <= 360) score += 20;
  else if (song.seconds > 360 && song.seconds <= 480) score += 5;
  if (/伴奏|remix|dj|翻唱|片段|纯音乐|karaoke|instrumental|inst\.|钢琴版|吉他版/i.test(song.name)) score -= 70;
  if (/live|现场|演唱会/i.test(song.name + song.album)) score -= 10;
  return score;
}

export function createQqMusic({ fetchImpl = fetch, log = () => {} } = {}) {
  // QQ音乐对密集请求也会回 code 2001（和真·未登录一样的码），所以要限速 + 退避重试
  let lastAt = 0;
  const MIN_INTERVAL = 1500;
  const pace = async () => {
    const wait = lastAt + MIN_INTERVAL - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
  };

  async function api(body, session, { attempts = 4, timeoutMs = 15000 } = {}) {
    // 匿名（没有 musickey）时没必要重试 4 次：被回 2001 就说明要登录/被限流，重试只是白等
    const tries = session?.musickey ? attempts : Math.min(2, attempts);
    let lastError;
    for (let i = 1; i <= tries; i += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        await pace();
        const headers = { ...HEADERS };
        const cookie = sessionCookies(session);
        if (cookie) headers.Cookie = cookie;
        const res = await fetchImpl(API, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        // 搜索走的是 req 字段（req_1/req_0 是 vkey 用的），三个都要看，否则 2001 会被静默吞掉
        const mod = json?.req_1 ?? json?.req_0 ?? json?.req;
        if (mod?.code === 2001) throw new Error('QQ音乐未登录（2001，需要登录态或请求太密）');
        if (mod && mod.code !== 0) throw new Error(`QQ音乐接口 code=${mod.code}`);
        return json;
      } catch (error) {
        lastError = error;
        if (i < tries) await new Promise((r) => setTimeout(r, 1200 * i));
      } finally { clearTimeout(timer); }
    }
    throw new Error(`QQ音乐请求失败：${lastError?.message || lastError}`);
  }

  /** 匿名走老接口：search_for_qq_cp 字段全、条数多；挂了再退 smartbox（只有 4 条）。 */
  async function searchAnonymous(query, limit = 5) {
    const n = Math.max(10, Math.min(30, limit * 3));
    const url = `${LEGACY_SEARCH}?w=${encodeURIComponent(query)}&p=1&n=${n}&format=json&cr=1&new_json=1`
      + '&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&platform=yqq.json&needNewCode=0';
    try {
      const res = await fetchImpl(url, { headers: GET_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const list = json?.data?.song?.list || [];
      if (list.length) {
        log(`QQ音乐匿名搜索（老接口）拿到 ${list.length} 条`);
        return list.map(normalizeLegacySong).filter((s) => s.mid);
      }
      throw new Error(`老接口返回 0 条（code=${json?.code}）`);
    } catch (error) {
      log(`QQ音乐老搜索接口失败：${error.message}，退联想接口`);
    }
    const box = `${SMARTBOX}?key=${encodeURIComponent(query)}&format=json&g_tk=5381&loginUin=0&hostUin=0`
      + '&inCharset=utf8&outCharset=utf-8&platform=yqq.json&needNewCode=0';
    const res = await fetchImpl(box, { headers: GET_HEADERS });
    if (!res.ok) throw new Error(`QQ音乐联想接口 HTTP ${res.status}`);
    const json = await res.json();
    const items = json?.data?.song?.itemlist || [];
    if (!items.length) throw new Error('QQ音乐没搜到结果（匿名接口都没给数据）');
    log(`QQ音乐匿名搜索（联想接口）拿到 ${items.length} 条`);
    return items.map((it) => normalizeSong({ mid: it.mid, name: it.name, singer: [{ name: it.singer }] }))
      .filter((s) => s.mid);
  }

  async function search(query, limit = 5, session = null) {
    let list = [];
    if (session?.musickey) {
      // 有登录态就走官方 musicu（结果最全、能带付费标记）
      try {
        const body = {
          comm: authComm(session, { ct: '19', cv: '1859' }),
          req: { module: 'music.search.SearchCgiService', method: 'DoSearchForQQMusicDesktop', param: { grp: 1, num_per_page: String(Math.max(10, limit * 3)), page_num: '1', query, search_type: 0 } }
        };
        const json = await api(body, session);
        const raw = json?.req?.data?.body?.song?.list || json?.req_1?.data?.body?.song?.list || [];
        list = raw.map(normalizeSong).filter((s) => s.mid);
      } catch (error) {
        log(`QQ音乐登录态搜索失败（${error.message}），改用匿名接口`);
      }
    }
    // searchAnonymous 返回的已经是归一化对象，只有 musicu 分支需要再归一化（上面已做）
    if (!list.length) list = await searchAnonymous(query, limit);
    // 保持平台原始顺序（m03140）：score 只做参考，不参与排序
    return list.filter((s) => s?.mid).map((s) => ({ ...s, score: scoreSong(s, query) }));
  }

  /** 逐个清晰度试，拿到 purl 就返回；purl 为空 = 没版权/会员不足。 */
  async function getUrl(mid, session, levels = LEVELS) {
    // 2026-10 起匿名连 128k 都不给了（purl 全空），没 musickey 就别浪费三次请求
    if (!session?.musickey) {
      throw new Error('QQ音乐未登录：匿名已经拿不到直链了（搜索还能用，播放必须要 qqMusicCookie）');
    }
    for (const level of levels) {
      const uin = session?.uin || '0';
      const json = await api({
        req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param: { guid: '10000', songmid: [mid], songtype: [0], uin, loginflag: 1, platform: '20', filename: [`${level.prefix}${mid}${mid}.${level.ext}`] } },
        comm: authComm(session)
      }, session);
      const data = json?.req_0?.data;
      const info = data?.midurlinfo?.[0];
      if (info?.purl) {
        const sip = data.sip?.[0] || 'https://isure.stream.qqmusic.qq.com/';
        const url = /^https?:/.test(info.purl) ? info.purl : sip + info.purl;
        log(`QQ音乐直链：${level.label}（${level.key}）`);
        return { url, level: level.key, ext: level.ext, label: level.label };
      }
      log(`QQ音乐 ${level.label} 无直链，降级下一档`);
    }
    throw new Error('QQ音乐所有清晰度都拿不到直链（可能没版权或会员不足）');
  }

  return { search, getUrl };
}
