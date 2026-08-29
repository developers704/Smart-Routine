# Phase 3 Mac / Xcode acceptance

Linux CI cannot compile Swift or run the iOS Simulator. Treat every command
below as **unverified until a Mac with Xcode 26 runs it**. Do not interpret a
green `npm test` on Linux as an iOS build.

The main App target stays **iOS 17.0**. `RoutineAlarmWidget` deploys at
**iOS 26.0** because it imports AlarmKit. AlarmKit is weak-linked on the App
target.

No App Group is configured. AlarmKit delivers `AlarmAttributes` to the widget
itself; `VerifyAwakeIntent` runs in-process and writes the pending challenge to
standard `UserDefaults`. Signing: select the same Team on **App** and
**RoutineAlarmWidget** (`app.routine.calendar` /
`app.routine.calendar.RoutineAlarmWidget`). Automatic signing is enough; there
are no Family Controls entitlements.

## Commands

```bash
npm ci
npm test
npx cap sync ios
node scripts/patch-ios.mjs
cd ios/App
pod install --repo-update

xcodebuild \
  -workspace App.xcworkspace \
  -scheme App \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

`npx cap sync ios` rewrites `packageClassList`. Always re-run
`node scripts/patch-ios.mjs` afterwards so `RoutineAlarmsPlugin` stays
registered, the widget target stays embedded, and
`NSAlarmKitUsageDescription` / `NSSupportsLiveActivities` remain in Info.plist.

## Physical iPhone 17 Pro on latest iOS 26

### Normal mode (Wake Verification off)

1. Open Smart Routine and tap **Enable iPhone alarms**. Confirm the system
   prompt. Authorization must not appear at startup.
2. Schedule the 2-minute **Test alarm**.
3. Lock the phone and terminate Smart Routine.
4. Enable Silent Mode and a Focus.
5. Confirm the alarm rings.
6. Confirm **Stop** dismisses it.
7. Schedule another test, confirm **Snooze** starts the countdown and the
   Lock Screen / Dynamic Island live activity.
8. Confirm the Live Activity is not a fake countdown (missing widget
   extensions can fail to alert).

### Math Wake Verification

1. Enable **Math Wake Verification** on Set. Leave shift/leave alarms on
   normal Stop/Snooze.
2. Schedule a protected wake (sleep block that ends soon, or wait for the
   next real wake).
3. When it fires, tap **Solve to Stop**. The app must open onto the math
   challenge without stopping the ringing alarm.
4. Enter a wrong answer: the alarm and backups must keep going.
5. Enter the correct answer(s): the current alarm stops and every backup is
   cancelled.
6. On a fresh protected wake, press Apple’s **system Stop** without solving.
   The current alarm may stop. Backup alarms must still ring. Smart Routine
   does not claim the alarm is uninterruptible — Apple’s Stop button cannot
   be removed or blocked.
7. Force-close the challenge without solving: backups remain.
8. Confirm regeneration / restart does not duplicate backups.
9. Edit, delete, or complete the sleep event and confirm the primary and
   backups are cancelled or retimed.
10. Restart the app and the device and confirm scheduled alarms survive.
11. While the alarm is ringing, open Smart Routine (cold start and appActive).
    The math screen appears and the family must still be alerting — sync must
    not cancel it.
12. A wrong answer must leave the complete family; only a correct solve or an
    explicit cancel may remove it. After a correct solve, sync the next wake.

### iOS 17–25

1. Confirm the app runs (deployment target 17.0).
2. Confirm wake/shift/leave reminders fall back to Capacitor
   LocalNotifications with `interruptionLevel: "timeSensitive"`. Silent Mode
   and Focus bypass are **not** guaranteed.
3. Enable **Math Wake Verification**. Confirm the settings copy says backups
   are ordinary notifications and that the notification itself does **not**
   have AlarmKit’s Solve to Stop button.
4. After the wake fires, open Smart Routine. The math challenge must appear
   (`syncWakeProtection` arms it without AlarmKit). A wrong answer must leave
   backup notifications pending. A correct solve must set `verifiedAt` and
   cancel the primary and backups.

### Partial AlarmKit leftover

1. On iOS 26 with AlarmKit authorized, force a per-item schedule failure
   (or observe `ok: false`, `scheduled: 1`, `failed: [{ id }]`, `capped: []`).
2. Confirm the successful AlarmKit alarm is **not** also a local notification.
3. Confirm only the failed/capped ids fall back to LocalNotifications.
4. `maximumLimitReached` is partial: leftover is only the capped ids.

## Known iOS limitations (honest)

- Apple’s system **Stop** button cannot be removed, hidden, or blocked.
- Backup count is finite (1–3). This is not indefinite ringing.
- AlarmKit is iOS 26+ only.
- On iOS 17–25, alarm-channel fallback notifications request `interruptionLevel: "timeSensitive"` (Capacitor 8). Silent Mode and Focus bypass are still **not** guaranteed. Math verification is still native-iOS-only: `syncWakeProtection` remembers the next protected wake without calling AlarmKit, and opening the app at/after fire time shows the challenge. The fallback notification does not have AlarmKit’s Solve to Stop button.
- A partial AlarmKit sync (`ok: false` with `failed` / `capped` / `maximumLimitReached`) keeps AlarmKit ownership of successful items and leftovers only those ids to LocalNotifications. A fatal AlarmManager query is reported separately and must not dump the whole alarm channel onto LocalNotifications.
- The combined 64 pending LocalNotifications cap reserves the nearest wake, its backups, and other alarm-channel items first. Ordinary reminders fill leftover slots.
- Opening the app while an alarm is ringing refreshes the pending math challenge before any resync and must not cancel the alerting family.
- One-shot AlarmKit alarms disappear from `AlarmManager.shared.alarms`
  after they fire and are stopped; the native manifest is always compared
  against the live set.
- Custom licensed alarm audio is not shipped.
- Screen Time / Family Controls, PIN / Face ID, and permanent app auth are
  not in this phase.
