#!/bin/sh
# Tests for bin/claude-org. Everything runs in a temporary home with a fake
# `claude` on PATH: no network, no login, the real home is never touched.
set -eu

fail() {
    printf 'FAIL: %s\n' "$1" >&2
    exit 1
}

pass() {
    printf 'ok - %s\n' "$1"
}

repo=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tmp=$(CDPATH= cd -P "$tmp" && pwd)
HOME=$tmp/fake\ home
export HOME
fake_repo=$tmp/repo
FAKE=$tmp/fake
export FAKE
SID=a1b2c3d4-0000-4000-8000-000000000001
two=$HOME/.claude-two

mkdir -p "$HOME/.claude" "$fake_repo/bin" "$tmp/bin" "$FAKE"
cp "$repo/bin/claude-org" "$fake_repo/bin/claude-org"
cat > "$fake_repo/orgs.json" <<'EOF'
{ "orgs": [
  { "key": "one", "name": "Org One", "configDir": "~/.claude", "environmentId": "env_one" },
  { "key": "two", "name": "", "configDir": "~/.claude-two", "environmentId": "" }
] }
EOF

# The fake claude: logs its environment and arguments, and on call N copies
# $FAKE/handoff.N (when there is one) to the handoff file the launcher gave it,
# then runs $FAKE/hook.N (when there is one). CLAUDE_ORG_CODEX_EXIT, when set,
# is logged on a line of its own.
cat > "$tmp/bin/claude" <<'EOF'
#!/bin/sh
n=$(( $(cat "$FAKE/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FAKE/count"
{
    printf 'call %s org=%s orgs=%s resumed=%s config=%s\n' "$n" "${CLAUDE_ORG-}" "${CLAUDE_ORGS-}" "${CLAUDE_ORG_RESUMED-}" "${CLAUDE_CONFIG_DIR-<unset>}"
    for a in "$@"; do printf 'arg %s\n' "$a"; done
} >> "$FAKE/log"
[ -z "${CLAUDE_ORG_CODEX_EXIT-}" ] || printf 'codex-exit %s\n' "$CLAUDE_ORG_CODEX_EXIT" >> "$FAKE/log"
if [ -f "$FAKE/handoff.$n" ]; then cp "$FAKE/handoff.$n" "$CLAUDE_ORG_HANDOFF"; fi
if [ -f "$FAKE/hook.$n" ]; then sh "$FAKE/hook.$n"; fi
exit 0
EOF
chmod +x "$tmp/bin/claude"
PATH=$tmp/bin:$PATH
export PATH

reset() { rm -f "$FAKE"/*; }
# Run the launcher with a stray CLAUDE_CONFIG_DIR in the environment, as a shell might have.
launch() { (cd "$tmp" && CLAUDE_CONFIG_DIR=/elsewhere sh "$fake_repo/bin/claude-org" "$@") > "$tmp/out" 2>&1; }
calls() { cat "$FAKE/count" 2>/dev/null || echo 0; }
expect_log() {
    printf '%s\n' "$@" > "$tmp/want"
    cmp -s "$tmp/want" "$FAKE/log" || { diff "$tmp/want" "$FAKE/log" >&2; fail "$label"; }
    pass "$label"
}
mod=$fake_repo/mods/org-switch
off='{"enabledPlugins":{"acct-switch@local-mods":false}}'

printf '# setup\n'
mkdir -p "$HOME/.claude/projects" "$HOME/.claude/skills" "$HOME/.claude/backups" "$HOME/.claude/daemon"
for f in settings.json CLAUDE.md history.jsonl .claude.json .credentials.json policy-limits.json remote-settings.json mcp-needs-auth-cache.json daemon-auth-status.json; do
    echo '{}' > "$HOME/.claude/$f"
done
echo '{}' > "$HOME/.claude/.credentials.review-sentinel"
printf '{"mcpServers":{"svc":{"command":"x","env":{"API_TOKEN":"SECRET-VALUE-123"}}},"oauthAccount":{"emailAddress":"someone@example.com"}}\n' > "$HOME/.claude.json"

# What every org shares: setup and the launcher must leave all of it as it is.
snap() { (cd "$HOME" && find .claude .claude.json -type f -exec cksum {} + | sort); }
shared=$(snap)

mkdir -p "$two" && echo keep > "$two/existing"
label='setup refuses a directory that exists and is not empty'
if (printf 'n\n' | sh "$fake_repo/bin/claude-org" setup two) > "$tmp/out" 2>&1; then fail "$label"; fi
grep -q 'already exists and is not empty' "$tmp/out" || fail "$label: message"
[ "$(ls -A "$two")" = existing ] && [ "$(cat "$two/existing")" = keep ] || fail "$label: contents changed"
pass "$label"
rm -rf "$two"

label='setup links everything but the account state, and asks before copying MCP servers'
printf 'n\n' | sh "$fake_repo/bin/claude-org" setup two > "$tmp/out" 2>&1 || { cat "$tmp/out" >&2; fail "$label"; }
for name in projects skills settings.json CLAUDE.md history.jsonl; do
    [ -L "$two/$name" ] && [ "$(readlink "$two/$name")" = "$HOME/.claude/$name" ] || fail "$label: $name not linked"
done
for name in .claude.json .credentials.json backups daemon policy-limits.json remote-settings.json mcp-needs-auth-cache.json daemon-auth-status.json; do
    [ ! -e "$two/$name" ] && [ ! -L "$two/$name" ] || fail "$label: $name was linked or copied"
done
grep -q 'MCP servers not copied' "$tmp/out" || fail "$label: did not ask"
grep -q "CLAUDE_CONFIG_DIR='$two' command claude auth login" "$tmp/out" || fail "$label: no login hint"
pass "$label"

label='setup leaves out the whole .credentials* family, backups included'
[ ! -e "$two/.credentials.review-sentinel" ] && [ ! -L "$two/.credentials.review-sentinel" ] || fail "$label"
pass "$label"

label='setup copies the MCP servers when told yes, without printing them'
rm -rf "$two"
printf 'y\n' | sh "$fake_repo/bin/claude-org" setup two > "$tmp/out" 2>&1 || { cat "$tmp/out" >&2; fail "$label"; }
python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); assert list(d) == ["mcpServers"] and d["mcpServers"]["svc"]["env"]["API_TOKEN"] == "SECRET-VALUE-123"' "$two/.claude.json" || fail "$label: wrong file"
[ "$(ls -l "$two/.claude.json" | cut -c1-10)" = '-rw-------' ] || fail "$label: file not private"
if grep -q 'SECRET-VALUE-123\|someone@' "$tmp/out"; then fail "$label: printed contents"; fi
pass "$label"

printf '# launcher\n'
reset
label='plain start: default-directory org runs with CLAUDE_CONFIG_DIR unset, acct-switch off, mod loaded'
launch one -p hi
expect_log 'call 1 org=one orgs=one,two resumed= config=<unset>' "arg --plugin-dir" "arg $mod" 'arg --settings' "arg $off" 'arg -p' 'arg hi'

reset
label='restart drops -c and --resume <id>, keeps the rest, resumes under the other org'
printf 'next=two\nsession=%s\nreason=one: 5h window at 95%%\n' "$SID" > "$FAKE/handoff.1"
launch one -c --model opus --resume old-id -p 'two words' --session-id=x --verbose
expect_log \
    'call 1 org=one orgs=one,two resumed=1 config=<unset>' "arg --plugin-dir" "arg $mod" 'arg --settings' "arg $off" \
    'arg -c' 'arg --model' 'arg opus' 'arg --resume' 'arg old-id' 'arg -p' 'arg two words' 'arg --session-id=x' 'arg --verbose' \
    "call 2 org=two orgs=one,two resumed=1 config=$two" "arg --plugin-dir" "arg $mod" 'arg --settings' "arg $off" \
    'arg --resume' "arg $SID" 'arg --model' 'arg opus' 'arg -p' 'arg two words' 'arg --verbose'
grep -q "one -> two, resuming $SID (one: 5h window at 95%)" "$tmp/out" || fail 'restart message'

reset
label='a fresh handoff starts a new session under the other org'
printf 'next=two\nfresh=1\n' > "$FAKE/handoff.1"
launch one
[ "$(calls)" = 2 ] && grep -q 'one -> two, new session' "$tmp/out" || fail "$label"
pass "$label"

for bad in 'BAD!' 'nosuch' "\$(touch $tmp/pwned)"; do
    reset
    label="handoff naming org '$bad' stops without a restart"
    printf 'next=%s\nsession=%s\n' "$bad" "$SID" > "$FAKE/handoff.1"
    launch one
    [ "$(calls)" = 1 ] && grep -q 'names an org that cannot start; stopping' "$tmp/out" && [ ! -e "$tmp/pwned" ] || fail "$label"
    pass "$label"
done

reset
label='handoff session id that is not a UUID stops without a restart'
printf 'next=two\nsession=not-a-uuid\n' > "$FAKE/handoff.1"
launch one
[ "$(calls)" = 1 ] && grep -q 'not a UUID; stopping' "$tmp/out" || fail "$label"
pass "$label"

reset
label='an org whose directory is missing cannot start'
rm -rf "$two"
if launch two; then fail "$label"; fi
[ "$(calls)" = 0 ] && grep -q 'run: claude-org setup two' "$tmp/out" || fail "$label"
pass "$label"
mkdir -p "$two"

reset
label='a handoff to an org whose directory has gone since the start stops without a restart'
printf 'next=two\nsession=%s\n' "$SID" > "$FAKE/handoff.1"
printf 'rm -rf "%s"\n' "$two" > "$FAKE/hook.1"
launch one
[ "$(calls)" = 1 ] && grep -q 'names an org that cannot start; stopping' "$tmp/out" || { cat "$tmp/out" >&2; fail "$label"; }
pass "$label"
mkdir -p "$two"

reset
label='everything after -- is kept as it is across a restart'
printf 'next=two\nsession=%s\n' "$SID" > "$FAKE/handoff.1"
launch one --verbose -- --resume 'keep as prompt' --session-id=literal -c x=y
expect_log \
    'call 1 org=one orgs=one,two resumed= config=<unset>' "arg --plugin-dir" "arg $mod" 'arg --settings' "arg $off" \
    'arg --verbose' 'arg --' 'arg --resume' 'arg keep as prompt' 'arg --session-id=literal' 'arg -c' 'arg x=y' \
    "call 2 org=two orgs=one,two resumed=1 config=$two" "arg --plugin-dir" "arg $mod" 'arg --settings' "arg $off" \
    'arg --resume' "arg $SID" 'arg --verbose' 'arg --' 'arg --resume' 'arg keep as prompt' 'arg --session-id=literal' 'arg -c' 'arg x=y'

label='two orgs resolving to one physical directory: neither starts'
rm -rf "$two" && ln -s "$HOME/.claude" "$two"
for o in one two; do
    reset
    if launch "$o"; then fail "$label: $o started"; fi
    [ "$(calls)" = 0 ] && grep -q 'same directory' "$tmp/out" || { cat "$tmp/out" >&2; fail "$label: $o"; }
done
pass "$label"
rm "$two" && mkdir -p "$two"

label='an org directory spelled with other letter case is the same login directory: neither setup nor a start goes ahead'
if [ -d "$HOME/.CLAUDE" ]; then
    cp "$fake_repo/orgs.json" "$tmp/orgs.saved"
    sed 's#~/.claude-two#~/.CLAUDE#' "$tmp/orgs.saved" > "$fake_repo/orgs.json"
    reset
    if launch one; then fail "$label: started"; fi
    [ "$(calls)" = 0 ] && grep -q 'same directory' "$tmp/out" || { cat "$tmp/out" >&2; fail "$label: start"; }
    if (printf 'n\n' | sh "$fake_repo/bin/claude-org" setup two) > "$tmp/out" 2>&1; then fail "$label: setup went ahead"; fi
    grep -q 'same directory' "$tmp/out" || { cat "$tmp/out" >&2; fail "$label: setup"; }
    cp "$tmp/orgs.saved" "$fake_repo/orgs.json"
    pass "$label"
else
    printf 'skip - %s (this file system tells letter case apart)\n' "$label"
fi

label='setup and the launcher wrote nothing into the shared directory (settings file included)'
[ "$(snap)" = "$shared" ] || fail "$label"
pass "$label"

reset
label='no org named: skips the one the records show spent, starts on the free one'
mkdir -p "$HOME/.claude/plugins/store"
python3 -I - "$HOME/.claude/plugins/store/org-switch_local.json" <<'PY'
import json, sys, time
soon = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + 3600))
json.dump({'ledger:one': {'seenAt': 1, 'windows': {'five_hour': {'percentUsed': 100, 'resetsAt': soon}}}}, open(sys.argv[1], 'w'))
PY
launch
[ "$(sed -n 1p "$FAKE/log")" = "call 1 org=two orgs=one,two resumed= config=$two" ] && grep -q 'starting on two' "$tmp/out" || fail "$label"
pass "$label"

reset
label='no org named: a newer store file that is empty is skipped for the older one with readings'
touch -t 202001010000 "$HOME/.claude/plugins/store/org-switch_local.json"
: > "$HOME/.claude/plugins/store/org-switch_newer.json"
launch
[ "$(sed -n 1p "$FAKE/log")" = "call 1 org=two orgs=one,two resumed= config=$two" ] || { cat "$tmp/out" >&2; fail "$label"; }
pass "$label"

reset
label='no org named: a dangling link and a file whose windows are not a table are skipped'
ln -s "$tmp/nowhere" "$HOME/.claude/plugins/store/org-switch_dangling.json"
printf '{"ledger:two":{"seenAt":5,"windows":[1,2]}}' > "$HOME/.claude/plugins/store/org-switch_badwin.json"
launch
[ "$(sed -n 1p "$FAKE/log")" = "call 1 org=two orgs=one,two resumed= config=$two" ] && ! grep -q Traceback "$tmp/out" || { cat "$tmp/out" >&2; fail "$label"; }
rm -f "$HOME/.claude/plugins/store/org-switch_dangling.json" "$HOME/.claude/plugins/store/org-switch_badwin.json"
pass "$label"

printf '# quota-status\n'
qs() { (unset CLAUDE_ORG; sh "$repo/bin/quota-status") > "$tmp/out" 2>&1; }
store=$HOME/.claude/plugins/store
rm -rf "$store"

label='quota-status with no store file says there is no reading yet and exits 0'
qs || fail "$label: exit code"
[ "$(cat "$tmp/out")" = '还没有读数' ] || { cat "$tmp/out" >&2; fail "$label"; }
pass "$label"

mkdir -p "$store"
write_store() {
    python3 -I - "$store/org-switch_local.json" "$1" <<'PY'
import json, sys, time
now = time.time() * 1000
iso = lambda ms: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(ms / 1000))
d = {
    'ledger:one': {'seenAt': now - 2 * 60000, 'windows': {
        'five_hour': {'percentUsed': 81, 'resetsAt': iso(now + 90 * 60000 + 30000)},
        'seven_day': {'percentUsed': 40, 'resetsAt': iso(now + 3 * 86400000 + 30000)}}},
    'ledger:two': {'seenAt': now - 10 * 60000, 'windows': {'five_hour': {'percentUsed': 12, 'resetsAt': iso(now + 50 * 60000 + 30000)}}},
}
if sys.argv[2] == 'saving':
    d['saving:one'] = {'since': now, 'softAt': 80}
json.dump(d, open(sys.argv[1], 'w'))
PY
}

label='quota-status prints the current org, its windows, saving off, and the other org'
write_store normal
qs || fail "$label: exit code"
printf '%s\n' 'org: one' 'one: 5h 81% (resets in 1.5 h), 7d 40% (resets in 3 d); seen 2 min ago' '省额度模式: 关' 'two: 5h 12% (resets in 50 min); seen 10 min ago' > "$tmp/want"
cmp -s "$tmp/want" "$tmp/out" || { diff "$tmp/want" "$tmp/out" >&2; fail "$label"; }
pass "$label"

label='quota-status shows saving mode on, and follows CLAUDE_ORG'
write_store saving
qs || fail "$label: exit code"
grep -qx '省额度模式: 开' "$tmp/out" || { cat "$tmp/out" >&2; fail "$label"; }
(CLAUDE_ORG=two sh "$repo/bin/quota-status") > "$tmp/out" 2>&1
[ "$(sed -n 1p "$tmp/out")" = 'org: two' ] && grep -qx '省额度模式: 关' "$tmp/out" || { cat "$tmp/out" >&2; fail "$label: CLAUDE_ORG"; }
pass "$label"

label='quota-status with an empty or broken store file says so in one line and exits 0'
for content in '' '{broken'; do
    printf '%s' "$content" > "$store/org-switch_local.json"
    qs || fail "$label: exit code with '$content'"
    [ "$(wc -l < "$tmp/out" | tr -d ' ')" = 1 ] && ! grep -q Traceback "$tmp/out" || { cat "$tmp/out" >&2; fail "$label: '$content'"; }
done
pass "$label"

label='quota-status skips newer files with no reading for the older one that has one'
write_store normal
touch -t 202001010000 "$store/org-switch_local.json"
: > "$store/org-switch_empty.json"
echo '{}' > "$store/org-switch_blank.json"
qs || fail "$label: exit code"
[ "$(sed -n 1p "$tmp/out")" = 'org: one' ] || { cat "$tmp/out" >&2; fail "$label"; }
pass "$label"

label='quota-status skips a dangling link and a file whose windows are not a table'
ln -s "$tmp/nowhere" "$store/org-switch_dangling.json"
printf '{"ledger:two":{"seenAt":5,"windows":[1,2]}}' > "$store/org-switch_badwin.json"
qs || { cat "$tmp/out" >&2; fail "$label: exit code"; }
[ "$(sed -n 1p "$tmp/out")" = 'org: one' ] && grep -q '^two: 5h 12%' "$tmp/out" && ! grep -q Traceback "$tmp/out" || { cat "$tmp/out" >&2; fail "$label"; }
rm -f "$store/org-switch_dangling.json" "$store/org-switch_badwin.json"
pass "$label"

# A checkout of its own: bin/quota-status beside an orgs.json that names T3 instances,
# reached through a link from another directory; and one with no orgs.json at all.
qrepo=$tmp/qrepo
mkdir -p "$qrepo/bin" "$tmp/qnoorgs/bin" "$tmp/qlink"
cp "$repo/bin/quota-status" "$qrepo/bin/quota-status"
cp "$repo/bin/quota-status" "$tmp/qnoorgs/bin/quota-status"
ln -s "$qrepo/bin/quota-status" "$tmp/qlink/quota-status"
cat > "$qrepo/orgs.json" <<'EOF'
{ "orgs": [
  { "key": "one", "name": "", "configDir": "~/.claude", "environmentId": "", "t3Instance": "claudeAgent" },
  { "key": "two", "name": "", "configDir": "~/.claude-two", "environmentId": "", "t3Instance": "claude-org2" }
] }
EOF
# Every store file emptied of readings (a file with none is skipped).
blank_store() { for f in "$store"/org-switch_*.json; do echo '{}' > "$f"; done; }
# put FILE ORG 5H% SEEN_MIN_AGO RESET_IN_MIN [saving]: add one org's reading to a store file.
put() {
    python3 -I - "$store/org-switch_$1.json" "$2" "$3" "$4" "$5" "${6-}" <<'PY'
import json, sys, time
p, org, pct, ago, reset, saving = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]), sys.argv[6]
now = time.time() * 1000
iso = lambda ms: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(ms / 1000))
try:
    d = json.load(open(p))
except (OSError, ValueError):
    d = {}
d['ledger:' + org] = {'seenAt': now - ago * 60000, 'windows': {'five_hour': {'percentUsed': pct, 'resetsAt': iso(now + reset * 60000 + 30000)}}}
if saving:
    d['saving:' + org] = {'since': now, 'softAt': 80}
json.dump(d, open(p, 'w'))
PY
}
qrun() { (CLAUDE_ORG=one sh "$1") > "$tmp/out" 2>&1; }

label="quota-status reads every store file and takes each org's newest reading, with its saving mark"
blank_store
put plugindir one 81 2 90
put plugindir two 70 60 50
put envdirs two 12 5 50
put envdirs one 99 30 90 saving
qrun "$tmp/qlink/quota-status" || fail "$label: exit code"
printf '%s\n' 'org: one' 'one: 5h 81% (resets in 1.5 h); seen 2 min ago' '省额度模式: 关' 'two: 5h 12% (resets in 50 min); seen 5 min ago' > "$tmp/want"
cmp -s "$tmp/want" "$tmp/out" || { diff "$tmp/want" "$tmp/out" >&2; fail "$label"; }
pass "$label"

label='quota-status, current org at the hard threshold and another free: names it and its T3 instance, through a link'
blank_store
put a one 100 1 120
put b two 12 5 50
qrun "$tmp/qlink/quota-status" || fail "$label: exit code"
[ "$(sed -n '$p' "$tmp/out")" = '建议换到: two（T3 实例 claude-org2）' ] && [ "$(wc -l < "$tmp/out" | tr -d ' ')" = 5 ] || { cat "$tmp/out" >&2; fail "$label"; }
pass "$label"

label='quota-status with no orgs.json: names the org without an instance, no error'
qrun "$tmp/qnoorgs/bin/quota-status" || fail "$label: exit code"
[ "$(sed -n '$p' "$tmp/out")" = '建议换到: two' ] && ! grep -q Traceback "$tmp/out" || { cat "$tmp/out" >&2; fail "$label"; }
pass "$label"

label="quota-status: the other org's full window has reset since, so it is free"
put b two 100 30 -10
qrun "$tmp/qlink/quota-status" || fail "$label: exit code"
[ "$(sed -n '$p' "$tmp/out")" = '建议换到: two（T3 实例 claude-org2）' ] || { cat "$tmp/out" >&2; fail "$label"; }
pass "$label"

label='quota-status, every org limited: says none and when the first frees'
put b two 100 5 50
qrun "$tmp/qlink/quota-status" || fail "$label: exit code"
[ "$(sed -n '$p' "$tmp/out")" = '建议换到: 无（都受限，最早 50 min 后恢复）' ] || { cat "$tmp/out" >&2; fail "$label"; }
pass "$label"

label="quota-status: a bad entry in a file does not hide the good one beside it (the other org's newer full reading still counts)"
blank_store
put a one 100 1 120
put a two 12 60 50
put b two 100 2 200
python3 -I -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["ledger:three"]={"windows":"nope"}; json.dump(d,open(p,"w"))' "$store/org-switch_b.json"
qrun "$tmp/qlink/quota-status" || fail "$label: exit code"
sed -n '$p' "$tmp/out" | grep -q '^建议换到: 无（都受限' || { cat "$tmp/out" >&2; fail "$label"; }
pass "$label"

label='quota-status: a full window that does not say when it resets is never suggested'
blank_store
put a one 100 1 120
put b two 100 2 200
python3 -I -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); del d["ledger:two"]["windows"]["five_hour"]["resetsAt"]; json.dump(d,open(p,"w"))' "$store/org-switch_b.json"
qrun "$tmp/qlink/quota-status" || fail "$label: exit code"
sed -n '$p' "$tmp/out" | grep -q '^建议换到: 无（都受限' || { cat "$tmp/out" >&2; fail "$label"; }
pass "$label"

label='quota-status: an org every model is held off on is not suggested until the hold ends'
blank_store
put a one 100 1 120
put b two 12 5 50
python3 -I -c 'import json,sys,time; p=sys.argv[1]; d=json.load(open(p)); d["block:two"]={"kind":"all","until":time.time()*1000+600000}; json.dump(d,open(p,"w"))' "$store/org-switch_b.json"
qrun "$tmp/qlink/quota-status" || fail "$label: exit code"
sed -n '$p' "$tmp/out" | grep -q '^建议换到: 无（都受限，最早 10 min 后恢复）' || { cat "$tmp/out" >&2; fail "$label"; }
pass "$label"

label='quota-status, current org under the hard threshold: no suggestion line'
put a one 94 1 120
qrun "$tmp/qlink/quota-status" || fail "$label: exit code"
! grep -q '建议换到' "$tmp/out" && [ "$(wc -l < "$tmp/out" | tr -d ' ')" = 4 ] || { cat "$tmp/out" >&2; fail "$label"; }
pass "$label"

printf '# Codex takeover\n'
# The fake codex and sleep live in their own directory, on PATH only here.
cbin=$tmp/cbin
mkdir -p "$cbin"
cat > "$cbin/codex" <<'CODEX'
#!/bin/sh
# Fake codex: logs its arguments, its directory and how many times claude has
# run so far, runs $FAKE/codex.do there (when there is one), and exits with
# $FAKE/codex.rc (default 0). With $FAKE/codex.int it is "Ctrl-C'd": the
# launcher gets SIGINT too, as from the terminal, and codex exits 130.
{ printf 'codex arg %s\n' "$@"; printf 'codex cwd %s\n' "$(pwd -P)"; printf 'codex claude-calls %s\n' "$(cat "$FAKE/count")"; } >> "$FAKE/log"
[ ! -f "$FAKE/codex.do" ] || . "$FAKE/codex.do"
if [ -f "$FAKE/codex.int" ]; then kill -INT "$PPID"; exit 130; fi
exit "$(cat "$FAKE/codex.rc" 2>/dev/null || echo 0)"
CODEX
cat > "$cbin/sleep" <<'SLEEP'
#!/bin/sh
# Fake sleep: records how long it was asked to wait; with $FAKE/sleep.int the person presses Ctrl-C.
echo sleep >> "$FAKE/log"
echo "$1" > "$FAKE/slept"
[ ! -f "$FAKE/sleep.int" ] || kill -INT "$PPID"
SLEEP
chmod +x "$cbin/codex" "$cbin/sleep"
work="$tmp/it's a repo"
git init -q "$work"
gitw() { git -C "$work" -c user.name=t -c user.email=t@example.invalid "$@"; }
echo notes > "$work/.handoff.md"; gitw add .handoff.md; gitw commit -qm handoff
work=$(CDPATH= cd -P "$work" && pwd)
launch_codex() { (cd "$work" && PATH=$cbin:$PATH sh "$fake_repo/bin/claude-org" "$@") > "$tmp/out" 2>&1; }
# The handoff the mod writes when it hands the time to Codex; $1: resume time, seconds from now.
codex_handoff() {
    printf 'next=two\nsession=%s\ncodex=1\nuntil=%s\nreason=every org limited\n' "$SID" "$(( $(date +%s) + $1 ))" > "$FAKE/handoff.1"
}
reset_codex() { reset; git -C "$work" checkout -q -- . && git -C "$work" clean -qfd; }
prompt='读 .handoff.md，只做其中标为非界面的单元。只改文件：不要 git add、不要提交、不要推送。做完把做了什么追加写进仓库根目录的 .codex-takeover-notes.md。'

reset_codex
label='Codex runs in the foreground here before Claude is started again; the launcher waits for the reset, then resumes with the exit code'
codex_handoff 120
echo 3 > "$FAKE/codex.rc"
launch_codex one --model opus -- 'keep this'
expect_log \
    'call 1 org=one orgs=one,two resumed= config=<unset>' "arg --plugin-dir" "arg $mod" 'arg --settings' "arg $off" 'arg --model' 'arg opus' 'arg --' 'arg keep this' \
    'codex arg exec' 'codex arg -C' "codex arg $work" 'codex arg -s' 'codex arg workspace-write' 'codex arg -m' 'codex arg gpt-6.2-astra' "codex arg $prompt" \
    "codex cwd $work" 'codex claude-calls 1' \
    'sleep' \
    "call 2 org=two orgs=one,two resumed=1 config=$two" "arg --plugin-dir" "arg $mod" 'arg --settings' "arg $off" \
    'arg --resume' "arg $SID" 'arg --model' 'arg opus' 'arg --' 'arg keep this' 'codex-exit 3'
slept=$(cat "$FAKE/slept")
[ "$slept" -ge 115 ] && [ "$slept" -le 120 ] || fail "waited $slept s, not until the reset"
pass 'the wait lasts until the resume time'

reset_codex
label='the resume time has passed when Codex exits: no wait'
codex_handoff -60
launch_codex one
[ "$(calls)" = 2 ] && [ ! -e "$FAKE/slept" ] && grep -qx 'codex-exit 0' "$FAKE/log" || { cat "$tmp/out" >&2; fail "$label"; }
pass "$label"

reset_codex
label='Codex leaves the tree dirty even when it changes nothing (the notes file), so the next limit hands nothing over'
codex_handoff -60
launch_codex one
[ -n "$(git -C "$work" status --porcelain)" ] || fail "$label: tree clean"
grep -qx 'Codex 退出码 0' "$work/.codex-takeover-notes.md" || fail "$label: no exit code in the notes"
pass "$label"

reset_codex
label='Ctrl-C while Codex runs: Codex stops, the launcher is not killed and resumes Claude with exit code 130'
codex_handoff -60
: > "$FAKE/codex.int"
launch_codex one || true
[ "$(calls)" = 2 ] && grep -qx 'codex-exit 130' "$FAKE/log" || { cat "$tmp/out" >&2; fail "$label"; }
pass "$label"

reset_codex
label='Ctrl-C during the wait: stops there without starting Claude and says how to resume'
codex_handoff 600
: > "$FAKE/sleep.int"
set +e; launch_codex one; rc=$?; set -e
[ "$rc" = 130 ] && [ "$(calls)" = 1 ] || { cat "$tmp/out" >&2; fail "$label (exit $rc)"; }
grep -q "review git status, then run: claude-org two --resume $SID" "$tmp/out" || { cat "$tmp/out" >&2; fail "$label: no hint"; }
pass "$label"

reset_codex
label='a resume time that is not a number: stops without running Codex'
printf 'next=two\nsession=%s\ncodex=1\nuntil=soon\n' "$SID" > "$FAKE/handoff.1"
launch_codex one || true
[ "$(calls)" = 1 ] && ! grep -q '^codex' "$FAKE/log" && grep -q 'resume time is not a number' "$tmp/out" || { cat "$tmp/out" >&2; fail "$label"; }
pass "$label"

reset_codex
label='an ordinary switch never runs Codex and never sets the exit code'
printf 'next=two\nsession=%s\n' "$SID" > "$FAKE/handoff.1"
launch_codex one
[ "$(calls)" = 2 ] && ! grep -q '^codex' "$FAKE/log" && [ ! -e "$work/.codex-takeover-notes.md" ] || { cat "$tmp/out" >&2; fail "$label"; }
pass "$label"

printf '# when Codex may take over (the mod check, run against real git)\n'
awk '/^export const CODEX_READY_SH = `/ { on = 1; sub(/^.*= `/, "") } on && /`$/ { sub(/`$/, ""); print; exit } on' \
    "$repo/mods/org-switch/hooks/register.ts" > "$tmp/ready.sh"
grep -q 'handoff.md' "$tmp/ready.sh" || fail 'could not extract the readiness check'
mkdir -p "$tmp/gitonly" && ln -sf "$(command -v git)" "$tmp/gitonly/git"
ready_rc() { set +e; (cd "$1" && PATH=$2 sh "$tmp/ready.sh") > /dev/null 2>&1; r=$?; set -e; echo "$r"; }
with_codex=$cbin:$tmp/gitonly:/usr/bin:/bin
reset_codex
label='clean repository with .handoff.md and codex installed: ready'
[ "$(ready_rc "$work" "$with_codex")" = 0 ] || fail "$label"
pass "$label"
label='uncommitted changes: not ready'
echo change >> "$work/.handoff.md"
[ "$(ready_rc "$work" "$with_codex")" = 5 ] || fail "$label"
git -C "$work" checkout -q -- .
echo x > "$work/untracked"
[ "$(ready_rc "$work" "$with_codex")" = 5 ] || fail "$label (untracked file)"
rm "$work/untracked"
pass "$label"
label='codex not installed: not ready'
[ "$(ready_rc "$work" "$tmp/gitonly:/usr/bin:/bin")" = 6 ] || fail "$label"
pass "$label"
label='no .handoff.md: not ready'
mkdir -p "$tmp/bare" && git init -q "$tmp/bare"
[ "$(ready_rc "$tmp/bare" "$with_codex")" = 4 ] || fail "$label"
pass "$label"
label='not in a git repository: not ready'
mkdir -p "$tmp/plain"
[ "$(GIT_CEILING_DIRECTORIES=$tmp ready_rc "$tmp/plain" "$with_codex")" = 3 ] || fail "$label"
pass "$label"
reset_codex
label='a resume time years away: no Codex, no wait, the launcher stops'
codex_handoff 193456000
if launch_codex one; then :; fi
[ "$(calls)" = 1 ] && ! grep -q '^codex ' "$FAKE/log" && [ ! -e "$FAKE/slept" ] && grep -q 'more than 8 days' "$tmp/out" ||
    { cat "$tmp/out" >&2; fail "$label"; }
pass "$label"

printf 'all claude-org tests passed\n'
