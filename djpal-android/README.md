# DJPal for Android (DJPal Bridge)

The DJPal party page inside an Android app, plus a helper that loads requests into djay for you.

Download: `https://abhyuday2103.github.io/games/djpal/DJPalBridge.apk`

## What it does

Tap **Deck 1** or **Deck 2** on any request. DJPal Bridge opens djay, taps that deck's load button, types the song into djay's search, and taps the matching result. It uses Android's Accessibility feature, the same thing screen readers and auto-clickers use. It only acts when you tap Load, Teach or Capture.

Guests stay connected while you're in djay, because the app keeps running in the background.

## Setup on the phone (about 3 minutes, once)

1. Open the APK link on the phone and install it. Android will ask to allow installs from your browser; allow it.
2. Open DJPal, tap **Bridge**.
3. **Switch on the bridge.** Tap Open Accessibility settings, find DJPal Bridge, switch it on. If Android greys it out ("Restricted setting"), go back, tap App info, tap the ⋮ menu in the corner, choose **Allow restricted settings**, then switch it on.
4. **In djay:** Settings > turn off **Start Playback** (so a loaded song waits for you), and pick **Apple Music** as the library source.
5. **Teach djay.** Hold the phone the way you DJ. DJPal opens djay and asks you to tap 4 spots: Deck 1's load button, the search box, the first result, Deck 2's load button.
6. **Test.** Load a test song puts Kesariya on Deck 1.

If djay updates and loads start missing, run Teach again. If it still misses, use **Capture djay's screen** and send the text to Claude.

## Building

Plain Android SDK tools, no Gradle: `ANDROID_HOME=/path/to/sdk ./build.sh` produces `build/DJPalBridge.apk`. Needs `platforms;android-35`, `build-tools;35.0.0` and a JDK 17+. The signing key in `keystore/` is not committed. A build signed with a different key will not install over the old app: uninstall DJPal first, then install, then run Teach again.
