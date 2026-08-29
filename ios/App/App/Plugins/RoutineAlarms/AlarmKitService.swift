import Foundation
import SwiftUI

#if canImport(AlarmKit)
import AlarmKit
import AppIntents
#endif

/// AlarmKit scheduling, diff-sync and observation.
///
/// Every symbol in this file is an official AlarmKit / iOS 26 API:
///   AlarmManager.shared.{requestAuthorization, authorizationState, authorizationUpdates,
///                        schedule(id:configuration:), alarms, alarmUpdates, cancel, stop}
///   Alarm.Schedule.fixed(Date)
///   Alarm.CountdownDuration(preAlert:postAlert:)
///   AlarmPresentation.Alert / Countdown / Paused
///   AlarmButton(text:textColor:systemImageName:)
///   AlarmAttributes<Metadata>
///   AlarmManager.AlarmConfiguration(...)
///   AlarmManager.AlarmError.maximumLimitReached
///   AlarmAlertSound.default  (`.default`)
///
/// The main app target stays iOS 17.0; this type is `@available(iOS 26.0, *)`
/// and the AlarmKit import is `canImport`-gated so older SDKs still compile.
#if canImport(AlarmKit)
@available(iOS 26.0, *)
actor AlarmKitService {
    static let shared = AlarmKitService()

    private let defaults = UserDefaults.standard
    private let manifestKey = "routine.alarmkit.manifest.v1"
    private var observing = false

    struct DesiredAlarm: Sendable {
        var planId: String
        var role: String
        var at: Date
        var title: String
        var body: String
        var protected: Bool
        var snooze: Bool
        var snoozeMin: Int
        var isBackup: Bool
        var primaryId: String?

        var uuid: UUID { RoutineAlarmIdentity.uuid(fromPlanId: planId) }

        var fingerprint: String {
            "\(at.timeIntervalSince1970)|\(title)|\(body)|\(role)|\(protected)|\(snooze)|\(snoozeMin)|\(isBackup)"
        }
    }

    struct SyncResult: Sendable {
        var ok: Bool
        var scheduled: Int
        var updated: Int
        var cancelled: Int
        var unchanged: Int
        var failed: [[String: String]]
        var capped: [[String: String]]
        var errors: [String]
        var maximumLimitReached: Bool
        var fatal: Bool
        var partial: Bool
    }

    private struct ManifestEntry: Codable {
        var planId: String
        var role: String
        var at: Date
        var title: String
        var fingerprint: String
        var isBackup: Bool
        var primaryId: String?
        var protected: Bool
    }

    func startObserving() async {
        guard !observing else { return }
        observing = true
        Task { [weak self] in
            guard let self else { return }
            for await alarms in AlarmManager.shared.alarmUpdates {
                await self.handleUpdates(alarms)
            }
        }
        Task {
            for await _ in AlarmManager.shared.authorizationUpdates {
                // Diagnostics re-read authorization on the next JS poll.
            }
        }
    }

    private func handleUpdates(_ alarms: [Alarm]) {
        for alarm in alarms where alarm.state == .alerting {
            guard let entry = loadManifest()[alarm.id], entry.protected, !entry.isBackup else { continue }
            WakeChallengeService.shared.activate(
                alarmId: entry.planId,
                difficulty: UserDefaults.standard.string(forKey: "routine.wakeChallenge.difficulty") ?? "medium",
                questionCount: UserDefaults.standard.integer(forKey: "routine.wakeChallenge.questionCount") == 0
                    ? 1
                    : UserDefaults.standard.integer(forKey: "routine.wakeChallenge.questionCount"),
                wakeAt: entry.at
            )
        }
    }

    func authorizationStatus() -> String {
        switch AlarmManager.shared.authorizationState {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unavailable"
        }
    }

    func requestAuthorization() async throws -> String {
        let state = try await AlarmManager.shared.requestAuthorization()
        switch state {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unavailable"
        }
    }

    func scheduledAlarms() throws -> [[String: Any]] {
        let live = try AlarmManager.shared.alarms
        let manifest = loadManifest()
        return live.map { alarm in
            let entry = manifest[alarm.id]
            return [
                "id": entry?.planId ?? alarm.id.uuidString,
                "uuid": alarm.id.uuidString,
                "role": entry?.role ?? "",
                "title": entry?.title ?? "",
                "at": ISO8601DateFormatter().string(from: entry?.at ?? Date()),
                "backup": entry?.isBackup ?? RoutineAlarmIdentity.isBackup(entry?.planId ?? ""),
                "state": String(describing: alarm.state)
            ]
        }
    }

    func sync(desired: [DesiredAlarm], cancelStale: Bool = true, protectFamily: Set<String> = []) async -> SyncResult {
        var result = SyncResult(
            ok: true, scheduled: 0, updated: 0, cancelled: 0, unchanged: 0,
            failed: [], capped: [], errors: [], maximumLimitReached: false,
            fatal: false, partial: false
        )
        let testUUID = RoutineAlarmIdentity.testAlarmUUID()
        let desiredByUUID = Dictionary(uniqueKeysWithValues: desired.map { ($0.uuid, $0) })
        let protect = Set(protectFamily.map { $0.lowercased() })

        func isProtected(_ alarm: Alarm, manifest: [UUID: ManifestEntry]) -> Bool {
            if let entry = manifest[alarm.id] {
                if protect.contains(entry.planId.lowercased()) { return true }
                if let primary = entry.primaryId, protect.contains(primary.lowercased()) { return true }
                if let primary = RoutineAlarmIdentity.primaryId(of: entry.planId),
                   protect.contains(primary.lowercased()) { return true }
            }
            return false
        }

        let live: [Alarm]
        do {
            live = try AlarmManager.shared.alarms
        } catch {
            result.ok = false
            result.fatal = true
            result.partial = false
            result.errors.append(String(describing: error))
            return result
        }

        var liveById: [UUID: Alarm] = [:]
        for alarm in live { liveById[alarm.id] = alarm }

        var manifest = loadManifest()

        if cancelStale {
            for alarm in live {
                if alarm.id == testUUID { continue }
                if isProtected(alarm, manifest: manifest) { continue }
                if desiredByUUID[alarm.id] == nil {
                    if manifest[alarm.id] != nil || isOurs(alarm.id, manifest: manifest) {
                        do {
                            try AlarmManager.shared.cancel(id: alarm.id)
                            result.cancelled += 1
                            manifest.removeValue(forKey: alarm.id)
                        } catch {
                            result.errors.append("cancel \(alarm.id.uuidString): \(error)")
                            result.failed.append(["id": manifest[alarm.id]?.planId ?? alarm.id.uuidString, "error": String(describing: error)])
                        }
                    }
                }
            }
        }

        for item in desired {
            if item.at.timeIntervalSinceNow < 1 {
                // Do not reschedule an alerting / already-fired protected family member.
                result.unchanged += 1
                continue
            }
            let id = item.uuid
            if let existing = liveById[id], manifest[id]?.fingerprint == item.fingerprint {
                result.unchanged += 1
                continue
            }
            let updating = liveById[id] != nil
            if updating {
                do {
                    try AlarmManager.shared.cancel(id: id)
                } catch {
                    result.errors.append("pre-update cancel \(item.planId): \(error)")
                }
            }
            do {
                try await schedule(item)
                if updating { result.updated += 1 } else { result.scheduled += 1 }
                manifest[id] = ManifestEntry(
                    planId: item.planId,
                    role: item.role,
                    at: item.at,
                    title: item.title,
                    fingerprint: item.fingerprint,
                    isBackup: item.isBackup,
                    primaryId: item.primaryId,
                    protected: item.protected
                )
                liveById[id] = nil
            } catch {
                if isMaximumLimit(error) {
                    result.maximumLimitReached = true
                    result.ok = false
                    result.partial = true
                    result.capped.append(["id": item.planId, "error": "maximumLimitReached"])
                    result.errors.append("maximumLimitReached: \(item.planId)")
                    // Keep already-scheduled alarms; do not try the rest of the
                    // list once Apple's cap is hit.
                    for leftover in desired where desiredByUUID[leftover.uuid] != nil && liveById[leftover.uuid] == nil && manifest[leftover.uuid] == nil {
                        if leftover.planId == item.planId { continue }
                        result.capped.append(["id": leftover.planId, "error": "maximumLimitReached"])
                    }
                    break
                }
                result.failed.append(["id": item.planId, "error": String(describing: error)])
                result.errors.append("schedule \(item.planId): \(error)")
                result.ok = false
                result.partial = true
            }
        }

        saveManifest(manifest)
        if result.maximumLimitReached {
            result.ok = false
            result.partial = true
        }
        return result
    }

    func scheduleTest(at: Date, minutes: Int) async throws {
        let item = DesiredAlarm(
            planId: RoutineAlarmIdentity.testAlarmPlanId,
            role: "wake",
            at: at,
            title: "Smart Routine test alarm",
            body: "Scheduled \(minutes) minutes ago. AlarmKit works.",
            protected: false,
            snooze: true,
            snoozeMin: 9,
            isBackup: false,
            primaryId: nil
        )
        if (try? AlarmManager.shared.alarms.contains(where: { $0.id == item.uuid })) == true {
            try AlarmManager.shared.cancel(id: item.uuid)
        }
        try await schedule(item)
    }

    func cancelTest() throws {
        try AlarmManager.shared.cancel(id: RoutineAlarmIdentity.testAlarmUUID())
    }

    func cancelFamily(primaryPlanId: String) async {
        let ids = RoutineAlarmIdentity.familyIds(forPrimary: primaryPlanId, extraCount: 8)
        for planId in ids {
            let uuid = RoutineAlarmIdentity.uuid(fromPlanId: planId)
            try? AlarmManager.shared.stop(id: uuid)
            try? AlarmManager.shared.cancel(id: uuid)
        }
        var manifest = loadManifest()
        for planId in ids {
            manifest.removeValue(forKey: RoutineAlarmIdentity.uuid(fromPlanId: planId))
        }
        saveManifest(manifest)
    }

    private func schedule(_ item: DesiredAlarm) async throws {
        if item.at.timeIntervalSinceNow < 1 {
            throw AlarmValidationError.pastDate
        }
        let metadata = RoutineAlarmMetadata(
            title: item.title,
            role: item.role,
            planId: item.planId,
            isBackup: item.isBackup
        )

        let secondary: AlarmButton
        let countdownDuration: Alarm.CountdownDuration?
        let useCustomIntent: Bool

        if item.protected || item.isBackup {
            secondary = AlarmButton(
                text: "Solve to Stop",
                textColor: .white,
                systemImageName: "function"
            )
            useCustomIntent = true
            countdownDuration = nil
        } else {
            secondary = AlarmButton(
                text: "Snooze",
                textColor: .white,
                systemImageName: "zzz"
            )
            useCustomIntent = false
            let seconds = TimeInterval(max(1, min(60, item.snoozeMin)) * 60)
            countdownDuration = Alarm.CountdownDuration(preAlert: nil, postAlert: seconds)
        }

        // The system always supplies Stop. We do not set stopIntent, so a
        // system Stop cannot cancel backups. Apple does not allow removing Stop.
        // iOS 26.1+ dropped the stopButton parameter; iOS 26.0 still requires it.
        let title = LocalizedStringResource(stringLiteral: item.title)
        let alert: AlarmPresentation.Alert
        if #available(iOS 26.1, *) {
            alert = AlarmPresentation.Alert(
                title: title,
                secondaryButton: secondary,
                secondaryButtonBehavior: useCustomIntent ? .custom : .countdown
            )
        } else {
            alert = AlarmPresentation.Alert(
                title: title,
                stopButton: AlarmButton(
                    text: LocalizedStringResource("Stop"),
                    textColor: .white,
                    systemImageName: "stop.circle"
                ),
                secondaryButton: secondary,
                secondaryButtonBehavior: useCustomIntent ? .custom : .countdown
            )
        }
        let countdown = AlarmPresentation.Countdown(
            title: LocalizedStringResource(stringLiteral: item.title),
            pauseButton: AlarmButton(text: "Pause", textColor: .white, systemImageName: "pause.fill")
        )
        let paused = AlarmPresentation.Paused(
            title: LocalizedStringResource(stringLiteral: "Paused"),
            resumeButton: AlarmButton(text: "Resume", textColor: .white, systemImageName: "play.fill")
        )
        let presentation = AlarmPresentation(alert: alert, countdown: countdown, paused: paused)
        let attributes = AlarmAttributes(
            presentation: presentation,
            metadata: metadata,
            tintColor: RoutineAlarmStyle.tint
        )
        let configuration = AlarmManager.AlarmConfiguration(
            countdownDuration: countdownDuration,
            schedule: .fixed(item.at),
            attributes: attributes,
            secondaryIntent: useCustomIntent ? VerifyAwakeIntent(alarmId: item.primaryId ?? item.planId) : nil,
            sound: .default
        )
        _ = try await AlarmManager.shared.schedule(id: item.uuid, configuration: configuration)
    }

    private func isMaximumLimit(_ error: Error) -> Bool {
        if let alarmError = error as? AlarmManager.AlarmError {
            if case .maximumLimitReached = alarmError { return true }
        }
        return String(describing: error).localizedCaseInsensitiveContains("maximumLimitReached")
    }

    private func isOurs(_ id: UUID, manifest: [UUID: ManifestEntry]) -> Bool {
        manifest[id] != nil
    }

    private func loadManifest() -> [UUID: ManifestEntry] {
        guard let data = defaults.data(forKey: manifestKey),
              let decoded = try? JSONDecoder().decode([String: ManifestEntry].self, from: data) else {
            return [:]
        }
        var out: [UUID: ManifestEntry] = [:]
        for (key, value) in decoded {
            if let uuid = UUID(uuidString: key) { out[uuid] = value }
        }
        return out
    }

    private func saveManifest(_ manifest: [UUID: ManifestEntry]) {
        var encoded: [String: ManifestEntry] = [:]
        for (key, value) in manifest { encoded[key.uuidString] = value }
        if let data = try? JSONEncoder().encode(encoded) {
            defaults.set(data, forKey: manifestKey)
        }
    }
}

enum AlarmValidationError: LocalizedError {
    case pastDate
    case invalidId
    case invalidTitle
    case invalidRole
    case invalidDate

    var errorDescription: String? {
        switch self {
        case .pastDate: return "alarm time is in the past"
        case .invalidId: return "alarm id is required"
        case .invalidTitle: return "alarm title is required"
        case .invalidRole: return "role must be wake, shift or leave"
        case .invalidDate: return "alarm time is invalid"
        }
    }
}
#endif
