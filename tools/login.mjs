#!/usr/bin/env node
// 扫码登录助手 —— 拿一次 cookie，粘到插件设置里就行。
//
//   node tools/login.mjs --platform qq        # QQ 音乐（QQ 扫码）
//   node tools/login.mjs --platform qq --wechat   # QQ 音乐（微信扫码）
//   node tools/login.mjs --platform kugou     # 酷狗音乐
//   node tools/login.mjs --platform netease   # 网易云音乐（需要 qrcode 包，见下）
//
// 为什么要它：DSH 插件面板只能填设置项，没有"点一下登录"的按钮。
// 这个脚本在终端里把二维码存成 PNG（再给个 http 地址方便手机扫），扫完直接把 cookie 串打出来，
// 你复制粘贴到插件设置对应字段即可：qqMusicCookie / kugouCookie / neteaseCookie。
//
// 只依赖 Node 内置模块；网易云的二维码要自己画，需要 `npm i qrcode`（不给也能跑，会退回手抄 MUSIC_U）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

try { (await import('node:dns')).setDefaultResultOrder('ipv4first'); } catch { /* ignore */ }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

// ── 参数 ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, def = '') => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : def;
};
const flag = (name) => argv.includes(`--${name}`);

const platform = arg('platform', 'qq');
const outDir = path.resolve(arg('out', 'qr'));
const serveQr = flag('serve');       // 起个本地 http，手机直接扫
const timeoutSec = Number(arg('timeout', '180'));
if (!['qq', 'kugou', 'netease'].includes(platform)) {
  console.error('用法：node tools/login.mjs --platform qq|kugou|netease [--wechat] [--serve] [--out qr]');
  process.exit(2);
}

// ── 小工具 ─────────────────────────────────────────────────────────────
function makeJar() {
  const map = new Map();
  return {
    set: (k, v) => map.set(k, v),
    get: (k) => map.get(k),
    header: () => [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}
function absorbCookies(res, jar) {
  for (const raw of res.headers?.getSetCookie?.() || []) {
    const pair = String(raw).split(';')[0].trim();
    const i = pair.indexOf('=');
    if (i < 1) continue;
    const k = pair.slice(0, i);
    const v = pair.slice(i + 1);
    if (v) jar.set(k, v);
  }
}
const isPng = (b) => Buffer.isBuffer(b) && b.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
const isImage = (b) => Buffer.isBuffer(b) && b.length > 12 && /^(89504e47|ffd8ff)/.test(b.slice(0, 4).toString('hex'));
function hash33(t) {
  let e = 0;
  for (let i = 0; i < t.length; i += 1) e += (e << 5) + t.charCodeAt(i);
  return 2147483647 & e;
}
function gtkOf(pSkey) {
  let h = 5381;
  for (let i = 0; i < pSkey.length; i += 1) h += (h << 5) + pSkey.charCodeAt(i);
  return h & 0x7fffffff;
}
const guid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
}).toUpperCase();

let server = null;
async function showQr(buf, name) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, buf);
  console.log(`\n二维码已保存：${file}`);
  if (serveQr) {
    if (!server) {
      server = http.createServer((req, res) => {
        const f = path.join(outDir, path.basename(decodeURIComponent(req.url.split('?')[0])) || '');
        if (!fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'image/png' });
        fs.createReadStream(f).pipe(res);
      });
      await new Promise((r) => server.listen(0, '0.0.0.0', r));
    }
    const { port } = server.address();
    console.log(`手机可打开：http://<本机局域网IP>:${port}/${name}.png`);
  }
  console.log('用对应 App 扫码 → 手机确认，脚本会自动继续。\n');
}

async function makeQr(text, width = 420) {
  let lib;
  try { lib = (await import('qrcode')).default; } catch { throw new Error('没装 qrcode 包'); }
  return lib.toBuffer(String(text), { type: 'png', width, margin: 1, errorCorrectionLevel: 'M' });
}

const done = (lines) => {
  console.log('\n✅ 登录成功，把下面整行粘到插件设置里：\n');
  for (const l of lines) console.log(`   ${l}\n`);
  server?.close();
  process.exit(0);
};

// ── QQ 音乐 ────────────────────────────────────────────────────────────
const QQ_LOGIN_JUMP = 'https://graph.qq.com/oauth2.0/login_jump';
const QQ_REDIRECT = 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/';
const WX_APPID = 'wx48db31d50e334801';

async function loginQq(useWechat) {
  const jar = makeJar();
  const get = (url, opt = {}) => fetch(url, { ...opt, signal: AbortSignal.timeout(20000) });

  let state;
  if (!useWechat) {
    const url = `https://ssl.ptlogin2.qq.com/ptqrshow?appid=716027609&e=2&l=M&s=3&d=72&v=4&t=${Math.random()}`
      + `&daid=383&pt_3rd_aid=100497308&u1=${encodeURIComponent(QQ_LOGIN_JUMP)}`;
    const res = await get(url, { headers: { 'User-Agent': UA } });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!isPng(buf)) throw new Error('QQ 二维码不是 PNG（可能被风控，稍后再试）');
    const qrsig = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0])
      .find((c) => c.startsWith('qrsig='))?.split('=')[1] || '';
    if (!qrsig) throw new Error('QQ 没给 qrsig');
    state = { kind: 'qq', qrsig, token: hash33(qrsig) };
    await showQr(buf, 'qqmusic-qq');
  } else {
    const url = `https://open.weixin.qq.com/connect/qrconnect?appid=${WX_APPID}`
      + `&redirect_uri=${encodeURIComponent(QQ_REDIRECT)}&response_type=code&scope=snsapi_login&state=STATE#wechat_redirect`;
    const html = await (await get(url, { headers: { 'User-Agent': UA } })).text();
    const uuid = (html.match(/connect\/qrcode\/([A-Za-z0-9_-]{10,})/) || [])[1];
    if (!uuid) throw new Error('微信二维码没解析出来');
    const buf = Buffer.from(await (await get(`https://open.weixin.qq.com/connect/qrcode/${uuid}`, { headers: { 'User-Agent': UA } })).arrayBuffer());
    if (!isImage(buf)) throw new Error('微信二维码不是图片');
    state = { kind: 'wechat', uuid };
    await showQr(buf, 'qqmusic-wechat');
  }

  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    await sleep(2500);
    let code = '';
    if (state.kind === 'qq') {
      const url = `https://ssl.ptlogin2.qq.com/ptqrlogin?u1=${encodeURIComponent(QQ_LOGIN_JUMP)}&ptqrtoken=${state.token}`
        + `&ptredirect=0&h=1&t=1&g=1&from_ui=1&ptlang=2052&action=0-0-${Date.now()}&js_ver=23111510&js_type=1`
        + `&login_sig=&pt_uistyle=40&aid=716027609&daid=383&pt_3rd_aid=100497308&pt_js_version=v1.48.1`;
      const res = await get(url, { headers: { 'User-Agent': UA, Cookie: `qrsig=${state.qrsig}`, Referer: 'https://xui.ptlogin2.qq.com/' } });
      const text = await res.text();
      const m = text.match(/ptuiCB\('(\d+)','(\d+)','([^']*)','(\d+)','([^']*)'/);
      const c = m?.[1] || '?';
      if (c === '53') { process.stdout.write('已扫码，等你确认…\r'); continue; }
      if (c !== '0') { process.stdout.write(`等待扫码（${c}）…\r`); continue; }
      const cs = await get(m[3], { headers: { 'User-Agent': UA, Cookie: jar.header() }, redirect: 'manual' });
      absorbCookies(cs, jar);
      const pSkey = jar.get('p_skey') || '';
      if (!pSkey) throw new Error('没拿到 p_skey');
      const form = new FormData();
      for (const [k, v] of Object.entries({
        response_type: 'code', client_id: '100497308', redirect_uri: QQ_REDIRECT,
        scope: 'get_user_info,get_app_friends', state: 'state', switch: '', from_ptlogin: '1',
        src: '1', update_auth: '1', openapi: '1010_1030', g_tk: String(gtkOf(pSkey)),
        auth_time: new Date().toString(), ui: guid(),
      })) form.append(k, v);
      const authRes = await get('https://graph.qq.com/oauth2.0/authorize', {
        method: 'POST', body: form, redirect: 'manual',
        headers: { 'User-Agent': UA, Cookie: jar.header(), Referer: 'https://graph.qq.com/oauth2.0/show?which=Login' },
      });
      absorbCookies(authRes, jar);
      const cm = (authRes.headers.get('location') || '').match(/[?&]code=([^&#]+)/);
      if (!cm) throw new Error(`authorize 没回 code（HTTP ${authRes.status}）`);
      code = decodeURIComponent(cm[1]);
    } else {
      const text = await (await get(`https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=${state.uuid}&_=${Date.now()}`, { headers: { 'User-Agent': UA } })).text();
      const errcode = Number((text.match(/wx_errcode=(\d+)/) || [])[1] || 0);
      const wcode = (text.match(/wx_code='([^']+)'/) || [])[1] || '';
      if (errcode === 404) { process.stdout.write('已扫码，等你确认…\r'); continue; }
      if (errcode === 403) throw new Error('二维码已失效，请重跑脚本');
      if (errcode !== 405 || !wcode) { process.stdout.write(`等待扫码（${errcode || '?'}）…\r`); continue; }
      code = wcode;
    }

    // code → 音乐站登录态（Set-Cookie 里下发 qm_keyst / qqmusic_key）
    const tries = state.kind === 'wechat' ? [2, 1] : [1];
    for (const loginType of tries) {
      const pSkey = jar.get('p_skey') || '';
      const body = JSON.stringify({
        comm: { g_tk: pSkey ? gtkOf(pSkey) : 5381, platform: 'yqq', ct: 24, cv: 0 },
        req: { module: 'QQConnectLogin.LoginServer', method: 'QQLogin', param: { code, ...(loginType === 2 ? { loginType: 2 } : {}) } },
      });
      const res = await get('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST', body,
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header(), Referer: 'https://y.qq.com/' },
      });
      absorbCookies(res, jar);
      const json = await res.json().catch(() => null);
      if ((json?.req?.code ?? json?.req_0?.code) !== 0) continue;
      const musickey = jar.get('qm_keyst') || jar.get('qqmusic_key') || '';
      if (!musickey) continue;
      const uin = String(jar.get('qqmusic_uin') || jar.get('uin') || jar.get('p_uin') || json?.req?.data?.musicid || '').replace(/^o0/, '');
      const cookie = `qm_keyst=${musickey}; qqmusic_key=${musickey}; uin=o0${uin}; qqmusic_uin=${uin}`;
      done([
        `qqMusicCookie = ${cookie}`,
        json?.req?.data?.nick ? `（账号昵称：${json.req.data.nick}）` : '',
      ].filter(Boolean));
      return;
    }
    throw new Error('扫码成功但换票失败（code 可能已用过，请重跑脚本）');
  }
  throw new Error('等扫码超时了，重跑脚本再来一次');
}

// ── 酷狗 ───────────────────────────────────────────────────────────────
const KG_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';

async function loginKugou() {
  const mid = md5(`${Date.now()}${Math.random()}`).toUpperCase();
  const base = () => ({ dfid: '-', mid, uuid: '-', appid: 1014, clientver: 20489, clienttime: Math.floor(Date.now() / 1000) });
  const sign = (p) => md5(`${KG_SALT}${Object.keys(p).map((k) => `${k}=${p[k]}`).sort().join('')}${KG_SALT}`);
  const headers = () => ({
    'User-Agent': UA, Referer: 'https://www.kugou.com/',
    dfid: '-', mid, clienttime: String(Math.floor(Date.now() / 1000)),
    'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1', 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
  });
  const call = async (url, params) => {
    const p = { ...base(), ...params };
    p.signature = sign(p);
    const qs = new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)])).toString();
    const res = await fetch(`${url}?${qs}`, { headers: headers(), signal: AbortSignal.timeout(20000) });
    return res.json().catch(() => null);
  };

  const j = await call('https://login-user.kugou.com/v2/qrcode', {
    type: 1, plat: 4, qrcode_txt: 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=1005&', srcappid: 2919,
  });
  const key = j?.data?.qrcode;
  if (!key) throw new Error(`酷狗二维码取不到（${j?.error_code ?? '?'}）`);
  const buf = Buffer.from(String(j.data.qrcode_img || '').replace(/^data:image\/png;base64,/, ''), 'base64');
  if (!isPng(buf)) throw new Error('酷狗二维码不是 PNG');
  await showQr(buf, 'kugou');

  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    await sleep(2500);
    const r = await call('https://login-user.kugou.com/v2/get_userinfo_qrcode', { plat: 4, appid: 1005, srcappid: 2919, qrcode: key });
    const st = Number(r?.data?.status);
    if (st === 0) throw new Error('二维码已失效，重跑脚本');
    if (st === 1) { process.stdout.write('等待扫码…\r'); continue; }
    if (st === 2) { process.stdout.write('已扫码，等你确认…\r'); continue; }
    if (st !== 4) { process.stdout.write(`等待扫码（${st || '?'}）…\r`); continue; }
    const token = r?.data?.token || '';
    const userid = String(r?.data?.userid || '');
    if (!token) throw new Error('授权成功但没拿到 token');
    done([`kugouCookie = token=${token}; userid=${userid}; kg_mid=${mid}; kg_dfid=-`]);
    return;
  }
  throw new Error('等扫码超时了');
}

// ── 网易云 ─────────────────────────────────────────────────────────────
async function loginNetease() {
  let unikey;
  try {
    const res = await fetch('https://music.163.com/api/login/qrcode/unikey', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://music.163.com/' },
      body: 'type=1', signal: AbortSignal.timeout(20000),
    });
    unikey = (await res.json().catch(() => null))?.unikey;
  } catch { /* 下面统一报错 */ }
  if (!unikey) throw new Error('网易云 unikey 拿不到');
  const url = `https://music.163.com/login?codekey=${unikey}`;

  let buf = null;
  try { buf = await makeQr(url); } catch { /* 没装 qrcode 就退回手抄 */ }
  if (buf) await showQr(buf, 'netease');
  else {
    console.log(`\n没装 qrcode 包，画不出二维码。两种办法：\n  1) npm i qrcode 后重跑本命令\n  2) 直接抄：浏览器登录 music.163.com → F12 → Application → Cookies → 复制 MUSIC_U\n`);
    process.exit(1);
  }

  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    await sleep(2500);
    const res = await fetch(`https://music.163.com/api/login/qrcode/client/login?type=1&key=${unikey}`, {
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' }, signal: AbortSignal.timeout(20000),
    });
    const j = await res.json().catch(() => null);
    const code = Number(j?.code);
    if (code === 800) throw new Error('二维码已过期，重跑脚本');
    if (code === 801) { process.stdout.write('等待扫码…\r'); continue; }
    if (code === 802) { process.stdout.write('已扫码，等你确认…\r'); continue; }
    if (code !== 803) { process.stdout.write(`等待扫码（${code || '?'}）…\r`); continue; }
    const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0].trim()).filter((x) => x.includes('=')).join('; ');
    if (!/MUSIC_U=/.test(cookie)) throw new Error('扫码成功但没拿到 MUSIC_U');
    done([`neteaseCookie = ${cookie}`]);
    return;
  }
  throw new Error('等扫码超时了');
}

// ── 入口 ───────────────────────────────────────────────────────────────
console.log(`\n=== ${platform === 'qq' ? 'QQ音乐' : platform === 'kugou' ? '酷狗音乐' : '网易云音乐'} 扫码登录 ===`);
try {
  if (platform === 'qq') await loginQq(flag('wechat'));
  else if (platform === 'kugou') await loginKugou();
  else await loginNetease();
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  server?.close();
  process.exit(1);
}
