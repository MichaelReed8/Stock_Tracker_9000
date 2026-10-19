import type { CompanyProfile } from './cache.js';

const DAY = 86_400_000;
// Refresh is a queue priority, not a deletion deadline. Keep the last observation.
export const PROFILE_REFRESH_DAYS = 90;
export const PROFILE_MAX_AGE_DAYS = 180;

export function profileAgeDays(profile: CompanyProfile | null, now = new Date()): number | null {
  const age = profile ? (now.getTime() - Date.parse(profile.fetchedAt)) / DAY : NaN;
  return Number.isFinite(age) && age >= 0 ? age : null;
}

export function profileIsUsable(profile: CompanyProfile | null, now = new Date()): boolean {
  const age = profileAgeDays(profile, now);
  return age !== null && age < PROFILE_MAX_AGE_DAYS;
}

export function profileNeedsRefresh(profile: CompanyProfile | null, now = new Date()): boolean {
  const age = profileAgeDays(profile, now);
  return age === null || age >= PROFILE_REFRESH_DAYS;
}
