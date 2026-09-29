import { HOT_THRESHOLD_F, weatherAdvice } from "../client/shared/weather-advice.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

assert(weatherAdvice(null) === null, "No weather data gives no advice");

const clear = { tempF: 68, precipitationMm: 0, weatherCode: 1 };
assert(weatherAdvice(clear) === null, "Clear, mild weather has nothing to flag");

const rain = { tempF: 60, precipitationMm: 1.2, weatherCode: 61 };
assert(/umbrella/i.test(weatherAdvice(rain)) && /jacket/i.test(weatherAdvice(rain)), "Rain advises umbrella and jacket");

const drizzleByPrecipOnly = { tempF: 60, precipitationMm: 0.5, weatherCode: 1 };
assert(/umbrella/i.test(weatherAdvice(drizzleByPrecipOnly)), "Real precipitation triggers rain advice even with a clear-ish code");

const trace = { tempF: 60, precipitationMm: 0.05, weatherCode: 1 };
assert(weatherAdvice(trace) === null, "A trace of precipitation below the threshold is not flagged as rain");

const snow = { tempF: 28, precipitationMm: 2, weatherCode: 73 };
const snowAdvice = weatherAdvice(snow);
assert(/snow/i.test(snowAdvice) && /jacket/i.test(snowAdvice), "Snow advises a jacket, mentions snow");
assert(!/umbrella/i.test(snowAdvice), "Snow does not also suggest an umbrella");

const hot = { tempF: HOT_THRESHOLD_F + 3, precipitationMm: 0, weatherCode: 0 };
assert(/sunscreen/i.test(weatherAdvice(hot)), "Hot weather advises sunscreen");

const justUnderHot = { tempF: HOT_THRESHOLD_F - 1, precipitationMm: 0, weatherCode: 0 };
assert(weatherAdvice(justUnderHot) === null, "Just under the hot threshold has no advice");

const hotAndRainy = { tempF: HOT_THRESHOLD_F + 5, precipitationMm: 3, weatherCode: 63 };
const both = weatherAdvice(hotAndRainy);
assert(/umbrella/i.test(both) && /sunscreen/i.test(both), "Hot and rainy at once combines both notes");

if (failed) {
  console.error(`\n${failed} weather-advice check(s) failed`);
  process.exit(1);
}
console.log("\nAll weather-advice checks passed");
