#!/usr/bin/env bash
# Kingston Tutoring iPhone app: one command on a Mac with Xcode installed.
#
#   ./setup.sh               check settings, run the tests, build for the Simulator, open Xcode
#   ./setup.sh check         check Config.xcconfig and your live site (API + universal-links file)
#   ./setup.sh test          run the app's logic tests (plus the live contract test, see below)
#   ./setup.sh build         compile the app for the Simulator (no signing needed)
#   ./setup.sh screenshots   make App Store screenshots from demo data (6.9" iPhone Simulator)
#   ./setup.sh regenerate    rebuild KingstonTutoring.xcodeproj from project.yml (needs XcodeGen)
#
# Live contract test: set KT_CONTRACT_LINK to a private booking link from your deployed site, e.g.
#   KT_CONTRACT_LINK="https://your-site/b/..." ./setup.sh test
set -euo pipefail
cd "$(dirname "$0")"

PROJECT=KingstonTutoring.xcodeproj
SCHEME=KingstonTutoring
DERIVED=build/DerivedData

setting() { sed -n "s/^$1[[:space:]]*=[[:space:]]*//p" Config.xcconfig | tail -1 | sed 's/[[:space:]]*$//'; }

need_xcode() {
  if ! xcodebuild -version >/dev/null 2>&1; then
    echo "Xcode isn't installed (or its command-line tools aren't selected)."
    echo "Install Xcode from the Mac App Store, open it once, then run: sudo xcode-select -s /Applications/Xcode.app"
    exit 1
  fi
  local major
  major=$(xcodebuild -version | sed -n 's/^Xcode \([0-9]*\).*/\1/p')
  echo "Using $(xcodebuild -version | head -1)"
  if [[ -n "$major" && "$major" -lt 26 ]]; then
    echo "! This project needs Xcode 16 or later, and App Store uploads need Xcode 26 or later. Update Xcode before submitting."
  fi
}

check() {
  local problems=0 host team bundle
  host=$(setting KT_PUBLIC_HOST); team=$(setting DEVELOPMENT_TEAM); bundle=$(setting KT_BUNDLE_ID)
  if [[ -z "$host" || "$host" == "tutoring.example.com" ]]; then
    echo "✗ KT_PUBLIC_HOST in Config.xcconfig is still the example. Set it to your booking site's host name."; problems=1
  elif [[ "$host" == *"://"* || "$host" == */* ]]; then
    echo "✗ KT_PUBLIC_HOST must be just the host name (no https://, no slashes)."; problems=1
  fi
  if [[ ! "$team" =~ ^[A-Z0-9]{10}$ ]]; then
    echo "✗ DEVELOPMENT_TEAM in Config.xcconfig must be your 10-character Apple Team ID (needed for iPhones and uploads)."; problems=1
  fi
  if [[ -z "$bundle" || "$bundle" == com.example.* ]]; then
    echo "✗ KT_BUNDLE_ID in Config.xcconfig is still the example. Use an identifier you own, e.g. uk.yourname.tutoring."; problems=1
  fi
  if [[ $problems -eq 0 ]]; then
    echo "✓ Config.xcconfig: $host, team $team, bundle $bundle"
  fi
  if [[ -n "$host" && "$host" != "tutoring.example.com" && "$host" != *"/"* ]]; then
    if curl -fsS --max-time 15 "https://$host/api/app/v1/config" >/dev/null 2>&1; then
      echo "✓ https://$host answers the app API"
    else
      echo "✗ https://$host/api/app/v1/config didn't answer. Deploy the site first (docs/DEPLOY.md)."; problems=1
    fi
    local aasa
    aasa=$(curl -fsS --max-time 15 "https://$host/.well-known/apple-app-site-association" 2>/dev/null || true)
    if [[ -n "$team" && -n "$bundle" && "$aasa" == *"\"$team.$bundle\""* ]]; then
      echo "✓ The universal-links file lists $team.$bundle, so emailed links will open the app"
    else
      echo "✗ https://$host/.well-known/apple-app-site-association doesn't list $team.$bundle yet."
      echo "  Set \"APPLE_APP_IDS\": \"$team.$bundle\" in workers/public/wrangler.jsonc and redeploy the public worker."
      problems=1
    fi
  fi
  return $problems
}

run_tests() {
  echo "Running the app's logic tests…"
  if [[ -n "${KT_CONTRACT_LINK:-}" ]]; then
    local host
    host=$(setting KT_PUBLIC_HOST)
    export KT_CONTRACT_BASE_URL="${KT_CONTRACT_BASE_URL:-https://$host}"
    echo "Including the live contract test against $KT_CONTRACT_BASE_URL"
  fi
  (cd KingstonTutoringCore && swift test)
}

build_simulator() {
  echo "Compiling the app for the iPhone Simulator…"
  xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Debug \
    -destination 'generic/platform=iOS Simulator' -derivedDataPath "$DERIVED" \
    CODE_SIGNING_ALLOWED=NO build -quiet
  echo "✓ The app builds"
}

screenshots() {
  local list device udid app bundle out=AppStore/screenshots
  list=$(xcrun simctl list devices available)
  device=$(echo "$list" | grep -Eo 'iPhone [0-9]+ Pro Max' | sort -V | tail -1 || true)
  if [[ -z "$device" ]]; then
    echo "No 'iPhone … Pro Max' simulator found. Add one in Xcode > Window > Devices and Simulators, then retry."
    exit 1
  fi
  udid=$(echo "$list" | grep -F "$device (" | head -1 | grep -Eo '[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}')
  echo "Using the $device simulator (6.9-inch screenshots)"
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null
  xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Debug -destination "id=$udid" \
    -derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO build -quiet
  app="$DERIVED/Build/Products/Debug-iphonesimulator/KingstonTutoring.app"
  bundle=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Info.plist")
  xcrun simctl install "$udid" "$app"
  xcrun simctl status_bar "$udid" override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
    --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
  mkdir -p "$out"
  local n=1
  for screen in list detail settings; do
    xcrun simctl terminate "$udid" "$bundle" >/dev/null 2>&1 || true
    xcrun simctl launch "$udid" "$bundle" -KTDemo -KTDemoScreen "$screen" >/dev/null
    sleep 5
    xcrun simctl io "$udid" screenshot "$out/$n-$screen.png" >/dev/null
    echo "✓ $out/$n-$screen.png"
    n=$((n + 1))
  done
  xcrun simctl status_bar "$udid" clear
  echo "Upload these in App Store Connect under the 6.9-inch iPhone display size. They show fictional demo data."
}

regenerate() {
  if ! command -v xcodegen >/dev/null 2>&1; then
    echo "XcodeGen isn't installed. Install it with: brew install xcodegen"
    exit 1
  fi
  xcodegen generate
}

case "${1:-all}" in
  check) check ;;
  test) run_tests ;;
  build) need_xcode; build_simulator ;;
  screenshots) need_xcode; screenshots ;;
  regenerate) regenerate ;;
  all)
    need_xcode
    check || echo "(Fix the ✗ items above before running on an iPhone or uploading. The Simulator demo works without them.)"
    run_tests
    build_simulator
    open "$PROJECT"
    echo
    echo "Xcode is opening. Choose an iPhone simulator and press ⌘R."
    echo "To try it without a live site: Product > Scheme > Edit Scheme > Run > Arguments, tick -KTDemo."
    ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
