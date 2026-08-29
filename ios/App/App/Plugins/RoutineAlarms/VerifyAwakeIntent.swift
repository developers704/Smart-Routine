import Foundation
import AppIntents

#if canImport(AlarmKit)
import AlarmKit
import ActivityKit
#endif

/// Custom secondary action for a protected wake alarm. Opens Smart Routine to
/// the math challenge without stopping the ringing alarm.
///
/// Official AlarmKit API: pass this type as `secondaryIntent` on
/// `AlarmManager.AlarmConfiguration` when `secondaryButtonBehavior` is `.custom`.
/// `openAppWhenRun` (and iOS 26 `supportedModes`) tells the system to bring the
/// app forward. No App Group is used — the intent runs in-process and writes
/// the alarm id to standard `UserDefaults`.
#if canImport(AlarmKit)
@available(iOS 26.0, *)
struct VerifyAwakeIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Solve to Stop"
    static var description = IntentDescription("Open Smart Routine to solve the wake math challenge.")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Alarm ID")
    var alarmId: String

    init() {
        alarmId = ""
    }

    init(alarmId: String) {
        self.alarmId = alarmId
    }

    func perform() async throws -> some IntentResult {
        // Do not call AlarmManager.stop / cancel here. Opening the challenge
        // must leave the current alarm ringing; only a correct answer cancels.
        WakeChallengeService.shared.markOpenedFromAlarm(planId: alarmId)
        if !alarmId.isEmpty {
            WakeChallengeService.shared.activate(
                alarmId: alarmId,
                difficulty: UserDefaults.standard.string(forKey: "routine.wakeChallenge.difficulty") ?? "medium",
                questionCount: UserDefaults.standard.integer(forKey: "routine.wakeChallenge.questionCount") == 0
                    ? 1
                    : UserDefaults.standard.integer(forKey: "routine.wakeChallenge.questionCount"),
                wakeAt: nil
            )
        }
        return .result()
    }
}
#endif
