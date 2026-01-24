/**
 * Market Hours Utility
 * Provides market hours calculations for US equity markets
 */

export interface MarketHoursInfo {
  isMarketOpen: boolean;
  currentTime: Date;
  currentDayOfWeek: string;
  currentTimeET: string;
  marketOpen: string;
  marketClose: string;
  description: string;
}

export interface TradingTimeCalculation {
  totalBars: number;
  barsPerDay: number; // Based on timeframe
  estimatedTradingDays: number;
  estimatedTradingHours: number;
  totalCalendarHours: number;
  description: string;
}

/**
 * Check if current time is within US equity market hours
 * Market hours: 9:30 AM - 4:00 PM ET, Monday-Friday
 */
export function getMarketHoursInfo(): MarketHoursInfo {
  const now = new Date();

  // Convert to ET (UTC-5 or UTC-4 depending on DST)
  // Note: This is a simplified approach. For production, use a timezone library like luxon
  const etOffset = isDST(now) ? -4 : -5;
  const etTime = new Date(now.getTime() + (etOffset * 60 * 60 * 1000));

  const dayOfWeek = etTime.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const hours = etTime.getHours();
  const minutes = etTime.getMinutes();
  const totalMinutes = hours * 60 + minutes;

  // Market hours: 9:30 AM (570 minutes) to 4:00 PM (960 minutes)
  const marketOpenMinutes = 9 * 60 + 30; // 9:30 AM
  const marketCloseMinutes = 16 * 60; // 4:00 PM

  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isDuringMarketHours = totalMinutes >= marketOpenMinutes && totalMinutes < marketCloseMinutes;
  const isMarketOpen = isWeekday && isDuringMarketHours;

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  let description = '';
  if (!isWeekday) {
    description = `Weekend (${dayNames[dayOfWeek]}) - market closed`;
  } else if (totalMinutes < marketOpenMinutes) {
    description = `Pre-market hours - market opens at 9:30 AM ET`;
  } else if (totalMinutes >= marketCloseMinutes) {
    description = `After-hours - market closed at 4:00 PM ET`;
  } else {
    description = `Market is OPEN (${dayNames[dayOfWeek]})`;
  }

  return {
    isMarketOpen,
    currentTime: now,
    currentDayOfWeek: dayNames[dayOfWeek],
    currentTimeET: etTime.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }),
    marketOpen: '9:30 AM ET',
    marketClose: '4:00 PM ET',
    description
  };
}

/**
 * Calculate trading time metrics from bar count
 * @param totalBars Total number of bars strategy has been active
 * @param timeframe Timeframe string (e.g., "5m", "15m", "1h", "1d")
 */
export function calculateTradingTime(totalBars: number, timeframe: string): TradingTimeCalculation {
  const minutesPerBar = parseTimeframeToMinutes(timeframe);
  const totalMinutes = totalBars * minutesPerBar;
  const totalCalendarHours = totalMinutes / 60;

  // US equity market: 6.5 hours per day (9:30 AM - 4:00 PM)
  const marketHoursPerDay = 6.5;
  const minutesPerTradingDay = marketHoursPerDay * 60; // 390 minutes

  // Calculate bars per trading day
  const barsPerDay = Math.floor(minutesPerTradingDay / minutesPerBar);

  // Estimate trading days (total bars / bars per day)
  const estimatedTradingDays = totalBars / barsPerDay;

  // Estimate trading hours (only counting market hours)
  const estimatedTradingHours = estimatedTradingDays * marketHoursPerDay;

  let description = '';
  if (estimatedTradingDays < 1) {
    description = `${totalBars} bars ≈ ${estimatedTradingHours.toFixed(1)} hours of market time (less than 1 trading day)`;
  } else if (estimatedTradingDays < 2) {
    description = `${totalBars} bars ≈ ${estimatedTradingDays.toFixed(1)} trading days (${estimatedTradingHours.toFixed(1)} hours of market time)`;
  } else {
    description = `${totalBars} bars ≈ ${estimatedTradingDays.toFixed(1)} trading days (${estimatedTradingHours.toFixed(0)} hours of market time)`;
  }

  return {
    totalBars,
    barsPerDay,
    estimatedTradingDays,
    estimatedTradingHours,
    totalCalendarHours,
    description
  };
}

/**
 * Parse timeframe string to minutes
 */
function parseTimeframeToMinutes(timeframe: string): number {
  const match = timeframe.match(/^(\d+)([mhd])$/);
  if (!match) {
    throw new Error(`Invalid timeframe format: ${timeframe}`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'm': return value; // minutes
    case 'h': return value * 60; // hours to minutes
    case 'd': return value * 60 * 24; // days to minutes
    default: throw new Error(`Unknown timeframe unit: ${unit}`);
  }
}

/**
 * Check if a date is in Daylight Saving Time (simplified)
 * Note: This is a simplified check. For production, use a proper timezone library
 */
function isDST(date: Date): boolean {
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return Math.max(jan, jul) !== date.getTimezoneOffset();
}

/**
 * Format trading time info for display/logging
 */
export function formatTradingTimeInfo(totalBars: number, timeframe: string): string {
  const marketInfo = getMarketHoursInfo();
  const tradingTime = calculateTradingTime(totalBars, timeframe);

  return [
    `Current Time: ${marketInfo.currentTimeET} (${marketInfo.currentDayOfWeek})`,
    `Market Status: ${marketInfo.description}`,
    `Strategy Activity: ${tradingTime.description}`,
  ].join('\n');
}

/**
 * Check if US stock market is currently open (9:30 AM - 4:00 PM ET, weekdays only)
 * Simple boolean version of getMarketHoursInfo()
 * @returns true if market is open, false otherwise
 */
export function isMarketOpen(): boolean {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });

    const parts = formatter.formatToParts(new Date());
    const weekday = parts.find((p) => p.type === 'weekday')?.value || '';
    const hour = parseInt(
      parts.find((p) => p.type === 'hour')?.value || '0',
      10
    );
    const minute = parseInt(
      parts.find((p) => p.type === 'minute')?.value || '0',
      10
    );

    // Weekend check
    if (['Sat', 'Sun'].includes(weekday)) {
      return false;
    }

    // Market hours: 9:30 AM - 4:00 PM ET
    const minutes = hour * 60 + minute;
    const marketOpen = 9 * 60 + 30; // 9:30 AM
    const marketClose = 16 * 60;    // 4:00 PM

    return minutes >= marketOpen && minutes < marketClose;
  } catch (error) {
    // Fallback: assume market closed on error
    console.error('Error checking market hours:', error);
    return false;
  }
}

/**
 * Get current time in ET timezone as string (for logging)
 * @returns Current ET time in format "HH:MM ET"
 */
export function getCurrentETTime(): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
    });
    return formatter.format(new Date()) + ' ET';
  } catch {
    return 'Unknown ET';
  }
}

/**
 * Convert timeframe string to milliseconds
 * @param timeframe Timeframe string (e.g., "5m", "15m", "1h", "1d")
 * @returns Timeframe duration in milliseconds
 */
export function getTimeframeMs(timeframe: string): number {
  const minutes = parseTimeframeToMinutes(timeframe);
  return minutes * 60 * 1000;
}

/**
 * Check if a specific timestamp falls within market hours
 * @param timestamp Unix timestamp in milliseconds
 * @returns true if timestamp is during market hours, false otherwise
 */
export function isMarketHours(timestamp: number): boolean {
  try {
    const date = new Date(timestamp);
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });

    const parts = formatter.formatToParts(date);
    const weekday = parts.find((p) => p.type === 'weekday')?.value || '';
    const hour = parseInt(
      parts.find((p) => p.type === 'hour')?.value || '0',
      10
    );
    const minute = parseInt(
      parts.find((p) => p.type === 'minute')?.value || '0',
      10
    );

    // Weekend check
    if (['Sat', 'Sun'].includes(weekday)) {
      return false;
    }

    // Market hours: 9:30 AM - 4:00 PM ET
    const minutes = hour * 60 + minute;
    const marketOpen = 9 * 60 + 30; // 9:30 AM
    const marketClose = 16 * 60;    // 4:00 PM

    return minutes >= marketOpen && minutes < marketClose;
  } catch (error) {
    console.error('Error checking market hours for timestamp:', error);
    return false;
  }
}

/**
 * Check if a time range includes any market hours
 * Useful for gap detection - only flag gaps during market hours
 * @param startTime Start timestamp in milliseconds
 * @param endTime End timestamp in milliseconds
 * @returns true if range includes any market hours
 */
export function rangeIncludesMarketHours(startTime: number, endTime: number): boolean {
  // Sample every 30 minutes in the range
  const sampleInterval = 30 * 60 * 1000; // 30 minutes in ms

  for (let time = startTime; time <= endTime; time += sampleInterval) {
    if (isMarketHours(time)) {
      return true;
    }
  }

  // Check end time as well
  if (isMarketHours(endTime)) {
    return true;
  }

  return false;
}
