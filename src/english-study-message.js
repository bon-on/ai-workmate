import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildFormattedLesson } from "./english-study-format.js";

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DEFAULT_SOURCE_PATH = path.join(ROOT_DIR, "english-study-weekday-hourly.md");
const DEFAULT_OUTPUT_PATH = path.join(ROOT_DIR, "out", "telegram-english-study-message.txt");
const DEFAULT_TIMEZONE = "Asia/Seoul";
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ALLOWED_HOURS = new Set([12, 19]);

const HELP_TEXT = `Usage:
  node src/english-study-message.js
  node src/english-study-message.js --output /abs/path/to/message.txt
  node src/english-study-message.js --date-time 2026-04-17T10:00:00+09:00

Options:
  --source <path>       Markdown source file. Defaults to english-study-weekday-hourly.md
  --output <path>       Output text file path. Defaults to out/telegram-english-study-message.txt
  --date-time <iso>     Override the current time with an ISO date-time
  --timezone <tz>       IANA timezone. Defaults to Asia/Seoul
  --help                Show this help.`;

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  const markdown = await fs.readFile(options.sourcePath, "utf8");
  const schedule = parseStudySchedule(markdown);
  const target = resolveTargetSlot({
    now: options.dateTime ? new Date(options.dateTime) : new Date(),
    timezone: options.timezone,
  });
  const message = buildStudyMessage({
    schedule,
    dayName: target.dayName,
    hourLabel: target.hourLabel,
    dateLabel: target.dateLabel,
  });

  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.writeFile(options.outputPath, message, "utf8");
  console.log(options.outputPath);
}

export function parseArgs(argv) {
  const options = {
    sourcePath: DEFAULT_SOURCE_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    dateTime: null,
    timezone: DEFAULT_TIMEZONE,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--source":
        options.sourcePath = requireValue(argv, ++index, "--source");
        break;
      case "--output":
        options.outputPath = requireValue(argv, ++index, "--output");
        break;
      case "--date-time":
        options.dateTime = requireValue(argv, ++index, "--date-time");
        break;
      case "--timezone":
        options.timezone = requireValue(argv, ++index, "--timezone");
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.dateTime && Number.isNaN(Date.parse(options.dateTime))) {
    throw new Error("--date-time must be a valid ISO date-time");
  }

  return options;
}

export function parseStudySchedule(markdown) {
  const schedule = new Map();
  const daySections = markdown.split(/^## /m).slice(1);

  for (const section of daySections) {
    const normalized = section.trim();
    if (!normalized) {
      continue;
    }

    const [dayHeader, ...rest] = normalized.split("\n");
    const dayName = dayHeader.trim();
    const body = rest.join("\n");
    const hourMap = new Map();
    const timeSections = body.split(/^### /m).slice(1);

    for (const timeSection of timeSections) {
      const trimmed = timeSection.trim();
      if (!trimmed) {
        continue;
      }

      const [timeHeader, ...contentLines] = trimmed.split("\n");
      hourMap.set(timeHeader.trim(), contentLines.join("\n").trim());
    }

    schedule.set(dayName, hourMap);
  }

  return schedule;
}

export function resolveTargetSlot({ now, timezone = DEFAULT_TIMEZONE }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("A valid date is required");
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  })
    .formatToParts(now)
    .reduce((accumulator, part) => {
      if (part.type !== "literal") {
        accumulator[part.type] = part.value;
      }
      return accumulator;
    }, {});

  const dayName = parts.weekday;
  const hour = Number(parts.hour);

  if (!DAY_NAMES.includes(dayName)) {
    throw new Error(`No English study slot for ${dayName} in ${timezone}`);
  }

  if (!ALLOWED_HOURS.has(hour)) {
    throw new Error(`No English study slot at ${String(hour).padStart(2, "0")}:00 in ${timezone}`);
  }

  return {
    dayName,
    hourLabel: `${String(hour).padStart(2, "0")}:00`,
    dateLabel: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export function buildStudyMessage({ schedule, dayName, hourLabel, dateLabel }) {
  const daySchedule = schedule.get(dayName);
  if (!daySchedule) {
    throw new Error(`Study schedule for ${dayName} was not found`);
  }

  const content = daySchedule.get(hourLabel);
  if (!content) {
    throw new Error(`Study content for ${dayName} ${hourLabel} was not found`);
  }

  return [
    `English Study Reminder | ${dayName} ${hourLabel}`,
    dateLabel,
    "",
    buildFormattedLesson(content),
  ].join("\n");
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function isMainModule(moduleUrl) {
  const entryPoint = process.argv[1];
  if (!entryPoint) {
    return false;
  }

  return moduleUrl === pathToFileURL(path.resolve(entryPoint)).href;
}
