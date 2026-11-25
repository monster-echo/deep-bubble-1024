# Deep Bubble 1024 · 深海啵啵

An offline Cocos Creator puzzle game about merging liquid number bubbles. The Android application ID is `tech.zhongbei.deepbubble1024`.

## Android release

Start **Android release** in the GitHub Actions tab. A normal run builds and signs an Android App Bundle, uploads the build to the Google Play internal testing track, and saves a production track draft. The workflow does not submit the production draft for review.

Select `dry_run` to build a debug APK without signing or uploading it.

Configure these repository Actions secrets before a release run:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`

The service account needs release access to `tech.zhongbei.deepbubble1024` in Play Console. Set the version in `release/version.json` and provide English release notes at `release/play-store/release-notes/<version>/en-US.txt`.

The build upgrades the generated Android Gradle Plugin to 8.7.3, uses NDK 27.2, and applies 16 KB ELF alignment flags to the native Cocos library.

## Privacy policy

The Play listing policy page is hosted on Cloudflare Pages at
https://deep-bubble-legal.pages.dev/privacy/ . Its source is in
`store/legal-site/privacy/`. The in-game Settings screen links to the same page.
