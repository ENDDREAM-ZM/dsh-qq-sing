// dsh-compat.js —— 唯一碰 DSH 宿主 API 的地方。
//
// 旧版本 / 现版本 / 未来版本都能活，靠三条：
//   ① 工具注册方法名运行时探测（register / define / add / tool）
//   ② @deepseek-ai/dsh-tools 的 defineTool 有就用、没有就自己拼 schema 直接注册
//   ③ @deepseek-ai/schemastery 有就生成真 schema，没有就退化成纯 JSON 描述
//
// 探测结果会写进 compatReport()，插件启动日志里也会打一行，装到任何版本上都能一眼看出走了哪条路。

const TOOL_REGISTER_KEYS = ['register', 'define', 'add', 'tool'];

let defineToolFn = null;
let schemastery = null;
let toolsPkgError = '';
let schemaPkgError = '';

try {
  const mod = await import('@deepseek-ai/dsh-tools');
  defineToolFn = typeof mod.defineTool === 'function' ? mod.defineTool : typeof mod.default?.defineTool === 'function' ? mod.default.defineTool : null;
  if (!defineToolFn) toolsPkgError = '包在，但没有导出 defineTool';
} catch (error) {
  toolsPkgError = error?.code === 'ERR_MODULE_NOT_FOUND' ? '没装 @deepseek-ai/dsh-tools（用自带 schema 兜底）' : String(error?.message || error);
}

try {
  const mod = await import('@deepseek-ai/schemastery');
  schemastery = mod.default ?? mod;
  if (typeof schemastery?.object !== 'function') { schemastery = null; schemaPkgError = '包在，但没有 z.object'; }
} catch (error) {
  schemaPkgError = error?.code === 'ERR_MODULE_NOT_FOUND' ? '没装 @deepseek-ai/schemastery（用纯 JSON 配置兜底）' : String(error?.message || error);
}

const REPORT = {
  defineTool: Boolean(defineToolFn),
  schemastery: Boolean(schemastery),
  toolsPkgError,
  schemaPkgError,
  toolRegisterKey: null,
  registrations: 0,
  defineToolFallback: '',
};

/** 配置声明：有 schemastery 就是真 schema，没有就是带 defaults 的纯 JSON。 */
export function defineConfig(spec) {
  const defaults = {};
  for (const [key, field] of Object.entries(spec)) defaults[key] = field.default;

  if (schemastery) {
    const shape = {};
    for (const [key, field] of Object.entries(spec)) {
      let f;
      if (field.type === 'number') f = schemastery.number();
      else if (field.type === 'boolean') f = schemastery.boolean();
      else if (Array.isArray(field.enum)) f = schemastery.union(field.enum.map((v) => schemastery.const(v)));
      else f = schemastery.string();
      if (field.default !== undefined) f = f.default(field.default);
      if (field.description) f = f.description(field.description);
      shape[key] = f;
    }
    const schema = schemastery.object(shape);
    schema.defaults = defaults;
    return schema;
  }

  const properties = {};
  for (const [key, field] of Object.entries(spec)) {
    properties[key] = {
      type: field.type === 'number' ? 'number' : field.type === 'boolean' ? 'boolean' : 'string',
      default: field.default,
      description: field.description,
    };
    if (Array.isArray(field.enum)) properties[key].enum = field.enum;
  }
  return { type: 'object', additionalProperties: false, properties, defaults };
}

function pickRegister(host) {
  if (!host) return null;
  for (const key of TOOL_REGISTER_KEYS) {
    if (typeof host[key] === 'function') { REPORT.toolRegisterKey = key; return host[key].bind(host); }
  }
  return null;
}

/**
 * 有 defineTool 就用（带参数校验），但它要求 output.render，缺了就补一个空的；
 * 万一未来版本改了要求、抛错，也退回裸定义对象，绝不因此起不来。
 */
/**
 * defineTool 的 parameters 要的是「属性表」（{ 字段: {type,description,required} }），
 * 不是完整 JSON Schema。插件里统一写完整 schema（裸注册也能用），这里转一道。
 */
function toPropertyMap(params) {
  if (!params || params.type !== 'object' || !params.properties) return params;
  const required = new Set(Array.isArray(params.required) ? params.required : []);
  const map = {};
  for (const [key, value] of Object.entries(params.properties)) {
    const { required: ownRequired, ...rest } = value || {};
    const normalized = rest.type === 'object' && rest.properties
      ? { ...rest, additionalProperties: rest.additionalProperties ?? false }
      : rest;
    map[key] = { ...normalized, ...(ownRequired || required.has(key) ? { required: true } : {}) };
  }
  return map;
}

const DEFAULT_OUTPUT_SCHEMA = { type: 'object', properties: {}, additionalProperties: true };

/**
 * 把结果渲染成「内容块数组」。
 * dsh-tools 会把 render 的返回值直接当 result.content 用（内部还有 result.content.some(...)），
 * 所以**必须返回数组**，返回字符串会炸 `content.some is not a function`。
 */
function renderValue(_args, value) {
  let text;
  try {
    if (value === undefined || value === null) text = '';
    else if (typeof value === 'string') text = value;
    else text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return [{ type: 'text', text }];
}

/** defineTool 只要收到 output 就无条件读 output.render，缺了会在调用时抛 userRender is not a function —— 这里补全。 */
function withRender(output) {
  if (output && typeof output.render === 'function') return output;
  if (!output) return { schema: DEFAULT_OUTPUT_SCHEMA, render: renderValue };
  return { ...output, render: renderValue };
}

function makeTool(def) {
  if (!defineToolFn) return { ...def, output: withRender(def.output) };
  try {
    return defineToolFn({
      ...def,
      parameters: toPropertyMap(def.parameters),
      output: withRender(def.output),
    });
  } catch (error) {
    REPORT.defineToolFallback = String(error?.message || error);
    return { ...def, output: withRender(def.output) };
  }
}

/** 注册一个工具；拿不到注册入口就抛一条人话错误。 */
export function registerTool(ctx, def) {
  // 先看 ctx.tools.*，再看 ctx.*（超老版本可能直接把注册函数挂在 ctx 上）
  const register = pickRegister(ctx?.tools) || pickRegister(ctx);
  if (!register) {
    throw new Error(`这个 DSH 版本没有可用的工具注册入口（试过 ${TOOL_REGISTER_KEYS.join('/')}），插件没法注册工具`);
  }
  const tool = makeTool(def);
  const out = register(tool);
  REPORT.registrations += 1;
  if (out && typeof out.then === 'function') return out;
  return out;
}

export function compatReport() {
  return { ...REPORT };
}

export function compatLine() {
  return `工具注册=${REPORT.toolRegisterKey || '无'}，defineTool=${REPORT.defineTool ? '有' : '无'}，schemastery=${REPORT.schemastery ? '有' : '无'}`;
}
