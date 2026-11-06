// 网易云音乐音源（免登录即可拿「官方原版」320k；有 MUSIC_U 时能拿会员/无损）
//
// 为什么加它：QQ音乐要 musickey 才有高音质，其它来源往往只有二传音轨。
// 网易云的搜索 + 播放直链接口是裸的：搜索不用登录，直链对免费曲目直接给 320k mp3。
//   - 搜索：https://music.163.com/api/search/get?s=<kw>&type=1&limit=N
//   - 直链：https://music.163.com/api/song/enhance/player/url/v1?ids=[id]&level=exhigh
//     level 档位：standard(128) / higher(192) / exhigh(320) / lossless(flac) / hires
//     返回 data[0].url 为空 = 会员曲/无版权，需要 cookie 里的 MUSIC_U（登录后才有）
//
// 想解锁会员曲：把浏览器登录 music.163.com 后的 cookie 粘到插件设置（neteaseCookie），
// 形如 MUSIC_U=xxxx; __csrf=yyyy。不填就只走免费曲。

import dns from 'node:dns';

try { dns.setDefaultResultOrder('ipv4first'); } catch { /* 老 node 没有这个 API */ }

export const NETEASE_LEVELS = [
  { key: 'lossless', label: '无损', ext: 'flac' },
  { key: 'exhigh', label: '320k', ext: 'mp3' },
  { key: 'higher', label: '192k', ext: 'mp3' },
  { key: 'standard', label: '128k', ext: 'mp3' }
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Referer: 'https://music.163.com/',
  'Accept-Encoding': 'gzip',
  'Accept-Language': 'zh-CN,zh;q=0.9'
};

export function normalizeNetease(song = {}) {
  const artists = song.artists || song.ar || [];
  const album = song.album || song.al || {};
  const ms = Number(song.duration || song.dt || 0);
  return {
    id: String(song.id || ''),
    name: String(song.name || ''),
    singer: artists.map((a) => a?.name).filter(Boolean).join('/'),
    album: String(album?.name || ''),
    seconds: Math.round(ms / 1000),
    fee: Number(song.fee ?? 0), // 0/8=免费，1=VIP，4=付费专辑
    alias: (song.alias || song.alia || []).join('/')
  };
}

/** 官方原版优先：同名、歌手对得上、时长像一首歌；live/翻唱/伴奏往后排。 */
export function scoreNetease(song, query = '') {
  let score = 0;
  const q = String(query || '').replace(/\s+/g, '').toLowerCase();
  const name = song.name.replace(/\s+/g, '').toLowerCase();
  const singer = song.singer.replace(/\s+/g, '').toLowerCase();
  if (q && name && q.includes(name)) score += 60;
  if (q && name && name.includes(q)) score += 50;
  if (singer && q.includes(singer.split('/')[0])) score += 40;
  if (song.album) score += 20;
  if (song.fee === 0 || song.fee === 8) score += 10;
  if (song.seconds >= 150 && song.seconds <= 360) score += 20;
  if (/伴奏|remix|dj|翻唱|片段|纯音乐|karaoke|instrumental|钢琴版|吉他版/i.test(song.name)) score -= 70;
  if (/live|现场|演唱会/i.test(song.name + song.album)) score -= 10;
  return score;
}

export function createNetease({ fetchImpl = fetch, log = () => {}, cookie = '' } = {}) {
  let lastAt = 0;
  const MIN_INTERVAL = 700;
  const pace = async () => {
    const wait = lastAt + MIN_INTERVAL - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
  };

  async function call(url, { attempts = 3, timeoutMs = 15000 } = {}) {
    let lastError;
    for (let i = 1; i <= attempts; i += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        await pace();
        const headers = { ...HEADERS };
        if (cookie) headers.Cookie = cookie;
        const res = await fetchImpl(url, { headers, signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json?.code && json.code !== 200) throw new Error(`网易云接口 code=${json.code}`);
        return json;
      } catch (error) {
        lastError = error;
        if (i < attempts) await new Promise((r) => setTimeout(r, 600 * i));
      } finally { clearTimeout(timer); }
    }
    throw new Error(`网易云请求失败：${lastError?.message || lastError}`);
  }

  async function search(query, limit = 5) {
    const json = await call(`https://music.163.com/api/search/get?s=${encodeURIComponent(query)}&type=1&limit=${Math.min(30, Math.max(10, limit * 3))}&offset=0`);
    const list = json?.result?.songs || [];
    return list
      .map(normalizeNetease)
      .filter((s) => s.id && s.name)
      .map((s) => ({ ...s, score: scoreNetease(s, query) }));
    // 保持平台原始顺序（m03140）
  }

  /** 逐档降级拿直链；url 为空 = 会员曲/无版权。 */
  async function getUrl(id, levels = NETEASE_LEVELS) {
    for (const level of levels) {
      const json = await call(`https://music.163.com/api/song/enhance/player/url/v1?ids=[${id}]&level=${level.key}&encodeType=${level.ext}`);
      const item = json?.data?.[0];
      if (item?.url) {
        const ext = String(item.type || level.ext);
        const br = Number(item.br || 0);
        // 免费曲即便要 lossless 也只给 320k mp3，所以标签按真实码率写，别糊人
        const realLabel = ext === 'flac' ? '无损' : br >= 300000 ? '320k' : br >= 180000 ? '192k' : '128k';
        log(`网易云直链：${realLabel}（请求档位 ${level.key}，实际 ${ext}/${Math.round(br / 1000)}kbps）`);
        return { url: item.url, level: level.key, ext, label: realLabel, br, size: item.size };
      }
    }
    throw new Error('网易云没有可用直链（会员曲需要登录 cookie）');
  }

  return { search, getUrl };
}
