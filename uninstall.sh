#!/usr/bin/env bash
# 卸载 dsh-qq-* 插件（profile 机制）：bundles / dependencies / node_modules 软链 / plugin-src 目录，四处一起清。
#   bash uninstall.sh                 # 按当前目录名
#   bash uninstall.sh dsh-qq-sing
set -euo pipefail
NAME="${1:-$(basename "$PWD")}"
NAME="$(basename "$NAME")"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
DEST="$DSH_HOME/plugin-src/$NAME"
PATCH="$PROFILE_DIR/cordis.patch.yml"

if [ -f "$PROFILE_DIR/package.json" ]; then
  python3 - "$PROFILE_DIR/package.json" "$NAME" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as f: pkg = json.load(f)
pkg.get('dependencies', {}).pop(name, None)
prof = pkg.get('dsh', {}).get('profile', {})
bundles = prof.get('bundles', [])
if name in bundles: bundles.remove(name)
with open(path, 'w', encoding='utf-8') as f:
    json.dump(pkg, f, ensure_ascii=False, indent=2); f.write('\n')
print(f'  已从 bundles 摘除（剩 {len(bundles)} 项）、dependencies 已删 {name}')
PY
  [ -L "$PROFILE_DIR/node_modules/$NAME" ] && rm -f "$PROFILE_DIR/node_modules/$NAME" && echo "  软链已删"
else
  REG="$DSH_HOME/builtin-plugins.json"
  [ -f "$REG" ] && python3 - "$REG" "$NAME" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as f: data = json.load(f)
before = len(data.get('plugins') or [])
data['plugins'] = [p for p in (data.get('plugins') or []) if p.get('name') != name]
with open(path, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2); f.write('\n')
print(f'  已从 builtin-plugins.json 摘除（{before} → {len(data["plugins"])}）')
PY
fi

# 摘 cordis.patch.yml 里对应的配置块（从 "# NAME 配置" 注释到下一个 "- id:" 之前）
if [ -f "$PATCH" ] && grep -q "^- id: $NAME$" "$PATCH"; then
  python3 - "$PATCH" "$NAME" <<'PY'
import re, sys
path, name = sys.argv[1], sys.argv[2]
text = open(path, encoding='utf-8').read()
pattern = re.compile(rf'\n# {re.escape(name)} 配置[^\n]*\n- id: {re.escape(name)}\n(?:  .*\n|\n)*?(?=^- id: |\Z)', re.M)
new, n = pattern.subn('\n', text)
open(path, 'w', encoding='utf-8').write(new.rstrip('\n') + '\n')
print(f'  cordis.patch.yml 配置块已移除（{n} 处）')
PY
fi

rm -rf "$DEST" && echo "  目录已删：$DEST"
echo "  重启 DSH 生效"
