#!/usr/bin/env bash
# Compile, package, and install into every VS Code profile.
# Profiles with useDefaultFlags.extensions inherit the default profile and are skipped.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -p "require('./package.json').version")
VSIX="localaitab-${VERSION}.vsix"

echo "==> compile"
npx tsc -p ./

echo "==> test"
npm test --silent

echo "==> package ${VSIX}"
npx --yes @vscode/vsce package --out "$VSIX" >/dev/null
echo "    ok"

PROFILES=$(python3 -c "
import json, pathlib
p = pathlib.Path.home()/'Library/Application Support/Code/User/globalStorage/storage.json'
for x in json.loads(p.read_text()).get('userDataProfiles', []):
    if not x.get('useDefaultFlags', {}).get('extensions'):
        print(x['name'])
")

echo "==> install: default profile"
code --install-extension "$VSIX" --force 2>&1 | grep -E 'successfully|error' || true

while IFS= read -r name; do
  [ -z "$name" ] && continue
  echo "==> install: $name"
  code --profile "$name" --install-extension "$VSIX" --force 2>&1 | grep -E 'successfully|error' || true
done <<< "$PROFILES"

echo "==> done. Reload VS Code windows to pick up the new build."
