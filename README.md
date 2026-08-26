# Routine

Hospital shift calendar. You enter **M / M+A / E+N / N** (or leave the day off). Generate fills sleep, recovery, meals, commute, JK, MCAT, gym, laundry, groceries, meal prep, and chores.

## Run

```bash
npm install
npm test
npm start
```

Open http://localhost:4173

Allow notifications so event alarms and the end-of-day notepad reminder can fire.

On a phone browser, use the **Download Routine** banner (Chrome: Install app; iPhone Safari: Share → Add to Home Screen). After that, open it from the home screen like a normal app.

## iPhone (iOS 17+, iPhone Pro)

This is a Capacitor iOS app. Build it on a **Mac** with Xcode 15+ (iOS 17 SDK). Target is **iPhone only**, portrait, Dynamic Island / home-indicator safe areas, native local-notification alarms.

```bash
npm install
npx cap add ios
npx cap sync ios
node scripts/patch-ios.mjs
npx cap open ios
```

In Xcode: select **App** target → iPhone 15 Pro / 16 Pro / 17 Pro simulator or a physical Pro device → Run. First launch, allow notifications.

Minimum iOS: **17.0**. The app also works offline; shifts and events stay on the phone.

## Android

```bash
npx cap sync android
npx cap open android
```

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
