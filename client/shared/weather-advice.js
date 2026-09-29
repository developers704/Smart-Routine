/**
 * Turns Open-Meteo's current conditions into a short leave-time advisory.
 * Pure and network-free so it is unit-testable without hitting Open-Meteo.
 *
 * WMO weather codes: https://open-meteo.com/en/docs
 */
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

export const HOT_THRESHOLD_F = 85;

/**
 * @param {object|null} weather  { tempF, precipitationMm, weatherCode } or null
 * @returns {string|null} one short sentence per condition, or null when there's nothing to flag
 */
export function weatherAdvice(weather) {
  if (!weather) return null;
  const { tempF, precipitationMm, weatherCode } = weather;
  const snow = SNOW_CODES.has(weatherCode);
  const rain = !snow && (RAIN_CODES.has(weatherCode) || precipitationMm > 0.2);
  const hot = Number.isFinite(tempF) && tempF >= HOT_THRESHOLD_F;

  const notes = [];
  if (snow) notes.push("Snow expected — wear a jacket and boots.");
  else if (rain) notes.push("Rain expected — bring an umbrella and a jacket.");
  if (hot) notes.push("Hot out — apply sunscreen.");
  return notes.length ? notes.join(" ") : null;
}
