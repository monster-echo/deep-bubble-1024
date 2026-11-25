#!/usr/bin/env bash
# Build the signed AAB for Google Play (Deep Bubble 1024 / 深海啵啵).
#
#   STAGE=release ./tools/build_android.sh   # signed bundleRelease AAB
#   STAGE=debug   ./tools/build_android.sh   # CI dry run: assembleDebug
#
# Flow: Cocos Creator CLI generates the Gradle project from
# tools/build-config-android.json, gradle.properties gets target SDK / ABI /
# release signing keys, the manifest gets portrait locked, and versions are
# injected through AGP's android.injected.* properties (the Android Studio
# mechanism — no generated files need editing). Signing values come from
# release.env (git-ignored) locally or from secrets on CI:
#   KEYSTORE, KEYSTORE_PASS, KEYSTORE_USER (alias), KEY_PASS (defaults to KEYSTORE_PASS)
#
# Needs: Cocos Creator 3.8.6 (COCOS env or a known install path) and a JDK 17+
# with the Android SDK. Prefer the project's gradlew wrapper when present.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT/release.env" ]]; then
	# shellcheck disable=SC1091
	source "$ROOT/release.env"
fi
STAGE="${STAGE:-release}"
TARGET_SDK="${TARGET_SDK:-35}"
MIN_SDK="${MIN_SDK:-24}"
APP_ABI="${APP_ABI:-arm64-v8a}"
APP_NAME="${APP_NAME:-deepbubble1024}"
KEY_PASS="${KEY_PASS:-${KEYSTORE_PASS:-}}"

eval "$(python3 "$ROOT/tools/set_versions.py" get)"
# set_versions.py prints lowercase; the workflow injects uppercase env.
# Accept either so the script works standalone and under CI.
VERSION="${VERSION:-$version}"
BUILD="${BUILD:-$build}"
BUILD_DIR="$ROOT/game/build-android"
PROJ_DIR="$BUILD_DIR/proj"
OUT_DIR="$ROOT/export/android"

find_cocos() {
	for candidate in \
		"${COCOS:-}" \
		"/Applications/Cocos/Creator/3.8.6/CocosCreator.app/Contents/MacOS/CocosCreator" \
		"/Applications/Cocos/Creator/3.8.4/CocosCreator.app/Contents/MacOS/CocosCreator" \
		"$HOME/Applications/Cocos/Creator/3.8.6/CocosCreator.app/Contents/MacOS/CocosCreator" \
		"$HOME/cocos-creator/CocosCreator.app/Contents/MacOS/CocosCreator"; do
		[[ -n "$candidate" && -x "$candidate" ]] && { echo "$candidate"; return; }
	done
}

CC_BIN="$(find_cocos || true)"
if [[ -z "$CC_BIN" ]]; then
	echo "Cocos Creator 3.8.x not found. Set COCOS=/path/to/CocosCreator binary." >&2
	exit 1
fi

# Cocos 3.8.6 engine headers predate clang 17+, which made the argument-less
# `this->template fn()` form a hard error. Upstream fixed it in 3.8.7; patch
# the installed editor's copy in place. Idempotent: lines with explicit
# template args (fn<T>(...)) do not match the pattern.
patch_engine_headers() {
	local header
	header="$(dirname "$(dirname "$CC_BIN")")/Resources/resources/3d/engine/native/cocos/core/event/EventTarget.h"
	if [[ -f "$header" ]] && grep -q -- '->template addEventListener(' "$header"; then
		sed -i.bak 's/->template addEventListener(/->addEventListener(/g' "$header" \
			&& rm -f "$header.bak"
		echo "patched engine header for new clang: $header"
	fi
}
patch_engine_headers

echo "== resolve Android SDK/NDK for Cocos"
# The editor has no preferences on a fresh runner; build options carry the
# paths instead. Resolve the newest installed NDK and write a resolved copy
# of the build config into .tmp/ (gitignored — machine paths stay out of git).
ANDROID_SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
# Cocos 3.8.x supports NDK up to r27: r28's libc++ dropped
# std::char_traits<unsigned char>, which the engine bindings still use.
# Prefer the newest supported NDK; only fall back to the absolute newest
# (with a warning) when nothing <= 27 is installed.
ANDROID_NDK="${ANDROID_NDK:-$(find "$ANDROID_SDK/ndk" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -V | awk -F/ '$NF + 0 <= 27.99' | tail -1 || true)}"
if [[ -z "$ANDROID_NDK" ]]; then
	ANDROID_NDK="$(find "$ANDROID_SDK/ndk" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -V | tail -1 || true)"
	[[ -n "$ANDROID_NDK" ]] && echo "::warning::only NDK r28+ found; Cocos 3.8.x supports up to r27 — build may fail"
fi
if [[ ! -d "$ANDROID_SDK" ]]; then
	echo "Android SDK not found at $ANDROID_SDK (set ANDROID_HOME)" >&2
	exit 1
fi
if [[ -z "$ANDROID_NDK" ]]; then
	echo "No Android NDK under $ANDROID_SDK/ndk" >&2
	exit 1
fi
echo "sdk: $ANDROID_SDK"
echo "ndk: $ANDROID_NDK"
RESOLVED="$ROOT/.tmp/build-config-android.json"
mkdir -p "$ROOT/.tmp"
python3 - "$ROOT/tools/build-config-android.json" "$RESOLVED" \
	"$ANDROID_SDK" "$ANDROID_NDK" <<'PY'
import json, os, sys
src, dst, sdk, ndk = sys.argv[1:]
with open(src) as f:
    cfg = json.load(f)
android = cfg.setdefault('packages', {}).setdefault('android', {})
android['sdkPath'] = sdk
android['ndkPath'] = ndk
os.makedirs(os.path.dirname(dst), exist_ok=True)
with open(dst, 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
PY

echo "== Cocos CLI build -> Gradle project"
rm -rf "$BUILD_DIR"
# Exit code 36 is Cocos' documented CLI-build success; 32 invalid parameters,
# 34 build error. One line only: a newline inside --build silently no-ops.
set +e
"$CC_BIN" --project "$ROOT/game" --build "configPath=$RESOLVED"
rc=$?
set -e
if [[ $rc != 36 && $rc != 0 ]]; then
	echo "Cocos CLI build failed with exit code $rc (36=ok, 32=bad params, 34=build error)" >&2
	exit 1
fi
if [[ ! -d "$PROJ_DIR" ]]; then
	echo "No Gradle project at $PROJ_DIR" >&2
	exit 1
fi
echo "project: $PROJ_DIR"

# Google Play requires 16 KB page-size support. Cocos 3.8.6 generates an
# Android Gradle Plugin 8.0.2 project; upgrade it to AGP 8.7.3 / Gradle 8.9
# and pin NDK r27, then pass the required ELF alignment flags to the linker.
TOP_LEVEL_GRADLE="$PROJ_DIR/build.gradle"
WRAPPER_PROPERTIES="$PROJ_DIR/gradle/wrapper/gradle-wrapper.properties"
if [[ ! -f "$TOP_LEVEL_GRADLE" || ! -f "$WRAPPER_PROPERTIES" ]]; then
	echo "Generated Gradle build files are missing" >&2
	exit 1
fi
sed -i.bak 's/com.android.tools.build:gradle:8.0.2/com.android.tools.build:gradle:8.7.3/' "$TOP_LEVEL_GRADLE"
rm -f "$TOP_LEVEL_GRADLE.bak"
sed -i.bak 's/gradle-8.0.2-bin.zip/gradle-8.9-bin.zip/' "$WRAPPER_PROPERTIES"
rm -f "$WRAPPER_PROPERTIES.bak"

NATIVE_DIR="$(sed -n 's/^NATIVE_DIR=//p' "$PROJ_DIR/gradle.properties" | head -1)"
APP_GRADLE="$NATIVE_DIR/app/build.gradle"
NATIVE_CMAKE="$NATIVE_DIR/CMakeLists.txt"
if [[ -z "$NATIVE_DIR" || ! -f "$APP_GRADLE" || ! -f "$NATIVE_CMAKE" ]]; then
	echo "Generated Android native project is missing (NATIVE_DIR=$NATIVE_DIR)" >&2
	exit 1
fi
if ! grep -q 'com.android.tools.build:gradle:8.7.3' "$TOP_LEVEL_GRADLE"; then
	echo "Could not upgrade Android Gradle Plugin to 8.7.3" >&2
	exit 1
fi
if grep -q 'ndkVersion ' "$APP_GRADLE"; then
	sed -i.bak 's/ndkVersion "[^"]*"/ndkVersion "27.2.12479018"/' "$APP_GRADLE"
	rm -f "$APP_GRADLE.bak"
else
	python3 - "$APP_GRADLE" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
needle = "    ndkPath PROP_NDK_PATH\n"
if needle not in s:
    raise SystemExit("Cannot pin NDK version in generated app/build.gradle")
p.write_text(s.replace(needle, needle + '    ndkVersion "27.2.12479018"\n', 1))
PY
fi
if ! grep -q -- '-Wl,-z,max-page-size=16384' "$NATIVE_CMAKE"; then
	python3 - "$NATIVE_CMAKE" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
needle = 'cc_android_after_target(${CC_LIB_NAME})'
block = '''cc_android_after_target(${CC_LIB_NAME})

# Google Play requires 16 KB ELF load-segment alignment for Android 15+.
target_link_options(${CC_LIB_NAME} PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384"
)'''
if needle not in s:
    raise SystemExit("Cannot add 16 KB linker flags to generated Android CMakeLists.txt")
p.write_text(s.replace(needle, block, 1))
PY
fi

GRADLE_PROPS="$PROJ_DIR/gradle.properties"
touch "$GRADLE_PROPS"
set_prop() {
	# | delimiter: keystore paths contain / and would break s///
	if grep -q "^$1=" "$GRADLE_PROPS"; then
		sed -i.bak "s|^$1=.*|$1=$2|" "$GRADLE_PROPS" && rm -f "$GRADLE_PROPS.bak"
	else
		printf '%s=%s\n' "$1" "$2" >> "$GRADLE_PROPS"
	fi
}

echo "== patch gradle.properties / manifest"
set_prop PROP_TARGET_SDK_VERSION "$TARGET_SDK"
set_prop PROP_MIN_SDK_VERSION "$MIN_SDK"
set_prop PROP_APP_ABI "$APP_ABI"

if [[ "$STAGE" == "release" ]]; then
	if [[ -z "${KEYSTORE:-}" || -z "${KEYSTORE_PASS:-}" || -z "${KEYSTORE_USER:-}" ]]; then
		echo "Signing not configured: set KEYSTORE / KEYSTORE_PASS / KEYSTORE_USER" >&2
		exit 1
	fi
	set_prop RELEASE_STORE_FILE "$KEYSTORE"
	set_prop RELEASE_STORE_PASSWORD "$KEYSTORE_PASS"
	set_prop RELEASE_KEY_ALIAS "$KEYSTORE_USER"
	set_prop RELEASE_KEY_PASSWORD "$KEY_PASS"
fi

MAIN_MANIFEST=""
# The :app module lives under NATIVE_DIR (native/engine/android), not in
# proj/ — proj only carries libservice. Read NATIVE_DIR out of the generated
# gradle.properties.
NATIVE_DIR="$(sed -n 's/^NATIVE_DIR=//p' "$GRADLE_PROPS" | head -1)"
for candidate in "$NATIVE_DIR/app/AndroidManifest.xml" "$PROJ_DIR/app/AndroidManifest.xml"; do
	[[ -n "$candidate" && -f "$candidate" ]] && { MAIN_MANIFEST="$candidate"; break; }
done
if [[ -z "$MAIN_MANIFEST" ]]; then
	echo "app AndroidManifest.xml not found (NATIVE_DIR=$NATIVE_DIR)" >&2
	exit 1
fi
# The template hardcodes versionCode/versionName in defaultConfig and
# ignores AGP's android.injected.version.* properties — rewrite them in the
# generated file (regenerated on every Cocos build, so idempotent).
if [[ -f "$APP_GRADLE" ]]; then
	sed -i.bak "s/versionCode [0-9]\+/versionCode $BUILD/" "$APP_GRADLE"
	sed -i.bak "s/versionName \"[^\"]*\"/versionName \"$VERSION\"/" "$APP_GRADLE"
	rm -f "$APP_GRADLE.bak"
	echo "app/build.gradle: version $VERSION ($BUILD)"
else
	echo "app/build.gradle not found at $APP_GRADLE" >&2
	exit 1
fi

if grep -q 'android:screenOrientation=' "$MAIN_MANIFEST"; then
	# Cocos defaults to sensorLandscape; the game is portrait-only. Only the
	# main activity is rewritten (dialog activities keep their own value).
	sed -i.bak 's/android:screenOrientation="[^"]*"/android:screenOrientation="portrait"/' \
		"$MAIN_MANIFEST" && rm -f "$MAIN_MANIFEST.bak"
	echo "manifest: portrait locked ($MAIN_MANIFEST)"
else
	echo "manifest: no screenOrientation attribute — check orientation ($MAIN_MANIFEST)"
fi

GRADLE="$PROJ_DIR/gradlew"
if [[ ! -x "$GRADLE" ]]; then
	GRADLE="gradle"
	echo "no gradlew wrapper in $PROJ_DIR, using system gradle"
fi

# Gradle 8.x (the template wrapper) cannot run on very new JDKs (class file
# major 69 = JDK 25 fails hard). Prefer a 17/21 toolchain whenever one exists
# — the ambient JAVA_HOME on dev machines is often too new. CI sets temurin
# 17 via setup-java; a caller-set JAVA_HOME is only used as a last resort.
for candidate in \
	/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
	/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home; do
	if [[ -x "$candidate/bin/java" ]]; then
		export JAVA_HOME="$candidate"
		break
	fi
done
echo "JAVA_HOME: ${JAVA_HOME:-<ambient>}"

echo "== gradle $STAGE build"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
if [[ "$STAGE" == "debug" ]]; then
	(cd "$PROJ_DIR" && "$GRADLE" assembleDebug --no-daemon)
	APK="$(find "$PROJ_DIR" -path '*/outputs/apk/debug/*.apk' -print -quit)"
	if [[ -z "$APK" ]]; then
		echo "assembleDebug produced no APK" >&2
		exit 1
	fi
	cp "$APK" "$OUT_DIR/$APP_NAME-debug.apk"
	echo
	echo "Debug APK: $OUT_DIR/$APP_NAME-debug.apk (dry run OK, no signing attempted)"
	exit 0
fi

# AGP injected properties: versions and signing without editing generated
# files. Works for any AGP project — this is exactly what Android Studio does.
(cd "$PROJ_DIR" && "$GRADLE" bundleRelease --no-daemon \
	-Pandroid.injected.version.code="$BUILD" \
	-Pandroid.injected.version.name="$VERSION" \
	-Pandroid.injected.signing.store.file="$KEYSTORE" \
	-Pandroid.injected.signing.store.password="$KEYSTORE_PASS" \
	-Pandroid.injected.signing.key.alias="$KEYSTORE_USER" \
	-Pandroid.injected.signing.key.password="$KEY_PASS")

AAB="$(find "$PROJ_DIR" -path '*/outputs/bundle/release/*.aab' -print -quit)"
if [[ -z "$AAB" ]]; then
	echo "bundleRelease produced no AAB" >&2
	exit 1
fi
cp "$AAB" "$OUT_DIR/$APP_NAME-release.aab"

echo "== verify versionCode"
AAPT2="$(find "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/nonexistent}}" \
	-build-tools -name aapt2 -type f -print 2>/dev/null | sort -V | tail -1 || true)"
if [[ -n "$AAPT2" ]]; then
	CODE="$("$AAPT2" dump badging "$OUT_DIR/$APP_NAME-release.aab" 2>/dev/null \
		| head -1 | sed -n 's/.*versionCode=.\([0-9]*\).*/\1/p')"
	if [[ "$CODE" == "$BUILD" ]]; then
		echo "versionCode $CODE matches build $BUILD"
	else
		echo "versionCode mismatch: AAB says '$CODE', expected '$BUILD' \
(injected properties may be ignored by this template)" >&2
		exit 1
	fi
else
	echo "aapt2 not found; skipping versionCode check (play_upload will print it)"
fi

echo
echo "AAB: $OUT_DIR/$APP_NAME-release.aab (version $VERSION build $BUILD)"
