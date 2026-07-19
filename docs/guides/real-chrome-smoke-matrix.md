# Exact-Package Real-Chrome Smoke Matrix

This runbook verifies the eleven final reliability rows against one expanded
GitHub Actions package. It is an operator procedure, not evidence that any row
has passed. A row is green only when its production action, expected assertion,
redacted evidence, and cleanup all pass against the same `release_commit` and
`package_sha256`.

Do not load the repository or worktree as the extension. Chrome must load only
`unpacked_dir` from the mode-0600 release-state file. Do not shorten production
timeouts, add a test hook, change the manifest key/OAuth client, install a model,
or replace a live Drive/Prompt assertion with a mock. An OAuth identity mismatch,
unavailable Prompt model, CORS failure, or infrastructure timeout blocks release.

## Evidence and safety rules

- Use only synthetic fixture titles and URLs. Close unrelated tabs before each
  row; never record browsing history or screenshots of a personal profile.
- Enter passphrases, API keys, and Google credentials only in Chrome UI. Never
  put them in a shell command, DevTools snippet, release state, PID ledger,
  terminal log, screenshot, or release note.
- Never record OAuth/access tokens, authorization headers, prompts containing
  private data, Drive file IDs or bodies, encrypted credential fields, or raw
  portable exports. Record only synthetic labels, counts, booleans, safe typed
  error text, versions, hashes, elapsed time, and cleanup results.
- DevTools snippets below return redacted summaries. Do not expand returned
  objects, preserve a Network HAR, or capture the DevTools request headers.
- Every browser, Xvfb, and fixture process started here is appended immediately
  to `matrix_pid_file`, one numeric PID per line. Named paths and PIDs are also
  appended to `release_state`, so a fresh shell can continue or clean up.
- A disposable directory is removed only after its resolved path matches its
  documented `/tmp/tabkebab-*` prefix. Never point a cleanup variable at the
  repository, parent checkout, or a normal Chrome profile.
- Stop at the first failed row, perform that row's cleanup plus the guarded
  matrix cleanup, record the blocker, and create no GitHub release. A product
  repair consumes a new patch version and restarts CI, artifact download, and
  all eleven rows.

## 1. Source and exact-artifact preflight

Run from the release repository in every fresh shell. The controller must have
already created the release-state file, downloaded the unique CI artifact, and
appended `artifact_dir`, `unpacked_dir`, `notes_file`, `matrix_pid_file`,
`zip_path`, and `package_sha256`.

```bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
current_version="$(tr -d '\r\n' < VERSION)"
release_state="/tmp/tabkebab-release-state-$current_version.env"
test -O "$release_state"
test "$(stat -c '%a' "$release_state")" = 600
# Controller-generated with printf %q, mode 0600.
# shellcheck disable=SC1090
source "$release_state"

test "$release_version" = "$current_version"
test "$release_commit" = "$(git rev-parse HEAD)"
test "$release_commit" = "$(git rev-parse main)"
test -d "$artifact_dir"
test -d "$unpacked_dir"
test -s "$zip_path"
test -s "$unpacked_dir/manifest.json"
test -O "$notes_file" && test "$(stat -c '%a' "$notes_file")" = 600
test -O "$matrix_pid_file" && test "$(stat -c '%a' "$matrix_pid_file")" = 600

computed_package_sha256="$(sha256sum "$zip_path" | awk '{print $1}')"
test "$computed_package_sha256" = "$package_sha256"
test "$(jq -r .version "$unpacked_dir/manifest.json")" = "$release_version"
expected_extension_id='cgfnjdcioainbclbbihglaopbhikhdob'
derived_extension_id="$(bun - "$unpacked_dir/manifest.json" <<'BUN'
import { createHash } from 'node:crypto';
const manifest = await Bun.file(Bun.argv[2]).json();
if (typeof manifest.key !== 'string' || manifest.key.length === 0) process.exit(1);
const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest();
const alphabet = 'abcdefghijklmnop';
let id = '';
for (const byte of digest.subarray(0, 16)) id += alphabet[byte >> 4] + alphabet[byte & 15];
process.stdout.write(id);
BUN
)"
test "$derived_extension_id" = "$expected_extension_id"

mapfile -t expected_top < <(printf '%s\n' core icons manifest.json service-worker.js sidepanel)
mapfile -t actual_top < <(
  find "$unpacked_dir" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort
)
test "$(printf '%s\n' "${actual_top[@]}")" = "$(printf '%s\n' "${expected_top[@]}")"

# Reject absolute, parent-traversing, or backslash archive names and symlinks.
zipinfo -1 "$zip_path" | awk '
  /^\// || /(^|\/)\.\.(\/|$)/ || /\\/ { bad = 1 }
  END { exit bad }
'
test -z "$(find "$unpacked_dir" -type l -print -quit)"
unpacked_real="$(realpath "$unpacked_dir")"
while IFS= read -r -d '' entry; do
  entry_real="$(realpath -m "$entry")"
  case "$entry_real" in
    "$unpacked_real"|"$unpacked_real"/*) ;;
    *) echo "Archive entry escaped unpacked_dir" >&2; exit 1 ;;
  esac
done < <(find "$unpacked_dir" -mindepth 1 -print0)

for repository_only in .git .github coverage docs store tests package.cmd \
  README.md GUIDE.md ARCHITECTURE.md PRIVACY.md CONTRIBUTING.md CHANGELOG.md \
  PROGRESS.md VERSION bunfig.toml package.json package-lock.json bun.lock bun.lockb; do
  test ! -e "$unpacked_dir/$repository_only"
done

printf 'source_commit=%s\npackage_sha256=%s\npackage_version=%s\n' \
  "$release_commit" "$package_sha256" "$release_version"
```

Failure here is a package/CI failure, not a browser row failure. Do not launch
Chrome.

## 2. Persistent matrix state, process helpers, and loopback pages

The commands below create one mode-0700 helper and one loopback-only page/AI
fixture under `/tmp`. The fixture never logs a request URL, prompt, body, or
header. It provides synthetic pages, an eight-second Focus classification, and
an immediate natural-language close parse. Row 9 deliberately does **not** use
this fixture; it uses the committed hanging fixture.

Choose an already installed Chrome binary. Do not download a browser during the
matrix. A different browser may be selected for Row 8 only if its path,
version, and SHA-256 replace the three browser identity values in the state
file before that row starts.

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
current_version="$(tr -d '\r\n' < VERSION)"
release_state="/tmp/tabkebab-release-state-$current_version.env"
test -O "$release_state" && test "$(stat -c '%a' "$release_state")" = 600
source "$release_state"

chrome_bin="${TABKEBAB_CHROME_BIN:-/home/michel/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome}"
test -x "$chrome_bin"
for tool in bun curl jq Xvfb xauth mcookie; do command -v "$tool" >/dev/null; done
chrome_version="$($chrome_bin --version)"
chrome_sha256="$(sha256sum "$chrome_bin" | awk '{print $1}')"
os_label="$(uname -srvmo)"
baseline_chrome_bin="$chrome_bin"
baseline_chrome_version="$chrome_version"
baseline_chrome_sha256="$chrome_sha256"
baseline_os_label="$os_label"
expected_extension_id='cgfnjdcioainbclbbihglaopbhikhdob'
umask 077
matrix_lib="$(mktemp /tmp/tabkebab-matrix-lib.XXXXXX.sh)"
matrix_fixture_script="$(mktemp /tmp/tabkebab-matrix-pages.XXXXXX.js)"
matrix_fixture_log="$(mktemp /tmp/tabkebab-matrix-pages.XXXXXX.log)"
for private_file in "$matrix_lib" "$matrix_fixture_script" "$matrix_fixture_log"; do
  test -O "$private_file" && test -f "$private_file" && test ! -L "$private_file"
  test "$(stat -c '%a' "$private_file")" = 600
done
{
  printf 'repo_root=%q\n' "$(pwd -P)"
  printf 'chrome_bin=%q\n' "$chrome_bin"
  printf 'chrome_version=%q\n' "$chrome_version"
  printf 'chrome_sha256=%q\n' "$chrome_sha256"
  printf 'os_label=%q\n' "$os_label"
  printf 'baseline_chrome_bin=%q\n' "$baseline_chrome_bin"
  printf 'baseline_chrome_version=%q\n' "$baseline_chrome_version"
  printf 'baseline_chrome_sha256=%q\n' "$baseline_chrome_sha256"
  printf 'baseline_os_label=%q\n' "$baseline_os_label"
  printf 'expected_extension_id=%q\n' "$expected_extension_id"
  printf 'matrix_lib=%q\n' "$matrix_lib"
  printf 'matrix_fixture_script=%q\n' "$matrix_fixture_script"
  printf 'matrix_fixture_log=%q\n' "$matrix_fixture_log"
} >> "$release_state"

cat > "$matrix_lib" <<'MATRIX_LIB'
set -Eeuo pipefail

matrix_append_state() {
  local key="$1" value="$2"
  [[ "$key" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]
  printf '%s=%q\n' "$key" "$value" >> "$release_state"
}

matrix_record_pid() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 ))
  printf '%s\n' "$pid" >> "$matrix_pid_file"
}

matrix_process_tree() {
  local root="$1" current child index=0
  local -a queue=("$root")
  [[ "$root" =~ ^[0-9]+$ ]] && (( root > 1 ))
  while (( index < ${#queue[@]} )); do
    current="${queue[$index]}"
    index=$((index + 1))
    printf '%s\n' "$current"
    while IFS= read -r child; do
      child="${child//[[:space:]]/}"
      test -z "$child" && continue
      [[ "$child" =~ ^[0-9]+$ ]] && (( child > 1 ))
      queue+=("$child")
    done < <(ps -o pid= --ppid "$current" 2>/dev/null || true)
  done
}

matrix_record_tree() {
  local root="$1" pid
  while IFS= read -r pid; do
    matrix_record_pid "$pid"
  done < <(matrix_process_tree "$root")
}

matrix_pid_starttime() {
  local pid="$1" stat_line stat_tail
  [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 ))
  test -r "/proc/$pid/stat" || return 1
  stat_line="$(< "/proc/$pid/stat")"
  stat_tail="${stat_line##*) }"
  set -- $stat_tail
  test "$#" -ge 20
  printf '%s\n' "${20}"
}

matrix_pid_identity_matches() {
  local pid="$1" expected_starttime="$2" actual_starttime
  actual_starttime="$(matrix_pid_starttime "$pid" 2>/dev/null || true)"
  test -n "$actual_starttime" && test "$actual_starttime" = "$expected_starttime"
}

matrix_pid_ppid() {
  local pid="$1" stat_line stat_tail
  [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 ))
  test -r "/proc/$pid/stat" || return 1
  stat_line="$(< "/proc/$pid/stat")"
  stat_tail="${stat_line##*) }"
  set -- $stat_tail
  test "$#" -ge 2
  printf '%s\n' "${2}"
}

matrix_capture_owned_tree() {
  local root="$1" profile="$2" pid starttime cmdline current current_start child child_start child_ppid index=0
  local -a queue_pids=() queue_starts=()
  [[ "$root" =~ ^[0-9]+$ ]] && (( root > 1 ))
  kill -0 "$root" 2>/dev/null || return 0
  cmdline="$(tr '\0' ' ' < "/proc/$root/cmdline" 2>/dev/null || true)"
  [[ "$cmdline" == *"--user-data-dir=$profile"* ]] || return 1
  starttime="$(matrix_pid_starttime "$root")" || return 1
  queue_pids+=("$root"); queue_starts+=("$starttime")
  while (( index < ${#queue_pids[@]} )); do
    current="${queue_pids[$index]}"; current_start="${queue_starts[$index]}"
    index=$((index + 1))
    matrix_pid_identity_matches "$current" "$current_start" || continue
    printf '%s:%s\n' "$current" "$current_start"
    while IFS= read -r child; do
      child="${child//[[:space:]]/}"
      test -n "$child" || continue
      [[ "$child" =~ ^[0-9]+$ ]] && (( child > 1 )) || return 1
      child_start="$(matrix_pid_starttime "$child" 2>/dev/null || true)"
      test -n "$child_start" || continue
      child_ppid="$(matrix_pid_ppid "$child" 2>/dev/null || true)"
      test "$child_ppid" = "$current" || continue
      queue_pids+=("$child"); queue_starts+=("$child_start")
    done < <(ps -o pid= --ppid "$current" 2>/dev/null || true)
  done
}

matrix_start_browser() {
  local label="$1" profile="$2"
  [[ "$label" =~ ^row[0-9]{2}[a-z]?$ ]]
  case "$(realpath -m "$profile")" in
    /tmp/tabkebab-smoke-*) ;;
    *) echo "Unsafe profile path: $profile" >&2; return 1 ;;
  esac
  mkdir -p "$profile"
  chmod 700 "$profile"

  local log_dir chrome_log display_value display_number xvfb_pid=''
  local xauthority_file=''
  log_dir="$(mktemp -d "/tmp/tabkebab-${label}-logs.XXXXXX")"
  chrome_log="$log_dir/chrome.log"
  display_value="${DISPLAY:-}"
  matrix_append_state "${label}_profile" "$profile"
  matrix_append_state "${label}_log_dir" "$log_dir"

  if test -z "$display_value"; then
    xauthority_file="$log_dir/Xauthority"
    : > "$xauthority_file"
    chmod 600 "$xauthority_file"
    matrix_append_state "${label}_xauthority" "$xauthority_file"
    for display_number in $(seq 91 151); do
      : > "$xauthority_file"
      xauth -f "$xauthority_file" add ":$display_number" . "$(mcookie)"
      matrix_append_state "${label}_display" ":$display_number.0"
      Xvfb ":$display_number" -screen 0 1280x900x24 \
        -nolisten tcp -auth "$xauthority_file" > "$log_dir/xvfb.log" 2>&1 &
      xvfb_pid=$!
      matrix_record_pid "$xvfb_pid"
      matrix_append_state "${label}_xvfb_pid" "$xvfb_pid"
      sleep 0.3
      if kill -0 "$xvfb_pid" 2>/dev/null; then
        display_value=":$display_number.0"
        break
      fi
      wait "$xvfb_pid" 2>/dev/null || true
      xvfb_pid=''
    done
    if test -z "$display_value"; then
      matrix_stop_browser "$label" no || true
      echo "Unable to start a private Xvfb display" >&2
      return 1
    fi
  fi
  matrix_append_state "${label}_display" "$display_value"
  matrix_append_state "${label}_xauthority" "$xauthority_file"
  matrix_append_state "${label}_xvfb_pid" "$xvfb_pid"

  local -a display_env=("DISPLAY=$display_value")
  if test -n "$xauthority_file"; then display_env+=("XAUTHORITY=$xauthority_file"); fi
  env "${display_env[@]}" "$chrome_bin" \
    --user-data-dir="$profile" \
    --disable-extensions-except="$unpacked_dir" \
    --load-extension="$unpacked_dir" \
    --remote-debugging-port=0 \
    --remote-debugging-address=127.0.0.1 \
    --remote-allow-origins='*' \
    --no-first-run \
    --no-default-browser-check \
    --disable-component-update \
    --disable-sync \
    '--host-resolver-rules=MAP matrix.test 127.0.0.1, MAP *.matrix.test 127.0.0.1, MAP notmatrix.test 127.0.0.1, MAP matrix.test.invalid 127.0.0.1' \
    chrome://extensions/ > "$chrome_log" 2>&1 &
  local chrome_pid=$!
  matrix_record_pid "$chrome_pid"
  matrix_append_state "${label}_chrome_pid" "$chrome_pid"

  local ready=0
  for _ in $(seq 1 200); do
    if test -s "$profile/DevToolsActivePort" && kill -0 "$chrome_pid" 2>/dev/null; then
      ready=1
      break
    fi
    sleep 0.1
  done
  if test "$ready" -ne 1; then
    matrix_stop_browser "$label" no || true
    echo "Chrome DevTools endpoint did not become ready for $label" >&2
    return 1
  fi
  local devtools_port
  devtools_port="$(head -n 1 "$profile/DevToolsActivePort" 2>/dev/null || true)"
  if [[ ! "$devtools_port" =~ ^[0-9]+$ ]]; then
    matrix_stop_browser "$label" no || true
    echo "Invalid DevTools port for $label" >&2
    return 1
  fi

  # Record the browser parent and every currently observable Chrome descendant.
  matrix_record_tree "$chrome_pid"
  local browser_tree_records
  browser_tree_records="$(matrix_capture_owned_tree "$chrome_pid" "$profile")" || return 1
  browser_tree_records="$(LC_ALL=C sort -u <<< "$browser_tree_records")"
  matrix_append_state "${label}_browser_tree_records" "$browser_tree_records"

  matrix_append_state "${label}_devtools_port" "$devtools_port"
}

matrix_set_download_dir() {
  local label="$1" download_dir="$2"
  [[ "$label" =~ ^row[0-9]{2}[a-z]?$ ]]
  case "$(realpath -m "$download_dir")" in
    /tmp/tabkebab-row*-downloads.*) ;;
    *) echo "Unsafe download path: $download_dir" >&2; return 1 ;;
  esac
  mkdir -p "$download_dir"
  chmod 700 "$download_dir"
  matrix_append_state "${label}_download_dir" "$download_dir"
  source "$release_state"
  local port_var="${label}_devtools_port" port="${!port_var:-}"
  [[ "$port" =~ ^[0-9]+$ ]]
  bun - "$port" "$download_dir" <<'BUN'
const port = Bun.argv[2];
const downloadPath = Bun.argv[3];
const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
if (!version.webSocketDebuggerUrl) throw new Error('Browser CDP endpoint unavailable');
await new Promise((resolve, reject) => {
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  const timer = setTimeout(() => reject(new Error('CDP download setup timed out')), 5_000);
  socket.onopen = () => socket.send(JSON.stringify({
    id: 1,
    method: 'Browser.setDownloadBehavior',
    params: { behavior: 'allow', downloadPath, eventsEnabled: true },
  }));
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    socket.close();
    if (message.error) reject(new Error(message.error.message));
    else resolve();
  };
  socket.onerror = () => reject(new Error('CDP download setup failed'));
});
BUN
}

matrix_stop_browser() {
  local label="$1" keep_profile="${2:-no}"
  [[ "$label" =~ ^row[0-9]{2}[a-z]?$ ]]
  source "$release_state"
  local profile_var="${label}_profile" log_var="${label}_log_dir"
  local chrome_var="${label}_chrome_pid"
  local xvfb_var="${label}_xvfb_pid"
  local display_var="${label}_display" xauthority_var="${label}_xauthority"
  local download_var="${label}_download_dir"
  local records_var="${label}_browser_tree_records"
  local profile="${!profile_var:-}" log_dir="${!log_var:-}"
  local chrome_pid="${!chrome_var:-}" xvfb_pid="${!xvfb_var:-}"
  local display_value="${!display_var:-}" xauthority_file="${!xauthority_var:-}"
  local download_dir="${!download_var:-}" cmdline=''
  local stored_records="${!records_var:-}" record pid starttime root
  test -n "$profile" || return 0
  case "$(realpath -m "$profile")" in
    /tmp/tabkebab-smoke-*) ;;
    *) echo "Refusing unsafe profile cleanup: $profile" >&2; return 1 ;;
  esac

  declare -A owned_starttimes=()
  for record in $stored_records; do
    pid="${record%%:*}"; starttime="${record#*:}"
    [[ "$pid" =~ ^[0-9]+$ && "$starttime" =~ ^[0-9]+$ ]] || return 1
    owned_starttimes["$pid"]="$starttime"
  done

  # A root is owned only when its exact profile argument matches. At that point
  # capture every descendant's immutable PID/starttime identity; renderer and
  # GPU descendants do not necessarily repeat --user-data-dir.
  local -a owned_roots=()
  if [[ "$chrome_pid" =~ ^[0-9]+$ ]] && (( chrome_pid > 1 )) && kill -0 "$chrome_pid" 2>/dev/null; then
    owned_roots+=("$chrome_pid")
  fi
  while IFS= read -r root; do
    test -n "$root" || continue
    [[ "$root" =~ ^[0-9]+$ ]] || return 1
    owned_roots+=("$root")
  done < <(pgrep -f -- "--user-data-dir=$profile" 2>/dev/null || true)
  for root in "${owned_roots[@]}"; do
    local captured_tree
    captured_tree="$(matrix_capture_owned_tree "$root" "$profile")" || return 1
    while IFS=: read -r pid starttime; do
      test -n "$pid" || continue
      owned_starttimes["$pid"]="$starttime"
      matrix_record_pid "$pid"
    done <<< "$captured_tree"
  done

  stored_records=''
  for pid in "${!owned_starttimes[@]}"; do
    stored_records+="${pid}:${owned_starttimes[$pid]} "
  done
  matrix_append_state "$records_var" "${stored_records% }"

  for pid in "${!owned_starttimes[@]}"; do
    if matrix_pid_identity_matches "$pid" "${owned_starttimes[$pid]}"; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  for _ in $(seq 1 100); do
    local survivor=0
    for pid in "${!owned_starttimes[@]}"; do
      matrix_pid_identity_matches "$pid" "${owned_starttimes[$pid]}" && survivor=1
    done
    test "$survivor" -eq 0 && break
    sleep 0.1
  done
  for pid in "${!owned_starttimes[@]}"; do
    if matrix_pid_identity_matches "$pid" "${owned_starttimes[$pid]}"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  for _ in $(seq 1 50); do
    local survivor=0
    for pid in "${!owned_starttimes[@]}"; do
      matrix_pid_identity_matches "$pid" "${owned_starttimes[$pid]}" && survivor=1
    done
    test "$survivor" -eq 0 && break
    sleep 0.1
  done
  for pid in "${!owned_starttimes[@]}"; do
    if matrix_pid_identity_matches "$pid" "${owned_starttimes[$pid]}"; then
      echo "Recorded Chrome process identity did not exit: $pid:${owned_starttimes[$pid]}" >&2
      return 1
    fi
  done
  if test -n "$(pgrep -f -- "--user-data-dir=$profile" 2>/dev/null || true)"; then
    echo "Owned Chrome root remained after recorded-tree shutdown: $profile" >&2
    return 1
  fi
  if [[ "$chrome_pid" =~ ^[0-9]+$ ]]; then wait "$chrome_pid" 2>/dev/null || true; fi

  if test -n "$xvfb_pid" && kill -0 "$xvfb_pid" 2>/dev/null; then
    cmdline="$(tr '\0' ' ' < "/proc/$xvfb_pid/cmdline" 2>/dev/null || true)"
    local expected_display="${display_value%.0}"
    case "$(realpath -m "$xauthority_file")" in "$log_dir"/Xauthority) ;; *) return 1 ;; esac
    [[ "$cmdline" == *"Xvfb $expected_display "* ]] || return 1
    [[ "$cmdline" == *"-auth $xauthority_file"* ]] || return 1
    kill -TERM "$xvfb_pid"
    for _ in $(seq 1 50); do
      kill -0 "$xvfb_pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$xvfb_pid" 2>/dev/null; then
      cmdline="$(tr '\0' ' ' < "/proc/$xvfb_pid/cmdline" 2>/dev/null || true)"
      [[ "$cmdline" == *"Xvfb $expected_display "* ]] || return 1
      [[ "$cmdline" == *"-auth $xauthority_file"* ]] || return 1
      kill -KILL "$xvfb_pid" 2>/dev/null || true
      for _ in $(seq 1 50); do
        kill -0 "$xvfb_pid" 2>/dev/null || break
        sleep 0.1
      done
    fi
    if kill -0 "$xvfb_pid" 2>/dev/null; then
      echo "Owned Xvfb did not exit: $xvfb_pid" >&2
      return 1
    fi
    wait "$xvfb_pid" 2>/dev/null || true
  fi

  if test -n "$log_dir"; then
    case "$(realpath -m "$log_dir")" in
      /tmp/tabkebab-row*-logs.*) rm -rf -- "$log_dir" ;;
      *) echo "Refusing unsafe log cleanup: $log_dir" >&2; return 1 ;;
    esac
  fi
  if test "$keep_profile" = no; then
    if test -n "$download_dir"; then
      case "$(realpath -m "$download_dir")" in
        /tmp/tabkebab-row*-downloads.*) rm -rf -- "$download_dir" ;;
        *) echo "Refusing unsafe download cleanup: $download_dir" >&2; return 1 ;;
      esac
    fi
    rm -rf -- "$profile"
    test ! -e "$profile" || return 1
  else
    test "$keep_profile" = yes
    test -d "$profile" || return 1
  fi
}

matrix_record_row() {
  local row="$1" profiles="$2" setup="$3" action="$4" expected="$5" actual="$6" result="$7" cleanup="$8"
  [[ "$row" =~ ^(0[1-9]|1[01])$ ]]
  [[ "$result" = PASS || "$result" = FAIL || "$result" = BLOCKED ]]
  ! grep -q "^### Matrix row $row — " "$notes_file"
  [[ "$actual" == observed:* ]]
  case "${actual,,}" in
    *redacted*|*placeholder*|*tbd*|*todo*|*true/false*)
      echo "Actual evidence contains a placeholder token" >&2
      return 1
      ;;
  esac
  for value in "$profiles" "$setup" "$action" "$expected" "$actual" "$cleanup"; do
    [[ "$value" != *$'\n'* && "$value" != *'|'* ]]
  done
  {
    printf '\n### Matrix row %s — %s\n\n' "$row" "$result"
    printf -- '- OS: `%s`\n' "$os_label"
    printf -- '- Chrome: `%s`\n' "$chrome_version"
    printf -- '- Chrome binary SHA-256: `%s`\n' "$chrome_sha256"
    printf -- '- Release commit: `%s`\n' "$release_commit"
    printf -- '- Package SHA-256: `%s`\n' "$package_sha256"
    printf -- '- Disposable profile paths: `%s`\n' "$profiles"
    printf -- '- Setup: %s\n' "$setup"
    printf -- '- Production action: %s\n' "$action"
    printf -- '- Expected: %s\n' "$expected"
    printf -- '- Actual and redacted evidence: %s\n' "$actual"
    printf -- '- Result: **%s**\n' "$result"
    printf -- '- Cleanup: %s\n' "$cleanup"
  } >> "$notes_file"
}

matrix_read_outcome() {
  local row="$1" actual_var="$2" result_var="$3" actual result attestation=''
  [[ "$row" =~ ^(0[1-9]|1[01])$ ]]
  [[ "$actual_var" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]
  [[ "$result_var" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]
  read -r -p "Row $row result (PASS, FAIL, or BLOCKED): " result
  [[ "$result" = PASS || "$result" = FAIL || "$result" = BLOCKED ]]
  read -r -p "Row $row redacted actual evidence (must begin observed:): " actual
  [[ "$actual" == observed:* && ${#actual} -ge 20 ]]
  case "${actual,,}" in
    *redacted*|*placeholder*|*tbd*|*todo*|*true/false*) return 1 ;;
  esac
  if test "$result" = PASS; then
    read -r -p "Type PASS $row $package_sha256 to attest exact-package observation: " attestation
    test "$attestation" = "PASS $row $package_sha256"
  fi
  printf -v "$actual_var" '%s' "$actual"
  printf -v "$result_var" '%s' "$result"
}

matrix_record_failure() {
  matrix_record_row "$@"
}

matrix_begin_row() {
  local row="$1" profiles="$2"
  [[ "$row" =~ ^(0[1-9]|1[01])$ ]]
  [[ "$profiles" != *$'\n'* && "$profiles" != *'|'* ]]
  source "$release_state"
  test -z "${active_row:-}"
  matrix_append_state active_row "$row"
  matrix_append_state active_profiles "$profiles"
  matrix_append_state active_cleanup_status pending
  source "$release_state"
}

matrix_end_row() {
  local row="$1"
  source "$release_state"
  test "${active_row:-}" = "$row"
  matrix_append_state active_row ''
  matrix_append_state active_profiles ''
  matrix_append_state active_cleanup_status complete
  source "$release_state"
}

matrix_emergency_cleanup() {
  trap - ERR INT TERM
  set +e
  source "$release_state" 2>/dev/null || true
  local label pid cmdline profile_var profile_path keep_profile cleanup_failed=0
  for label in row01 row02 row03 row04 row05 row06a row06b row07 row08 row09 row10 row11; do
    profile_var="${label}_profile"
    profile_path="${!profile_var:-}"
    test -n "$profile_path" && test -e "$profile_path" || continue
    keep_profile=no
    if [[ "$label" = row06a || "$label" = row06b ]]; then keep_profile=yes; fi
    matrix_stop_browser "$label" "$keep_profile" || cleanup_failed=1
  done
  if [[ "${row09_fixture_pid:-}" =~ ^[0-9]+$ ]] && kill -0 "$row09_fixture_pid" 2>/dev/null; then
    cmdline="$(tr '\0' ' ' < "/proc/$row09_fixture_pid/cmdline" 2>/dev/null || true)"
    if test -n "${row09_fixture_script:-}" && [[ "$cmdline" == *"$row09_fixture_script"* ]]; then
      kill -TERM "$row09_fixture_pid"
      for _ in $(seq 1 50); do kill -0 "$row09_fixture_pid" 2>/dev/null || break; sleep 0.1; done
      if kill -0 "$row09_fixture_pid" 2>/dev/null; then
        kill -KILL "$row09_fixture_pid"
        for _ in $(seq 1 50); do kill -0 "$row09_fixture_pid" 2>/dev/null || break; sleep 0.1; done
      fi
    else cleanup_failed=1
    fi
    if kill -0 "$row09_fixture_pid" 2>/dev/null; then cleanup_failed=1; fi
  fi
  if [[ "${matrix_fixture_pid:-}" =~ ^[0-9]+$ ]] && kill -0 "$matrix_fixture_pid" 2>/dev/null; then
    cmdline="$(tr '\0' ' ' < "/proc/$matrix_fixture_pid/cmdline" 2>/dev/null || true)"
    if [[ "$cmdline" == *"${matrix_fixture_script:-/no-match}"* ]]; then
      kill -TERM "$matrix_fixture_pid"
      for _ in $(seq 1 50); do kill -0 "$matrix_fixture_pid" 2>/dev/null || break; sleep 0.1; done
      if kill -0 "$matrix_fixture_pid" 2>/dev/null; then
        kill -KILL "$matrix_fixture_pid"
        for _ in $(seq 1 50); do kill -0 "$matrix_fixture_pid" 2>/dev/null || break; sleep 0.1; done
      fi
    else cleanup_failed=1
    fi
    if kill -0 "$matrix_fixture_pid" 2>/dev/null; then cleanup_failed=1; fi
  fi
  if test -n "${portable_file:-}"; then
    case "$(realpath -m "$portable_file")" in /tmp/tabkebab-row0*-export.*.json) rm -f -- "$portable_file" ;; esac
  fi
  if test "$cleanup_failed" -eq 0 && test -n "${row09_fixture_log:-}"; then
    case "$(realpath -m "$row09_fixture_log")" in /tmp/tabkebab-row09-hanging.*.log) rm -f -- "$row09_fixture_log" ;; esac
  fi
  if test "$cleanup_failed" -eq 0 && test -n "${row09_fixture_script:-}"; then
    case "$(realpath -m "$row09_fixture_script")" in /tmp/tabkebab-row09-hanging.*.js) rm -f -- "$row09_fixture_script" ;; esac
  fi
  local helper preserve_matrix_lib=no
  if test -d "${row06a_profile:-}" || test -d "${row06b_profile:-}"; then
    preserve_matrix_lib=yes
  fi
  if test -n "${active_row:-}"; then preserve_matrix_lib=yes; fi
  if test -n "${active_row:-}"; then
    if test "$cleanup_failed" -eq 0; then
      matrix_append_state active_cleanup_status complete || cleanup_failed=1
    else
      matrix_append_state active_cleanup_status failed || true
    fi
  fi
  if test "$cleanup_failed" -eq 0; then
    for helper in "${matrix_fixture_script:-}" "${matrix_fixture_log:-}"; do
      test -n "$helper" || continue
      case "$(realpath -m "$helper")" in /tmp/tabkebab-matrix-*) rm -f -- "$helper" ;; esac
    done
  fi
  if test "$cleanup_failed" -eq 0 && test "$preserve_matrix_lib" = no && test -n "${matrix_lib:-}"; then
    case "$(realpath -m "$matrix_lib")" in /tmp/tabkebab-matrix-*) rm -f -- "$matrix_lib" ;; esac
  fi
  if test "$cleanup_failed" -ne 0; then
    echo "Emergency cleanup could not prove every owned process dead; guarded paths and helper retained" >&2
  fi
}

matrix_finalize_failure() {
  trap - ERR INT TERM
  set -Eeuo pipefail
  source "$release_state"
  local row="${active_row:-}" profiles="${active_profiles:-}"
  [[ "$row" =~ ^(0[1-9]|1[01])$ ]]
  test "$row" != 06 || {
    echo 'Row 06 requires its remote/pre-auth cleanup branch, not the generic finalizer' >&2
    return 1
  }
  matrix_emergency_cleanup
  set -Eeuo pipefail
  source "$release_state"
  test "$active_cleanup_status" = complete
  local actual result
  matrix_read_outcome "$row" actual result
  [[ "$result" = FAIL || "$result" = BLOCKED ]]
  matrix_record_failure "$row" "$profiles" \
    "exact Row $row setup against its disposable exact-artifact profile" \
    "row stopped at its first failed or blocked assertion before the normal recorder" \
    "all documented Row $row production assertions pass" \
    "$actual" "$result" \
    'emergency cleanup proved owned processes dead and removed the disposable profile'
  matrix_end_row "$row"
  case "$(realpath -m "$matrix_lib")" in
    /tmp/tabkebab-matrix-*) rm -f -- "$matrix_lib" ;;
    *) echo 'Unsafe matrix helper cleanup path' >&2; return 1 ;;
  esac
  exit 1
}

matrix_fail_cleanup() {
  local status="$1"
  matrix_emergency_cleanup
  exit "$status"
}

trap 'matrix_fail_cleanup $?' ERR
trap 'matrix_fail_cleanup 130' INT TERM
MATRIX_LIB
chmod 700 "$matrix_lib"

cat > "$matrix_fixture_script" <<'MATRIX_FIXTURE'
const counters = { pages: 0, focus: 0, focusActive: 0, nl: 0, generic: 0 };
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (value, status = 200) => Response.json(value, { status, headers });
const completion = (value) => json({
  choices: [{ message: { content: JSON.stringify(value) } }],
  usage: { total_tokens: 1 },
});
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 30,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method === 'GET' && url.pathname === '/metrics') return json(counters);
    if (request.method === 'GET' && url.pathname.endsWith('/models')) {
      return json({ data: [{ id: 'matrix-fixture' }] });
    }
    if (request.method === 'POST' && url.pathname === '/focus/v1/chat/completions') {
      counters.focus += 1;
      counters.focusActive += 1;
      try {
        await Bun.sleep(8_000);
        return completion({ distraction: true, category: 'matrix fixture', confidence: 0.99 });
      } finally {
        counters.focusActive -= 1;
      }
    }
    if (request.method === 'POST' && url.pathname === '/nl/v1/chat/completions') {
      counters.nl += 1;
      return completion({
        action: 'close',
        filter: { domain: 'matrix.test' },
        confirmation: 'Close Matrix fixture tabs?',
      });
    }
    if (request.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      counters.generic += 1;
      return completion({ ok: true });
    }
    counters.pages += 1;
    const label = url.pathname.replace(/[^a-zA-Z0-9_-]/g, ' ').trim().slice(0, 80) || 'fixture';
    return new Response(`<!doctype html><meta charset="utf-8"><title>${label}</title><p>TabKebab synthetic matrix page</p>`, {
      headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
});
const stop = async () => { await server.stop(true); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
console.log(JSON.stringify({ ready: true, baseUrl: `http://127.0.0.1:${server.port}` }));
MATRIX_FIXTURE
chmod 600 "$matrix_fixture_script"

source "$matrix_lib"
bun "$matrix_fixture_script" > "$matrix_fixture_log" 2>&1 &
matrix_fixture_pid="$!"
matrix_record_pid "$matrix_fixture_pid"
for _ in $(seq 1 100); do
  jq -e '.ready == true' "$matrix_fixture_log" >/dev/null 2>&1 && break
  kill -0 "$matrix_fixture_pid" 2>/dev/null
  sleep 0.1
done
fixture_base_url="$(jq -er .baseUrl "$matrix_fixture_log")"
[[ "$fixture_base_url" =~ ^http://127\.0\.0\.1:[0-9]+$ ]]
fixture_port="${fixture_base_url##*:}"
matrix_append_state matrix_fixture_pid "$matrix_fixture_pid"
matrix_append_state fixture_base_url "$fixture_base_url"
matrix_append_state fixture_port "$fixture_port"

printf 'chrome=%s\nchrome_sha256=%s\nos=%s\nfixture=%s\n' \
  "$chrome_version" "$chrome_sha256" "$os_label" "$fixture_base_url"
```

When `DISPLAY` is unset, the helper starts Xvfb and records its PID. Manual UI
steps then require the operator's established CDP/remote-viewing channel. The
same production controls may be driven through CDP, but a driver must not patch
extension APIs, add init scripts that change product behavior, or load any path
other than `unpacked_dir`. Failure to create a local X11 socket is a blocker;
never work around it by exposing Xvfb over TCP. The helper uses a mode-0600
Xauthority cookie and does not disable X access control. Its error, interrupt,
and termination traps stop every recorded browser/fixture and remove guarded
profiles/downloads, so a failed or blocked row does not depend on the all-PASS
completion block for cleanup. The sole exception is Row 06: its authenticated
profiles are stopped but deliberately preserved until the operator deletes the
throwaway Drive folder and disconnects both profiles using Row 06's exact
cleanup procedure; only then may those two guarded profiles be removed.

If any shell assertion fails before a row's normal outcome prompt, the trap
records the active row and cleanup status while retaining `release_state` and
`matrix_lib`. For Rows 01-05 and 07-11, run this in a fresh shell; it refuses
Row 06 because that row must use its remote/pre-auth cleanup branch. A failed
cleanup must be repaired and the command rerun before blocker evidence can be
recorded:

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
release_state="/tmp/tabkebab-release-state-$(tr -d '\r\n' < VERSION).env"
test -O "$release_state" && test "$(stat -c '%a' "$release_state")" = 600
source "$release_state"; source "$matrix_lib"
matrix_finalize_failure
```

The Row 01 setup below starts the first browser before it captures the extension
ID. Every later profile must show the same extension ID and version before testing.
If it does not, the artifact identity check fails.

## 3. Eleven-row matrix

Use a fresh disposable profile for each row unless a row explicitly preserves
one across a restart. At the end of each row, finish its explicit cleanup, then
call `matrix_record_row` with only the permitted redacted values. A `BLOCKED` or
`FAIL` result still requires cleanup before it is recorded and stops the matrix.

### Row 01 — complete and forced-partial stash restoration

**Setup.** Start a fresh browser and open the production panel document.

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
release_state="/tmp/tabkebab-release-state-$(tr -d '\r\n' < VERSION).env"
source "$release_state"; source "$matrix_lib"
row01_profile="$(mktemp -d /tmp/tabkebab-smoke-r01.XXXXXX)"
matrix_append_state row01_profile "$row01_profile"
matrix_begin_row 01 "$row01_profile"
matrix_start_browser row01 "$row01_profile"
source "$release_state"
read -r -p 'Artifact TabKebab extension ID shown on chrome://extensions: ' extension_id
[[ "$extension_id" =~ ^[a-p]{32}$ ]]
test "$extension_id" = "$expected_extension_id"
matrix_append_state extension_id "$extension_id"
printf 'chrome-extension://%s/sidepanel/panel.html\n' "$extension_id"
```

Before entering the ID, open `chrome://extensions`, enable Developer mode, and
verify exactly one TabKebab card shows `release_version` and loaded path
`unpacked_dir`. Copy the ID as text without taking a screenshot.

In the panel DevTools console, import two synthetic stash records through the
production worker. Substitute only the numeric `fixture_port` from state:

```js
const port = Number('FIXTURE_PORT_FROM_RELEASE_STATE');
const exportedAt = new Date().toISOString();
const result = await chrome.runtime.sendMessage({
  action: 'importPortableData',
  document: {
    version: 2,
    kind: 'stashes',
    exportedAt,
    stashes: [
      {
        id: 'matrix-r01-complete', name: 'Matrix complete', createdAt: Date.now(), tabCount: 2,
        windows: [{ tabCount: 2, tabs: [
          { title: 'Matrix complete one', url: `http://matrix.test:${port}/r01-complete-one` },
          { title: 'Matrix complete two', url: `http://matrix.test:${port}/r01-complete-two` },
        ] }],
      },
      {
        id: 'matrix-r01-partial', name: 'Matrix partial', createdAt: Date.now() + 1, tabCount: 2,
        windows: [{ tabCount: 2, tabs: [
          { title: 'Matrix partial valid', url: `http://matrix.test:${port}/r01-partial-valid` },
          { title: 'Matrix partial forbidden', url: 'chrome://settings/' },
        ] }],
      },
    ],
  },
});
({ imported: result.imported, skipped: result.skipped });
```

In **Settings**, enable **Remove stash after restore**. In **Stash**, restore
`Matrix complete`, then `Matrix partial`, using the production **Restore**
buttons.

**Assertions.** The complete toast reports exactly two restored tabs and its
source disappears. The partial toast reports `1 of 2`, zero duplicates, one
invalid, zero failed, and `Stash kept for recovery.` The partial stash remains
with its original two-tab count; retrying it after closing the first restored
tab gives the same recoverable result. Any deleted partial source, shifted tab
metadata, uncaught error, or different count fails the row.

Record only the counts and retention boolean, then close the synthetic tabs:

```bash
source "$release_state"; source "$matrix_lib"
matrix_stop_browser row01 no
matrix_read_outcome 01 row_actual row_result
matrix_record_row 01 "$row01_profile" \
  'two imported synthetic stashes; remove-after-restore enabled' \
  'restore complete, then forbidden-URL partial, through production Stash UI' \
  'complete=2/2 and removed; partial=1/2, invalid=1, errors=0 and retained unchanged' \
  "$row_actual" "$row_result" 'fixture tabs closed; no private data captured; profile removed'
matrix_end_row 01
test "$row_result" = PASS
```

### Row 02 — session/stash audio safety before and after discard

**Setup.** Start `row02` exactly as Row 01 with
`/tmp/tabkebab-smoke-r02.XXXXXX`. In the panel DevTools console, substitute only
the numeric `fixture_port` and import this exact secret-free full fixture through
the production worker:

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
release_state="/tmp/tabkebab-release-state-$(tr -d '\r\n' < VERSION).env"
source "$release_state"; source "$matrix_lib"
row02_profile="$(mktemp -d /tmp/tabkebab-smoke-r02.XXXXXX)"
matrix_append_state row02_profile "$row02_profile"
matrix_begin_row 02 "$row02_profile"
matrix_start_browser row02 "$row02_profile"
source "$release_state"
```

```js
const port = Number('FIXTURE_PORT_FROM_RELEASE_STATE');
const now = Date.now();
const importResult = await chrome.runtime.sendMessage({
  action: 'importPortableData',
  document: {
    version: 2,
    kind: 'full',
    exportedAt: new Date(now).toISOString(),
    sessions: [{
      id: 'matrix-r02-session', name: 'Matrix audio session', version: 2,
      createdAt: now, modifiedAt: now,
      windows: [{ tabCount: 2, tabs: [
        { title: 'Matrix session visible', url: `http://matrix.test:${port}/r02-session-visible` },
        { title: 'Matrix session background', url: `http://matrix.test:${port}/r02-session-background` },
      ] }],
    }],
    stashes: [{
      id: 'matrix-r02-stash', name: 'Matrix audio stash', createdAt: now + 1, tabCount: 2,
      windows: [{ tabCount: 2, tabs: [
        { title: 'Matrix stash visible', url: `http://matrix.test:${port}/r02-stash-visible` },
        { title: 'Matrix stash background', url: `http://matrix.test:${port}/r02-stash-background` },
      ] }],
    }],
    manualGroups: {},
    keepAwakeDomains: [],
    bookmarks: [],
    settings: {},
    focusProfilePrefs: {},
    focusHistory: [],
    aiSettings: { enabled: false, providerId: null, providerConfigs: {} },
  },
});
({ imported: importResult.imported, skipped: importResult.skipped });
```

Run each restore through the production worker twice: once with
`discarded: false`, close those restored tabs, then once with `discarded: true`.
Use `mode: 'windows'` so the first created tab is the visible tab. This console
probe returns no URLs, titles, or tab IDs and closes each isolated restore after
capturing Chrome's authoritative state:

```js
async function restoreAndSummarize(message) {
  const before = new Set((await chrome.tabs.query({})).map(({ id }) => id));
  const outcome = await chrome.runtime.sendMessage(message);
  const created = (await chrome.tabs.query({})).filter(({ id }) => !before.has(id));
  const summary = {
    outcome: {
      requested: outcome.requestedCount,
      restored: outcome.restoredCount,
      duplicate: outcome.skippedDuplicate,
      invalid: outcome.skippedInvalid,
      errors: outcome.errors?.length,
      complete: outcome.complete,
    },
    tabState: created.map(({ active, discarded, mutedInfo }) => ({
      active, discarded, muted: mutedInfo?.muted === true,
    })),
  };
  await chrome.tabs.remove(created.map(({ id }) => id));
  return summary;
}
const audioResults = [];
for (const discarded of [false, true]) {
  audioResults.push({
    source: 'session', discarded,
    result: await restoreAndSummarize({
      action: 'restoreSession', sessionId: 'matrix-r02-session',
      options: { mode: 'windows', discarded },
    }),
  });
  audioResults.push({
    source: 'stash', discarded,
    result: await restoreAndSummarize({
      action: 'restoreStash', stashId: 'matrix-r02-stash', deleteAfterRestore: false,
      options: { mode: 'windows', discarded },
    }),
  });
}
audioResults;
```

**Assertions.** Both non-discarding restores return complete exact counts and
every restored tab is unmuted and not discarded. Both discarding restores keep
the visible active tab unmuted/not discarded; every background tab is unmuted
after the discard attempt, whether its final `discarded` state is true or Chrome
declines the discard. No tab remains muted after settlement.

Record four count summaries plus `mutedAfter=0` and the visible-tab boolean.
Close the created windows/tabs, then:

```bash
source "$release_state"; source "$matrix_lib"
matrix_stop_browser row02 no
matrix_read_outcome 02 row_actual row_result
matrix_record_row 02 "$row02_profile" \
  'one two-tab synthetic session and stash; non-discard and discard cases isolated' \
  'restore both sources through the production worker with discarded false, then true' \
  'session/stash non-discard and discard settle with zero muted tabs; visible tab active and unmuted' \
  "$row_actual" "$row_result" 'all synthetic windows closed; profile removed'
matrix_end_row 02
test "$row_result" = PASS
```

### Row 03 — Focus delayed authority, strict policy, exact URL, and group rebinding

**Setup.** Start `row03` with `/tmp/tabkebab-smoke-r03.XXXXXX`. In **AI
Settings**, select **Custom**, set the base URL to
`$fixture_base_url/focus/v1`, model `matrix-fixture`, leave the key empty, save,
and pass **Test Connection**. Do not paste a key. Open the Focus view.

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
release_state="/tmp/tabkebab-release-state-$(tr -d '\r\n' < VERSION).env"
source "$release_state"; source "$matrix_lib"
row03_profile="$(mktemp -d /tmp/tabkebab-smoke-r03.XXXXXX)"
matrix_append_state row03_profile "$row03_profile"
matrix_begin_row 03 "$row03_profile"
matrix_start_browser row03 "$row03_profile"
source "$release_state"
```

**Delayed classification actions.** Enable **AI blocking**, choose a
non-destructive fixture action only if the UI requires one, and start a run.
For each of the pause, end, and pause→resume subcases, first capture the current
counter in a terminal, perform the named UI setup, and press Enter immediately:

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
focus_before="$(curl --fail --silent "$fixture_base_url/metrics" | jq -er .focus)"
matrix_append_state focus_before "$focus_before"
printf 'Start the subcase and open its unique fixture URL, then press Enter immediately.\n'
read -r
deadline=$((SECONDS + 8))
while (( SECONDS < deadline )); do
  focus_metrics="$(curl --fail --silent "$fixture_base_url/metrics")"
  if test "$(jq -r .focus <<< "$focus_metrics")" -eq "$((focus_before + 1))" &&
     test "$(jq -r .focusActive <<< "$focus_metrics")" -eq 1; then
    break
  fi
  sleep 0.1
done
test "$(jq -r .focus <<< "$focus_metrics")" -eq "$((focus_before + 1))"
test "$(jq -r .focusActive <<< "$focus_metrics")" -eq 1
printf 'Pending classification proven; perform the named Pause/End action now.\n'
```

Do not perform the authority-changing action until that exact `focus + 1` and
`focusActive == 1` proof succeeds. For the pause subcase, open
`http://pause.matrix.test:$fixture_port/pause`, click **Pause**, then after ten
seconds require the tab, URL, run ID, paused status, zero distraction-count
change, and paused badge to remain. End that run. Repeat the whole counter proof
with a unique `end.matrix.test` URL and click **End Session** before settlement;
require the ended run cannot mutate the tab or a replacement run. Repeat once
more for pause→resume; resuming within the proven delay must not restore the old
request's authority. After each subcase, require `focusActive == 0` and the
counter remains exactly `focus_before + 1` before starting the next one:

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
sleep 10
focus_metrics="$(curl --fail --silent "$fixture_base_url/metrics")"
test "$(jq -r .focus <<< "$focus_metrics")" -eq "$((focus_before + 1))"
test "$(jq -r .focusActive <<< "$focus_metrics")" -eq 0
```

**Strict and exact actions.** Disable AI blocking. With strict mode enabled and
an empty allowlist, open `http://strict.matrix.test:$fixture_port/blocked`; it
must be rejected while Focus has zero allowed tabs. Add the exact URL
`http://matrix.test:$fixture_port/exact`, start again, and prove that URL remains
while `http://matrix.test:$fixture_port/exact/child` is rejected. Prefix matching
is a failure.

**Group/restart actions.** Create two Chrome groups titled exactly
`Matrix Exact Group`, add that title once to the Focus allowlist, start and
pause. Record only the old runtime-ID count. Fully stop Chrome but preserve the
profile, then relaunch the same artifact/profile:

```bash
source "$release_state"; source "$matrix_lib"
matrix_stop_browser row03 yes
matrix_start_browser row03 "$row03_profile"
source "$release_state"
```

If the old groups survived, ungroup their synthetic tabs, then create two new
groups with the same exact title. Resume the paused run. In the panel DevTools
console, return only this redacted summary:

```js
const { focusState, focusProfilePrefs } = await chrome.storage.local.get([
  'focusState', 'focusProfilePrefs',
]);
const live = (await chrome.tabGroups.query({}))
  .filter(({ title }) => title === 'Matrix Exact Group');
const groupEntry = focusState?.allowedDomains?.find((entry) =>
  entry?.type === 'group' && entry.value === 'Matrix Exact Group');
({
  status: focusState?.status,
  runtimeIdCount: groupEntry?.groupIds?.length ?? 0,
  runtimeMatchesLive: JSON.stringify([...(groupEntry?.groupIds ?? [])].sort((a, b) => a - b)) ===
    JSON.stringify(live.map(({ id }) => id).sort((a, b) => a - b)),
  staleScalarPresent: Object.hasOwn(groupEntry ?? {}, 'groupId'),
  profileContainsNumericId: JSON.stringify(focusProfilePrefs ?? {}).includes('"groupId"'),
});
```

**Assertions.** All delayed results are no-ops after their captured authority is
lost. Strict-empty rejects; the exact URL remains and its prefix extension does
not. After a complete browser restart, runtime IDs equal both and only current
same-title groups, the stale scalar is absent, and profile preferences remain
title-only.

End Focus, ungroup/close fixture tabs, then record and remove the profile.

```bash
source "$release_state"; source "$matrix_lib"
matrix_stop_browser row03 no
matrix_read_outcome 03 row_actual row_result
matrix_record_row 03 "$row03_profile" \
  'keyless delayed fixture, strict/exact fixtures, and two same-title Chrome groups' \
  'pause/end/resume during classification; exercise strict/exact policy; restart and resume group run' \
  'delayed pause/end/resume no-op; strict-empty; exact URL; two exact-title groups rebound after restart' \
  "$row_actual" "$row_result" 'Focus ended; fixture groups/tabs closed; restarted browser stopped; profile removed'
matrix_end_row 03
test "$row_result" = PASS
```

### Row 04 — duplicate cleanup and lossless Undo

Start `row04` with `/tmp/tabkebab-smoke-r04.XXXXXX`. Open exactly two copies of
each synthetic URL:

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
release_state="/tmp/tabkebab-release-state-$(tr -d '\r\n' < VERSION).env"
source "$release_state"; source "$matrix_lib"
row04_profile="$(mktemp -d /tmp/tabkebab-smoke-r04.XXXXXX)"
matrix_append_state row04_profile "$row04_profile"
matrix_begin_row 04 "$row04_profile"
matrix_start_browser row04 "$row04_profile"
source "$release_state"
```

```text
http://matrix.test:FIXTURE_PORT/r04/ordinary
http://matrix.test:FIXTURE_PORT/r04/route#/one
http://matrix.test:FIXTURE_PORT/r04/route#/two
```

In **Duplicates**, click **Scan for Duplicates**. Require three independent
groups of two with one selected copy per group. Click **Close All Duplicates**;
require exact multiplicities `1,1,1`. Click the eight-second **Undo** toast;
require exact multiplicities `2,2,2`. The two fragments must never collapse
into one identity. Use count-only `chrome.tabs.query()` summaries; do not record
the full tab list.

Close all six fixtures, then:

```bash
source "$release_state"; source "$matrix_lib"
matrix_stop_browser row04 no
matrix_read_outcome 04 row_actual row_result
matrix_record_row 04 "$row04_profile" \
  'two copies each of one ordinary URL and two distinct fragment routes' \
  'scan, Close All Duplicates, then invoke the production Undo toast' \
  'three exact duplicate groups; close counts 1,1,1; Undo counts 2,2,2' \
  "$row_actual" "$row_result" 'all duplicate fixture tabs closed; profile removed'
matrix_end_row 04
test "$row_result" = PASS
```

### Row 05 — natural-language close host boundary

Start `row05` with `/tmp/tabkebab-smoke-r05.XXXXXX`. Configure the keyless
Custom provider at `$fixture_base_url/nl/v1`, model `matrix-fixture`, and pass
**Test Connection**. Open one tab for each host:

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
release_state="/tmp/tabkebab-release-state-$(tr -d '\r\n' < VERSION).env"
source "$release_state"; source "$matrix_lib"
row05_profile="$(mktemp -d /tmp/tabkebab-smoke-r05.XXXXXX)"
matrix_append_state row05_profile "$row05_profile"
matrix_begin_row 05 "$row05_profile"
matrix_start_browser row05 "$row05_profile"
source "$release_state"
```

```text
http://matrix.test:FIXTURE_PORT/r05/exact
http://docs.matrix.test:FIXTURE_PORT/r05/subdomain
http://notmatrix.test:FIXTURE_PORT/r05/lookalike
http://matrix.test.invalid:FIXTURE_PORT/r05/sibling
```

Enter `close the Matrix fixture tabs` in the production natural-language
command bar. The synthetic endpoint returns a domain filter for `matrix.test`;
this tests the product's live preview boundary, not model quality.

**Assertions.** The preview-approved ID set contains exactly the exact host and
true subdomain and excludes both lookalikes. The confirmation count is two.
Click **Cancel** and require all four tabs remain. Optionally repeat and confirm;
only the exact/subdomain pair may close. Any suffix/substring acceptance or
expansion between preview and confirmation fails the row.

Close remaining fixtures and record only acceptance booleans/counts:

```bash
source "$release_state"; source "$matrix_lib"
matrix_stop_browser row05 no
matrix_read_outcome 05 row_actual row_result
matrix_record_row 05 "$row05_profile" \
  'keyless NL fixture plus exact, subdomain, suffix-lookalike, and sibling-lookalike tabs' \
  'submit close command to production command bar, inspect preview, and cancel' \
  'preview exact=true, subdomain=true, two lookalikes=false; confirmation cannot expand' \
  "$row_actual" "$row_result" 'all NL fixture tabs closed; provider held no credential; profile removed'
matrix_end_row 05
test "$row_result" = PASS
```

### Row 06 — Drive migration/convergence/retention and full portable transfer

This is a live OAuth/Drive gate. It cannot pass with CDP-fulfilled Google
responses. The two Chrome profiles use distinct user-data directories and
operator labels A/B, but must authenticate the **same Google account** and use
the **same** unique `driveProfileName`/Drive folder. Different Drive folder
names do not test convergence.

Create the two profiles using these exact constructors:

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
release_state="/tmp/tabkebab-release-state-$(tr -d '\r\n' < VERSION).env"
source "$release_state"; source "$matrix_lib"
profile_a="$(mktemp -d /tmp/tabkebab-smoke-a.XXXXXX)"
profile_b="$(mktemp -d /tmp/tabkebab-smoke-b.XXXXXX)"
drive_profile_name="Matrix-${release_version//./-}-${package_sha256:0:12}"
[[ "$drive_profile_name" =~ ^[a-zA-Z0-9_-]{1,50}$ ]]
matrix_append_state row06a_profile "$profile_a"
matrix_append_state row06b_profile "$profile_b"
matrix_begin_row 06 "$profile_a,$profile_b"
matrix_append_state drive_profile_name "$drive_profile_name"
matrix_append_state row06_production_connect_succeeded no
matrix_append_state row06_drive_scope_created no
matrix_append_state row06_remote_cleanup_required no
matrix_append_state row06_cleanup_proof ''
matrix_append_state row06_local_cleanup_proof ''
matrix_start_browser row06a "$profile_a"
matrix_start_browser row06b "$profile_b"
source "$release_state"
row06_download_dir="$(mktemp -d /tmp/tabkebab-row06-downloads.XXXXXX)"
matrix_set_download_dir row06a "$row06_download_dir"
source "$release_state"
printf 'Shared throwaway Drive profile: %s\n' "$drive_profile_name"
```

In each browser, verify the exact artifact ID/version. Connect **A first** from
the production **Google Drive** settings UI, authenticate the account, and
enter the exact shared `drive_profile_name`. Wait for A to show **Connected**
and for its production settings lookup to settle, then attest that first
successful profile-folder proof in a terminal:

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
read -r -p "Type ROW06_A_CONNECTED $drive_profile_name after production Connect A succeeds: " row06_connect_attestation
test "$row06_connect_attestation" = "ROW06_A_CONNECTED $drive_profile_name"
matrix_append_state row06_production_connect_succeeded yes
matrix_append_state row06_drive_scope_created yes
matrix_append_state row06_remote_cleanup_required yes
source "$release_state"
```

Only then connect B to the same account and exact `drive_profile_name`. Give the
local operator labels `Matrix A` and `Matrix B`; do not use those labels as
different Drive folders.

There is one narrow pre-authentication failure branch. If and only if A's first
Connect attempt returns the safe Chrome identity/OAuth rejection before ever
showing **Connected**, do not attempt B. Record the safe identity error and
generated extension ID, plus `oauthTokenIssued=false` and
`productionConnectSucceeded=false`; remote cleanup is `notRequired` because no
authenticated Drive request could run. For every other failure after attempting
Connect A—including any failure after A connected, or a rejection while
connecting B—set `row06_remote_cleanup_required=yes` and use the guarded remote
cleanup below. Do not load the repository path, change `manifest.json`, replace
its key, reuse a normal signed profile, or call a different OAuth client.

**v1 migration setup.** First click **Sync Now** in A so the app creates its
own canonical file. Then, in A's panel DevTools, run the following credential-
safe IIFE. Replace `SHARED_DRIVE_PROFILE_NAME` with the exact synthetic value.
It keeps the token and Drive IDs in lexical memory, writes one synthetic v1
canonical document, and returns counts/booleans only:

```js
await (async (profileName) => {
  const token = await new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (value) => {
      const error = chrome.runtime.lastError;
      if (error || typeof value !== 'string' || !value) reject(new Error(error?.message || 'OAuth token unavailable'));
      else resolve(value);
    });
  });
  const auth = { Authorization: `Bearer ${token}` };
  const list = async (q) => {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', q);
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('pageSize', '2');
    url.searchParams.set('fields', 'files(id,name)');
    const response = await fetch(url, { headers: auth });
    if (!response.ok) throw new Error(`Drive setup list failed: ${response.status}`);
    return (await response.json()).files;
  };
  const one = async (q, label) => {
    const files = await list(q);
    if (files.length !== 1) throw new Error(`${label} count was ${files.length}`);
    return files[0];
  };
  const esc = (value) => value.replaceAll("'", "\\'");
  const root = await one("name='TabKebab' and 'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false", 'root');
  const profile = await one(`name='${esc(profileName)}' and '${root.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'profile');
  const canonical = await one(`name='tabkebab-sync.json' and '${profile.id}' in parents and trashed=false`, 'canonical');
  const v1 = {
    version: 1,
    sessions: [{
      id: 'matrix-v1-session', name: 'Matrix v1 session', version: 2,
      createdAt: 1, modifiedAt: 1,
      windows: [{ tabCount: 1, tabs: [{ title: 'Matrix v1 tab', url: 'https://matrix.invalid/v1' }] }],
    }],
    manualGroups: {},
  };
  const response = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(canonical.id)}?uploadType=media`, {
    method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(v1),
  });
  if (!response.ok) throw new Error(`Drive v1 setup failed: ${response.status}`);
  return { canonicalCount: 1, wroteVersion: 1, sessionCount: 1, tokenExposed: false };
})('SHARED_DRIVE_PROFILE_NAME');
```

Click **Sync Now** in A. Inspect only local key names/counts and require
`matrix-v1-session` exists and both tombstone maps exist. Then run this remote
canonical inspector in A. It keeps the token and Drive IDs lexical and returns
only schema/count booleans, proving the production sync rewrote canonical v1 as
v2 rather than proving migration from local state alone:

```js
await (async (profileName) => {
  const token = await new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, (value) => {
      const error = chrome.runtime.lastError;
      if (error || typeof value !== 'string' || !value) reject(new Error(error?.message || 'OAuth token unavailable'));
      else resolve(value);
    });
  });
  const auth = { Authorization: `Bearer ${token}` };
  const list = async (q) => {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', q);
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('pageSize', '2');
    url.searchParams.set('fields', 'files(id,name)');
    const response = await fetch(url, { headers: auth });
    if (!response.ok) throw new Error(`Drive migration list failed: ${response.status}`);
    return (await response.json()).files;
  };
  const one = async (q, label) => {
    const files = await list(q);
    if (files.length !== 1) throw new Error(`${label} count was ${files.length}`);
    return files[0];
  };
  const esc = (value) => value.replaceAll("'", "\\'");
  const root = await one("name='TabKebab' and 'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false", 'root');
  const profile = await one(`name='${esc(profileName)}' and '${root.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'profile');
  const canonical = await one(`name='tabkebab-sync.json' and '${profile.id}' in parents and trashed=false`, 'canonical');
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(canonical.id)}?alt=media`, { headers: auth });
  if (!response.ok) throw new Error(`Drive migration read failed: ${response.status}`);
  const value = await response.json();
  const summary = {
    version: value.version,
    sessionPresent: value.sessions?.some(({ id }) => id === 'matrix-v1-session') === true,
    sessionTombstonesPresent: value.tombstones?.sessions && typeof value.tombstones.sessions === 'object',
    groupTombstonesPresent: value.tombstones?.manualGroups && typeof value.tombstones.manualGroups === 'object',
    tokenExposed: false,
    idExposed: false,
  };
  if (summary.version !== 2 || !summary.sessionPresent ||
      !summary.sessionTombstonesPresent || !summary.groupTombstonesPresent) {
    throw new Error('Remote canonical migration postcondition failed');
  }
  return summary;
})('SHARED_DRIVE_PROFILE_NAME');
```

Then baseline-sync B and A again. Both must contain the session before deletion.

**Deletion convergence action.** Delete `Matrix v1 session` in A, then perform
the exact order:

1. A **Sync Now**.
2. B **Sync Now**.
3. A **Sync Now** again.

On both profiles, this count-only probe must report absence plus a retained
tombstone:

```js
const state = await chrome.storage.local.get(['sessions', 'driveSyncTombstones']);
({
  sessionPresent: (state.sessions ?? []).some(({ id }) => id === 'matrix-v1-session'),
  sessionTombstonePresent: Number.isSafeInteger(state.driveSyncTombstones?.sessions?.['matrix-v1-session']),
  sessionCount: state.sessions?.length ?? 0,
});
```

**Retention action.** Create a new synthetic session in A and sync three times,
waiting at least two seconds between completed syncs, to create distinct
canonical archive names. In A's panel DevTools run this exact age setup. Replace
only `SHARED_DRIVE_PROFILE_NAME`; the token and IDs remain lexical and the
return value contains counts only. This setup uses the documented Drive
[`files.update`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update)
operation and writable
[`File.modifiedTime`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
field under the artifact's existing OAuth scope:

```js
await (async (profileName) => {
  const token = await new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (value) => {
      const error = chrome.runtime.lastError;
      if (error || typeof value !== 'string' || !value) reject(new Error(error?.message || 'OAuth token unavailable'));
      else resolve(value);
    });
  });
  const auth = { Authorization: `Bearer ${token}` };
  const list = async (q, fields = 'id,name,modifiedTime') => {
    const files = [];
    let pageToken = null;
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set('q', q);
      url.searchParams.set('spaces', 'drive');
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set('fields', `nextPageToken,files(${fields})`);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const response = await fetch(url, { headers: auth });
      if (!response.ok) throw new Error(`Drive age setup list failed: ${response.status}`);
      const page = await response.json();
      files.push(...page.files);
      pageToken = page.nextPageToken ?? null;
    } while (pageToken);
    return files;
  };
  const one = async (q, label) => {
    const values = await list(q, 'id,name');
    if (values.length !== 1) throw new Error(`${label} count was ${values.length}`);
    return values[0];
  };
  const esc = (value) => value.replaceAll("'", "\\'");
  const root = await one("name='TabKebab' and 'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false", 'root');
  const profile = await one(`name='${esc(profileName)}' and '${root.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'profile');
  const sessions = await one(`name='sessions' and '${profile.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'sessions');
  const stashes = await one(`name='stashes' and '${profile.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'stashes');
  const bookmarks = await one(`name='bookmarks' and '${profile.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'bookmarks');
  const archive = await one(`name='archive' and '${profile.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'archive');
  const create = async (parentId, name, content, mimeType) => {
    const boundary = `matrix-${crypto.randomUUID()}`;
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8', '',
      JSON.stringify({ name, parents: [parentId] }),
      `--${boundary}`,
      `Content-Type: ${mimeType}`, '', content,
      `--${boundary}--`, '',
    ].join('\r\n');
    const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!response.ok) throw new Error(`Drive retention seed failed: ${response.status}`);
    return response.json();
  };
  const age = async (file, modifiedTime) => {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?fields=id`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ modifiedTime }),
    });
    if (!response.ok) throw new Error(`Drive retention age update failed: ${response.status}`);
  };
  const seeded = [
    ['sessions', sessions.id, 'sessions-2020-01-01.json', 'sessions-2020-02-01.json', 'application/json', /^sessions-\d{4}-\d{2}-\d{2}\.json$/],
    ['stashes', stashes.id, 'stashes-2020-01-01.json', 'stashes-2020-02-01.json', 'application/json', /^stashes-\d{4}-\d{2}-\d{2}\.json$/],
    ['bookmarks-json', bookmarks.id, 'bookmarks-2020-01-01.json', 'bookmarks-2020-02-01.json', 'application/json', /^bookmarks-\d{4}-\d{2}-\d{2}\.json$/],
    ['bookmarks-html', bookmarks.id, 'bookmarks-2020-01-01.html', 'bookmarks-2020-02-01.html', 'text/html', /^bookmarks-\d{4}-\d{2}-\d{2}\.html$/],
    ['portable-export', profile.id, 'tabkebab-export-1577836800000.json', 'tabkebab-export-1580515200000.json', 'application/json', /^tabkebab-export-\d{13}\.json$/],
  ];
  const summary = [];
  for (const [category, parentId, oldName, newestName, mimeType, pattern] of seeded) {
    const content = mimeType === 'text/html' ? '<!doctype html><title>Matrix retention</title>' : '{}';
    await create(parentId, oldName, content, mimeType);
    await create(parentId, newestName, content, mimeType);
    const matches = (await list(`'${parentId}' in parents and trashed=false`))
      .filter(({ name }) => pattern.test(name));
    const intendedNewest = matches.filter(({ name }) => name === newestName);
    if (intendedNewest.length !== 1) throw new Error(`${category} intended-newest count was ${intendedNewest.length}`);
    for (const file of matches) {
      await age(file, file.id === intendedNewest[0].id
        ? '2020-02-01T00:00:00.000Z'
        : '2020-01-01T00:00:00.000Z');
    }
    summary.push({ category, eligibleOld: matches.length - 1, newestCount: 1, newestIsOld: true });
  }
  const profileFiles = await list(`'${profile.id}' in parents and trashed=false`);
  const canonical = profileFiles.filter(({ name }) => name === 'tabkebab-sync.json' || name === 'tabkebab-settings.json');
  if (canonical.length !== 2) throw new Error(`canonical count was ${canonical.length}`);
  for (const file of canonical) await age(file, '2020-01-15T00:00:00.000Z');
  const files = await list(`'${archive.id}' in parents and trashed=false`);
  const families = [
    ['archive-sync', /^tabkebab-sync-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/],
    ['archive-settings', /^tabkebab-settings-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/],
  ];
  for (const [category, pattern] of families) {
    const matches = files.filter(({ name }) => pattern.test(name))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    if (matches.length < 2) throw new Error(`${category} needs at least two copies`);
    const aged = matches.slice(0, -1);
    for (const file of aged) await age(file, '2020-01-01T00:00:00.000Z');
    await age(matches.at(-1), '2020-02-01T00:00:00.000Z');
    summary.push({ category, eligibleOld: aged.length, newestCount: 1, newestIsOld: true });
  }
  return { protectedOldCanonicals: 2, categories: summary, tokenExposed: false, idExposed: false };
})('SHARED_DRIVE_PROFILE_NAME');
```

Run **Clean Drive Files** with 30 days. Require:

- `tabkebab-sync.json` and `tabkebab-settings.json` remain;
- the one deliberately unique newest copy in each seeded category remains;
- the deliberately old non-newest archive is removed;
- unrelated/undated files, if any were intentionally seeded, remain; and
- the result has zero deletion errors.

If the environment cannot safely set and verify the synthetic file age, the
retention subcase is blocked; a filename with an old embedded date but a current
Drive `modifiedTime` is not valid deletion evidence.

After cleanup, run this count-only inspector with the same shared profile name.
It must report both deliberately old canonical files retained, zero old
non-newest copies, and one deliberately old-but-newest retained copy in every
seeded normal/archive category:

```js
await (async (profileName) => {
  const token = await new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, (value) => {
      const error = chrome.runtime.lastError;
      if (error || typeof value !== 'string' || !value) reject(new Error(error?.message || 'OAuth token unavailable'));
      else resolve(value);
    });
  });
  const auth = { Authorization: `Bearer ${token}` };
  const list = async (q, fields = 'id,name,modifiedTime') => {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', q);
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('fields', `files(${fields})`);
    const response = await fetch(url, { headers: auth });
    if (!response.ok) throw new Error(`Drive retention inspection failed: ${response.status}`);
    return (await response.json()).files;
  };
  const one = async (q, label) => {
    const values = await list(q, 'id,name');
    if (values.length !== 1) throw new Error(`${label} count was ${values.length}`);
    return values[0];
  };
  const esc = (value) => value.replaceAll("'", "\\'");
  const root = await one("name='TabKebab' and 'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false", 'root');
  const profile = await one(`name='${esc(profileName)}' and '${root.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'profile');
  const sessions = await one(`name='sessions' and '${profile.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'sessions');
  const stashes = await one(`name='stashes' and '${profile.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'stashes');
  const bookmarks = await one(`name='bookmarks' and '${profile.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'bookmarks');
  const archive = await one(`name='archive' and '${profile.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'archive');
  const profileFiles = await list(`'${profile.id}' in parents and trashed=false`);
  const sessionFiles = await list(`'${sessions.id}' in parents and trashed=false`);
  const stashFiles = await list(`'${stashes.id}' in parents and trashed=false`);
  const bookmarkFiles = await list(`'${bookmarks.id}' in parents and trashed=false`);
  const archiveFiles = await list(`'${archive.id}' in parents and trashed=false`);
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const summarize = (files, pattern) => {
    const values = files.filter(({ name }) => pattern.test(name));
    const times = values.map(({ modifiedTime }) => Date.parse(modifiedTime));
    const newest = Math.max(...times);
    return {
      count: values.length,
      oldEligible: times.filter((value) => value < cutoff && value !== newest).length,
      newestCount: times.filter((value) => value === newest).length,
      newestIsOld: newest < cutoff,
    };
  };
  const canonical = profileFiles.filter(({ name }) => name === 'tabkebab-sync.json' || name === 'tabkebab-settings.json');
  const summary = {
    canonicalCount: canonical.length,
    canonicalOldCount: canonical.filter(({ modifiedTime }) => Date.parse(modifiedTime) < cutoff).length,
    categories: {
      sessions: summarize(sessionFiles, /^sessions-\d{4}-\d{2}-\d{2}\.json$/),
      stashes: summarize(stashFiles, /^stashes-\d{4}-\d{2}-\d{2}\.json$/),
      bookmarksJson: summarize(bookmarkFiles, /^bookmarks-\d{4}-\d{2}-\d{2}\.json$/),
      bookmarksHtml: summarize(bookmarkFiles, /^bookmarks-\d{4}-\d{2}-\d{2}\.html$/),
      portableExport: summarize(profileFiles, /^tabkebab-export-\d{13}\.json$/),
      archiveSync: summarize(archiveFiles, /^tabkebab-sync-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/),
      archiveSettings: summarize(archiveFiles, /^tabkebab-settings-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/),
    },
    tokenExposed: false,
    idExposed: false,
  };
  if (summary.canonicalCount !== 2 || summary.canonicalOldCount !== 2) {
    throw new Error('Old canonical retention postcondition failed');
  }
  for (const value of Object.values(summary.categories)) {
    if (value.count !== 1 || value.oldEligible !== 0 ||
        value.newestCount !== 1 || !value.newestIsOld) {
      throw new Error('Old newest-copy retention postcondition failed');
    }
  }
  return summary;
})('SHARED_DRIVE_PROFILE_NAME');
```

The production cleanup result's `deleted` count must equal the sum of
`eligibleOld` from age setup unless another explicitly enumerated synthetic old
copy was seeded; `errors` must be empty.

**Full portable transfer action.** In A, import this exact secret-free document
through `importPortableData`, then export **full data** through the production
Sessions UI. This provides at least one synthetic record/value in every portable
section without putting a credential in the fixture:

```js
const now = Date.now();
const portableSetup = await chrome.runtime.sendMessage({
  action: 'importPortableData',
  document: {
    version: 2, kind: 'full', exportedAt: new Date(now).toISOString(),
    sessions: [{
      id: 'matrix-portable-session', name: 'Matrix portable session', version: 2,
      createdAt: now, modifiedAt: now,
      windows: [{ tabCount: 1, tabs: [{ title: 'Matrix portable tab', url: 'https://matrix.invalid/portable' }] }],
    }],
    stashes: [{
      id: 'matrix-portable-stash', name: 'Matrix portable stash', createdAt: now,
      tabCount: 1,
      windows: [{ tabCount: 1, tabs: [{ title: 'Matrix portable stash tab', url: 'https://matrix.invalid/stash' }] }],
    }],
    manualGroups: {
      'matrix-portable-group': {
        name: 'Matrix portable group', color: 'blue', createdAt: now, modifiedAt: now,
        tabUrls: ['https://matrix.invalid/group'],
      },
    },
    keepAwakeDomains: ['matrix.invalid'],
    bookmarks: [{
      id: 'matrix-portable-bookmark', date: '2026-07-19', time: '12:00 PM', createdAt: now,
      formats: { byWindows: [{ name: 'Matrix portable window', tabs: [{
        title: 'Matrix bookmark tab', url: 'https://matrix.invalid/bookmark',
      }] }] },
    }],
    settings: { theme: 'dark', maxTabsPerWindow: 50, recommendedTabsPerWindow: 20 },
    focusProfilePrefs: {
      coding: {
        blockedCategories: ['social'],
        allowlist: [{ type: 'domain', value: 'matrix.invalid' }],
        blockedDomains: [], strictMode: false, aiBlocking: false, duration: 25, tabAction: 'none',
      },
    },
    focusHistory: [{
      runId: 'matrix-portable-run', profileId: 'coding', startedAt: now, endedAt: now + 1,
    }],
    aiSettings: {
      enabled: true, providerId: 'custom',
      providerConfigs: { custom: { model: 'matrix-fixture', baseUrl: 'http://127.0.0.1:1/v1' } },
    },
  },
});
({ imported: portableSetup.imported, skipped: portableSetup.skipped, warningPresent: Boolean(portableSetup.warning) });
```

After the UI download completes, copy the unique physical download into a
mode-0600 guarded path and persist that path for fresh shells:

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
mapfile -t portable_downloads < <(
  find "$row06a_download_dir" -maxdepth 1 -type f -name 'tabkebab-export-*.json' -print
)
test "${#portable_downloads[@]}" -eq 1
portable_file="$(mktemp --suffix=.json /tmp/tabkebab-row06-export.XXXXXX)"
chmod 600 "$portable_file"
cp -- "${portable_downloads[0]}" "$portable_file"
rm -f -- "${portable_downloads[0]}"
matrix_append_state portable_file "$portable_file"
```

Inspect the guarded copy offline without printing values:

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
case "$(realpath -m "$portable_file")" in /tmp/tabkebab-row06-export.*.json) ;; *) exit 1 ;; esac
test -s "$portable_file"
bun - "$portable_file" <<'BUN'
const value = await Bun.file(Bun.argv[2]).json();
const forbidden = new Set([
  'apiKey', 'token', 'credential', 'installId', 'focusState', 'driveSync',
  'driveProfileName', 'tabkebabSettingsPrevious', 'ciphertext', 'salt', 'iv',
]);
let forbiddenCount = 0;
const visit = (entry) => {
  if (!entry || typeof entry !== 'object') return;
  for (const [key, child] of Object.entries(entry)) {
    const lower = key.toLowerCase();
    if (
      forbidden.has(key) || lower.includes('cache') || lower.includes('token') ||
      lower.includes('secret') || lower.includes('passphrase') || lower.includes('authorization')
    ) forbiddenCount++;
    visit(child);
  }
};
visit(value);
console.log(JSON.stringify({
  version: value.version, kind: value.kind, forbiddenKeyCount: forbiddenCount,
  sectionCounts: {
    sessions: value.sessions?.length, stashes: value.stashes?.length,
    groups: Object.keys(value.manualGroups ?? {}).length,
    bookmarks: value.bookmarks?.length, focusHistory: value.focusHistory?.length,
  },
}));
BUN
```

Require version 2, kind `full`, all expected section counts, and
`forbiddenKeyCount: 0`. In B, clear only the disposable portable destinations
while retaining `driveSync` and `driveProfileName`:

```js
await chrome.storage.local.remove([
  'sessions', 'manualGroups', 'keepAwakeDomains', 'tabkebabBookmarks',
  'tabkebabSettings', 'focusProfilePrefs', 'focusHistory', 'aiSettings',
]);
const db = await new Promise((resolve, reject) => {
  const request = indexedDB.open('TabKebabStash', 1);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
await new Promise((resolve, reject) => {
  const tx = db.transaction('stashes', 'readwrite');
  tx.objectStore('stashes').clear();
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
});
db.close();
```

Import `portable_file` through B's production **Import** picker. Require all
section counts/settings plus the IndexedDB stash appear and the import summary
reports no rollback. Automated injected tests remain the rollback-failure
authority; do not add a live failure hook.

**Drive cleanup.** From A, run this credential-safe IIFE. Replace only the
shared profile name. It refuses ambiguous root/profile lookup, deletes that one
throwaway folder, polls its non-trashed absence, and exposes no token or ID:

```js
await (async (profileName) => {
  const token = await new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, (value) => {
      const error = chrome.runtime.lastError;
      if (error || typeof value !== 'string' || !value) reject(new Error(error?.message || 'OAuth token unavailable'));
      else resolve(value);
    });
  });
  const auth = { Authorization: `Bearer ${token}` };
  const list = async (q) => {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', q);
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('pageSize', '2');
    url.searchParams.set('fields', 'files(id,name)');
    const response = await fetch(url, { headers: auth });
    if (!response.ok) throw new Error(`Drive cleanup list failed: ${response.status}`);
    return (await response.json()).files;
  };
  const esc = (value) => value.replaceAll("'", "\\'");
  const roots = await list("name='TabKebab' and 'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false");
  if (roots.length > 1) throw new Error(`Drive root count was ${roots.length}`);
  if (roots.length === 0) {
    return { deletedProfileFolders: 0, remainingNonTrashed: 0, tokenExposed: false, idExposed: false };
  }
  const query = `name='${esc(profileName)}' and '${roots[0].id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const profiles = await list(query);
  if (profiles.length > 1) throw new Error(`Drive profile count was ${profiles.length}`);
  let deletedProfileFolders = 0;
  let remaining = profiles.length;
  if (profiles.length === 1) {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(profiles[0].id)}`, {
      method: 'DELETE', headers: auth,
    });
    if (response.status !== 204) throw new Error(`Drive profile delete failed: ${response.status}`);
    deletedProfileFolders = 1;
    for (let attempt = 0; attempt < 20; attempt++) {
      remaining = (await list(query)).length;
      if (remaining === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (remaining !== 0) throw new Error(`Drive profile remained after delete: ${remaining}`);
  return { deletedProfileFolders, remainingNonTrashed: 0, tokenExposed: false, idExposed: false };
})('SHARED_DRIVE_PROFILE_NAME');
```

After **every** successful execution of that guarded cleanup IIFE—on the normal
path or during failure recovery—persist the remote-absence proof before
disconnecting or deleting either local profile:

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
test "$row06_remote_cleanup_required" = yes
read -r -p 'Type ROW06_REMOTE_ABSENT after the guarded IIFE reports remainingNonTrashed=0: ' row06_cleanup_attestation
test "$row06_cleanup_attestation" = ROW06_REMOTE_ABSENT
matrix_append_state row06_cleanup_proof remote-absent
source "$release_state"
test "$row06_cleanup_proof" = remote-absent
```

On a Row 06 `FAIL` or `BLOCKED`, the emergency trap stops but preserves both
profiles and `matrix_lib`. If the failure was anything except the exact
pre-authentication rejection above, first persist the conservative cleanup
requirement in a fresh shell:

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
matrix_append_state row06_remote_cleanup_required yes
source "$release_state"
```

Enter cleanup idempotently. UI-only failures do not fire the shell trap, so run
the same emergency cleanup first; it stops the shared fixture and any live
Chrome while preserving Row 06 profiles. Restore strict mode and state because
the cleanup helper deliberately disables both. Relaunch whichever preserved
profiles still exist for required remote or local Disconnect cleanup; a
persisted proof means the remote IIFE itself is not repeated:

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
release_state="/tmp/tabkebab-release-state-$(tr -d '\r\n' < VERSION).env"
source "$release_state"; source "$matrix_lib"
matrix_emergency_cleanup
set -Eeuo pipefail
source "$release_state"; source "$matrix_lib"
test "$active_cleanup_status" = complete
if test -d "$row06a_profile"; then matrix_start_browser row06a "$row06a_profile"; fi
if test -d "$row06b_profile"; then matrix_start_browser row06b "$row06b_profile"; fi
source "$release_state"
printf 'Cleanup panels: chrome-extension://%s/sidepanel/panel.html\n' "$extension_id"
```

When `row06_remote_cleanup_required=yes`, re-authenticate A if necessary, run
the exact cleanup IIFE above (its guarded `0`-or-`1` result handles failures
before or after folder creation), require `remainingNonTrashed: 0`, and run the
mandatory remote-proof block immediately following the IIFE. When it is `no`,
do not run the IIFE: instead require the exact pre-auth identity error, that A
never showed **Connected**, `row06_drive_scope_created=no`, and that B was
never attempted. Persist that proof **before** deleting either local profile,
so a partial local cleanup can resume without repeating or losing the
remote/pre-auth authority:

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
if test -z "$row06_cleanup_proof" && test "$row06_remote_cleanup_required" = yes; then
  echo 'Run the guarded cleanup IIFE and its mandatory remote-proof block first.' >&2
  exit 1
elif test -z "$row06_cleanup_proof"; then
  test "$row06_production_connect_succeeded" = no
  test "$row06_drive_scope_created" = no
  read -r -p 'Type ROW06_PREAUTH_NO_SCOPE after confirming oauthTokenIssued=false, A never connected, and B was not attempted: ' row06_cleanup_attestation
  test "$row06_cleanup_attestation" = ROW06_PREAUTH_NO_SCOPE
  matrix_append_state row06_cleanup_proof preauth-no-scope
fi
source "$release_state"
[[ "$row06_cleanup_proof" = remote-absent || "$row06_cleanup_proof" = preauth-no-scope ]]
```

Click **Disconnect** where available, clear disposable extension data, and
close the live cleanup profiles. A profile already absent on a retry counts as
locally removed; complete Disconnect/data clearing in every profile that was
relaunched. Persist that local proof before deleting either remaining profile.
The failure evidence must be operator supplied and include the safe triggering
cause plus both persisted cleanup proofs. Then remove whichever guarded
profiles still exist; this is retry-safe if one local deletion completed before
a later assertion failed:

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
[[ "$row06_cleanup_proof" = remote-absent || "$row06_cleanup_proof" = preauth-no-scope ]]
if test -z "$row06_local_cleanup_proof"; then
  read -r -p 'Type ROW06_LOCAL_CLEAN after every surviving profile is disconnected and its disposable extension data is cleared: ' row06_local_cleanup_attestation
  test "$row06_local_cleanup_attestation" = ROW06_LOCAL_CLEAN
  matrix_append_state row06_local_cleanup_proof complete
fi
source "$release_state"
test "$row06_local_cleanup_proof" = complete
test -z "${portable_file:-}" || case "$(realpath -m "$portable_file")" in
  /tmp/tabkebab-row06-export.*.json) rm -f -- "$portable_file" ;;
  *) echo 'Unsafe Row 06 portable cleanup path' >&2; exit 1 ;;
esac
matrix_stop_browser row06a no
matrix_stop_browser row06b no
test ! -e "$row06a_profile" && test ! -e "$row06b_profile"
if test "$row06_cleanup_proof" = remote-absent; then
  row06_cleanup_summary='remoteCleanup=required; remainingNonTrashed=0'
else
  test "$row06_cleanup_proof" = preauth-no-scope
  row06_cleanup_summary='remoteCleanup=notRequired; oauthTokenIssued=false; productionConnectSucceeded=false; driveScopeCreated=false'
fi
matrix_read_outcome 06 row06_actual row06_result
[[ "$row06_result" = FAIL || "$row06_result" = BLOCKED ]]
row06_actual="$row06_actual; $row06_cleanup_summary; credentialsRecorded=false"
matrix_record_failure 06 "$row06a_profile,$row06b_profile" \
  'two exact-artifact profiles and one guarded throwaway Drive scope' \
  'row stopped at first failed or blocked assertion; required remote-or-pre-auth cleanup branch then local cleanup ran' \
  'remote scope absent or provably never authenticated/created; local cleanup attested; both disposable profiles removed' \
  "$row06_actual" "$row06_result" 'required remote/pre-auth proof recorded; both locally disconnected; profiles/downloads removed'
matrix_end_row 06
case "$(realpath -m "$matrix_lib")" in
  /tmp/tabkebab-matrix-*) rm -f -- "$matrix_lib" ;;
  *) echo 'Unsafe matrix helper cleanup path' >&2; exit 1 ;;
esac
exit 1
```

On the normal path, the guarded cleanup IIFE and mandatory remote-proof block
must already have completed. Click **Disconnect** in A and B, clear disposable
local/session/IndexedDB data, and close both browsers. Attest the local cleanup
before either profile is deleted, then remove the portable file and profiles:

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
test "$row06_cleanup_proof" = remote-absent
if test -z "$row06_local_cleanup_proof"; then
  read -r -p 'Type ROW06_LOCAL_CLEAN after A and B are disconnected and their disposable extension data is cleared: ' row06_local_cleanup_attestation
  test "$row06_local_cleanup_attestation" = ROW06_LOCAL_CLEAN
  matrix_append_state row06_local_cleanup_proof complete
fi
source "$release_state"
test "$row06_local_cleanup_proof" = complete
case "$(realpath -m "$portable_file")" in
  /tmp/tabkebab-row06-export.*.json) rm -f -- "$portable_file" ;;
  *) echo 'Unsafe Row 06 portable cleanup path' >&2; exit 1 ;;
esac
matrix_stop_browser row06a no
matrix_stop_browser row06b no
test ! -e "$row06a_profile" && test ! -e "$row06b_profile"
matrix_read_outcome 06 row_actual row_result
matrix_record_row 06 "$row06a_profile,$row06b_profile" \
  'two exact-artifact profiles on one account and one shared throwaway Drive scope; synthetic v1/retention/portable fixtures' \
  'migrate and baseline; A delete, A sync, B sync, A sync; clean old copies; export A and import B' \
  'live v1->v2; shared-scope A-delete/A-sync/B-sync/A-sync absence+tombstone; canonical/newest retention; full v2 transfer' \
  "$row_actual" "$row_result" 'remote and local cleanup proofs recorded; throwaway Drive folder absent; both disconnected; export removed; both profiles removed'
matrix_end_row 06
test "$row_result" = PASS
```

### Row 07 — passphrase unlock after complete Chrome restart

Start `row07` with `/tmp/tabkebab-smoke-r07.XXXXXX`. In AI Settings, select the
key-requiring **Custom** provider at the loopback-only
`$fixture_base_url/v1`, model `matrix-fixture`. Enter a synthetic disposable key
and passphrase in Chrome UI, enable passphrase protection, and save. They do not
belong to any account and must still never appear in this guide, a shell
environment variable, DevTools, logs, or evidence.

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
release_state="/tmp/tabkebab-release-state-$(tr -d '\r\n' < VERSION).env"
source "$release_state"; source "$matrix_lib"
row07_profile="$(mktemp -d /tmp/tabkebab-smoke-r07.XXXXXX)"
matrix_append_state row07_profile "$row07_profile"
matrix_begin_row 07 "$row07_profile"
matrix_start_browser row07 "$row07_profile"
source "$release_state"
```

Confirm the provider works, then fully stop Chrome while preserving the
profile and relaunch the exact artifact:

```bash
source "$release_state"; source "$matrix_lib"
matrix_stop_browser row07 yes
matrix_start_browser row07 "$row07_profile"
source "$release_state"
row07_download_dir="$(mktemp -d /tmp/tabkebab-row07-downloads.XXXXXX)"
matrix_set_download_dir row07 "$row07_download_dir"
source "$release_state"
```

**Assertions.** After restart, the UI requires unlock before provider use. One
wrong passphrase fails with safe text and changes no stored credential state;
the correct passphrase unlocks and allows one connection test against the local
fixture. Require exactly one additional local fixture request after successful
unlock. The configured endpoint and counted fixture are loopback-only; this row
does not claim that all browser traffic is globally zero. The synthetic secret is not shown in UI,
logs, runtime responses, or a full portable export. Use this count-only/key-only
console probe and do not expand `state`:

Before the wrong-passphrase attempt, record the generic loopback counter. It
must remain unchanged after the wrong value and increase by exactly one only
after the right value plus **Test Connection**:

```js
const beforeWrong = await chrome.storage.local.get('aiSettings');
const beforeBytes = new TextEncoder().encode(JSON.stringify(beforeWrong.aiSettings ?? {}));
globalThis.__matrixWrongPassphraseFingerprint = Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', beforeBytes)),
  (byte) => byte.toString(16).padStart(2, '0'),
).join('');
({ fingerprintCaptured: true, statePrinted: false });
```

```bash
source "$release_state"; source "$matrix_lib"
generic_before="$(curl --fail --silent "$fixture_base_url/metrics" | jq -er .generic)"
matrix_append_state generic_before "$generic_before"
read -r -p 'Enter the wrong passphrase in Chrome, submit it, then press Enter here: '
test "$(curl --fail --silent "$fixture_base_url/metrics" | jq -er .generic)" -eq "$generic_before"
```

Before attempting the correct passphrase, run this equality-only probe in the
same panel console. It prints no stored setting, ciphertext, or fingerprint:

```js
const afterWrong = await chrome.storage.local.get('aiSettings');
const afterBytes = new TextEncoder().encode(JSON.stringify(afterWrong.aiSettings ?? {}));
const afterFingerprint = Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', afterBytes)),
  (byte) => byte.toString(16).padStart(2, '0'),
).join('');
const unchanged = afterFingerprint === globalThis.__matrixWrongPassphraseFingerprint;
delete globalThis.__matrixWrongPassphraseFingerprint;
if (!unchanged) throw new Error('Wrong passphrase changed stored AI settings');
({ storedCredentialStateUnchanged: true, statePrinted: false });
```

Then perform the successful unlock and one connection test:

```bash
source "$release_state"; source "$matrix_lib"
read -r -p 'Enter the correct passphrase, click Test Connection exactly once, wait for success, then press Enter here: '
generic_after="$(curl --fail --silent "$fixture_base_url/metrics" | jq -er .generic)"
test "$generic_after" -eq "$((generic_before + 1))"
```

Then use this count-only/key-only console probe and do not expand `state`:

```js
const state = await chrome.storage.local.get('aiSettings');
const text = JSON.stringify(state.aiSettings ?? {});
({
  plaintextApiKeyStringPresent: /"apiKey"\s*:\s*"/.test(text),
  encryptedEnvelopePresent: /"ciphertext"/.test(text) && /"salt"/.test(text) && /"iv"/.test(text),
});
```

Export full data through the production Sessions UI, then capture the unique
file from the CDP-configured guarded download directory:

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
mapfile -t row07_exports < <(
  find "$row07_download_dir" -maxdepth 1 -type f -name 'tabkebab-export-*.json' -print
)
test "${#row07_exports[@]}" -eq 1
portable_file="${row07_exports[0]}"
chmod 600 "$portable_file"
matrix_append_state portable_file "$portable_file"
```

Run this Row 07-specific guarded forbidden-key scan and require zero:

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
case "$(realpath -m "$portable_file")" in
  /tmp/tabkebab-row07-downloads.*/tabkebab-export-*.json) ;;
  *) echo 'Unsafe Row 07 export path' >&2; exit 1 ;;
esac
test -s "$portable_file"
bun - "$portable_file" <<'BUN'
const value = await Bun.file(Bun.argv[2]).json();
const forbidden = new Set([
  'apiKey', 'token', 'credential', 'installId', 'focusState', 'driveSync',
  'driveProfileName', 'tabkebabSettingsPrevious', 'ciphertext', 'salt', 'iv',
]);
let forbiddenCount = 0;
const visit = (entry) => {
  if (!entry || typeof entry !== 'object') return;
  for (const [key, child] of Object.entries(entry)) {
    const lower = key.toLowerCase();
    if (forbidden.has(key) || lower.includes('cache') || lower.includes('token') ||
        lower.includes('secret') || lower.includes('passphrase') ||
        lower.includes('authorization')) forbiddenCount++;
    visit(child);
  }
};
visit(value);
if (forbiddenCount !== 0) throw new Error('Row 07 export contains forbidden keys');
console.log(JSON.stringify({ version: value.version, kind: value.kind, forbiddenKeyCount: 0 }));
BUN
```

Delete the export. In AI
Settings remove/replace the disposable credential, clear site/extension data,
and remove the profile.

```bash
source "$release_state"; source "$matrix_lib"
matrix_stop_browser row07 no
matrix_read_outcome 07 row_actual row_result
matrix_record_row 07 "$row07_profile" \
  'synthetic Custom key/passphrase saved for loopback fixture in one disposable profile' \
  'fully restart Chrome; try wrong then right passphrase; issue one local request and export full data' \
  'restart clears unlock; wrong fails; right succeeds; no plaintext/export secret' \
  "$row_actual" "$row_result" 'synthetic credential removed; export removed; restarted browser stopped; profile removed'
matrix_end_row 07
test "$row_result" = PASS
```

### Row 08 — Chrome Prompt API foreground, cancel, reconnect, and background skip

This row requires a Chrome build and installed Prompt model for which the
production availability check is true. It may incur a local model operation,
but the matrix must not start a model download. If the current browser reports
`unavailable`, record `BLOCKED`; earlier port/Web-Locks evidence is not a
completion substitute.

If using another already-installed supported binary, it must be a Linux binary
compatible with this runbook's `/proc`, Xvfb, and disposable-profile cleanup.
Append its exact identity, including OS, before starting `row08`. A Windows
browser needs a separately reviewed native PID/profile/CDP runbook and cannot be
dropped into this helper:

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
release_state="/tmp/tabkebab-release-state-$(tr -d '\r\n' < VERSION).env"
source "$release_state"; source "$matrix_lib"
chrome_bin="/absolute/path/to/already-installed/supported/chrome"
test -x "$chrome_bin"
test "$(uname -s)" = Linux
file "$chrome_bin" | grep -q 'ELF'
chrome_version="$($chrome_bin --version)"
chrome_sha256="$(sha256sum "$chrome_bin" | awk '{print $1}')"
os_label="$(uname -srvmo)"
source "$matrix_lib"
matrix_append_state chrome_bin "$chrome_bin"
matrix_append_state chrome_version "$chrome_version"
matrix_append_state chrome_sha256 "$chrome_sha256"
matrix_append_state os_label "$os_label"
```

Start `/tmp/tabkebab-smoke-r08.XXXXXX`, open the production panel, select
**Chrome Built-in AI**, and require availability plus one completed connection
test. In `chrome://extensions`, open only this artifact's service-worker
DevTools. Keeping that inspector open is allowed for count-only observation; do
not alter worker state or APIs.

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
release_state="/tmp/tabkebab-release-state-$(tr -d '\r\n' < VERSION).env"
source "$release_state"; source "$matrix_lib"
row08_profile="$(mktemp -d /tmp/tabkebab-smoke-r08.XXXXXX)"
matrix_append_state row08_profile "$row08_profile"
matrix_begin_row 08 "$row08_profile"
matrix_start_browser row08 "$row08_profile"
source "$release_state"
```

**Uncached active-close action.** In Settings use the production **Clear AI
Cache** button and require its success toast. In the panel DevTools console,
replace only `FIXTURE_BASE_URL_FROM_RELEASE_STATE`, create exactly four unique
synthetic tabs, and capture a secret-free pre-dispatch fingerprint. It hashes
only the AI cache key set plus the synthetic tabs' IDs/group IDs; it never
prints titles, URLs, prompts, or responses:

```js
const row08Base = 'FIXTURE_BASE_URL_FROM_RELEASE_STATE';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(row08Base)) throw new Error('Invalid fixture base URL');
const row08Nonce = crypto.randomUUID();
const oldSynthetic = (await chrome.tabs.query({})).filter(({ url }) =>
  typeof url === 'string' && url.includes('/r08-'));
if (oldSynthetic.length) await chrome.tabs.remove(oldSynthetic.map(({ id }) => id));
for (let index = 0; index < 4; index++) {
  await chrome.tabs.create({ url: `${row08Base}/r08-cancel-${row08Nonce}-${index}`, active: index === 0 });
}
for (let attempt = 0; attempt < 100; attempt++) {
  const ready = (await chrome.tabs.query({})).filter(({ url, status }) =>
    typeof url === 'string' && url.includes(`/r08-cancel-${row08Nonce}-`) && status === 'complete');
  if (ready.length === 4) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
};
const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(JSON.stringify(canonical(value))),
)), (byte) => byte.toString(16).padStart(2, '0')).join('');
const stored = await chrome.storage.local.get('aiCache');
const synthetic = (await chrome.tabs.query({})).filter(({ url }) =>
  typeof url === 'string' && url.includes(`/r08-cancel-${row08Nonce}-`));
if (synthetic.length !== 4 || Object.keys(stored.aiCache ?? {}).length !== 0) {
  throw new Error('Row 08 uncached baseline was not exact');
}
await digest({
  cacheKeys: Object.keys(stored.aiCache ?? {}).sort(),
  tabs: synthetic.map(({ id, groupId }) => ({ id, groupId })).sort((a, b) => a.id - b.id),
});
```

Copy only that 64-character digest into this terminal prompt:

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
read -r -p 'Row 08 pre-cancel fingerprint: ' row08_cancel_fingerprint
[[ "$row08_cancel_fingerprint" =~ ^[0-9a-f]{64}$ ]]
matrix_append_state row08_cancel_fingerprint "$row08_cancel_fingerprint"
source "$release_state"
```

In the service-worker DevTools, establish the count-only observer and require
zero pending before dispatch:

```js
const { chromeAIBrokerClient } = await import(chrome.runtime.getURL('core/ai/chrome-ai-broker-client.js'));
if (chromeAIBrokerClient.pending.size !== 0) throw new Error('Prompt broker was not idle');
({ pendingCount: 0 });
```

Return to the **Domains** sub-view and panel DevTools. This exact action clicks
the production per-domain **Summarize tabs (AI)** control for `127.0.0.1` and
refuses to continue until the unique uncached operation has
actually acquired the exclusive production provider lock. Close the side panel
document immediately after it returns `heldProviderLocks: 1`; a cache hit or
pre-dispatch close cannot pass:

```js
const cancelDomain = [...document.querySelectorAll('.domain-group')].find((element) =>
  element.querySelector('.domain-name')?.textContent === '127.0.0.1');
const cancelButton = cancelDomain?.querySelector('.summarize-btn');
if (!cancelButton || cancelButton.disabled) throw new Error('Synthetic domain summarize control unavailable');
cancelButton.click();
let providerLocks;
for (let attempt = 0; attempt < 200; attempt++) {
  const state = await navigator.locks.query();
  providerLocks = {
    held: state.held.filter(({ name }) => name === 'tabkebab:chrome-ai-provider').length,
    pending: state.pending.filter(({ name }) => name === 'tabkebab:chrome-ai-provider').length,
  };
  if (providerLocks.held === 1 && providerLocks.pending === 0) break;
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (providerLocks.held !== 1 || providerLocks.pending !== 0) {
  throw new Error('Unique uncached Prompt request never acquired its provider lock');
}
({ heldProviderLocks: 1, waitingProviderLocks: 0 });
```

After closing the panel, use only the already-open service-worker DevTools.
Poll the production broker until the cancelled request is absent, then require
the stored cache is still empty:

```js
for (let attempt = 0; attempt < 200 && chromeAIBrokerClient.pending.size !== 0; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
const afterCancelCache = await chrome.storage.local.get('aiCache');
if (chromeAIBrokerClient.pending.size !== 0 || Object.keys(afterCancelCache.aiCache ?? {}).length !== 0) {
  throw new Error('Cancelled Prompt request left pending work or cache mutation');
}
({ pendingCount: 0, cacheKeyCount: 0 });
```

Wait five seconds, reopen the panel, and rerun the canonical/digest definitions
from the baseline snippet against all four `/r08-cancel-` tabs. Require the
named lock has zero held and zero pending entries, all four tabs remain
ungrouped, and copy only the resulting fingerprint:

```js
const lockState = await navigator.locks.query();
const namedHeld = lockState.held.filter(({ name }) => name === 'tabkebab:chrome-ai-provider').length;
const namedPending = lockState.pending.filter(({ name }) => name === 'tabkebab:chrome-ai-provider').length;
const storedAfterCancel = await chrome.storage.local.get('aiCache');
const cancelTabs = (await chrome.tabs.query({})).filter(({ url }) =>
  typeof url === 'string' && url.includes('/r08-cancel-'));
if (namedHeld !== 0 || namedPending !== 0 || cancelTabs.length !== 4 ||
    cancelTabs.some(({ groupId }) => groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) ||
    Object.keys(storedAfterCancel.aiCache ?? {}).length !== 0) {
  throw new Error('Prompt cancellation postcondition failed');
}
({
  fingerprint: await digest({
    cacheKeys: Object.keys(storedAfterCancel.aiCache ?? {}).sort(),
    tabs: cancelTabs.map(({ id, groupId }) => ({ id, groupId })).sort((a, b) => a.id - b.id),
  }),
  heldProviderLocks: 0,
  waitingProviderLocks: 0,
  pendingCount: 0,
  cacheKeyCount: 0,
});
```

Prove exact equality in the terminal:

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
read -r -p 'Row 08 post-cancel fingerprint: ' row08_cancel_after
test "$row08_cancel_after" = "$row08_cancel_fingerprint"
```

**Distinct reconnect action.** Create one additional tab at a new
`/r08-reconnect-${crypto.randomUUID()}` fixture path, wait for it to load, click
the production per-domain summarize button once, and require one visible
summary for each of the five exact synthetic domain tabs. In service-worker
DevTools require `pending.size === 0` and exactly one `aiCache` key; in panel
DevTools require zero named held/pending locks. The new five-tab request differs
from the cancelled four-tab request, and cache `0 -> 1` plus five rendered
summaries proves a distinct reconnected completion rather than fallback or a
stale result.

```js
const row08Base = 'FIXTURE_BASE_URL_FROM_RELEASE_STATE';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(row08Base)) throw new Error('Invalid fixture base URL');
const reconnectNonce = crypto.randomUUID();
const reconnectTab = await chrome.tabs.create({
  url: `${row08Base}/r08-reconnect-${reconnectNonce}`,
  active: true,
});
for (let attempt = 0; attempt < 100; attempt++) {
  const current = await chrome.tabs.get(reconnectTab.id);
  if (current.status === 'complete') break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
document.querySelector('.tab-nav [data-view="tabs"]').click();
let reconnectDomain;
for (let attempt = 0; attempt < 100; attempt++) {
  reconnectDomain = [...document.querySelectorAll('.domain-group')].find((element) =>
    element.querySelector('.domain-name')?.textContent === '127.0.0.1');
  if (reconnectDomain?.querySelectorAll('.tab-item').length === 5) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (reconnectDomain?.querySelectorAll('.tab-item').length !== 5) {
  throw new Error('Production Tabs refresh did not render five synthetic domain tabs');
}
const reconnectButton = reconnectDomain?.querySelector('.summarize-btn');
if (!reconnectButton || reconnectButton.disabled) throw new Error('Reconnect summarize control unavailable');
reconnectButton.click();
let reconnectSucceeded = false;
for (let attempt = 0; attempt < 1200; attempt++) {
  reconnectSucceeded = reconnectDomain.querySelectorAll('.tab-summary').length === 5 &&
    reconnectButton.disabled === false;
  if (reconnectSucceeded) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!reconnectSucceeded) throw new Error('Distinct reconnect completion did not succeed');
const reconnectLocks = await navigator.locks.query();
const reconnectHeld = reconnectLocks.held.filter(({ name }) => name === 'tabkebab:chrome-ai-provider').length;
const reconnectPending = reconnectLocks.pending.filter(({ name }) => name === 'tabkebab:chrome-ai-provider').length;
if (reconnectHeld !== 0 || reconnectPending !== 0) throw new Error('Reconnect left provider locks');
({ reconnectSucceeded: true, heldProviderLocks: 0, waitingProviderLocks: 0 });
```

```js
const reconnectCache = await chrome.storage.local.get('aiCache');
if (chromeAIBrokerClient.pending.size !== 0 || Object.keys(reconnectCache.aiCache ?? {}).length !== 1) {
  throw new Error('Distinct reconnect did not settle into exactly one cache entry');
}
({ pendingCount: 0, cacheKeyCount: 1 });
```

**Closed-panel background action.** Start a Focus run with AI blocking and a
non-destructive `none` action. Create one `about:blank` target tab. In panel
DevTools capture a canonical SHA-256 fingerprint of the complete `focusState`
and sorted `aiCache` key set, requiring one cache key and zero named locks; copy
only that digest into `row08_background_fingerprint` in `release_state` using
the same guarded terminal pattern above. Generate but do not visit a unique
`http://r08-${crypto.randomUUID()}.matrix.test:FIXTURE_PORT/background` URL.

```js
const backgroundTarget = await chrome.tabs.create({ url: 'about:blank', active: true });
const backgroundUrl = `http://r08-${crypto.randomUUID()}.matrix.test:FIXTURE_PORT/background`;
const backgroundState = await chrome.storage.local.get(['focusState', 'aiCache']);
const backgroundLocks = await navigator.locks.query();
const backgroundHeld = backgroundLocks.held.filter(({ name }) => name === 'tabkebab:chrome-ai-provider').length;
const backgroundPending = backgroundLocks.pending.filter(({ name }) => name === 'tabkebab:chrome-ai-provider').length;
if (backgroundState.focusState?.status !== 'active' ||
    Object.keys(backgroundState.aiCache ?? {}).length !== 1 ||
    backgroundHeld !== 0 || backgroundPending !== 0) {
  throw new Error('Background baseline was not idle and active');
}
({
  fingerprint: await digest({
    focusState: backgroundState.focusState,
    cacheKeys: Object.keys(backgroundState.aiCache ?? {}).sort(),
  }),
  backgroundUrl,
  targetReady: backgroundTarget.url === 'about:blank',
  heldProviderLocks: 0,
  waitingProviderLocks: 0,
});
```

Replace only `FIXTURE_PORT` in the returned synthetic URL, then persist the two
safe values without recording any browser data:

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
read -r -p 'Row 08 background-state fingerprint: ' row08_background_fingerprint
[[ "$row08_background_fingerprint" =~ ^[0-9a-f]{64}$ ]]
read -r -p 'Row 08 synthetic background URL: ' row08_background_url
[[ "$row08_background_url" =~ ^http://r08-[0-9a-f-]+\.matrix\.test:[0-9]+/background$ ]]
matrix_append_state row08_background_fingerprint "$row08_background_fingerprint"
matrix_append_state row08_background_url "$row08_background_url"
source "$release_state"
```

Close the panel, verify it stays closed, and navigate only the prepared target
through Chrome's address bar to that exact unique URL. Wait ten seconds. The
service-worker probe must report `pending.size === 0` and `aiCache` key count
still one. Reopen the panel, require the target remains at the requested URL,
zero named held/pending locks, and exact equality of the canonical
`focusState`/cache-key fingerprint with `row08_background_fingerprint`. This is
the objective zero-mutation snapshot: run ID, status, distraction count, and
all other Focus authority remain byte-equivalent while the foreground-required
AI request safely skips. Any automatic panel open, Prompt execution, cache
change, navigation reversal, or Focus-state change fails the row.

After the ten-second closed-panel wait, run this in service-worker DevTools:

```js
const backgroundCache = await chrome.storage.local.get('aiCache');
if (chromeAIBrokerClient.pending.size !== 0 || Object.keys(backgroundCache.aiCache ?? {}).length !== 1) {
  throw new Error('Closed-panel background request mutated pending/cache state');
}
({ pendingCount: 0, cacheKeyCount: 1 });
```

After reopening the panel, rerun the exact `canonical` and `digest` definitions,
replace only `BACKGROUND_URL_FROM_RELEASE_STATE`, and copy the returned digest:

```js
const expectedBackgroundUrl = 'BACKGROUND_URL_FROM_RELEASE_STATE';
const matchingTargets = (await chrome.tabs.query({})).filter(({ url }) => url === expectedBackgroundUrl);
const finalBackgroundState = await chrome.storage.local.get(['focusState', 'aiCache']);
const finalBackgroundLocks = await navigator.locks.query();
const finalHeld = finalBackgroundLocks.held.filter(({ name }) => name === 'tabkebab:chrome-ai-provider').length;
const finalPending = finalBackgroundLocks.pending.filter(({ name }) => name === 'tabkebab:chrome-ai-provider').length;
if (matchingTargets.length !== 1 || Object.keys(finalBackgroundState.aiCache ?? {}).length !== 1 ||
    finalHeld !== 0 || finalPending !== 0) {
  throw new Error('Closed-panel background postcondition failed');
}
({
  fingerprint: await digest({
    focusState: finalBackgroundState.focusState,
    cacheKeys: Object.keys(finalBackgroundState.aiCache ?? {}).sort(),
  }),
  targetAtRequestedUrl: true,
  heldProviderLocks: 0,
  waitingProviderLocks: 0,
});
```

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
read -r -p 'Row 08 post-background fingerprint: ' row08_background_after
test "$row08_background_after" = "$row08_background_fingerprint"
```

Record only availability, lock/completion/cancel/reconnect booleans, pending and
cache-key counts, snapshot equality, and mutation count. End Focus and close
fixture tabs.

```bash
source "$release_state"; source "$matrix_lib"
matrix_stop_browser row08 no
matrix_read_outcome 08 row_actual row_result
matrix_record_row 08 "$row08_profile" \
  'supported preinstalled Chrome/Prompt model and synthetic tabs in a clean exact-artifact profile' \
  'summarize with panel; close during request; reopen/distinct summarize; trigger background Focus with panel closed' \
  'available model; open-panel completion; active close cancels; reopen completes; closed-panel Focus mutations=0' \
  "$row_actual" "$row_result" 'Focus ended; panel/fixture tabs closed; Prompt pending=0; profile removed'
matrix_end_row 08
test "$row_result" = PASS
# Rows 09-11 use the original verified Linux browser identity.
matrix_append_state chrome_bin "$baseline_chrome_bin"
matrix_append_state chrome_version "$baseline_chrome_version"
matrix_append_state chrome_sha256 "$baseline_chrome_sha256"
matrix_append_state os_label "$baseline_os_label"
source "$release_state"
```

### Row 09 — unchanged 120-second Custom-provider timeout

Start `row09` with `/tmp/tabkebab-smoke-r09.XXXXXX`. Start the **committed**
loopback-only hanging fixture from the exact release commit, record its PID, and
persist its URLs. The extension still loads only `unpacked_dir`.

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
release_state="/tmp/tabkebab-release-state-$(tr -d '\r\n' < VERSION).env"
source "$release_state"; source "$matrix_lib"
test "$release_commit" = "$(git rev-parse HEAD)"
row09_profile="$(mktemp -d /tmp/tabkebab-smoke-r09.XXXXXX)"
matrix_append_state row09_profile "$row09_profile"
matrix_begin_row 09 "$row09_profile"
row09_fixture_script="$(mktemp /tmp/tabkebab-row09-hanging.XXXXXX.js)"
row09_fixture_log="$(mktemp /tmp/tabkebab-row09-hanging.XXXXXX.log)"
git cat-file -e "$release_commit:tests/fixtures/hanging-ai-server.js"
git show "$release_commit:tests/fixtures/hanging-ai-server.js" > "$row09_fixture_script"
chmod 600 "$row09_fixture_script" "$row09_fixture_log"
test "$(git hash-object "$row09_fixture_script")" = \
  "$(git rev-parse "$release_commit:tests/fixtures/hanging-ai-server.js")"
bun "$row09_fixture_script" > "$row09_fixture_log" 2>&1 &
row09_fixture_pid=$!
matrix_record_pid "$row09_fixture_pid"
for _ in $(seq 1 100); do
  jq -e '.ready == true' "$row09_fixture_log" >/dev/null 2>&1 && break
  kill -0 "$row09_fixture_pid" 2>/dev/null
  sleep 0.1
done
row09_base_url="$(jq -er .baseUrl "$row09_fixture_log")"
row09_metrics_url="$(jq -er .metricsUrl "$row09_fixture_log")"
[[ "$row09_base_url" =~ ^http://127\.0\.0\.1:[0-9]+/v1$ ]]
matrix_append_state row09_fixture_log "$row09_fixture_log"
matrix_append_state row09_fixture_script "$row09_fixture_script"
matrix_append_state row09_fixture_pid "$row09_fixture_pid"
matrix_append_state row09_base_url "$row09_base_url"
matrix_append_state row09_metrics_url "$row09_metrics_url"

matrix_start_browser row09 "$row09_profile"
source "$release_state"
```

In AI Settings select **Custom**, use `row09_base_url`, model
`matrix-fixture`, and no key. Arm the timestamp in its own shell block:

```bash
source "$release_state"; source "$matrix_lib"
row09_started_ms="$(date +%s%3N)"
matrix_append_state row09_started_ms "$row09_started_ms"
printf 'Click Test Connection once now; wait for its terminal failure before running the next block.\n'
```

Click the production **Test Connection** exactly once immediately after the
prompt, and wait for the UI's terminal timeout/failure. Do not alter the
120-second production timeout. Only after settlement, run this separate block
to query redacted metrics:

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
row09_finished_ms="$(date +%s%3N)"
row09_elapsed_ms="$((row09_finished_ms - row09_started_ms))"
test "$row09_elapsed_ms" -ge 119000
test "$row09_elapsed_ms" -le 135000
metrics="$(curl --fail --silent --show-error "$row09_metrics_url")"
jq -e '
  .requestStarts == 1 and
  .connectionAborts == 1 and
  .completedRequests == 0 and
  .activeRequests == 0 and
  .maxActiveRequests == 1
' <<< "$metrics" >/dev/null
printf '%s\n' "$metrics"
```

Require elapsed time is consistent with the unchanged 120-second timeout, one
request was aborted, zero remain active, and maximum active is exactly one.
Only then click **Test Connection** once more as an explicit retry. Poll until
`requestStarts == 2` and `activeRequests == 1`; no automatic request may appear.
Close the panel/browser to abort the second request, poll until active is zero,
then stop the fixture and remove its log:

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
deadline=$((SECONDS + 15))
while (( SECONDS < deadline )); do
  retry_metrics="$(curl --fail --silent "$row09_metrics_url")"
  test "$(jq -r .requestStarts <<< "$retry_metrics")" = 2 && \
    test "$(jq -r .activeRequests <<< "$retry_metrics")" = 1 && break
  sleep 0.25
done
test "$(jq -r .requestStarts <<< "$retry_metrics")" = 2
test "$(jq -r .activeRequests <<< "$retry_metrics")" = 1
test "$(jq -r .maxActiveRequests <<< "$retry_metrics")" = 1
```

```bash
source "$release_state"; source "$matrix_lib"
matrix_stop_browser row09 no
for _ in $(seq 1 100); do
  metrics="$(curl --fail --silent "$row09_metrics_url")" || break
  test "$(jq -r .activeRequests <<< "$metrics")" = 0 && break
  sleep 0.1
done
test "$(jq -r .requestStarts <<< "$metrics")" = 2
test "$(jq -r .activeRequests <<< "$metrics")" = 0
test "$(jq -r .maxActiveRequests <<< "$metrics")" = 1
fixture_cmdline="$(tr '\0' ' ' < "/proc/$row09_fixture_pid/cmdline" 2>/dev/null || true)"
[[ "$fixture_cmdline" == *"$row09_fixture_script"* ]]
kill -TERM "$row09_fixture_pid"
for _ in $(seq 1 50); do kill -0 "$row09_fixture_pid" 2>/dev/null || break; sleep 0.1; done
! kill -0 "$row09_fixture_pid" 2>/dev/null
case "$(realpath -m "$row09_fixture_log")" in /tmp/tabkebab-row09-hanging.*.log) rm -f -- "$row09_fixture_log" ;; *) exit 1 ;; esac
case "$(realpath -m "$row09_fixture_script")" in /tmp/tabkebab-row09-hanging.*.js) rm -f -- "$row09_fixture_script" ;; *) exit 1 ;; esac
matrix_read_outcome 09 row_actual row_result
matrix_record_row 09 "$row09_profile" \
  'committed hanging CORS fixture and keyless Custom provider in a clean exact-artifact profile' \
  'click connection test once; wait unchanged 120 seconds; inspect metrics; click one explicit retry' \
  '120-second first attempt aborts; starts=1 aborts=1 active=0 maxActive=1 before one explicit retry' \
  "$row_actual" "$row_result" 'browser/profile removed; exact-commit hanging fixture exited; script/log removed; no listener remains'
matrix_end_row 09
test "$row_result" = PASS
```

### Row 10 — checked background failure without optimistic UI

Start a clean `row10` profile at `/tmp/tabkebab-smoke-r10.XXXXXX`. Open the
panel DevTools console and create only this local failure precondition:

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
release_state="/tmp/tabkebab-release-state-$(tr -d '\r\n' < VERSION).env"
source "$release_state"; source "$matrix_lib"
row10_profile="$(mktemp -d /tmp/tabkebab-smoke-r10.XXXXXX)"
matrix_append_state row10_profile "$row10_profile"
matrix_begin_row 10 "$row10_profile"
matrix_start_browser row10 "$row10_profile"
source "$release_state"
```

```js
await chrome.storage.local.set({
  driveSync: { connected: true, lastSyncedAt: null, driveFileId: null },
  tabkebabSettings: { neverDeleteFromDrive: false, driveRetentionDays: 30 },
});
await chrome.storage.local.remove('driveProfileName');
({ ready: true, connected: true, profilePresent: false });
```

Open **Settings**, set cleanup days to `30`, click **Clean Drive Files**, and
confirm. Require exactly one error toast with safe text
`Cleanup failed: Drive cleanup failed`, zero success toasts, no unhandled
rejection, restored button/confirmation state, no Drive request, and exact
equality of `driveSync`, settings, profile absence, and days before/after.

Remove the synthetic precondition and record count/text only:

```js
await chrome.storage.local.remove(['driveSync', 'driveProfileName']);
```

```bash
source "$release_state"; source "$matrix_lib"
matrix_stop_browser row10 no
matrix_read_outcome 10 row_actual row_result
matrix_record_row 10 "$row10_profile" \
  'clean profile with driveSync.connected true, 30-day setting, and no driveProfileName' \
  'click production Clean Drive Files and confirm' \
  'checked cleanup failure; exact safe error=1; success=0; optimistic mutations=0' \
  "$row_actual" "$row_result" 'synthetic drive state removed; no Drive artifact/token created; profile removed'
matrix_end_row 10
test "$row_result" = PASS
```

### Row 11 — Ctrl+K tabs, stashes, sessions, empty, and unavailable

Start `row11` with `/tmp/tabkebab-smoke-r11.XXXXXX`. Open three synthetic tabs
in grouped order (two `alpha.matrix.test`, one `beta.matrix.test`). Import one
current-shape stash and one current-shape session whose nested tab title is
`Matrix archived sentinel`. Use the production portable import boundary or
save through the UI; do not insert a legacy flat saved record for the success
case.

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
release_state="/tmp/tabkebab-release-state-$(tr -d '\r\n' < VERSION).env"
source "$release_state"; source "$matrix_lib"
row11_profile="$(mktemp -d /tmp/tabkebab-smoke-r11.XXXXXX)"
matrix_append_state row11_profile "$row11_profile"
matrix_begin_row 11 "$row11_profile"
matrix_start_browser row11 "$row11_profile"
source "$release_state"
```

In the panel DevTools console, substitute only the numeric `fixture_port`, then
create the exact tabs and current-shape portable fixtures:

```js
const port = Number('FIXTURE_PORT_FROM_RELEASE_STATE');
const urls = [
  `http://alpha.matrix.test:${port}/r11-alpha-one`,
  `http://alpha.matrix.test:${port}/r11-alpha-two`,
  `http://beta.matrix.test:${port}/r11-beta-one`,
];
const created = [];
for (const url of urls) created.push(await chrome.tabs.create({ url, active: false }));
const now = Date.now();
const imported = await chrome.runtime.sendMessage({
  action: 'importPortableData',
  document: {
    version: 2,
    kind: 'full',
    exportedAt: new Date(now).toISOString(),
    sessions: [{
      id: 'matrix-r11-session', name: 'Matrix archived session', version: 2,
      createdAt: now, modifiedAt: now,
      windows: [{ tabCount: 1, tabs: [{
        title: 'Matrix archived sentinel', url: 'https://matrix.invalid/r11-session',
      }] }],
    }],
    stashes: [{
      id: 'matrix-r11-stash', name: 'Matrix archived stash', createdAt: now + 1,
      tabCount: 1,
      windows: [{ tabCount: 1, tabs: [{
        title: 'Matrix archived sentinel', url: 'https://matrix.invalid/r11-stash',
      }] }],
    }],
    manualGroups: {}, keepAwakeDomains: [], bookmarks: [], settings: {},
    focusProfilePrefs: {}, focusHistory: [],
    aiSettings: { enabled: false, providerId: null, providerConfigs: {} },
  },
});
({ createdTabs: created.length, imported: imported.imported, skipped: imported.skipped });
```

Press **Ctrl+K** in the panel. Require sections for **Open Tabs**, **Stashes**,
and **Sessions**, the three open fixtures in worker group order, and both saved
records. Search `Matrix archived sentinel`; require the nested stash and
session. Search `matrix-no-match-sentinel`; require exact ordinary text
`No results found` with no `role="alert"`.

To test true unavailability without a production hook, close the overlay and
insert one synthetic malformed stash directly into the disposable panel's
IndexedDB, then reopen Ctrl+K:

```js
const db = await new Promise((resolve, reject) => {
  const request = indexedDB.open('TabKebabStash', 1);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
await new Promise((resolve, reject) => {
  const tx = db.transaction('stashes', 'readwrite');
  tx.objectStore('stashes').put({
    id: 'matrix-malformed-search', name: 'Matrix malformed search',
    createdAt: Date.now(), windows: null,
  });
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
});
db.close();
```

Require exact `Search unavailable — try again.` with `role="alert"`, empty
result caches, and no ordinary `No results found`. Delete only the malformed
record, reopen Ctrl+K, and require normal results recover:

```js
const db = await new Promise((resolve, reject) => {
  const request = indexedDB.open('TabKebabStash', 1);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
await new Promise((resolve, reject) => {
  const tx = db.transaction('stashes', 'readwrite');
  tx.objectStore('stashes').delete('matrix-malformed-search');
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
});
db.close();
```

Close all fixture tabs and delete synthetic saved records, then:

```bash
source "$release_state"; source "$matrix_lib"
matrix_stop_browser row11 no
matrix_read_outcome 11 row_actual row_result
matrix_record_row 11 "$row11_profile" \
  'three synthetic open tabs plus current-shape stash/session; one temporary malformed IndexedDB record' \
  'open Ctrl+K; search nested/no-match values; inject malformed record; reopen; remove it and recover' \
  'Ctrl+K includes open tabs+stash+session; nested match; ordinary empty distinct from unavailable alert; recovery succeeds' \
  "$row_actual" "$row_result" 'malformed record and all synthetic data/tabs removed; profile removed'
matrix_end_row 11
test "$row_result" = PASS
```

## 4. Matrix completion and guarded cleanup

Before release creation, require exactly eleven PASS sections and no failed or
blocked section. This does not infer correctness from the count; the controller
must also review every row's actual evidence.

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
release_state="/tmp/tabkebab-release-state-$(tr -d '\r\n' < VERSION).env"
test -O "$release_state" && test "$(stat -c '%a' "$release_state")" = 600
source "$release_state"; source "$matrix_lib"
test "$(grep -c '^### Matrix row [0-9][0-9] — PASS$' "$notes_file")" -eq 11
test "$(grep -c '^### Matrix row [0-9][0-9] — \(FAIL\|BLOCKED\)$' "$notes_file" || true)" -eq 0
expected_rows="$(seq -w 1 11)"
actual_rows="$(sed -n 's/^### Matrix row \([0-9][0-9]\) — PASS$/\1/p' "$notes_file" | LC_ALL=C sort)"
test "$actual_rows" = "$expected_rows"
```

Stop the shared loopback fixture and remove only its guarded helper files. Then
prove every ledger entry is numeric/dead and no disposable profile remains.

```bash
set -euo pipefail
source "$release_state"; source "$matrix_lib"
if kill -0 "$matrix_fixture_pid" 2>/dev/null; then
  cmdline="$(tr '\0' ' ' < "/proc/$matrix_fixture_pid/cmdline" 2>/dev/null || true)"
  [[ "$cmdline" == *"$matrix_fixture_script"* ]]
  kill -TERM "$matrix_fixture_pid"
  for _ in $(seq 1 50); do kill -0 "$matrix_fixture_pid" 2>/dev/null || break; sleep 0.1; done
fi
! kill -0 "$matrix_fixture_pid" 2>/dev/null

for disposable_file in "$matrix_fixture_script" "$matrix_fixture_log"; do
  case "$(realpath -m "$disposable_file")" in
    /tmp/tabkebab-matrix-*) rm -f -- "$disposable_file" ;;
    *) echo "Refusing unsafe matrix helper cleanup: $disposable_file" >&2; exit 1 ;;
  esac
done

while IFS= read -r pid; do
  [[ "$pid" =~ ^[0-9]+$ ]] || { echo "Invalid PID ledger entry" >&2; exit 1; }
  if kill -0 "$pid" 2>/dev/null; then
    echo "Matrix process still alive: $pid" >&2
    exit 1
  fi
done < "$matrix_pid_file"

for profile_key in \
  row01_profile row02_profile row03_profile row04_profile row05_profile \
  row06a_profile row06b_profile row07_profile row08_profile row09_profile \
  row10_profile row11_profile; do
  profile_path="${!profile_key}"
  case "$(realpath -m "$profile_path")" in
    /tmp/tabkebab-smoke-*) ;;
    *) echo "Unsafe recorded profile path: $profile_path" >&2; exit 1 ;;
  esac
  test ! -e "$profile_path"
done

case "$(realpath -m "$matrix_lib")" in
  /tmp/tabkebab-matrix-*) rm -f -- "$matrix_lib" ;;
  *) echo "Refusing unsafe matrix helper cleanup: $matrix_lib" >&2; exit 1 ;;
esac
```

For Row 06, separately require the throwaway Drive folder is absent, both
profiles are disconnected, and the disposable provider credential/export is
gone. Do not delete `artifact_dir`, `zip_path`, `notes_file`, `matrix_pid_file`,
or `release_state` yet; the controller retains them through GitHub release
creation and remote asset verification, then runs the brief's guarded final
cleanup. No step in this runbook uploads or publishes to the Chrome Web Store.
