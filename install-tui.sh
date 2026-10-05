#!/usr/bin/env bash
# Compile, test, and install the terminal harness as `localaitab`.
#
# The build is copied rather than linked, so the command keeps working while
# the repo is mid-edit, on another branch, or mid-compile. Rerun to update.
#
#   ./install-tui.sh              install to ~/.local (bin/localaitab, lib/localaitab)
#   ./install-tui.sh --uninstall  remove both
#
# LOCALAITAB_PREFIX overrides ~/.local.
set -euo pipefail
cd "$(dirname "$0")"

PREFIX="${LOCALAITAB_PREFIX:-$HOME/.local}"
BIN="$PREFIX/bin/localaitab"
LIB="$PREFIX/lib/localaitab"

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$LIB" "$BIN"
  echo "==> removed $BIN and $LIB"
  exit 0
fi

# fetch and readline/promises both need 18.
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "localaitab needs Node 18 or newer; found $(node -v)." >&2
  exit 1
fi

echo "==> compile"
npx tsc -p ./

echo "==> test"
npm test --silent >/dev/null
echo "    ok"

# Only the core and the terminal host; both import nothing beyond Node itself.
# Staged next to the target and swapped in, so a failed copy leaves the last
# install working.
echo "==> install to $LIB"
mkdir -p "$PREFIX/bin" "$PREFIX/lib"
STAGE="$LIB.new"
rm -rf "$STAGE"
mkdir -p "$STAGE/hosts"
cp -R out/core "$STAGE/core"
cp -R out/hosts/tui "$STAGE/hosts/tui"
find "$STAGE" -name '*.map' -delete

VERSION=$(node -p "require('./package.json').version")
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
DIRTY=$(git status --porcelain 2>/dev/null | grep -q . && echo "+local changes" || true)
echo "localaitab $VERSION ($COMMIT$DIRTY, installed $(date '+%Y-%m-%d %H:%M'))" > "$STAGE/VERSION"
# The version the live session file reports.
echo "{\"version\": \"$VERSION\"}" > "$STAGE/package.json"

rm -rf "$LIB"
mv "$STAGE" "$LIB"

# The node on PATH wins, so a Node upgrade is picked up; the one used for this
# install is the fallback for shells that do not have it on PATH.
cat > "$BIN" <<EOF
#!/bin/sh
# Installed by localaitab's install-tui.sh; rerun that to update.
LIB="$LIB"
if [ "\${1:-}" = "--version" ]; then cat "\$LIB/VERSION"; exit 0; fi
NODE="\$(command -v node 2>/dev/null || echo '$(command -v node)')"
exec "\$NODE" "\$LIB/hosts/tui/main.js" "\$@"
EOF
chmod +x "$BIN"

echo "==> verify"
"$BIN" --help >/dev/null
echo "    $("$BIN" --version)"
case ":$PATH:" in
  *":$PREFIX/bin:"*) echo "==> done. Run localaitab in any terminal." ;;
  *) echo "==> done, but $PREFIX/bin is not on PATH. Add it, or run $BIN." ;;
esac
