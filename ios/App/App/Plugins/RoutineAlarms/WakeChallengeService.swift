import Foundation

/// Native math-wake session. The expected answer never leaves this type in a
/// JS-facing payload. Generation must stay in lockstep with
/// `client/shared/math-challenge.js` (fnv1a32 + mulberry32).
final class WakeChallengeService: @unchecked Sendable {
    static let shared = WakeChallengeService()

    private let lock = NSLock()
    private var session: Session?
    private let defaults = UserDefaults.standard
    private let storageKey = "routine.wakeChallenge.v1"

    struct PublicView: Sendable {
        var active: Bool
        var alarmId: String?
        var question: String?
        var questionNumber: Int?
        var questionCount: Int?
        var attempts: Int
    }

    struct SubmitResult: Sendable {
        var correct: Bool
        var complete: Bool
        var nextQuestion: String?
        var attempts: Int
    }

    private struct Session: Codable {
        var alarmId: String
        var nonce: String
        var difficulty: String
        var questionCount: Int
        var questionIndex: Int
        var attempts: Int
        var questions: [String]
        var answers: [Int]
        var complete: Bool
        var protectedWakeAt: Date?
    }

    private init() {
        if let data = defaults.data(forKey: storageKey),
           let stored = try? JSONDecoder().decode(Session.self, from: data) {
            session = stored
        }
    }

    func publicView(now: Date = Date()) -> PublicView {
        lock.lock()
        defer { lock.unlock() }
        activateIfDueLocked(now: now)
        guard let session, !session.complete else {
            return PublicView(active: false, alarmId: nil, question: nil, questionNumber: nil, questionCount: nil, attempts: 0)
        }
        let q = session.questions.indices.contains(session.questionIndex) ? session.questions[session.questionIndex] : nil
        return PublicView(
            active: true,
            alarmId: session.alarmId,
            question: q,
            questionNumber: session.questionIndex + 1,
            questionCount: session.questionCount,
            attempts: session.attempts
        )
    }

    func activate(
        alarmId: String,
        difficulty: String,
        questionCount: Int,
        wakeAt: Date?,
        now: Date = Date()
    ) {
        lock.lock()
        defer { lock.unlock() }
        if let session, session.alarmId == alarmId, !session.complete {
            persistLocked()
            return
        }
        let count = min(3, max(1, questionCount))
        let nonce = String(fnv1a32("\(alarmId)|\(Int(now.timeIntervalSince1970))"))
        var questions: [String] = []
        var answers: [Int] = []
        for i in 0..<count {
            let generated = MathChallenge.generate(alarmId: alarmId, nonce: nonce, questionIndex: i, difficulty: difficulty)
            questions.append(generated.question)
            answers.append(generated.answer)
        }
        session = Session(
            alarmId: alarmId,
            nonce: nonce,
            difficulty: MathChallenge.normalize(difficulty),
            questionCount: count,
            questionIndex: 0,
            attempts: 0,
            questions: questions,
            answers: answers,
            complete: false,
            protectedWakeAt: wakeAt
        )
        persistLocked()
    }

    func markOpenedFromAlarm(planId: String) {
        lock.lock()
        defer { lock.unlock() }
        if session?.alarmId == planId { return }
        // Intent only records the id; questions are created once activate() runs
        // with the stored verification settings from the last sync.
        defaults.set(planId, forKey: "routine.wakeChallenge.openedAlarmId")
    }

    func openedAlarmId() -> String? {
        defaults.string(forKey: "routine.wakeChallenge.openedAlarmId")
    }

    func submit(alarmId: String?, answer: String?) -> SubmitResult {
        lock.lock()
        defer { lock.unlock() }
        guard var session, !session.complete else {
            return SubmitResult(correct: false, complete: false, nextQuestion: nil, attempts: 0)
        }
        if let alarmId, alarmId != session.alarmId {
            return SubmitResult(correct: false, complete: false, nextQuestion: session.questions[session.questionIndex], attempts: session.attempts)
        }
        session.attempts += 1
        let parsed = MathChallenge.parseAnswer(answer)
        let expected = session.answers[session.questionIndex]
        if parsed == nil || parsed != expected {
            self.session = session
            persistLocked()
            return SubmitResult(
                correct: false,
                complete: false,
                nextQuestion: session.questions[session.questionIndex],
                attempts: session.attempts
            )
        }
        if session.questionIndex + 1 >= session.questionCount {
            session.complete = true
            self.session = session
            persistLocked()
            return SubmitResult(correct: true, complete: true, nextQuestion: nil, attempts: session.attempts)
        }
        session.questionIndex += 1
        self.session = session
        persistLocked()
        return SubmitResult(
            correct: true,
            complete: false,
            nextQuestion: session.questions[session.questionIndex],
            attempts: session.attempts
        )
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        session = nil
        defaults.removeObject(forKey: storageKey)
        defaults.removeObject(forKey: "routine.wakeChallenge.openedAlarmId")
    }

    func currentAlarmId() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return session?.complete == false ? session?.alarmId : nil
    }

    /// Remember the next protected wake so opening the app at/after fire time
    /// can start the challenge without AlarmKit (iOS 17 fallback) or after
    /// system Stop left backups running.
    func rememberProtectedWake(alarmId: String, at: Date, difficulty: String, questionCount: Int) {
        defaults.set(
            [
                "alarmId": alarmId,
                "at": at.timeIntervalSince1970,
                "difficulty": difficulty,
                "questionCount": questionCount
            ],
            forKey: "routine.wakeChallenge.protected"
        )
    }

    func clearProtectedWake() {
        defaults.removeObject(forKey: "routine.wakeChallenge.protected")
    }

    private func activateIfDueLocked(now: Date) {
        if let session, !session.complete { return }
        guard let info = defaults.dictionary(forKey: "routine.wakeChallenge.protected"),
              let alarmId = info["alarmId"] as? String,
              let at = info["at"] as? Double else { return }
        if now.timeIntervalSince1970 + 1 < at { return }
        let difficulty = info["difficulty"] as? String ?? "medium"
        let count = info["questionCount"] as? Int ?? 1
        // Inline activate without re-locking.
        let nonce = String(fnv1a32("\(alarmId)|\(Int(at))"))
        var questions: [String] = []
        var answers: [Int] = []
        for i in 0..<min(3, max(1, count)) {
            let generated = MathChallenge.generate(alarmId: alarmId, nonce: nonce, questionIndex: i, difficulty: difficulty)
            questions.append(generated.question)
            answers.append(generated.answer)
        }
        session = Session(
            alarmId: alarmId,
            nonce: nonce,
            difficulty: MathChallenge.normalize(difficulty),
            questionCount: min(3, max(1, count)),
            questionIndex: 0,
            attempts: 0,
            questions: questions,
            answers: answers,
            complete: false,
            protectedWakeAt: Date(timeIntervalSince1970: at)
        )
        persistLocked()
    }

    private func persistLocked() {
        guard let session, let data = try? JSONEncoder().encode(session) else {
            defaults.removeObject(forKey: storageKey)
            return
        }
        defaults.set(data, forKey: storageKey)
    }
}

enum MathChallenge {
    struct Generated {
        var question: String
        var answer: Int
    }

    static func normalize(_ difficulty: String) -> String {
        if difficulty == "easy" || difficulty == "hard" { return difficulty }
        return "medium"
    }

    static func parseAnswer(_ value: String?) -> Int? {
        guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              let value = Int(raw) else { return nil }
        return value
    }

    static func generate(alarmId: String, nonce: String, questionIndex: Int, difficulty: String) -> Generated {
        let level = normalize(difficulty)
        let seed = fnv1a32("\(alarmId)|\(nonce)|\(questionIndex)|\(level)")
        var rng = Mulberry32(seed: seed)
        if level == "easy" { return addOrSub(&rng, min: 1, max: 50) }
        if level == "medium" { return addOrSub(&rng, min: 10, max: 99) }
        let kind = rng.next()
        if kind < 1.0 / 3.0 {
            let a = rng.pick(1, 12)
            let b = rng.pick(1, 12)
            return Generated(question: "\(a) × \(b)", answer: a * b)
        }
        return addOrSub(&rng, min: 10, max: 99)
    }

    private static func addOrSub(_ rng: inout Mulberry32, min: Int, max: Int) -> Generated {
        let opPlus = rng.next() < 0.5
        var a = rng.pick(min, max)
        var b = rng.pick(min, max)
        if !opPlus && a < b { swap(&a, &b) }
        if opPlus {
            return Generated(question: "\(a) + \(b)", answer: a + b)
        }
        return Generated(question: "\(a) - \(b)", answer: a - b)
    }
}

func fnv1a32(_ string: String) -> UInt32 {
    var hash: UInt32 = 0x811c9dc5
    for byte in string.utf8 {
        hash ^= UInt32(byte)
        hash = hash &* 0x01000193
    }
    return hash
}

struct Mulberry32 {
    private var state: UInt32

    init(seed: UInt32) {
        state = seed
    }

    mutating func next() -> Double {
        state = state &+ 0x6d2b79f5
        var t = state
        t = (t ^ (t >> 15)) &* (t | 1)
        t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
        let result = (t ^ (t >> 14))
        return Double(result) / 4294967296.0
    }

    mutating func pick(_ min: Int, _ max: Int) -> Int {
        min + Int(floor(next() * Double(max - min + 1)))
    }
}
