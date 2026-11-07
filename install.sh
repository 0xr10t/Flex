#!/usr/bin/env bash
# Install Flexx for the current user. No services, configuration, or model downloads.
set -euo pipefail
umask 077

usage() {
  cat <<'HELP'
Usage: curl -fsSL https://HOST/install.sh | bash
       bash install.sh [--source] [--prefix PATH]
       bash install.sh --version VERSION --sha256 DIGEST [options]

  --source           Build the master branch with local Node and npm (the default)
  --version VERSION  Release tag, such as v0.1.0 (required for releases)
  --sha256 DIGEST    Trusted SHA-256 (required for releases)
  --archive PATH     Install a local archive instead of downloading
  --prefix PATH      Absolute installation directory (default: ~/.flex)
  -h, --help         Show this help

Downloads flex-VERSION-OS-ARCH.tar.gz from 0xr10t/Flex GitHub Releases.
Supported targets: linux/darwin, x86_64/aarch64. Requires Bash, Python 3,
and curl for downloads. Archives must contain bin/flexx plus its runtime,
with no enclosing directory, symlinks, hard links, or special files.
Source installs also require Git, npm, and Node 22.12+ (22.x) or 24+.
They install all three dependency trees and build the agent and wallet.
Native dependencies may require a compiler and build tools on your machine.
HELP
}
fail() { printf 'flexx installer: %s\n' "$*" >&2; exit 1; }
# Everything runs inside main, called on the last line: a truncated download runs nothing, and with
# `curl | bash` Bash has read the whole script before any command can consume stdin.
main() {
version=''
digest=''
archive=''
source_install=false
prefix="${HOME:?HOME must be set}/.flex"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --source) source_install=true; shift ;;
    --version|--sha256|--archive|--prefix)
      [[ $# -ge 2 && -n "$2" ]] || fail "missing value for $1"
      case "$1" in
        --version) version="$2" ;;
        --sha256) digest="$2" ;;
        --archive) archive="$2" ;;
        --prefix) prefix="$2" ;;
      esac
      shift 2 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[[ -n "$version$digest$archive" ]] || source_install=true
if "$source_install"; then
  [[ -z "$version$digest$archive" ]] || fail '--source cannot be combined with --version, --sha256, or --archive'
  for dependency in git node npm; do
    command -v "$dependency" >/dev/null 2>&1 || fail "$dependency is required for --source"
  done
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 12) || major >= 24 ? 0 : 1)' ||
    fail 'source installs require Node 22.12+ on the 22.x line, or Node 24+'
else
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$ ]] || fail 'provide a release version such as v0.1.0'
  [[ "$digest" =~ ^[[:xdigit:]]{64}$ ]] || fail 'provide a trusted 64-character SHA-256 digest'
fi
[[ "$prefix" == /* && "$prefix" != / ]] || fail '--prefix must be an absolute non-root directory'
command -v python3 >/dev/null 2>&1 || fail 'Python 3 is required'
case "$(uname -s)" in
  Linux) platform=linux ;;
  Darwin) platform=darwin ;;
  *) fail 'unsupported OS; use a supported Linux or macOS environment' ;;
esac
case "$(uname -m)" in
  x86_64|amd64) architecture=x86_64 ;;
  arm64|aarch64) architecture=aarch64 ;;
  *) fail 'unsupported CPU architecture' ;;
esac
if "$source_install"; then
  :
elif [[ -n "$archive" ]]; then
  [[ -f "$archive" ]] || fail 'local archive does not exist'
else
  command -v curl >/dev/null 2>&1 || fail 'curl is required for downloads'
fi
# Resolve the parent directories (a home directory reached through a symlink is common), then reject a symlinked
# prefix or installation component before writing.
prefix=$(python3 - "$prefix" <<'PY'
import os, pathlib, sys
absolute = os.path.abspath(sys.argv[1])
p = pathlib.Path(os.path.realpath(os.path.dirname(absolute))) / os.path.basename(absolute)
if p == pathlib.Path('/'):
    sys.exit('flexx installer: cannot install into /')
if p.is_symlink():
    sys.exit('flexx installer: the installation directory must not be a symlink')
if p.exists() and not p.is_dir():
    sys.exit('flexx installer: the installation directory exists and is not a directory')
for child in ('versions', 'bin', 'current'):
    target = p / child
    if child != 'current' and target.is_symlink():
        sys.exit('flexx installer: installation directories must not be symlinks')
    if child != 'current' and target.exists() and not target.is_dir():
        sys.exit(f'flexx installer: {child} exists and is not a directory')
    if child == 'current' and target.exists() and not target.is_symlink():
        sys.exit('flexx installer: current exists and is not an installer symlink')
    if child == 'current' and target.is_symlink():
        link = pathlib.PurePosixPath(os.readlink(target))
        if len(link.parts) != 2 or link.parts[0] != 'versions' or link.parts[1] in ('.', '..'):
            sys.exit('flexx installer: refusing to replace an unrelated current symlink')
launcher = p / 'bin/flexx'
if os.path.lexists(launcher) and not (launcher.is_symlink() and os.readlink(launcher) == '../current/bin/flexx'):
    sys.exit('flexx installer: refusing to replace an unrelated bin/flexx')
print(p)
PY
)
mkdir -p "$prefix"
lock="$prefix/.install-lock"
if ! mkdir "$lock" 2>/dev/null; then
  [[ -e "$lock" ]] && fail 'another install holds .install-lock; inspect it before removing a stale lock'
  fail "cannot create files in $prefix"
fi
staging=''
cleanup() {
  # Only remove this invocation's private staging directory and empty lock.
  python3 - "$staging" "$lock" <<'PY'
import pathlib, shutil, sys
if sys.argv[1]:
    shutil.rmtree(sys.argv[1])
pathlib.Path(sys.argv[2]).rmdir()
PY
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if "$source_install"; then
  [[ ! -e "$prefix/current" && ! -L "$prefix/current" ]] ||
    fail 'Flexx is already installed here; source installs never replace an existing installation or its configuration'
else
  [[ ! -e "$prefix/versions/$version" && ! -L "$prefix/versions/$version" ]] || fail 'version already installed; existing releases are never overwritten'
fi
staging=$(mktemp -d "$prefix/.install.XXXXXXXX")
if "$source_install"; then
  printf 'Building Flexx from source for the current user...\n'
  git clone --depth 1 --branch master -- https://github.com/0xr10t/Flex.git "$staging/payload" || fail 'could not download Flexx source'
  revision=$(git -C "$staging/payload" rev-parse HEAD)
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || fail 'could not identify the downloaded source revision'
  version="source-$revision"
  [[ ! -e "$prefix/versions/$version" && ! -L "$prefix/versions/$version" ]] || fail 'source revision already installed; existing files are never overwritten'
  (
    cd "$staging/payload" || exit 1
    npm ci --include=dev || exit 1
    npm --prefix wallet ci --include=dev || exit 1
    npm --prefix wallet/cre/autopay ci --include=dev || exit 1
    npm run testnet:build || exit 1
  ) || fail 'source build failed; check Node, npm and native build tools above; nothing activated'
  # The settings file flexx reads; umask 077 keeps it private.
  cp "$staging/payload/.env.example" "$staging/payload/.env" || fail 'the downloaded source has no .env.example'
  mkdir -p "$staging/payload/bin"
  cat > "$staging/payload/bin/flexx" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
# Resolve both the public launcher and current symlinks, including on macOS.
launcher="${BASH_SOURCE[0]}"
while [[ -L "$launcher" ]]; do
  directory=$(cd -P "$(dirname "$launcher")" && pwd)
  launcher=$(readlink "$launcher")
  [[ "$launcher" == /* ]] || launcher="$directory/$launcher"
done
root=$(cd -P "$(dirname "$launcher")/.." && pwd)
cd "$root"
exec node "$root/dist/src/cli/main.js" "$@"
LAUNCHER
  chmod 700 "$staging/payload/bin/flexx"
else
if [[ -z "$archive" ]]; then
  archive="$staging/release.tar.gz"
  asset="flex-$version-$platform-$architecture.tar.gz"
  printf 'Downloading %s from GitHub Releases...\n' "$asset"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 600 --retry 2 \
    "https://github.com/0xr10t/Flex/releases/download/$version/$asset" --output "$archive" ||
    fail "could not download $asset; check that release $version is published for this platform"
fi
python3 - "$archive" "$digest" "$staging/payload" <<'PY'
import hashlib, pathlib, shutil, sys, tarfile, zlib
archive, digest, destination = sys.argv[1:]
root = pathlib.Path(destination)
try:
    h = hashlib.sha256()
    with open(archive, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            h.update(chunk)
    if h.hexdigest() != digest.lower():
        sys.exit('flexx installer: SHA-256 mismatch; nothing activated')
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        seen = set()
        # Validate the whole archive before writing any payload file.
        for member in members:
            path = pathlib.PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or '\\' in member.name:
                sys.exit('flexx installer: unsafe archive path')
            if not (member.isfile() or member.isdir()):
                sys.exit('flexx installer: archive links and special files are forbidden')
            if path in seen:
                sys.exit('flexx installer: duplicate archive path')
            seen.add(path)
        for member in members:
            target = root / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o700 if member.mode & 0o111 else 0o600)
except (tarfile.TarError, EOFError, zlib.error) as error:
    sys.exit(f'flexx installer: archive is not a readable .tar.gz ({error})')
except OSError as error:
    sys.exit(f'flexx installer: could not unpack the archive ({error})')
launcher = root / 'bin/flexx'
if not launcher.is_file() or not launcher.stat().st_mode & 0o111:
    sys.exit('flexx installer: release must contain executable bin/flexx')
PY
fi
python3 - "$staging/payload/bin/flexx" <<'PY' || fail 'release smoke check failed; previous version remains active'
import os, signal, subprocess, sys
try:
    limit = int(os.environ.get('FLEX_INSTALL_SMOKE_TIMEOUT', '60'))  # seconds; the variable exists for the tests
    if limit < 1:
        raise ValueError()
except ValueError:
    sys.exit('flexx installer: smoke timeout must be a positive number of seconds')
# A process group of its own, so a hung check and anything it started can be stopped together.
try:
    check = subprocess.Popen([sys.argv[1], '--version'], stdin=subprocess.DEVNULL, start_new_session=True)
except OSError as error:
    sys.exit(f'flexx installer: cannot run bin/flexx ({error})')
try:
    code = check.wait(timeout=limit)
except subprocess.TimeoutExpired:
    code = None
except KeyboardInterrupt:
    code = 130
finally:
    try:
        os.killpg(check.pid, signal.SIGKILL)
    except OSError:
        pass
if code is None:
    sys.exit(f'flexx installer: release smoke check did not finish within {limit} seconds')
sys.exit(code)
PY
python3 - "$staging" "$prefix" "$version" <<'PY'
import os, pathlib, sys
stage, root, version = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
(root / 'versions').mkdir(exist_ok=True)
(root / 'bin').mkdir(exist_ok=True)
os.rename(stage / 'payload', root / 'versions' / version)
launcher = root / 'bin/flexx'
if not os.path.lexists(launcher):
    launcher.symlink_to('../current/bin/flexx')
link = stage / 'current'
link.symlink_to('versions/' + version)
os.replace(link, root / 'current')
PY
printf '\nInstalled Flexx %s in %s\n' "$version" "$prefix"
printf 'Add this directory to your PATH: %s/bin\n' "$prefix"
printf 'No shell files, configuration, or services were changed.\n'
printf 'Run: %q --help\n' "$prefix/bin/flexx"
if "$source_install"; then
  printf '\nNext:\n'
  printf '  1. Add your testnet RPC URLs to %q\n' "$prefix/current/.env"
  printf '  2. Run flexx. The first run connects MetaMask and finishes setup.\n'
fi
}
main "$@"
