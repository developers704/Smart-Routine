import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PLACES,
  DEFAULT_MODE,
  MODES,
  TRAFFIC_EARLY_MIN,
  bostonQuery,
  defaultsForPurpose,
  ensurePlaces,
  fallbackMin,
  haversineKm,
  isHeavyTrafficLocal,
  leaveWithTraffic,
  trafficEarlyMin,
  wantsTrafficLeave,
} from "../client/shared/travel.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

const home = DEFAULT_PLACES.find((p) => p.purpose === "home");
const office = DEFAULT_PLACES.find((p) => p.purpose === "office");
assert(/Park Drive/i.test(home.address), "Home is 85 Park Drive Boston");
assert(/Beth Israel/i.test(office.address), "Office is BIDMC Boston");

const km = haversineKm(home, office);
assert(km > 0.4 && km < 4, `Home–office is a short Boston hop (got ${km.toFixed(2)} km)`);
assert(fallbackMin(km, "walking") >= 5, "Walk ETA is at least a few minutes");
assert(fallbackMin(km, "driving") < fallbackMin(km, "walking"), "Drive is faster than walk");
assert(DEFAULT_MODE === "driving", "Map trips default to drive");
assert(MODES[0].id === "driving", "Drive is the first travel mode");

const places = ensurePlaces([]);
assert(places.some((p) => p.id === "place_home") && places.some((p) => p.id === "place_office"), "Seeds Home + Office");
const again = ensurePlaces(places);
assert(again.filter((p) => p.purpose === "home").length === 1, "Does not duplicate Home");

const officeTrip = defaultsForPurpose("office", places);
assert(officeTrip.fromId === "place_home" && officeTrip.toId === "place_office", "Office trip starts at Home");
const homeTrip = defaultsForPurpose("home", places);
assert(homeTrip.fromId === "place_office" && homeTrip.toId === "place_home", "Home trip starts at Office");
const shop = defaultsForPurpose("shopping", places);
assert(shop.fromId === "place_home" && shop.toId === "", "Shopping waits for a saved place");
assert(bostonQuery("Star Market") === "Star Market Boston MA", "Search adds Boston if missing");
assert(bostonQuery("Star Market Fenway Boston") === "Star Market Fenway Boston", "Does not duplicate Boston");

const rush = new Date("2026-09-29T08:15:00");
const quiet = new Date("2026-09-29T11:00:00");
const fridayJk = new Date("2026-09-25T19:00:00");
assert(isHeavyTrafficLocal(rush) === true, "Weekday morning commute is heavy");
assert(isHeavyTrafficLocal(quiet) === false, "Mid-morning is not treated as heavy");
assert(isHeavyTrafficLocal(fridayJk) === true, "Friday JK at 7:00 PM is in the evening rush");
assert(trafficEarlyMin({ typicalMin: 20, liveMin: 28 }) === TRAFFIC_EARLY_MIN, "Live drive 5+ min slower adds 15");
assert(trafficEarlyMin({ typicalMin: 20, liveMin: 21 }) === 0, "A 1 min gap is not heavy");
assert(trafficEarlyMin({ at: rush }) === TRAFFIC_EARLY_MIN, "Rush hour adds 15 without a live delta");
assert(wantsTrafficLeave({ kind: "jk" }) === true, "JK checks traffic");
assert(wantsTrafficLeave({ kind: "commute", extra: { leg: "to" } }) === true, "Morning commute checks traffic");
assert(wantsTrafficLeave({ kind: "commute", extra: { leg: "from" } }) === false, "Commute home does not");
assert(
  leaveWithTraffic(new Date("2026-09-29T08:00:00Z"), 15).getTime() === Date.parse("2026-09-29T07:45:00Z"),
  "Leave hint is 15 min earlier"
);

const mapSrc = await readFile(join(dirname(fileURLToPath(import.meta.url)), "../client/map-tab.js"), "utf8");
assert(!mapSrc.includes("basemaps.cartocdn.com"), "Map tiles do not use Carto (those now demand an API key)");
assert(mapSrc.includes("tile.openstreetmap.org"), "Map uses OpenStreetMap tiles");
assert(mapSrc.includes('data-mode="driving"'), "Map UI keeps Drive");
assert(!mapSrc.includes(">Walk<"), "Map UI does not offer Walk");
assert(!mapSrc.includes(">Bike<"), "Map UI does not offer Bike");
assert(mapSrc.includes("role=\"application\""), "Route map is an interactive application, not a static image");
assert(mapSrc.includes("t.mode = DEFAULT_MODE"), "Trips stay on Drive even if leftover state had Walk");
const styles = await readFile(join(dirname(fileURLToPath(import.meta.url)), "../client/styles.css"), "utf8");
assert(styles.includes("min-height: 380px"), "Anika route map is tall enough to pan");
assert(styles.includes("min-height: 420px"), "Kash family map is tall enough to pan");
assert(styles.includes("nav-2"), "Parent nav has a two-tab layout");
assert(styles.includes(".notes-page"), "Notes page has its own layout");
assert(styles.includes(".wa-call"), "Call Anika has a compact WhatsApp control");

if (failed) {
  console.error(`\n${failed} travel check(s) failed`);
  process.exit(1);
}
console.log("\nAll travel checks passed");
