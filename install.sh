#!/bin/sh
set -eu

repo=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
rule_file=$repo/rules/multi-model.md
begin='<!-- BEGIN multi-model-kit -->'
end='<!-- END multi-model-kit -->'

case ${1-} in
    '') check=false ;;
    --check) check=true ;;
    *) printf 'Usage: %s [--check]\n' "$0" >&2; exit 1 ;;
esac

skill_status() {
    if [ -L "$2" ] && [ "$(CDPATH= cd -P "$2" 2>/dev/null && pwd)" = "$1" ]; then
        printf 'installed\n'
    elif [ -e "$2" ] || [ -L "$2" ]; then
        printf 'conflict\n'
    else
        printf 'missing\n'
    fi
}

# Keep file bytes intact and put the next marker on its own line.
write_lines() {
    cat "$1" || return
    if [ -s "$1" ] && [ "$(tail -c 1 "$1" | wc -l)" -eq 0 ]; then
        printf '\n'
    fi
}

# True when the file has no markers, or exactly one pair in order.
markers_ok() {
    LC_ALL=C awk -v begin="$begin" -v end="$end" '
        $0 == begin { b++; if (!bl) bl = NR }
        $0 == end { e++; if (!el) el = NR }
        $0 == begin "\r" || $0 == end "\r" { crlf = 1 }
        END { exit !(!crlf && ((b == 0 && e == 0) || (b == 1 && e == 1 && bl < el))) }
    ' "$1"
}

render_rules() {
    if [ -f "$1" ]; then
        bounds=$(LC_ALL=C awk -v begin="$begin" -v end="$end" '
            $0 == begin && !start { start = NR }
            $0 == end && start { print start, NR; exit }
        ' "$1") || return
        if [ -n "$bounds" ]; then
            head -n "${bounds% *}" "$1" || return
            write_lines "$rule_file" || return
            tail -n "+${bounds#* }" "$1"
            return
        fi
        write_lines "$1" || return
    fi
    printf '%s\n' "$begin" || return
    write_lines "$rule_file" || return
    printf '%s\n' "$end"
}

blocked_directory() {
    [ ! -d "$1" ] && { [ -e "$1" ] || [ -L "$1" ]; }
}

# True when the path, or its nearest existing ancestor, is a directory files can be created in.
can_create_in() {
    dir=$1
    while [ ! -e "$dir" ] && [ ! -L "$dir" ]; do
        dir=${dir%/*}
    done
    [ -d "$dir" ] && [ -w "$dir" ] && [ -x "$dir" ]
}

inspect_target() {
    for skill in "$repo"/skills/*; do
        [ -d "$skill" ] || continue
        name=${skill##*/}
        target=$skill_dir/$name
        if ! "$enabled"; then
            status=skipped
        elif blocked_directory "${skill_dir%/*}" || blocked_directory "$skill_dir"; then
            status=conflict
        else
            source=$(CDPATH= cd -P "$skill" && pwd)
            status=$(skill_status "$source" "$target")
            if [ "$status" = missing ] && ! can_create_in "$skill_dir"; then
                status=conflict
            fi
        fi
        if "$check"; then
            printf '%sskill %s: %s\n' "$label" "$name" "$status"
        elif [ "$status" = conflict ]; then
            printf 'Cannot install skill %s: %s or its parent is already in use\n' "$name" "$target" >&2
            exit 1
        fi
    done

    if ! "$enabled"; then
        status=skipped
    elif [ -L "$instruction_file" ] && [ ! -e "$instruction_file" ]; then
        status=conflict
        reason='is a dangling link'
    elif ! can_create_in "${instruction_file%/*}"; then
        status=conflict
        reason='is in a directory that is not writable'
    elif [ -f "$instruction_file" ]; then
        if ! markers_ok "$instruction_file"; then
            status=conflict
            reason='has unpaired or repeated markers'
        elif [ ! -w "$instruction_file" ]; then
            status=conflict
            reason='is not writable'
        elif "$check" && ! grep -Fxq -- "$begin" "$instruction_file"; then
            status=missing
        elif "$check" && ! render_rules "$instruction_file" | cmp -s "$instruction_file" -; then
            status=outdated
        else
            status=installed
        fi
    elif [ -e "$instruction_file" ]; then
        status=conflict
        reason='is not a regular file'
    else
        status=missing
    fi
    if "$check"; then
        printf '%srules %s: %s\n' "$label" "${instruction_file##*/}" "$status"
    elif [ "$status" = conflict ]; then
        printf 'Cannot install rules: %s %s\n' "$instruction_file" "$reason" >&2
        exit 1
    fi
}

install_target() {
    "$enabled" || return 0
    mkdir -p "$skill_dir"
    candidate=$(mktemp "${instruction_file%/*}/.${instruction_file##*/}.XXXXXX")
    trap 'rm -f "$candidate"' 0
    if [ -f "$instruction_file" ]; then
        cp -p "$instruction_file" "$candidate"
    fi
    render_rules "$instruction_file" > "$candidate"

    for skill in "$repo"/skills/*; do
        [ -d "$skill" ] || continue
        target=$skill_dir/${skill##*/}
        [ -L "$target" ] || ln -s "$skill" "$skill_dir"
    done

    if cmp -s "$instruction_file" "$candidate"; then
        :
    elif [ -L "$instruction_file" ]; then
        # Write through the link so the user's real file is updated.
        cat "$candidate" > "$instruction_file"
    else
        mv -f "$candidate" "$instruction_file"
    fi
}

with_target() (
    label=$2
    instruction_file=$3
    skill_dir=$4
    enabled=true
    if [ -n "$label" ] && [ ! -d "${instruction_file%/*}" ]; then
        enabled=false
    fi
    "$1"
)

for_each_target() {
    with_target "$1" '' "$HOME/.claude/CLAUDE.md" "$HOME/.claude/skills"
    with_target "$1" 'Codex ' "$HOME/.codex/AGENTS.md" "$HOME/.agents/skills"
    with_target "$1" 'Gemini ' "$HOME/.gemini/GEMINI.md" "$HOME/.gemini/skills"
}

command_status() {
    if [ -L "$command_link" ]; then
        destination=$(readlink "$command_link") || return
        case $destination in
            /*) ;;
            *) destination=$command_dir/$destination ;;
        esac
        if parent=$(CDPATH= cd -P "${destination%/*}/" 2>/dev/null && pwd) &&
            [ "$parent/${destination##*/}" = "$command_source" ]; then
            printf 'installed\n'
        else
            printf 'conflict\n'
        fi
    elif [ -e "$command_link" ] || ! can_create_in "$command_dir"; then
        printf 'conflict\n'
    else
        printf 'missing\n'
    fi
}

command_dir=$HOME/.local/bin
command_link=$command_dir/quota-status
command_source=$repo/bin/quota-status

# Check every destination before writing to any of them.
for_each_target inspect_target
status=$(command_status)
if "$check"; then
    printf 'command quota-status: %s\n' "$status"
    exit 0
fi
if [ "$status" = conflict ]; then
    printf 'Cannot install command quota-status: %s or its parent is unavailable\n' "$command_link" >&2
    exit 1
fi

for_each_target install_target
if [ "$status" = missing ]; then
    mkdir -p "$command_dir"
    ln -s "$command_source" "$command_dir"
fi
case :${PATH-}: in
    *":$command_dir:"*) ;;
    *) printf 'Add ~/.local/bin to your PATH to run quota-status.\n' >&2 ;;
esac
