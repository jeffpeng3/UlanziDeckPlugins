#!/usr/bin/env bash
# 建 tag、push、發 GitHub release 並附上打包好的 zip
# 用法：release.sh <plugin-dir> <tag-prefix>
#   release.sh com.ulanzi.sysmonitor.ulanziPlugin sysmonitor
set -euo pipefail

plugin_dir="${1:-}"
tag_prefix="${2:-}"
if [[ -z "$plugin_dir" || -z "$tag_prefix" ]]; then
  echo "usage: release.sh <plugin-dir> <tag-prefix>" >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "worktree dirty，先 commit 再 release" >&2
  exit 1
fi

echo "== package: $plugin_dir"
( cd "$plugin_dir" && make package )

if [[ -n "$(git status --porcelain)" ]]; then
  echo "build 改了追蹤檔（如 bin/win-x64/winquery.exe）。" >&2
  echo "先 make helper 並 commit 重建的檔案，再 release。" >&2
  exit 1
fi

ver="$(node -p "require('./$plugin_dir/manifest.json').Version")"
tag="${tag_prefix}-v${ver}"
zip="$root/$plugin_dir/release/${plugin_dir}-${ver}.zip"
[[ -f "$zip" ]] || { echo "找不到 $zip" >&2; exit 1; }

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "tag $tag 已存在" >&2
  exit 1
fi

notes_file="$(mktemp)"
trap 'rm -f "$notes_file"' EXIT

prev="$(git tag -l "${tag_prefix}-v*" --sort=-v:refname | head -1)"
if [[ -n "$prev" ]]; then
  git log --oneline --no-merges "${prev}..HEAD" > "$notes_file"
else
  git log --oneline --no-merges > "$notes_file"
fi
[[ -s "$notes_file" ]] || echo "$tag" > "$notes_file"

echo "== tag $tag"
git tag -a "$tag" -m "$tag"
git push origin HEAD
git push origin "$tag"

echo "== gh release create"
gh release create "$tag" "$zip" --title "$tag" --notes-file "$notes_file"
echo "released: $tag"
