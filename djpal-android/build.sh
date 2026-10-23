#!/usr/bin/env bash
# Builds DJPalBridge.apk with plain SDK tools (no Gradle).
# Needs ANDROID_HOME with platforms;android-35 and build-tools;35.0.0, and a JDK.
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-/opt/android-sdk}"
BT="$SDK/build-tools/35.0.0"
JAR="$SDK/platforms/android-35/android.jar"
KS="${DJPAL_KEYSTORE:-keystore/djpal.jks}"
OUT=build
rm -rf "$OUT" && mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes" "$OUT/dex"

"$BT/aapt2" compile --dir res -o "$OUT/res/"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$JAR" --manifest AndroidManifest.xml \
  --min-sdk-version 26 --target-sdk-version 35 --version-code 1 --version-name 1.0 \
  --java "$OUT/gen" "$OUT"/res/*.flat

javac -source 17 -target 17 -Xlint:-options -encoding UTF-8 -classpath "$JAR" -d "$OUT/classes" \
  $(find src "$OUT/gen" -name '*.java')

"$BT/d8" --release --min-api 26 --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')

cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT/dex" && zip -q -j ../unsigned.apk classes.dex)
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

if [ ! -f "$KS" ]; then
  mkdir -p "$(dirname "$KS")"
  keytool -genkeypair -v -keystore "$KS" -alias djpal -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass djpalbridge -keypass djpalbridge -dname "CN=DJPal Bridge, O=Abhyuday" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:djpalbridge --key-pass pass:djpalbridge \
  --out "$OUT/DJPalBridge.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify "$OUT/DJPalBridge.apk"
ls -la "$OUT/DJPalBridge.apk"
