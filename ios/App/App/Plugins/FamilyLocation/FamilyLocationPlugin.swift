import Foundation
import Capacitor
import CoreLocation

/// Background location for Family Tracker. Never prompts from load().
/// When In Use is requested first; Always only from requestAlways().
@objc(FamilyLocationPlugin)
public class FamilyLocationPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "FamilyLocationPlugin"
    public let jsName = "FamilyLocation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestWhenInUse", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAlways", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startUpdating", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopUpdating", returnType: CAPPluginReturnPromise)
    ]

    private var manager: CLLocationManager?
    private var pendingWhenInUse: CallOnce?
    private var pendingAlways: CallOnce?
    private var sharing = false

    public override func load() {
        // Never prompt for location from load() — only the explicit buttons.
    }

    @objc func isSupported(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        once.resolve(supportPayload())
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        once.resolve(statusPayload())
    }

    @objc func requestWhenInUse(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        #if os(iOS)
        if #available(iOS 26.0, *) {
            DispatchQueue.main.async {
                self.ensureManager()
                let status = self.manager?.authorizationStatus
                if status == .authorizedAlways || status == .authorizedWhenInUse {
                    once.resolve(self.statusPayload())
                    return
                }
                self.pendingWhenInUse = once
                self.manager?.requestWhenInUseAuthorization()
            }
            return
        }
        #endif
        once.resolve(statusPayload())
    }

    @objc func requestAlways(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        #if os(iOS)
        if #available(iOS 26.0, *) {
            DispatchQueue.main.async {
                self.ensureManager()
                let status = self.manager?.authorizationStatus
                if status == .authorizedAlways {
                    once.resolve(self.statusPayload())
                    return
                }
                if status != .authorizedWhenInUse && status != .authorizedAlways {
                    once.resolve(self.statusPayload(error: "when-in-use-first"))
                    return
                }
                self.pendingAlways = once
                self.manager?.requestAlwaysAuthorization()
            }
            return
        }
        #endif
        once.resolve(statusPayload())
    }

    @objc func startUpdating(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        #if os(iOS)
        if #available(iOS 26.0, *) {
            DispatchQueue.main.async {
                self.ensureManager()
                guard let manager = self.manager else {
                    once.resolve(["ok": false, "reason": "no-manager"])
                    return
                }
                if manager.authorizationStatus != .authorizedAlways &&
                    manager.authorizationStatus != .authorizedWhenInUse {
                    once.resolve(self.statusPayload(error: "not-authorized"))
                    return
                }
                self.sharing = true
                manager.allowsBackgroundLocationUpdates = manager.authorizationStatus == .authorizedAlways
                manager.showsBackgroundLocationIndicator = true
                manager.startUpdatingLocation()
                once.resolve(self.statusPayload())
            }
            return
        }
        #endif
        once.resolve(statusPayload())
    }

    @objc func stopUpdating(_ call: CAPPluginCall) {
        let once = CallOnce(call)
        DispatchQueue.main.async {
            self.sharing = false
            self.manager?.allowsBackgroundLocationUpdates = false
            self.manager?.showsBackgroundLocationIndicator = false
            self.manager?.stopUpdatingLocation()
            once.resolve(self.statusPayload())
        }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        pendingWhenInUse?.resolve(statusPayload())
        pendingWhenInUse = nil
        pendingAlways?.resolve(statusPayload())
        pendingAlways = nil
        notifyListeners("status", data: statusPayload())
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard sharing, let loc = locations.last else { return }
        notifyListeners("location", data: [
            "lat": loc.coordinate.latitude,
            "lng": loc.coordinate.longitude,
            "accuracy": loc.horizontalAccuracy,
            "at": ISO8601DateFormatter().string(from: loc.timestamp)
        ])
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        notifyListeners("error", data: ["error": error.localizedDescription])
    }

    private func ensureManager() {
        if manager != nil { return }
        let m = CLLocationManager()
        m.delegate = self
        m.desiredAccuracy = kCLLocationAccuracyHundredMeters
        m.distanceFilter = 50
        m.pausesLocationUpdatesAutomatically = true
        if #available(iOS 14.0, *) {
            m.activityType = .other
        }
        manager = m
    }

    private func supportPayload() -> [String: Any] {
        let os = ProcessInfo.processInfo.operatingSystemVersion
        let osVersion = "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
        if #available(iOS 26.0, *) {
            return [
                "supported": true,
                "osVersion": osVersion,
                "osMajor": os.majorVersion
            ]
        }
        return [
            "supported": false,
            "reason": "requires-ios-26",
            "osVersion": osVersion,
            "osMajor": os.majorVersion
        ]
    }

    private func statusPayload(error: String? = nil) -> [String: Any] {
        var payload = supportPayload()
        payload["authorization"] = authorizationLabel()
        payload["sharing"] = sharing
        payload["ok"] = payload["authorization"] as? String == "always" || payload["authorization"] as? String == "whenInUse"
        if let error {
            payload["error"] = error
            payload["ok"] = false
        }
        return payload
    }

    private func authorizationLabel() -> String {
        guard let manager else { return "notDetermined" }
        switch manager.authorizationStatus {
        case .authorizedAlways: return "always"
        case .authorizedWhenInUse: return "whenInUse"
        case .denied: return "denied"
        case .restricted: return "denied"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }
}
