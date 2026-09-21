import Foundation
import Capacitor
import UIKit
import UserNotifications

/// Remote APNs registration. Never registers from load() — only after Sign In.
@objc(FamilyPushPlugin)
public class FamilyPushPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FamilyPushPlugin"
    public let jsName = "FamilyPush"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise)
    ]

    private var observer: NSObjectProtocol?

    public override func load() {
        observer = NotificationCenter.default.addObserver(
            forName: .familyApnsToken,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let token = note.object as? String else { return }
            self?.notifyListeners("token", data: ["token": token])
        }
    }

    @objc func register(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        #if os(iOS)
        if #available(iOS 26.0, *) {
            DispatchQueue.main.async {
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
                    DispatchQueue.main.async {
                        UIApplication.shared.registerForRemoteNotifications()
                        once.resolve(["ok": true, "token": UserDefaults.standard.string(forKey: "familyApnsToken") as Any])
                    }
                }
            }
            return
        }
        #endif
        once.resolve(["ok": false, "reason": "requires-ios-26"])
    }
}

extension Notification.Name {
    static let familyApnsToken = Notification.Name("familyApnsToken")
}
