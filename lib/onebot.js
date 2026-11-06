// OneBot v11 适配器 —— 一套接口吃下 NapCat / Lagrange / LLOneBot / snowluma / go-cqhttp。
// 三个 QQ 插件（点歌/生图/语音）各带一份，互相独立、可单独安装。
//
// 发送走 HTTP（POST {httpUrl}/{action}），接收走正向 WebSocket（{wsUrl}）。
// 只依赖 Node 内置 fetch / WebSocket，没有任何第三方包。

const SEG = {
  text: (text) => ({ type: 'text', data: { text } }),
  image: (file) => ({ type: 'image', data: { file } }),
  record: (file) => ({ type: 'record', data: { file } }),
  video: (file) => ({ type: 'video', data: { file } }),
  file: (file, name) => ({ type: 'file', data: name ? { file, name } : { file } }),
};

export function parseCookie(text) {
  const out = {};
  for (const part of String(text || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function createAdapter({ httpUrl, wsUrl, token, wsToken, selfId, log = () => {} } = {}) {
  const base = String(httpUrl || '').replace(/\/+$/, '');
  // 同一个 OneBot 实现的 HTTP 与 WebSocket 可能用两个不同的 token
  // （例如 SnowLuma：HTTP 用 httpAccessToken，WS 用 accessToken）。
  // 所以这里同时接受 token（HTTP 用）和 wsToken（WS 用），并互相兜底重试。
  const httpToken = String(token || '').trim();
  const tokens = [];
  for (const t of [wsToken, token]) {
    const v = String(t || '').trim();
    if (v && !tokens.includes(v)) tokens.push(v);
  }
  const wsTokens = tokens.length ? tokens : [''];
  // selfId 留空时自动问 OneBot 要（换框架最容易忘的就是这个，忘了就认不出 @ 和"自己发的消息"）
  let resolvedSelfId = String(selfId || '').trim();
  async function ensureSelfId() {
    if (resolvedSelfId) return resolvedSelfId;
    try {
      const info = await call('get_login_info');
      resolvedSelfId = String(info?.user_id ?? info?.userId ?? '');
      if (resolvedSelfId) log(`自动识别到机器人 QQ：${resolvedSelfId}（${info?.nickname || ''}）`);
    } catch (error) {
      log(`自动获取 selfId 失败（${error.message}），请手动填 selfId`);
    }
    return resolvedSelfId;
  }
  const authOf = (tk) => (tk ? { Authorization: `Bearer ${tk}` } : {});
  const httpOrder = [httpToken, ...tokens].filter((t, i, a) => t !== undefined && a.indexOf(t) === i);
  let socket = null;
  let stopped = false;
  let retry = 0;
  let wsTokenIndex = 0;

  // 不同实现收 token 的位置不一样：header Authorization: Bearer 与 ?access_token= 都有
  // （NapCat / Lagrange / LLOneBot / go-cqhttp 认 query，SnowLuma 认 header），两种都试一遍。
  async function call(action, body) {
    if (!base) throw new Error('没配 OneBot HTTP 地址（插件设置里的 onebotHttpUrl）');
    let lastAuthError = null;
    for (const tk of (httpOrder.length ? httpOrder : [''])) {
      for (const style of ['header', 'query']) {
      const url = style === 'query' && tk ? `${base}/${action}?access_token=${encodeURIComponent(tk)}` : `${base}/${action}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(style === 'header' ? authOf(tk) : {}) },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 401 || res.status === 403) {
        lastAuthError = new Error(`${action} 失败：OneBot 鉴权被拒（HTTP ${res.status}），token 不对或传法不认`);
        continue;
      }
      const json = await res.json().catch(() => ({}));
      const code = json?.retcode ?? json?.status;
      if (code === 1401 || code === 401) {
        lastAuthError = new Error(`${action} 失败：${json?.retcode ?? res.status} ${json?.wording || json?.message || ''}`.trim());
        continue;
      }
      if (code !== 0 && code !== 'ok') {
        throw new Error(`${action} 失败：${json?.retcode ?? res.status} ${json?.wording || json?.message || ''}`.trim());
      }
      return json?.data ?? json;
      }
    }
    throw lastAuthError || new Error(`${action} 失败：OneBot 没接受任何一个 token`);
  }

  let probedVersion = false;
  async function probeVersion() {
    if (probedVersion) return;
    probedVersion = true;
    try {
      const info = await call('get_version_info');
      const name = info?.app_name || info?.appName || info?.impl || 'OneBot';
      const ver = info?.app_version || info?.version || '';
      log(`OneBot 实现：${name}${ver ? ` ${ver}` : ''}`);
    } catch { /* 这个 action 不是所有实现都有，忽略 */ }
  }

  const chatOf = (chat) => {
    const kind = chat?.kind === 'group' ? 'group' : 'private';
    return { kind, id: Number(chat?.id), action: kind === 'group' ? 'send_group_msg' : 'send_private_msg', key: kind === 'group' ? 'group_id' : 'user_id' };
  };

  async function send(chat, segments) {
    if (!segments?.length) return null;
    const c = chatOf(chat);
    if (!Number.isFinite(c.id)) throw new Error('发送失败：chatId 不是数字');
    const data = await call(c.action, { [c.key]: c.id, message: segments });
    return data?.message_id ?? null;
  }

  // WS 路径各家不同：有的在 /，有的 /api/ws，有的 /onebot/v11/ws。全都试一遍。
  function wsCandidates(raw) {
    const list = [];
    const push = (u) => { if (u && !list.includes(u)) list.push(u); };
    push(raw);
    try {
      const base = new URL(raw);
      const cur = base.pathname || '/';
      for (const p of ['/', '/ws', '/api/ws', '/onebot/v11/ws', '/onebot/ws', '/event']) {
        if (p === cur) continue;
        const u = new URL(raw); u.pathname = p; push(u.toString());
      }
    } catch { /* ignore */ }
    return list.length ? list : [raw];
  }

  function onEvent(handler) {
    const url = String(wsUrl || '').trim();
    if (!url) { log('没配 WebSocket 地址，插件只在被工具调用时工作，不主动收消息'); return () => {}; }
    const pathList = wsCandidates(url);
    let pathIndex = 0;
    const connect = () => {
      if (stopped) return;
      if (!resolvedSelfId) ensureSelfId().catch(() => {});
      let target;
      try {
        target = new URL(pathList[pathIndex] || url);
        const wsTok = wsTokens[wsTokenIndex] || '';
        if (wsTok) target.searchParams.set('access_token', wsTok);
      } catch { log(`WebSocket 地址不合法：${url}`); return; }
      let ws;
      try { ws = new WebSocket(target.toString()); } catch (error) { log(`WebSocket 连接失败：${error.message}`); schedule(); return; }
      socket = ws;
      let opened = false;
      ws.addEventListener('open', () => {
        opened = true; retry = 0;
        log(`OneBot WebSocket 已连上（${pathList[pathIndex]}）`);
        probeVersion();
      });
      ws.addEventListener('message', (event) => {
        let payload;
        try { payload = JSON.parse(String(event.data)); } catch { return; }
        if (payload?.post_type !== 'message' && payload?.post_type !== 'message_sent') return;
        if (String(payload.user_id) === resolvedSelfId) return;
        try { handler(normalizeMessage(payload, resolvedSelfId)); } catch (error) { log(`处理消息出错：${error?.message || error}`); }
      });
      ws.addEventListener('close', () => {
        socket = null;
        if (!opened) {
          // 连不上时轮换：先换 token，token 轮完再换 WS 路径
          if (wsTokens.length > 1 && wsTokenIndex < wsTokens.length - 1) {
            wsTokenIndex += 1;
            log('OneBot WebSocket 被拒（多半是 token 不对），换另一个 token 重试');
          } else if (pathList.length > 1) {
            wsTokenIndex = 0;
            pathIndex = (pathIndex + 1) % pathList.length;
            log(`OneBot WebSocket 换路径重试：${pathList[pathIndex]}`);
          }
        }
        schedule();
      });
      ws.addEventListener('error', () => { try { ws.close(); } catch { /* ignore */ } });
    };
    const schedule = () => {
      if (stopped) return;
      retry += 1;
      const wait = Math.min(30000, 1000 * 2 ** Math.min(retry, 5));
      setTimeout(connect, wait).unref?.();
    };
    connect();
    return () => { stopped = true; try { socket?.close(); } catch { /* ignore */ } };
  }

  return {
    SEG,
    call,
    send,
    sendText: (chat, text) => send(chat, [SEG.text(text)]),
    sendImage: (chat, base64) => send(chat, [SEG.image(`base64://${base64}`)]),
    // 少数实现（或上游没装 silk 转码）会拒 record，这时退一步发成文件，别让用户啥也收不到
    sendRecord: async (chat, base64) => {
      try {
        return await send(chat, [SEG.record(`base64://${base64}`)]);
      } catch (error) {
        log(`发语音条失败（${error.message}），改发文件`);
        return send(chat, [SEG.file(`base64://${base64}`, `voice-${Date.now()}.mp3`)]);
      }
    },
    sendVideo: (chat, file) => send(chat, [SEG.video(file)]),
    sendFile: (chat, file, name) => send(chat, [SEG.file(file, name)]),
    getSelfInfo: () => call('get_login_info'),
    onEvent,
    get connected() { return Boolean(socket); },
  };
}

/** 归一化一条 OneBot 消息事件。 */
export function normalizeMessage(payload, selfId) {
  const type = payload.message_type;
  const kind = type === 'group' ? 'group' : type === 'private' ? 'private' : null;
  if (!kind) return null;
  const segments = Array.isArray(payload.message) ? payload.message : [];
  const text = segments.filter((s) => s.type === 'text').map((s) => s.data?.text || '').join('').trim();
  const images = segments.filter((s) => s.type === 'image').map((s) => ({ url: s.data?.url || '', file: s.data?.file || '' }));
  const atMe = kind === 'group'
    ? segments.some((s) => s.type === 'at' && String(s.data?.qq) === String(selfId))
    : false;
  const chatId = kind === 'group' ? payload.group_id : payload.user_id;
  const owner = payload.sender?.card || payload.sender?.nickname || String(payload.user_id);
  return {
    kind,
    chatId: Number(chatId),
    chat: { kind, id: Number(chatId) },
    senderId: String(payload.user_id),
    senderName: String(owner),
    text,
    images,
    atMe,
    mid: payload.message_id,
  };
}
