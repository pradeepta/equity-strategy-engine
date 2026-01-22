/**
 * Market Hours Utility
 * Determines if a given time is during US market hours and handles holidays
 */

/**
 * US Stock Market Hours (Eastern Time):
 * - Pre-market: 4:00 AM - 9:30 AM
 * - Regular hours: 9:30 AM - 4:00 PM
 * - After-hours: 4:00 PM - 8:00 PM
 */

/**
 * Convert millisecond timestamp to Eastern Time Date object
 */
function toEasternTime(timestamp: number): Date {
  // Create date in UTC
  const date = new Date(timestamp);

  // Convert to Eastern Time string, then parse back to Date
  // This handles DST automatically
  const etString = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
  });

  return new Date(etString);
}

/**
 * Check if a timestamp falls within US market hours (9:30 AM - 4:00 PM ET, Mon-Fri)
 *
 * @param timestamp Unix timestamp in milliseconds
 * @returns true if during market hours
 */
export function isMarketHours(timestamp: number): boolean {
  const date = toEasternTime(timestamp);

  // Check day of week (0 = Sunday, 6 = Saturday)
  const dayOfWeek = date.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return false; // Weekend
  }

  // Check time (9:30 AM - 4:00 PM)
  const hours = date.getHours();
  const minutes = date.getMinutes();

  // Before 9:30 AM
  if (hours < 9 || (hours === 9 && minutes < 30)) {
    return false;
  }

  // After 4:00 PM
  if (hours >= 16) {
    return false;
  }

  // TODO: Add holiday check (see isHoliday function below)
  // For now, we assume no holidays

  return true;
}

/**
 * Check if a time range spans market hours
 *
 * @param startTime Start timestamp (ms)
 * @param endTime End timestamp (ms)
 * @returns true if the range includes any market hours
 */
export function rangeIncludesMarketHours(startTime: number, endTime: number): boolean {
  // Check start and end
  if (isMarketHours(startTime) || isMarketHours(endTime)) {
    return true;
  }

  // Check if range spans multiple days (might include market hours in between)
  const startDate = toEasternTime(startTime);
  const endDate = toEasternTime(endTime);

  // If same day and neither endpoint is market hours, no market hours in range
  if (
    startDate.getFullYear() === endDate.getFullYear() &&
    startDate.getMonth() === endDate.getMonth() &&
    startDate.getDate() === endDate.getDate()
  ) {
    return false;
  }

  // Multi-day range: conservatively assume market hours exist
  // (More precise check would iterate through each day)
  return true;
}

/**
 * Check if a specific date is a US market holiday
 *
 * @param timestamp Unix timestamp in milliseconds
 * @returns true if the date is a market holiday
 *
 * NOTE: This is a simplified implementation. For production, use a library
 * like 'date-holidays' or maintain a database of holiday dates.
 */
export function isHoliday(timestamp: number): boolean {
  const date = toEasternTime(timestamp);
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // getMonth() returns 0-11
  const day = date.getDate();

  // Fixed holidays
  const fixedHolidays = [
    { month: 1, day: 1 }, // New Year's Day
    { month: 7, day: 4 }, // Independence Day
    { month: 12, day: 25 }, // Christmas
  ];

  for (const holiday of fixedHolidays) {
    if (month === holiday.month && day === holiday.day) {
      return true;
    }
  }

  // TODO: Add floating holidays:
  // - Martin Luther King Jr. Day (3rd Monday in January)
  // - Presidents' Day (3rd Monday in February)
  // - Good Friday (Friday before Easter)
  // - Memorial Day (last Monday in May)
  // - Juneteenth (June 19)
  // - Labor Day (1st Monday in September)
  // - Thanksgiving (4th Thursday in November)

  // For now, only check fixed holidays
  return false;
}

/**
 * Get the expected bar interval in milliseconds for a given timeframe
 *
 * @param timeframe Timeframe string (e.g., "1m", "5m", "15m", "1h", "1d")
 * @returns Interval in milliseconds
 */
export function getTimeframeMs(timeframe: string): number {
  const unit = timeframe.slice(-1);
  const value = parseInt(timeframe.slice(0, -1), 10);

  if (isNaN(value)) {
    throw new Error(`Invalid timeframe format: ${timeframe}`);
  }

  switch (unit) {
    case 'm': // minutes
      return value * 60 * 1000;
    case 'h': // hours
      return value * 60 * 60 * 1000;
    case 'd': // days
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown timeframe unit: ${unit}`);
  }
}

/**
 * Calculate the number of expected bars between two timestamps
 * considering market hours and holidays
 *
 * @param startTime Start timestamp (ms)
 * @param endTime End timestamp (ms)
 * @param timeframe Timeframe (e.g., "5m")
 * @returns Approximate number of bars expected
 *
 * NOTE: This is a simplified calculation that assumes continuous market hours.
 * A more accurate calculation would iterate through each bar interval and
 * check isMarketHours for each one.
 */
export function expectedBarCount(
  startTime: number,
  endTime: number,
  timeframe: string
): number {
  const intervalMs = getTimeframeMs(timeframe);
  const totalMs = endTime - startTime;
  const totalBars = Math.floor(totalMs / intervalMs);

  // For intraday timeframes, estimate based on market hours (6.5 hours/day)
  if (timeframe.endsWith('m') || timeframe.endsWith('h')) {
    const marketHoursPerDay = 6.5; // 9:30 AM - 4:00 PM = 6.5 hours
    const totalHoursPerDay = 24;
    const marketRatio = marketHoursPerDay / totalHoursPerDay;

    return Math.floor(totalBars * marketRatio);
  }

  // For daily timeframes, assume 5 trading days per week
  if (timeframe.endsWith('d')) {
    const tradingDaysPerWeek = 5;
    const totalDaysPerWeek = 7;
    const weekRatio = tradingDaysPerWeek / totalDaysPerWeek;

    return Math.floor(totalBars * weekRatio);
  }

  return totalBars;
}
