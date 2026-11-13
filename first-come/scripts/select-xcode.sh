#!/bin/bash
# Prints the path of the newest stable Xcode installed on this Mac, for example
# /Applications/Xcode_26.6.app. The CI workflows use it so that they never name an Xcode
# version that the runner may no longer have:
#
#   xcode_app="$(bash scripts/select-xcode.sh)"
#   export DEVELOPER_DIR="$xcode_app/Contents/Developer"
#
# "Stable" leaves out betas and release candidates, which App Store Connect does not accept
# builds from. A copy counts as a beta when its folder name says so or when its licence file
# is a beta licence. Symbolic links (Xcode.app, Xcode_26.0.app -> Xcode_26.0.1.app) are
# skipped, so every real copy is looked at once.
#
# What it found goes to standard error; only the chosen path goes to standard output.
# Works with the bash 3.2 that macOS ships.
#
# For testing on another system: XCODE_SEARCH_DIR (default /Applications) and PLISTBUDDY
# (default /usr/libexec/PlistBuddy) can be overridden.

set -euo pipefail

search_dir="${XCODE_SEARCH_DIR:-/Applications}"
plistbuddy="${PLISTBUDDY:-/usr/libexec/PlistBuddy}"

read_plist() { # key, file -> value, or nothing
  "$plistbuddy" -c "Print :$1" "$2" 2>/dev/null || true
}

candidates=""
for app in "$search_dir"/Xcode*.app; do
  if [ -L "$app" ] || [ ! -d "$app" ]; then
    continue
  fi
  name="$(basename "$app")"
  version="$(read_plist CFBundleShortVersionString "$app/Contents/version.plist")"
  if [ -z "$version" ]; then
    echo "skipped  $name (no version found)" >&2
    continue
  fi
  license="$(read_plist licenseType "$app/Contents/Resources/LicenseInfo.plist")"
  case "$name $license" in
    *[Bb][Ee][Tt][Aa]* | *_RC* | *[Rr]elease_[Cc]andidate*)
      echo "skipped  $name (Xcode $version, beta or release candidate)" >&2
      continue
      ;;
  esac
  echo "found    $name (Xcode $version)" >&2
  # A fixed-width key, so that 26.10 sorts after 26.9 and 26.4.1 after 26.4.
  key="$(echo "$version" | awk -F. '{ printf "%05d.%05d.%05d", $1, $2, $3 }')"
  candidates="${candidates}${key}	${app}
"
done

newest="$(printf '%s' "$candidates" | sort | tail -n 1 | cut -f 2-)"
if [ -z "$newest" ]; then
  echo "No stable Xcode found in $search_dir." >&2
  exit 1
fi
echo "selected $(basename "$newest")" >&2
echo "$newest"
