// 酷狗音乐音源（免登录；插件设置里的 kugouCookie 只影响会员曲，可留空）
//
// 接口链路（2026-10 实测可用）：
//   搜索  http://ioscdn.kugou.com/api/v3/search/song?format=json&keyword=<kw>&page=1&pagesize=N&showtype=1&plat=0&tag=1&sver=2
//         字段：songname / singername / album_name / duration(秒) / hash(128k) / 320hash / sqhash / album_id / privilege
//   直链  http://trackercdn.kugou.com/i/v2/?key=md5(hash+'kgcloudv2')&hash=<hash>&appid=1005&pid=2&cmd=25&behavior=play&br=128|320|sq
//         必须用 **http**（https 会被拒），br 传数字或 'sq'；status=1 才算成功，返回 url[] / extName / fileSize / bitRate
//
// 踩过的坑：wwwapi.kugou.com/yy/index.php?r=play/getdata 与 play/songinfo（无论签名对不对）都恒返回 err_code 30020，
// 跟会员/版权无关（连儿歌都 30020），别再用；mobilecdn.kugou.com 的 https 证书是 *.cdn.myqcloud.com，TLS 直接失败。

import dns from 'node:dns';
import crypto from 'node:crypto';

try { dns.setDefaultResultOrder('ipv4first'); } catch { /* 老 node 没有这个 API */ }

export const KUGOU_LEVELS = [
  { key: 'flac', br: 'sq', ext: 'flac', label: '无损' },
  { key: '320', br: '320', ext: 'mp3', label: '320k' },
  { key: '128', br: '128', ext: 'mp3', label: '128k' }
];

const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Referer: 'http://www.kugou.com/',
  'Accept-Language': 'zh-CN,zh;q=0.9'
};

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const clean = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

export function normalizeKugou(song = {}) {
  return {
    hash: String(song.hash || ''),
    hash320: String(song['320hash'] || song.highhash || ''),
    hashSq: String(song.sqhash || ''),
    albumId: String(song.album_id || ''),
    eaaid: String(song.album_audio_id || ''),
    name: clean(song.songname),
    singer: clean(song.singername),
    album: clean(song.album_name),
    seconds: Math.floor(Number(song.duration) || 0),
    privilege: Number(song.privilege ?? 0),
    fee: Number(song.pay_type ?? song.feetype ?? 0)
  };
}

/** 官方原版优先：同名、歌手对得上、时长像一首歌；Live/DJ/片段/改编/翻唱重罚（酷狗这类货特别多）。 */
export function scoreKugou(song, query = '') {
  let score = 0;
  const q = String(query || '').replace(/\s+/g, '').toLowerCase();
  const name = song.name.replace(/\s+/g, '').toLowerCase();
  const singer = song.singer.replace(/\s+/g, '').toLowerCase();
  if (q && name && q.includes(name)) score += 60;
  if (q && name && name.includes(q)) score += 50;
  if (singer && q.includes(singer.split('/')[0])) score += 40;
  if (song.album) score += 15;
  if (song.hashSq) score += 15;
  else if (song.hash320) score += 8;
  if (song.seconds >= 150 && song.seconds <= 360) score += 20;
  else if (song.seconds < 60) score -= 60;
  if (/[（(]/.test(song.name)) score -= 25; // 带括号后缀的多半是 Live/DJ/改编/片段
  if (/live|现场|演唱会|dj|remix|片段|改编|翻唱|伴奏|纯音乐|karaoke|instrumental|钢琴版|吉他版|加速|变速|降调|升调|0\.8x|1\.2x|铃声/i.test(song.name)) score -= 70;
  if (/合集|串烧|一小时|1小时|循环/i.test(song.name)) score -= 90;
  // 酷狗常把 DJ 版挂在正主名下（歌名干净、专辑写「DJ车载慢摇」），专辑名也要查一遍
  if (/车载|慢摇|dj|remix|改编|串烧|铃声|翻唱|纯音乐|伴奏/i.test(song.album)) score -= 80;
  return score;
}

export function createKugou({ fetchImpl = fetch, log = () => {} } = {}) {
  let lastAt = 0;
  const MIN_INTERVAL = 400;
  const pace = async () => {
    const wait = lastAt + MIN_INTERVAL - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
  };

  async function get(url, { attempts = 3, timeoutMs = 15000, json = true } = {}) {
    let lastError;
    for (let i = 1; i <= attempts; i += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        await pace();
        const res = await fetchImpl(url, { headers: HEADERS, signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return json ? await res.json() : res;
      } catch (error) {
        lastError = error;
        if (i < attempts) await new Promise((r) => setTimeout(r, 500 * i));
      } finally { clearTimeout(timer); }
    }
    throw new Error(`酷狗请求失败：${lastError?.message || lastError}`);
  }

  async function search(query, limit = 5) {
    const url = `http://ioscdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(query)}&page=1&pagesize=${Math.max(10, limit * 3)}&showtype=1&plat=0&tag=1&sver=2`;
    const json = await get(url);
    const list = json?.data?.info || [];
    return list
      .map(normalizeKugou)
      .filter((s) => s.name && s.hash)
      .map((s) => ({ ...s, score: scoreKugou(s, query) }));
    // 保持平台原始顺序（m03140）
  }

  /** 逐档降级拿直链；status!==1 或 url 为空 = 这档没资源。 */
  async function getUrl(song, levels = KUGOU_LEVELS) {
    for (const level of levels) {
      const hash = level.key === 'flac' ? song.hashSq : level.key === '320' ? song.hash320 : song.hash;
      if (!hash) { log(`酷狗没有 ${level.label} 的 hash，降级下一档`); continue; }
      const url = `http://trackercdn.kugou.com/i/v2/?key=${md5(`${hash}kgcloudv2`)}&hash=${hash}&appid=1005&pid=2&cmd=25&behavior=play&br=${level.br}`;
      let json;
      try { json = await get(url); } catch (error) { log(`酷狗 ${level.label} 请求失败：${error?.message || error}`); continue; }
      const purl = Array.isArray(json?.url) ? json.url[0] : json?.url;
      if (Number(json?.status) !== 1 || !purl) {
        log(`酷狗 ${level.label} 无直链（status=${json?.status} ${json?.error || ''}）`);
        continue;
      }
      const ext = String(json.extName || level.ext);
      const br = Number(json.bitRate) || 0;
      const label = ext === 'flac' ? '无损' : br >= 300000 ? '320k' : '128k';
      log(`酷狗直链：${label}（请求 ${level.key}，${Math.round(br / 1000)}kbps）`);
      return { url: purl, level: level.key, ext, label, br, size: Number(json.fileSize) || 0, seconds: Number(json.timeLength) || 0 };
    }
    throw new Error('酷狗没有可用直链');
  }

  return { search, getUrl };
}
