import Foundation
import CryptoKit

/// Deterministic UUIDs for AlarmKit. Must match `client/shared/alarm-identity.js`.
///
/// UUID v5 (SHA-1, RFC 4122) over a fixed namespace plus the stable Smart Routine
/// plan id (`eventId:kind:ms` or `planId:backup:n`). The same identity therefore
/// survives regeneration, app restarts and device restarts.
enum RoutineAlarmIdentity {
    /// Must match `ALARM_UUID_NAMESPACE` in alarm-identity.js.
    static let namespace = UUID(uuidString: "6dc9a1a0-5e11-4111-9c0d-0000006dc901")!

    static let testAlarmPlanId = "routine-test-alarm"

    static func uuid(fromPlanId planId: String) -> UUID {
        uuidv5(namespace: namespace, name: planId)
    }

    static func testAlarmUUID() -> UUID {
        uuid(fromPlanId: testAlarmPlanId)
    }

    static func isBackup(_ planId: String) -> Bool {
        planId.range(of: #":backup:\d+$"#, options: .regularExpression) != nil
    }

    static func primaryId(of planId: String) -> String? {
        guard let range = planId.range(of: #":backup:\d+$"#, options: .regularExpression) else {
            return nil
        }
        return String(planId[..<range.lowerBound])
    }

    static func backupId(primary: String, index: Int) -> String {
        "\(primary):backup:\(index)"
    }

    static func familyIds(forPrimary primary: String?, extraCount: Int = 8) -> Set<String> {
        guard let primary, !primary.isEmpty else { return [] }
        var ids: Set<String> = [primary]
        let n = max(0, extraCount)
        if n > 0 {
            for i in 1...n { ids.insert(backupId(primary: primary, index: i)) }
        }
        return ids
    }

    static func uuidv5(namespace: UUID, name: String) -> UUID {
        var ns = namespace.uuid
        var data = withUnsafeBytes(of: &ns) { Data($0) }
        data.append(contentsOf: name.utf8)
        let digest = Insecure.SHA1.hash(data: data)
        var bytes = Array(digest.prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x50
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5],
            bytes[6], bytes[7],
            bytes[8], bytes[9],
            bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }
}
