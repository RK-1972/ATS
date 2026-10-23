/**
 * Optalynx business calendar dates (Asia/Kolkata).
 * Used for Copilot interviewer filters and Interviewer Home view filters.
 */

const OPTALYNX_BUSINESS_TIMEZONE = "Asia/Kolkata";

const BUSINESS_CALENDAR_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: OPTALYNX_BUSINESS_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function pad2(value) {
  return String(value).padStart(2, "0");
}

function pickPart(parts, type) {
  const entry = parts.find((part) => part.type === type);
  return entry ? Number(entry.value) : 0;
}

function instantToBusinessCalendarDateKey(instant) {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    return "";
  }

  return BUSINESS_CALENDAR_FORMATTER.format(instant);
}

function getBusinessCalendarDateKey(referenceDate = new Date()) {
  return instantToBusinessCalendarDateKey(referenceDate);
}

function parseInterviewTime(value) {
  if (value == null || value === "") {
    return null;
  }

  const text = String(value).trim();
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);

  if (!match) {
    return null;
  }

  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
    second: Number(match[3] || 0)
  };
}

function parseInterviewDateValue(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }

    return { kind: "instant", instant: value };
  }

  const text = String(value ?? "").trim();

  if (!text) {
    return null;
  }

  const ddMmYyyy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(text);

  if (ddMmYyyy) {
    return {
      kind: "local",
      year: Number(ddMmYyyy[3]),
      month: Number(ddMmYyyy[2]),
      day: Number(ddMmYyyy[1])
    };
  }

  const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);

  if (isoDateOnly) {
    return {
      kind: "local",
      year: Number(isoDateOnly[1]),
      month: Number(isoDateOnly[2]),
      day: Number(isoDateOnly[3])
    };
  }

  const hasTimeOrOffset =
    /T/.test(text) || text.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(text);

  const parsed = new Date(text);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  if (hasTimeOrOffset) {
    return { kind: "instant", instant: parsed };
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const [year, month, day] = text.slice(0, 10).split("-").map(Number);
    return { kind: "local", year, month, day };
  }

  return { kind: "instant", instant: parsed };
}

function zonedLocalDateTimeToInstant(
  { year, month, day, hour, minute, second },
  timeZone = OPTALYNX_BUSINESS_TIMEZONE
) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let utcMs = desiredUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = formatter.formatToParts(new Date(utcMs));
    const actual = {
      year: pickPart(parts, "year"),
      month: pickPart(parts, "month"),
      day: pickPart(parts, "day"),
      hour: pickPart(parts, "hour"),
      minute: pickPart(parts, "minute"),
      second: pickPart(parts, "second")
    };

    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const diff = desiredAsUtc - actualAsUtc;

    if (diff === 0) {
      break;
    }

    utcMs += diff;
  }

  return new Date(utcMs);
}

/**
 * IST calendar date (YYYY-MM-DD) for an interview row.
 * @param {{ interview_date?: unknown, interview_time?: unknown }} row
 */
function getInterviewBusinessCalendarDateKey(row) {
  const parsed = parseInterviewDateValue(row?.interview_date);

  if (!parsed) {
    return "";
  }

  const time = parseInterviewTime(row?.interview_time);

  if (parsed.kind === "instant") {
    return instantToBusinessCalendarDateKey(parsed.instant);
  }

  const local = {
    year: parsed.year,
    month: parsed.month,
    day: parsed.day,
    hour: time?.hour ?? 0,
    minute: time?.minute ?? 0,
    second: time?.second ?? 0
  };

  const instant = zonedLocalDateTimeToInstant(local);
  return instantToBusinessCalendarDateKey(instant);
}

module.exports = {
  OPTALYNX_BUSINESS_TIMEZONE,
  getBusinessCalendarDateKey,
  getInterviewBusinessCalendarDateKey,
  instantToBusinessCalendarDateKey,
  parseInterviewDateValue,
  parseInterviewTime,
  zonedLocalDateTimeToInstant
};
