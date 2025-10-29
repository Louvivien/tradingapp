const RECURRENCE_MAP = {
  every_minute: { minutes: 1 },
  every_5_minutes: { minutes: 5 },
  every_15_minutes: { minutes: 15 },
  hourly: { hours: 1 },
  daily: { days: 1 },
  weekly: { days: 7 },
  monthly: { months: 1 },
};

const DEFAULT_RECURRENCE = 'daily';

const normalizeRecurrence = (recurrence) => {
  if (!recurrence) {
    return DEFAULT_RECURRENCE;
  }
  const lowered = String(recurrence).toLowerCase();
  if (RECURRENCE_MAP[lowered]) {
    return lowered;
  }
  return DEFAULT_RECURRENCE;
};

const computeNextRebalanceAt = (recurrence, fromDate = new Date()) => {
  const normalized = normalizeRecurrence(recurrence);
  const config = RECURRENCE_MAP[normalized];
  const base = new Date(fromDate);

  if (config.minutes) {
    base.setUTCMinutes(base.getUTCMinutes() + config.minutes);
  }

  if (config.hours) {
    base.setUTCHours(base.getUTCHours() + config.hours);
  }

  if (config.days) {
    base.setUTCDate(base.getUTCDate() + config.days);
  }

  if (config.months) {
    base.setUTCMonth(base.getUTCMonth() + config.months);
  }

  return base;
};

module.exports = {
  DEFAULT_RECURRENCE,
  normalizeRecurrence,
  computeNextRebalanceAt,
  RECURRENCE_MAP,
};
