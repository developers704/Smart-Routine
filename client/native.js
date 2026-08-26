export function isNative() {
  try {
    return !!globalThis.Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
}

export function plugin(name) {
  return globalThis.Capacitor?.Plugins?.[name] || null;
}

export async function bootNative() {
  if (!isNative()) return;
  const StatusBar = plugin("StatusBar");
  const Splash = plugin("SplashScreen");
  const Keyboard = plugin("Keyboard");
  try {
    await StatusBar?.setStyle?.({ style: "LIGHT" });
    await StatusBar?.setOverlaysWebView?.({ overlay: true });
  } catch {
    /* web or older plugin */
  }
  try {
    await Splash?.hide?.();
  } catch {
    /* ignore */
  }
  try {
    await Keyboard?.setAccessoryBarVisible?.({ isVisible: true });
  } catch {
    /* ignore */
  }
}

export function haptic(style = "light") {
  const Haptics = plugin("Haptics");
  if (!Haptics) return;
  const map = { light: "LIGHT", medium: "MEDIUM", success: "SUCCESS", warning: "WARNING" };
  if (style === "success" || style === "warning") {
    Haptics.notification?.({ type: map[style] });
    return;
  }
  Haptics.impact?.({ style: map[style] || "LIGHT" });
}

export function onAppActive(fn) {
  const App = plugin("App");
  if (!App?.addListener) return;
  App.addListener("appStateChange", ({ isActive }) => {
    if (isActive) fn();
  });
}
