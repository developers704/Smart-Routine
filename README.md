# Routine

Hospital shift calendar. You enter **M / M+A / E+N / N** (or leave the day off). Generate fills sleep, recovery, meals, commute, JK, MCAT, gym, laundry, groceries, meal prep, and chores.

## Run

```bash
npm ci
npm test
npm start
```

Open http://localhost:4173

Allow notifications so event alarms and the end-of-day notepad reminder can fire.

On a phone browser, use the **Download Routine** banner (Chrome: Install app; iPhone Safari: Share → Add to Home Screen). After that, open it from the home screen like a normal app.

## Native builds (Capacitor 8)

Requires **Node 22+**. Xcode **26+** for iOS, Android Studio **Otter (2025.2.1)+** with **JDK 21** for Android. Minimum iOS is **17.0**; Android `minSdk` is 24 and `compileSdk`/`targetSdk` are 36.

### How the native app loads and stores data

The native app runs the **bundled** copy of `client/` (`webDir: "client"`); there is no `server.url`, so it is not a wrapper around the live site. The web view origin is `https://localhost` (`server.hostname` / `iosScheme` / `androidScheme`), and `npx cap sync` copies `client/` into the platform projects.

That has a consequence worth knowing before Phase 3:

- Relative `/api/...` requests resolve against `https://localhost`, which only serves bundled files, so **every API call fails inside the native app**. `client/app.js` catches that and falls back to `localStorage`, `planRange()` runs the schedule generator on-device, and `save()` keeps writing locally.
- The native app therefore works fully offline, and **its data is separate from the PWA's** — nothing syncs to the VPS.
- Alarms in the native app come from Capacitor local notifications, not Web Push. Web Push is the PWA path only.

Wiring the native app to the server needs an absolute API base plus the authentication work, which is deliberately out of scope here.

## iPhone (iOS 17+, iPhone Pro)

Build on a **Mac**. Target is **iPhone only**, portrait, Dynamic Island / home-indicator safe areas, native local-notification alarms. The project uses **CocoaPods** (Capacitor 8 defaults new projects to SPM; this one stays on CocoaPods).

```bash
npm ci
npx cap sync ios
node scripts/patch-ios.mjs
cd ios/App && pod install && cd ../..
npx cap open ios
```

Do **not** run `npx cap add ios` — the existing project would be replaced with an SPM template. `scripts/patch-ios.mjs` is idempotent and re-asserts the iOS 17.0 target, iPhone-only device family, portrait orientation and usage descriptions after every sync.

In Xcode: select the **App** target → iPhone 17 Pro simulator or a physical device → Run. First launch, allow notifications.

## Android

```bash
npx cap sync android
cd android && ./gradlew assembleDebug
```

Or `npx cap open android`. Edge-to-edge is handled with the `env(safe-area-inset-*)` variables already in `client/styles.css`, which is the Capacitor 8 approach after `adjustMarginsForEdgeToEdge` was removed.

## What Generate does

- **M**: 07:00–15:00, wake 06:00, 7h sleep, JK 19:00 (2h) if the slot is free
- **M+A**: 07:00–19:00, wake 06:00; JK skipped when it overlaps the shift
- **E+N**: 19:00–07:00, no JK, recovery sleep after the commute home
- **N**: 23:00–07:00, JK if free, recovery sleep after
- **Off**: wake 08:00, 8h sleep, meals ≥4h apart, 6h+ MCAT target
- Commute 30 min each way; “Call parents” on commute blocks
- Gym 3× / week, laundry weekly, groceries every other ISO week, meal prep 2×, misc chores 2–4h spread into gaps
- Sleep never scheduled over 12h
- Your events, locked edits, and checked-off auto blocks are kept on regenerate
