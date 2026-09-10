#!/bin/sh
# spare10 installer — https://github.com/alesdi/spare10
#
# Fetches the published bundle and puts a `spare10` command on your PATH.
# Node.js 20+ is required: spare10 is a Node program, and this script installs it rather
# than bundling a runtime (which would cost 60-110MB and measurably slow the hot path).
set -eu

PREFIX="${SPARE10_PREFIX:-$HOME/.local}"
LIB="$PREFIX/share/spare10"
BIN="$PREFIX/bin"
VERSION="${SPARE10_VERSION:-latest}"

die() { printf 'spare10: %s\n' "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar  >/dev/null 2>&1 || die "tar is required"

if ! command -v node >/dev/null 2>&1; then
  die "Node.js 20 or newer is required and was not found on your PATH.
       spare10 needs a Node runtime; install one from https://nodejs.org and re-run this script."
fi

MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$MAJOR" -ge 20 ] 2>/dev/null || die "Node.js 20 or newer is required (found $(node -v))."

printf 'Resolving spare10@%s...\n' "$VERSION"
TARBALL=$(curl -fsSL "https://registry.npmjs.org/spare10/$VERSION" \
  | tr ',' '\n' | grep '"tarball"' | head -1 | sed 's/.*"tarball":"//; s/".*//')
[ -n "$TARBALL" ] || die "could not resolve a download URL for spare10@$VERSION"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$TARBALL" -o "$TMP/spare10.tgz" || die "download failed"
tar -xzf "$TMP/spare10.tgz" -C "$TMP" || die "could not unpack the download"
[ -f "$TMP/package/dist/spare10.js" ] || die "the downloaded package looks wrong"

mkdir -p "$LIB" "$BIN"
cp "$TMP/package/dist/spare10.js" "$LIB/spare10.js"
chmod +x "$LIB/spare10.js"
ln -sf "$LIB/spare10.js" "$BIN/spare10"

printf '\nInstalled to %s\n' "$BIN/spare10"
case ":$PATH:" in
  *":$BIN:"*) printf 'Run: spare10 claude\n' ;;
  *) printf '\n%s is not on your PATH. Add it with:\n  export PATH="%s:$PATH"\n' "$BIN" "$BIN" ;;
esac
