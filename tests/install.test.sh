#!/bin/sh
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
fake_repo=$tmp/fake\ repo
HOME=$tmp/fake\ home
export HOME
config=$HOME/.claude
begin='<!-- BEGIN multi-model-kit -->'
end='<!-- END multi-model-kit -->'
rule='Example global rule.'

mkdir -p "$fake_repo/rules" "$HOME"
for skill in prompt-library dispatch task-handoff; do
    mkdir -p "$fake_repo/skills/$skill"
done
printf '%s\n' "$rule" > "$fake_repo/rules/multi-model.md"
cp "$repo/install.sh" "$fake_repo/install.sh" || fail 'could not copy the installer into the fixture'

install() {
    (cd "$tmp" && sh "$fake_repo/install.sh" "$@")
}

reports() {
    grep -Fx "$1" "$tmp/check.out" >/dev/null || fail "missing check output: $1"
    pass "check reports $1"
}

same_file() {
    cmp -s "$1" "$2" || fail "$3"
    pass "$3"
}

printf '# Fresh home\n'
tar -cf "$tmp/before.tar" -C "$HOME" .
install --check > "$tmp/check.out"
for skill in prompt-library dispatch task-handoff; do
    reports "skill $skill: missing"
done
reports 'rules CLAUDE.md: missing'
tar -cf "$tmp/after.tar" -C "$HOME" .
same_file "$tmp/before.tar" "$tmp/after.tar" 'fresh home is unchanged by --check'

printf '# First install and rerun\n'
install
for skill in prompt-library dispatch task-handoff; do
    target=$config/skills/$skill
    [ -L "$target" ] && [ "$(readlink "$target")" = "$fake_repo/skills/$skill" ] ||
        fail "wrong link for $skill"
    pass "$skill links to its source directory"
done
printf '%s\n%s\n%s\n' "$begin" "$rule" "$end" > "$tmp/expected"
same_file "$tmp/expected" "$config/CLAUDE.md" 'first install writes the rules between the markers'
install
same_file "$tmp/expected" "$config/CLAUDE.md" 'rerun keeps the same bytes and one marker pair'

printf '# Existing user content\n'
printf '# Personal rules  \r\n\nKeep this line.  ' > "$tmp/original"
cp "$tmp/original" "$config/CLAUDE.md"
{
    cat "$tmp/original"
    printf '\n%s\n%s\n%s\n' "$begin" "$rule" "$end"
} > "$tmp/expected"
install
same_file "$tmp/expected" "$config/CLAUDE.md" 'append keeps existing user bytes, even without a final newline'

{
    printf '# Personal rules  \r\n\n%s\nOld rule line one.\nOld rule line two.\n%s\n' "$begin" "$end"
    printf '\nKeep this line.  \r\nNo final newline.'
} > "$config/CLAUDE.md"
{
    printf '# Personal rules  \r\n\n%s\n%s\n%s\n' "$begin" "$rule" "$end"
    printf '\nKeep this line.  \r\nNo final newline.'
} > "$tmp/expected"
install
same_file "$tmp/expected" "$config/CLAUDE.md" 'replacement preserves surrounding bytes exactly'

printf '# Check an installed home\n'
tar -cf "$tmp/before.tar" -C "$HOME" .
install --check > "$tmp/check.out"
for skill in prompt-library dispatch task-handoff; do
    reports "skill $skill: installed"
done
reports 'rules CLAUDE.md: installed'
tar -cf "$tmp/after.tar" -C "$HOME" .
same_file "$tmp/before.tar" "$tmp/after.tar" 'installed home is unchanged by --check'

printf '# Conflict\n'
HOME=$tmp/conflict\ home
config=$HOME/.claude
mkdir -p "$config/skills/prompt-library"
printf 'User skill\n' > "$config/skills/prompt-library/SKILL.md"
cp "$config/skills/prompt-library/SKILL.md" "$tmp/user-skill"
if install > "$tmp/conflict.out" 2>&1; then
    fail 'install succeeded despite an existing user skill directory'
fi
grep -F 'prompt-library' "$tmp/conflict.out" >/dev/null || fail 'conflict error did not name the skill'
pass 'install rejects a conflicting directory and names the skill'
[ -d "$config/skills/prompt-library" ] && [ ! -L "$config/skills/prompt-library" ] ||
    fail 'conflicting directory was replaced'
same_file "$tmp/user-skill" "$config/skills/prompt-library/SKILL.md" 'conflicting directory retains its contents'
install --check > "$tmp/check.out"
reports 'skill prompt-library: conflict'

printf '# Skill link pointing elsewhere\n'
HOME=$tmp/elsewhere\ home
config=$HOME/.claude
mkdir -p "$config/skills" "$tmp/other skill"
ln -s "$tmp/other skill" "$config/skills/dispatch"
if install > "$tmp/conflict.out" 2>&1; then
    fail 'install succeeded despite a skill link pointing elsewhere'
fi
grep -F 'Cannot install skill dispatch' "$tmp/conflict.out" >/dev/null ||
    fail 'conflict error did not name the foreign skill link'
[ "$(readlink "$config/skills/dispatch")" = "$tmp/other skill" ] || fail 'foreign skill link was changed'
pass 'install rejects a skill link pointing elsewhere and leaves it alone'

printf '# CLAUDE.md is a symbolic link\n'
HOME=$tmp/link\ home
config=$HOME/.claude
mkdir -p "$config" "$tmp/linked"
printf 'Linked user rules.\n' > "$tmp/linked/CLAUDE.md"
ln -s "$tmp/linked/CLAUDE.md" "$config/CLAUDE.md"
install
[ -L "$config/CLAUDE.md" ] || fail 'CLAUDE.md link was replaced by a regular file'
pass 'CLAUDE.md stays a symbolic link'
printf 'Linked user rules.\n%s\n%s\n%s\n' "$begin" "$rule" "$end" > "$tmp/expected"
same_file "$tmp/expected" "$tmp/linked/CLAUDE.md" 'rules are written through the link to the real file'

printf '# Unpaired marker\n'
HOME=$tmp/unpaired\ home
config=$HOME/.claude
mkdir -p "$config"
printf 'top\n%s\nold\nUSER KEEP ME\n' "$begin" > "$config/CLAUDE.md"
cp "$config/CLAUDE.md" "$tmp/original"
if install > "$tmp/unpaired.out" 2>&1; then
    fail 'install succeeded despite an unpaired marker'
fi
same_file "$tmp/original" "$config/CLAUDE.md" 'unpaired marker stops the install and keeps user bytes'
[ ! -e "$config/skills" ] || fail 'skills were linked despite an unpaired marker'
pass 'unpaired marker stops the install before any skill is linked'
install --check > "$tmp/check.out"
reports 'rules CLAUDE.md: conflict'

printf '# Skip tools without a config directory\n'
HOME=$tmp/skipped\ home
mkdir -p "$HOME/.agents/skills/dispatch"
install --check > "$tmp/check.out"
for tool in Codex Gemini; do
    for skill in prompt-library dispatch task-handoff; do
        reports "$tool skill $skill: skipped"
    done
done
reports 'Codex rules AGENTS.md: skipped'
reports 'Gemini rules GEMINI.md: skipped'
tar -cf "$tmp/before.tar" -C "$HOME" .agents
install
tar -cf "$tmp/after.tar" -C "$HOME" .agents
same_file "$tmp/before.tar" "$tmp/after.tar" 'skipping Codex leaves the shared skill directory alone'
[ ! -e "$HOME/.codex" ] && [ ! -e "$HOME/.gemini" ] ||
    fail 'install created a config directory for a skipped tool'
pass 'install skips absent Codex and Gemini config directories'

printf '# First install and rerun with Codex and Gemini\n'
HOME=$tmp/multi-tool\ home
codex_file=$HOME/.codex/AGENTS.md
gemini_file=$HOME/.gemini/GEMINI.md
mkdir -p "$HOME/.codex" "$HOME/.gemini"
install --check > "$tmp/check.out"
for tool in Codex Gemini; do
    for skill in prompt-library dispatch task-handoff; do
        reports "$tool skill $skill: missing"
    done
done
reports 'Codex rules AGENTS.md: missing'
reports 'Gemini rules GEMINI.md: missing'
install
printf '%s\n%s\n%s\n' "$begin" "$rule" "$end" > "$tmp/expected"
same_file "$tmp/expected" "$codex_file" 'first install writes the Codex rules'
same_file "$tmp/expected" "$gemini_file" 'first install writes the Gemini rules'
for skill_dir in "$HOME/.agents/skills" "$HOME/.gemini/skills"; do
    for skill in prompt-library dispatch task-handoff; do
        link=$skill_dir/$skill
        [ -L "$link" ] && [ "$(readlink "$link")" = "$fake_repo/skills/$skill" ] ||
            fail "wrong target for $link"
    done
    pass "all skills link to their sources in ${skill_dir#"$HOME"/}"
done
install
same_file "$tmp/expected" "$codex_file" 'Codex rerun keeps the same bytes and one marker pair'
same_file "$tmp/expected" "$gemini_file" 'Gemini rerun keeps the same bytes and one marker pair'
install --check > "$tmp/check.out"
for tool in Codex Gemini; do
    for skill in prompt-library dispatch task-handoff; do
        reports "$tool skill $skill: installed"
    done
done
reports 'Codex rules AGENTS.md: installed'
reports 'Gemini rules GEMINI.md: installed'

printf '# Existing Codex and Gemini user content\n'
for file in "$codex_file" "$gemini_file"; do
    filename=${file##*/}
    mkdir -p "$tmp/${filename%.md}"
    linked_file=$tmp/${filename%.md}/user.md
    printf '# Personal rules  \r\n\nUser text without a final newline.  ' > "$linked_file"
    {
        cat "$linked_file"
        printf '\n%s\n%s\n%s\n' "$begin" "$rule" "$end"
    } > "$tmp/expected"
    rm "$file"
    ln -s "$linked_file" "$file"
    install
    [ "$(readlink "$file")" = "$linked_file" ] || fail "$filename link was changed"
    same_file "$tmp/expected" "$linked_file" "$filename appends through the link and preserves existing user bytes"

    {
        printf '# Personal rules  \r\n\n%s\nOld rule.\n%s\n' "$begin" "$end"
        printf '\nUser text without a final newline.  '
    } > "$linked_file"
    {
        printf '# Personal rules  \r\n\n%s\n%s\n%s\n' "$begin" "$rule" "$end"
        printf '\nUser text without a final newline.  '
    } > "$tmp/expected"
    install
    [ "$(readlink "$file")" = "$linked_file" ] || fail "$filename link was changed"
    same_file "$tmp/expected" "$linked_file" "$filename replaces rules through the link and preserves surrounding bytes"
done

printf '# Conflicts prevent writes to all targets\n'
for tool in Claude Codex Gemini; do
    HOME=$tmp/$tool\ conflict\ home
    mkdir -p "$HOME/.codex" "$HOME/.gemini" "$HOME/.claude"
    case $tool in
        Claude)
            file=$HOME/.claude/CLAUDE.md
            skill_dir=$HOME/.claude/skills
            label=
            ;;
        Codex)
            file=$HOME/.codex/AGENTS.md
            skill_dir=$HOME/.agents/skills
            label='Codex '
            ;;
        Gemini)
            file=$HOME/.gemini/GEMINI.md
            skill_dir=$HOME/.gemini/skills
            label='Gemini '
            ;;
    esac
    printf 'User text\n%s\nOld rule.\nKeep this line.\n' "$begin" > "$file"
    install --check > "$tmp/check.out"
    reports "${label}rules ${file##*/}: conflict"
    tar -cf "$tmp/before.tar" -C "$HOME" .
    if install > "$tmp/conflict.out" 2>&1; then
        fail "install succeeded despite an unpaired marker in $file"
    fi
    grep -F "$file has unpaired or repeated markers" "$tmp/conflict.out" >/dev/null ||
        fail "marker conflict error did not name $file"
    tar -cf "$tmp/after.tar" -C "$HOME" .
    same_file "$tmp/before.tar" "$tmp/after.tar" "$tool marker conflict leaves all targets untouched"

    printf 'User text.\n' > "$file"
    mkdir -p "$skill_dir/task-handoff"
    printf 'User skill.\n' > "$skill_dir/task-handoff/SKILL.md"
    install --check > "$tmp/check.out"
    reports "${label}skill task-handoff: conflict"
    tar -cf "$tmp/before.tar" -C "$HOME" .
    if install > "$tmp/conflict.out" 2>&1; then
        fail "install succeeded despite a conflicting skill in $skill_dir"
    fi
    grep -F "$skill_dir/task-handoff" "$tmp/conflict.out" >/dev/null ||
        fail 'skill conflict error did not name the conflicting path'
    tar -cf "$tmp/after.tar" -C "$HOME" .
    same_file "$tmp/before.tar" "$tmp/after.tar" "$tool skill conflict leaves all targets untouched"
done

printf '# Blocked skill directory\n'
HOME=$tmp/blocked\ home
mkdir -p "$HOME/.codex" "$HOME/.gemini"
printf 'User file.\n' > "$HOME/.agents"
install --check > "$tmp/check.out"
reports 'Codex skill dispatch: conflict'
tar -cf "$tmp/before.tar" -C "$HOME" .
if install > "$tmp/conflict.out" 2>&1; then
    fail 'install succeeded despite a file blocking the Codex skill directory'
fi
tar -cf "$tmp/after.tar" -C "$HOME" .
same_file "$tmp/before.tar" "$tmp/after.tar" 'a blocked skill directory leaves all targets untouched'

printf '# Unwritable or broken destinations stop the install before any write\n'
for case in readonly dangling crlf readonly-dir closed-dir; do
    HOME=$tmp/$case\ home
    mkdir -p "$HOME/.codex" "$HOME/.gemini"
    case $case in
        readonly) printf 'user\n' > "$HOME/.codex/AGENTS.md"; chmod 444 "$HOME/.codex/AGENTS.md" ;;
        dangling) ln -s "$tmp/nowhere/x.md" "$HOME/.codex/AGENTS.md" ;;
        crlf) printf 'user\r\n%s\r\nold\r\n%s\r\n' "$begin" "$end" > "$HOME/.codex/AGENTS.md" ;;
        readonly-dir) mkdir -p "$HOME/.agents/skills"; chmod 555 "$HOME/.agents/skills" ;;
        closed-dir) chmod 600 "$HOME/.codex" ;;
    esac
    install --check > "$tmp/check.out"
    case $case in
        readonly-dir) reports 'Codex skill dispatch: conflict' ;;
        *) reports 'Codex rules AGENTS.md: conflict' ;;
    esac
    [ "$case" != closed-dir ] || chmod 700 "$HOME/.codex"
    tar -cf "$tmp/before.tar" -C "$HOME" .
    [ "$case" != closed-dir ] || chmod 600 "$HOME/.codex"
    if install > "$tmp/conflict.out" 2>&1; then
        fail "install succeeded despite a $case Codex destination"
    fi
    [ "$case" != closed-dir ] || chmod 700 "$HOME/.codex"
    tar -cf "$tmp/after.tar" -C "$HOME" .
    same_file "$tmp/before.tar" "$tmp/after.tar" "a $case Codex destination leaves all targets untouched"
    chmod -R u+w "$HOME"
done

printf '# An existing file without the rules reports missing\n'
HOME=$tmp/plain\ home
mkdir -p "$HOME/.codex"
printf 'user\n' > "$HOME/.codex/AGENTS.md"
install --check > "$tmp/check.out"
reports 'Codex rules AGENTS.md: missing'
