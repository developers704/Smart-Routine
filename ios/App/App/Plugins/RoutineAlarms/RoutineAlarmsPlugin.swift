import Foundation
import Capacitor

/// Capacitor 8 local plugin. Registered via `@objc(RoutineAlarmsPlugin)` plus
/// `packageClassList` in capacitor.config.json (re-asserted by patch-ios.mjs
/// after `npx cap sync ios`).
///
/// The App target's deployment target stays iOS 17.0. Every AlarmKit call is
/// behind `@available(iOS 26.0, *)` and `#if canImport(AlarmKit)`.
@objc(RoutineAlarmsPlugin)
public class RoutineAlarmsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RoutineAlarmsPlugin"
    public let jsName = "RoutineAlarms"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAuthorizationStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncAlarms", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getScheduledAlarms", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scheduleTestAlarm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelTestAlarm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingWakeChallenge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "submitWakeChallenge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelWakeProtection", returnType: CAPPluginReturnPromise)
    ]

    public override func load() {
        // Never prompt for AlarmKit authorization here — only the user-tapped
        // Enable Alarms button may call requestAuthorization().
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            Task { await AlarmKitService.shared.startObserving() }
        }
        #endif
    }

    @objc func isSupported(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            once.resolve(["supported": true])
            return
        }
        #endif
        once.resolve(["supported": false, "reason": "requires-ios-26"])
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            Task {
                do {
                    let status = try await AlarmKitService.shared.requestAuthorization()
                    once.resolve(["status": status, "ok": status == "authorized"])
                } catch {
                    once.resolve(["ok": false, "status": "denied", "error": String(describing: error)])
                }
            }
            return
        }
        #endif
        once.resolve(["ok": false, "status": "unavailable", "reason": "requires-ios-26"])
    }

    @objc func getAuthorizationStatus(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            Task {
                let status = await AlarmKitService.shared.authorizationStatus()
                once.resolve(["status": status])
            }
            return
        }
        #endif
        once.resolve(["status": "unavailable"])
    }

    @objc func syncAlarms(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            Task { await self.performSync(call, once: once) }
            return
        }
        #endif
        once.resolve([
            "ok": true,
            "skipped": "requires-ios-26",
            "scheduled": 0, "updated": 0, "cancelled": 0, "unchanged": 0,
            "failed": [], "capped": [], "errors": []
        ])
    }

    @available(iOS 26.0, *)
    private func performSync(_ call: CAPPluginCall, once: CallOnce) async {
        #if canImport(AlarmKit)
        let raw = call.getArray("alarms") ?? []
        let snoozeMin = max(1, min(60, call.getInt("snoozeMin") ?? 9))
        let verification = call.getObject("wakeVerification") ?? [:]
        let difficulty = verification["difficulty"] as? String ?? "medium"
        let questionCount = verification["questionCount"] as? Int ?? 1
        UserDefaults.standard.set(difficulty, forKey: "routine.wakeChallenge.difficulty")
        UserDefaults.standard.set(questionCount, forKey: "routine.wakeChallenge.questionCount")

        let protectPrimaryId = call.getString("protectPrimaryId")
        let extraCount = call.getInt("extraBackupCount") ?? 8
        var protectFamily = RoutineAlarmIdentity.familyIds(forPrimary: protectPrimaryId, extraCount: extraCount)
        if let active = WakeChallengeService.shared.currentAlarmId() {
            let primary = RoutineAlarmIdentity.primaryId(of: active) ?? active
            protectFamily.formUnion(RoutineAlarmIdentity.familyIds(forPrimary: primary, extraCount: extraCount))
        }

        var desired: [AlarmKitService.DesiredAlarm] = []
        var errors: [String] = []
        for entry in raw {
            guard let obj = entry as? JSObject else { continue }
            switch Self.parseDesired(obj, snoozeMin: snoozeMin) {
            case .success(let item):
                desired.append(item)
            case .failure(let err):
                errors.append(err)
            }
        }

        if let protected = desired.first(where: { $0.protected && !$0.isBackup }) {
            WakeChallengeService.shared.rememberProtectedWake(
                alarmId: protected.planId,
                at: protected.at,
                difficulty: difficulty,
                questionCount: questionCount
            )
        } else if protectPrimaryId == nil && WakeChallengeService.shared.currentAlarmId() == nil {
            WakeChallengeService.shared.clearProtectedWake()
        }

        let result = await AlarmKitService.shared.sync(desired: desired, protectFamily: protectFamily)
        var payload: [String: Any] = [
            "ok": result.ok && errors.isEmpty,
            "scheduled": result.scheduled,
            "updated": result.updated,
            "cancelled": result.cancelled,
            "unchanged": result.unchanged,
            "failed": result.failed,
            "capped": result.capped,
            "errors": result.errors + errors,
            "maximumLimitReached": result.maximumLimitReached
        ]
        if !errors.isEmpty { payload["error"] = errors.joined(separator: "; ") }
        if result.maximumLimitReached { payload["error"] = "maximumLimitReached" }
        once.resolve(payload)
        #endif
    }

    @objc func getScheduledAlarms(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            Task {
                do {
                    let alarms = try await AlarmKitService.shared.scheduledAlarms()
                    once.resolve(["ok": true, "alarms": alarms])
                } catch {
                    once.resolve(["ok": false, "alarms": [], "error": String(describing: error)])
                }
            }
            return
        }
        #endif
        once.resolve(["ok": true, "alarms": []])
    }

    @objc func scheduleTestAlarm(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            Task {
                let minutes = max(1, call.getInt("minutes") ?? 2)
                guard let atString = call.getString("at"), let at = Self.parseDate(atString), at.timeIntervalSinceNow > 0 else {
                    once.resolve(["ok": false, "reason": "invalid-date", "error": "Test alarm time is missing or in the past."])
                    return
                }
                do {
                    try await AlarmKitService.shared.scheduleTest(at: at, minutes: minutes)
                    once.resolve(["ok": true, "id": RoutineAlarmIdentity.testAlarmPlanId, "at": atString])
                } catch {
                    once.resolve(["ok": false, "reason": "error", "error": String(describing: error)])
                }
            }
            return
        }
        #endif
        once.resolve(["ok": false, "reason": "requires-ios-26", "error": "Test alarms need AlarmKit on iOS 26."])
    }

    @objc func cancelTestAlarm(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            Task {
                do {
                    try await AlarmKitService.shared.cancelTest()
                    once.resolve(["ok": true])
                } catch {
                    once.resolve(["ok": false, "error": String(describing: error)])
                }
            }
            return
        }
        #endif
        once.resolve(["ok": true, "skipped": "requires-ios-26"])
    }

    @objc func getPendingWakeChallenge(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        if let opened = WakeChallengeService.shared.openedAlarmId(),
           WakeChallengeService.shared.currentAlarmId() == nil {
            let difficulty = UserDefaults.standard.string(forKey: "routine.wakeChallenge.difficulty") ?? "medium"
            let count = UserDefaults.standard.integer(forKey: "routine.wakeChallenge.questionCount")
            WakeChallengeService.shared.activate(
                alarmId: opened,
                difficulty: difficulty,
                questionCount: count == 0 ? 1 : count,
                wakeAt: nil
            )
        }
        let view = WakeChallengeService.shared.publicView()
        var payload: [String: Any] = [
            "active": view.active,
            "attempts": view.attempts
        ]
        if view.active {
            payload["alarmId"] = view.alarmId ?? ""
            payload["question"] = view.question ?? ""
            payload["questionNumber"] = view.questionNumber ?? 1
            payload["questionCount"] = view.questionCount ?? 1
        }
        once.resolve(payload)
    }

    @objc func submitWakeChallenge(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        let alarmId = call.getString("alarmId")
        let answer = call.getString("answer") ?? String(call.getInt("answer") ?? Int.min)
        let result = WakeChallengeService.shared.submit(
            alarmId: alarmId,
            answer: answer == String(Int.min) ? call.getString("answer") : answer
        )
        if result.complete, let id = alarmId ?? WakeChallengeService.shared.currentAlarmId() {
            #if canImport(AlarmKit)
            if #available(iOS 26.0, *) {
                Task { await AlarmKitService.shared.cancelFamily(primaryPlanId: RoutineAlarmIdentity.primaryId(of: id) ?? id) }
            }
            #endif
            WakeChallengeService.shared.clear()
            WakeChallengeService.shared.clearProtectedWake()
        }
        var payload: [String: Any] = [
            "correct": result.correct,
            "complete": result.complete,
            "attempts": result.attempts
        ]
        if let next = result.nextQuestion { payload["nextQuestion"] = next }
        once.resolve(payload)
    }

    @objc func cancelWakeProtection(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        let alarmId = call.getString("alarmId") ?? WakeChallengeService.shared.currentAlarmId()
        guard let alarmId else {
            once.resolve(["ok": false, "reason": "missing-id"])
            return
        }
        let primary = RoutineAlarmIdentity.primaryId(of: alarmId) ?? alarmId
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            Task {
                await AlarmKitService.shared.cancelFamily(primaryPlanId: primary)
                WakeChallengeService.shared.clear()
                once.resolve(["ok": true, "alarmId": primary])
            }
            return
        }
        #endif
        WakeChallengeService.shared.clear()
        once.resolve(["ok": true, "alarmId": primary, "skipped": "requires-ios-26"])
    }

    @available(iOS 26.0, *)
    private static func parseDesired(_ obj: JSObject, snoozeMin: Int) -> Result<AlarmKitService.DesiredAlarm, String> {
        #if canImport(AlarmKit)
        guard let planId = obj["id"] as? String, !planId.isEmpty else {
            return .failure("missing id")
        }
        guard let title = obj["title"] as? String, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .failure("\(planId): missing title")
        }
        let role = (obj["role"] as? String) ?? ""
        guard ["wake", "shift", "leave"].contains(role) else {
            return .failure("\(planId): invalid role")
        }
        guard let atString = obj["at"] as? String, let at = parseDate(atString) else {
            return .failure("\(planId): invalid date")
        }
        if at.timeIntervalSinceNow < 1 {
            return .failure("\(planId): date is in the past")
        }
        let isBackup = RoutineAlarmIdentity.isBackup(planId)
        let protected = (obj["protected"] as? Bool) ?? false
        let snooze = (obj["snooze"] as? Bool) ?? !protected
        if protected && snooze {
            return .failure("\(planId): math verification and snooze cannot overlap")
        }
        return .success(AlarmKitService.DesiredAlarm(
            planId: planId,
            role: role,
            at: at,
            title: title,
            body: (obj["body"] as? String) ?? "",
            protected: protected || isBackup,
            snooze: snooze && !isBackup,
            snoozeMin: snoozeMin,
            isBackup: isBackup,
            primaryId: obj["primaryId"] as? String ?? RoutineAlarmIdentity.primaryId(of: planId)
        ))
        #else
        return .failure("AlarmKit unavailable")
        #endif
    }

    private static func parseDate(_ value: String) -> Date? {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = iso.date(from: value) { return date }
        iso.formatOptions = [.withInternetDateTime]
        if let date = iso.date(from: value) { return date }
        return nil
    }
}

/// Ensures a CAPPluginCall is resolved or rejected exactly once.
final class CallOnce {
    private var done = false
    private let lock = NSLock()
    private let call: CAPPluginCall

    init(_ call: CAPPluginCall) {
        self.call = call
    }

    func resolve(_ data: [String: Any] = [:]) {
        lock.lock()
        defer { lock.unlock() }
        guard !done else { return }
        done = true
        call.resolve(data)
    }

    func reject(_ message: String, _ code: String? = nil) {
        lock.lock()
        defer { lock.unlock() }
        guard !done else { return }
        done = true
        call.reject(message, code)
    }
}
