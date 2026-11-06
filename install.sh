#!/usr/bin/env bash
# 安装一个 dsh-qq-* 插件到 DSH（profile 机制：plugin-src + profile/package.json + node_modules 软链）。
#
#   bash install.sh                     # 装到 ~/.dsh/plugin-src/<插件名>
#   DSH_HOME=/root/.dsh DSH_PROFILE=web bash install.sh
#
# 为什么不用 builtin-plugins.json：那份文件是签名生成物（register-builtin-plugins.py 维护），
# 写进去的第三方插件不会被当成 bundle 加载，还会破坏签名一致性。真正的加载入口是
# profile 的 package.json —— bundles 名单 + dependencies 的 link: 条目 + node_modules 软链，三者缺一不可。
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="$(basename "$SRC")"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PLUGIN_SRC="$DSH_HOME/plugin-src"
DEST="$PLUGIN_SRC/$NAME"

say() { printf '\033[36m[%s]\033[0m %s\n' "$NAME" "$*"; }
die() { printf '\033[31m[%s] %s\033[0m\n' "$NAME" "$*" >&2; exit 1; }

[ -f "$SRC/lib/index.js" ] || die "这个目录里没有 lib/index.js，别在错误的目录跑 install.sh"
[ -d "$DSH_HOME" ] || die "找不到 DSH 目录：$DSH_HOME（用 DSH_HOME=... 指定）"

# ───────── 老式 DSH：只有 builtin-plugins.json，没有 profile 机制 ─────────
if [ ! -f "$PROFILE_DIR/package.json" ]; then
  REG="$DSH_HOME/builtin-plugins.json"
  [ -f "$REG" ] || die "既没有 $PROFILE_DIR/package.json 也没有 $REG，这不像是 DSH 安装目录"
  say "这套 DSH 是老的 builtin-plugins 机制，按老方式装"
  mkdir -p "$DEST"
  command -v rsync >/dev/null 2>&1 && rsync -a --exclude node_modules "$SRC"/ "$DEST"/ \
    || { rm -rf "$DEST/lib"; cp -a "$SRC"/. "$DEST"/; rm -rf "$DEST/node_modules"; }
  python3 - "$REG" "$NAME" "$DEST" <<'PY'
import json, sys
reg_path, name, dest = sys.argv[1], sys.argv[2], sys.argv[3]
with open(reg_path, encoding='utf-8') as f: data = json.load(f)
plugins = data.setdefault('plugins', [])
entry = {"name": name, "guestDirectory": dest, "entrypoint": "lib/index.js", "internal": False}
for i, item in enumerate(plugins):
    if item.get('name') == name:
        plugins[i] = {**item, **entry}; break
else:
    plugins.append(entry)
with open(reg_path, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2); f.write('\n')
print(f'  登记完成：{name} → {dest}')
PY
  say "装好了，重启 DSH 生效"
  exit 0
fi

# ───────── ① 插件本体 ─────────
mkdir -p "$PLUGIN_SRC"
say "插件本体 → $DEST"
mkdir -p "$DEST"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude node_modules --exclude '*.log' "$SRC"/ "$DEST"/
else
  ( cd "$SRC" && tar cf - --exclude node_modules --exclude '*.log' . ) | ( cd "$DEST" && tar xf - )
fi

# ───────── ② 依赖解析（让插件能 import 到宿主的 dsh-tools / schemastery） ─────────
LINKED=0
for CAND in "$PROFILE_DIR/node_modules/@deepseek-ai" \
            /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai \
            /usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai; do
  if [ -d "$CAND/dsh-tools" ]; then
    mkdir -p "$DEST/node_modules/@deepseek-ai"
    for p in dsh-tools schemastery; do
      [ -d "$CAND/$p" ] && ln -sfn "$CAND/$p" "$DEST/node_modules/@deepseek-ai/$p"
    done
    LINKED=1; say "依赖软链 → $CAND"; break
  fi
done
[ "$LINKED" = 1 ] || say "没找到 @deepseek-ai/dsh-tools，跳过依赖软链（插件会用自带 schema 兜底）"

# ───────── ③ profile/package.json：bundles + dependencies ─────────
python3 - "$PROFILE_DIR/package.json" "$NAME" "$DEST" <<'PY'
import json, sys, os
pkg_path, name, dest = sys.argv[1], sys.argv[2], sys.argv[3]
with open(pkg_path, encoding='utf-8') as f: pkg = json.load(f)
deps = pkg.setdefault('dependencies', {})
deps[name] = f'link:{dest}'
prof = pkg.setdefault('dsh', {}).setdefault('profile', {})
bundles = prof.setdefault('bundles', [])
if name not in bundles:
    bundles.append(name)
with open(pkg_path, 'w', encoding='utf-8') as f:
    json.dump(pkg, f, ensure_ascii=False, indent=2); f.write('\n')
print(f'  已登记：dependencies[{name}] = link:{dest}；bundles {len(bundles)} 项')
PY

# ───────── ④ node_modules 软链 ─────────
mkdir -p "$PROFILE_DIR/node_modules"
REL="$(python3 -c "import os,sys;print(os.path.relpath(sys.argv[1], sys.argv[2]))" "$DEST" "$PROFILE_DIR/node_modules")"
ln -sfn "$REL" "$PROFILE_DIR/node_modules/$NAME"
say "软链 node_modules/$NAME → $REL"

# ───────── ⑤ profile patch 里的 config 模板 ─────────
PATCH="$PROFILE_DIR/cordis.patch.yml"
if [ -f "$PATCH" ] && grep -q "id: $NAME\$" "$PATCH"; then
  say "$PATCH 里已有 $NAME 的配置块，保持不动"
else
  {
    printf '\n# %s 配置（改完重启 DSH）\n' "$NAME"
    printf -- "- id: %s\n  name: '%s'\n  config:\n" "$NAME" "$NAME"
    printf '    onebotHttpUrl: http://127.0.0.1:3000\n'
    printf '    onebotWsUrl: ws://127.0.0.1:3001\n'
    printf '    onebotToken: ""\n'
    printf '    onebotWsToken: ""\n'
    printf '    selfId: ""\n'
    case "$NAME" in
      dsh-qq-sing)
        printf '    ownerQQ: ""\n    qqMusicCookie: ""\n    kugouCookie: ""\n    neteaseCookie: ""\n    topN: 6\n    sendMode: voice\n    allowGroupWithoutAt: false\n' ;;
      dsh-qq-image)
        printf '    apiBaseUrl: ""\n    apiKey: ""\n    imageModel: agnes-image-2.5-flash\n    videoModel: agnes-video-2.5-flash\n' ;;
      dsh-qq-voice)
        printf '    edgePython: python3\n    ttsVoice: zh-CN-XiaoyiNeural\n    speed: 5\n    pitchHz: 0\n' ;;
    esac
  } >> "$PATCH"
  say "已在 $PATCH 末尾写好配置模板"
fi

say "装好了。下一步："
say "  1) 填 $PATCH 里 $NAME 的 config（OneBot 地址/token/selfId，以及这个插件的必填项）"
say "  2) 重启 DSH（patchReload=startup），日志里会有「$NAME …就绪」"
say "  3) 自检：cd $DEST && node contract-test.mjs && node smoke-test.mjs"
