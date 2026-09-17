import { isNative, plugin } from "./native.js";
import { familyRegisterApns } from "./family-api.js";

function api() {
  return plugin("FamilyPush");
}

export async function registerFamilyPush() {
  if (!isNative()) return { ok: false, reason: "not-native" };
  const FamilyPush = api();
  if (!FamilyPush?.register) return { ok: false, reason: "no-plugin" };
  try {
    if (FamilyPush.addListener) {
      await FamilyPush.addListener("token", async ({ token }) => {
        if (token) await familyRegisterApns(token);
      });
    }
    const status = await FamilyPush.register();
    if (status?.token) await familyRegisterApns(status.token);
    return status;
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}
