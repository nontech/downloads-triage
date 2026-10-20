#!/bin/zsh

set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"
npm run build

mkdir -p "$project_dir/macos/.build"
swiftc -O -target arm64-apple-macosx14.0 \
  -framework AppKit -framework WebKit \
  -o "$project_dir/macos/.build/DownloadsTriage" \
  "$project_dir"/macos/Sources/DownloadsTriage/*.swift

binary_path="$project_dir/macos/.build/DownloadsTriage"

app_path="$project_dir/Downloads Triage.app"
mkdir -p "$app_path/Contents/MacOS" "$app_path/Contents/Resources"
cp "$binary_path" "$app_path/Contents/MacOS/DownloadsTriage"
cp "$project_dir/macos/Info.plist" "$app_path/Contents/Info.plist"
codesign --force --deep --sign - "$app_path" >/dev/null

echo "Built $app_path"
