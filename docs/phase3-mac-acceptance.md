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

### iOS 17–25

1. Confirm the app runs (deployment target 17.0).
2. Confirm wake/shift/leave reminders fall back to Capacitor
   LocalNotifications. Silent Mode and Focus bypass are **not** guaranteed.
3. The math UI may still appear, but it is not full AlarmKit protection.

## Known iOS limitations (honest)

- Apple’s system **Stop** button cannot be removed, hidden, or blocked.
- Backup count is finite (1–3). This is not indefinite ringing.
- AlarmKit is iOS 26+ only.
- On iOS 17–25, local-notification backups may be silenced by Silent/Focus.
- One-shot AlarmKit alarms disappear from `AlarmManager.shared.alarms`
  after they fire and are stopped; the native manifest is always compared
  against the live set.
- Custom licensed alarm audio is not shipped.
- Screen Time / Family Controls, PIN / Face ID, and permanent app auth are
  not in this phase.
