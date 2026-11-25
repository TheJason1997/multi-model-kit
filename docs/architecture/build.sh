#!/bin/sh
# Rebuild the diagrams and the animated story from src/*.json with Archify
# (https://github.com/tt-a1i/archify). Usage: sh docs/architecture/build.sh <path to archify.mjs>
set -eu
archify=${1:?path to archify/bin/archify.mjs}
cd "$(dirname "$0")/../.."
out=docs/architecture
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for lang in en zh; do
    suffix=; [ "$lang" = en ] || suffix=.zh
    for pair in overview:architecture dispatch:workflow quota:lifecycle handoff:workflow; do
        name=${pair%%:*}
        node "$archify" finalize "${pair##*:}" "$out/src/$name.$lang.json" "$out/$name$suffix.html" \
            --quality showcase --out-dir "$tmp/receipts-$name-$lang" --json > /dev/null
        # The story SVG may not link out, so it reads copies without the drill-down links.
        python3 -c 'import json, sys
d = json.load(open(sys.argv[1]))
for c in d.get("components", []): c.pop("href", None)
d["meta"].pop("parentHref", None)
json.dump(d, open(sys.argv[2], "w"), ensure_ascii=False)' "$out/src/$name.$lang.json" "$tmp/$name.$lang.json"
    done
    cp "$out/src/story.$lang.json" "$tmp/story.$lang.json"
    node "$archify" story svg "$tmp/story.$lang.json" "$out/story$suffix" --theme both --json > /dev/null
    node "$archify" story stage "$tmp/story.$lang.json" "$out/story$suffix.html" --theme dark --json > /dev/null
done
rm -f "$out"/*.delivery.json   # receipts carry local absolute paths
echo "built $out"
