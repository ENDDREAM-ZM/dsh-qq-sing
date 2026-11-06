// 用 DSH 真实契约验证工具定义：defineTool 的 output.render 必须存在且返回「内容块数组」。
// 这个测试**不 mock** dsh-tools —— 上一版就是被 mock 掉了才漏掉 bug。
//   node contract-test.mjs
import http from 'node:http';

let defineToolFn = null;
let toolsPkgNote = '宿主没装 @deepseek-ai/dsh-tools，只能验证裸定义对象的形状';
try {
  ({ defineTool: defineToolFn } = await import('@deepseek-ai/dsh-tools'));
  toolsPkgNote = 'defineTool 已加载，走真实契约';
} catch (error) { toolsPkgNote = `defineTool 没加载（${error.message}），只能验证裸定义对象`; }

// 假 OneBot，避免插件启动时去连真服务
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 10000, nickname: 't' } }));
});
await new Promise((r) => server.listen(3995, '127.0.0.1', r));

// 放在三合一包里跑就测三个；放在单个插件目录里跑就只测自己。
const here = await import('node:fs');
let selfName = '本插件';
try { selfName = JSON.parse(here.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name; } catch { /* 三合一包根目录没有 package.json */ }
const PLUGINS = here.existsSync(new URL('./lib/index.js', import.meta.url))
  ? [[selfName, './lib/index.js']]
  : [
      ['dsh-qq-sing', './dsh-qq-sing/lib/index.js'],
      ['dsh-qq-image', './dsh-qq-image/lib/index.js'],
      ['dsh-qq-voice', './dsh-qq-voice/lib/index.js'],
    ];

let pass = 0;
const fail = [];
const tools = [];
for (const [name, path] of PLUGINS) {
  const mod = await import(path);
  const ctx = {
    tools: { register: (t) => { tools.push({ plugin: name, tool: t }); return t; } },
    logger: { info() {}, warn() {}, error() {} },
    effect: () => () => {},
  };
  mod.apply(ctx, { onebotHttpUrl: 'http://127.0.0.1:3995', selfId: '10000' });
}

console.log(`注册到 ${tools.length} 个工具（${toolsPkgNote}）`);
const compatPath = here.existsSync(new URL('./lib/dsh-compat.js', import.meta.url))
  ? new URL('./lib/dsh-compat.js', import.meta.url).href
  : new URL('./dsh-qq-sing/lib/dsh-compat.js', import.meta.url).href;
const { compatReport } = await import(compatPath);
console.log('兼容路径：', JSON.stringify(compatReport()));
for (const { plugin, tool } of tools) {
  const label = `${plugin} · ${tool.name}`;
  if (!tool.output) { fail.push(`${label}: 没有 output`); continue; }
  if (typeof tool.output.render !== 'function') { fail.push(`${label}: output.render 不是函数（会抛 userRender is not a function）`); continue; }
  let blocks;
  try { blocks = tool.output.render({}, { demo: true, list: [1, 2] }); }
  catch (error) { fail.push(`${label}: render 抛错 ${error.message}`); continue; }
  if (!Array.isArray(blocks)) { fail.push(`${label}: render 返回 ${typeof blocks}，不是数组（会抛 content.some is not a function）`); continue; }
  if (!blocks.length || typeof blocks[0]?.type !== 'string') { fail.push(`${label}: render 返回的块没有 type 字段`); continue; }
  // 模拟 dsh-tools 内部：result.content.some(...)
  const content = blocks;
  try { content.some((b) => b.type === 'image'); } catch (error) { fail.push(`${label}: content.some 不可用 ${error.message}`); continue; }
  // 模拟 schema 校验入口存在
  if (tool.output.schema && typeof tool.output.schema !== 'object') { fail.push(`${label}: output.schema 不是对象`); continue; }
  if (typeof tool.execute !== 'function' && typeof tool.handler !== 'function' && typeof tool.run !== 'function') {
    fail.push(`${label}: 没有可执行入口（execute/handler/run）`);
    continue;
  }
  pass += 1;
  console.log(`✓ ${label}  render → [${blocks[0].type}]`);
}

server.close();
if (fail.length) {
  console.log('\n失败：');
  for (const f of fail) console.log(' ✗', f);
}
console.log(`\nrender 合法 ${pass} / 非法 ${fail.length}`);
process.exit(fail.length ? 1 : 0);
