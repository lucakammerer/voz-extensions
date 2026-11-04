import type { Transcript } from "voz";

/** What one live session heard. `offset` is when it started, in seconds since the meeting began. */
export type Part = { offset: number; transcript: Transcript };

export function shift({ offset, transcript }: Part): Transcript {
  return {
    ...transcript,
    seconds: transcript.seconds + offset,
    turns: transcript.turns.map((turn) => ({
      ...turn,
      start: turn.start + offset,
      end: turn.end + offset,
    })),
  };
}

/** Joins the sessions of one meeting, such as before and after an extension reload */
export function merge(transcripts: Transcript[]): Transcript {
  const turns = transcripts.flatMap((transcript) => transcript.turns);
  return {
    text: transcripts
      .map((transcript) => transcript.text.trim())
      .filter(Boolean)
      .join(" "),
    seconds: Math.max(
      0,
      ...transcripts.map((transcript) => transcript.seconds),
    ),
    speakers: Math.max(
      0,
      ...transcripts.map((transcript) => transcript.speakers),
    ),
    turns,
  };
}

export function transcriptMarkdown(transcript: Transcript) {
  if (!transcript.turns.length) return transcript.text.trim();
  return transcript.turns
    .map(
      (turn) =>
        `**[${timestamp(turn.start)}] ${turn.you ? "You" : `Speaker ${turn.speaker}`}:** ${turn.text.trim()}`,
    )
    .join("\n\n");
}

/** One meeting's folder name and its Markdown files, leaving out empty ones */
export function meetingFiles(meeting: {
  title: string;
  date: Date;
  summary: string;
  notes: string;
  transcript: string;
}) {
  const [day, time] = meeting.date.toLocaleString("sv-SE").split(" ");
  const title =
    meeting.title
      .replace(/[/\\:]/g, "-")
      .trim()
      .slice(0, 80) || `Meeting ${time!.slice(0, 5).replace(":", "")}`;
  const files: [name: string, text: string][] = [
    [
      "Summary.md",
      meeting.summary && summaryFile(meeting.title, meeting.summary),
    ],
    ["Notes.md", meeting.notes && `# Notes\n\n${meeting.notes.trim()}\n`],
    [
      "Transcript.md",
      meeting.transcript && `# Transcript\n\n${meeting.transcript.trim()}\n`,
    ],
  ];
  return { folder: `${day} ${title}`, files: files.filter(([, text]) => text) };
}

export const summaryFile = (title: string, summary: string) =>
  `# ${title || "Summary"}\n\n${summary.trim()}\n`;

function timestamp(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return [whole / 3600, (whole % 3600) / 60, whole % 60]
    .map((part) => String(Math.floor(part)).padStart(2, "0"))
    .join(":");
}

// Apps people hold calls in, by bundle ID prefix. Browsers stand in for Google Meet and other calls in a tab.
/** A browser counts only while one of its tabs is on a meeting, so `tabs` names the app whose tabs to read */
export type CallApp = { name: string; tabs?: string };

// Lowercase bundle ID prefixes, so helpers such as com.google.Chrome.helper match too
const callApps: [prefix: string, app: CallApp][] = [
  ["us.zoom.", { name: "Zoom" }],
  ["com.microsoft.teams", { name: "Microsoft Teams" }],
  ["com.apple.facetime", { name: "FaceTime" }],
  ["com.tinyspeck.slackmacgap", { name: "Slack" }],
  ["com.hnc.discord", { name: "Discord" }],
  ["cisco-systems.spark", { name: "Webex" }],
  ["com.cisco.webexmeetings", { name: "Webex" }],
  ["com.webex.", { name: "Webex" }],
  ["net.whatsapp.whatsapp", { name: "WhatsApp" }],
  ["org.whispersystems.signal-desktop", { name: "Signal" }],
  ["ru.keepcoder.telegram", { name: "Telegram" }],
  ["com.skype.skype", { name: "Skype" }],
  ["com.google.chrome", { name: "Google Chrome", tabs: "com.google.Chrome" }],
  ["com.apple.safari", { name: "Safari", tabs: "com.apple.Safari" }],
  // Safari web pages use the microphone through WebKit
  ["com.apple.webkit.gpu", { name: "Safari", tabs: "com.apple.Safari" }],
  ["company.thebrowser.dia", { name: "Dia", tabs: "company.thebrowser.dia" }],
  ["company.thebrowser.", { name: "Arc", tabs: "company.thebrowser.Browser" }],
  [
    "com.microsoft.edgemac",
    { name: "Microsoft Edge", tabs: "com.microsoft.edgemac" },
  ],
  ["com.brave.browser", { name: "Brave", tabs: "com.brave.Browser" }],
  ["com.vivaldi.vivaldi", { name: "Vivaldi", tabs: "com.vivaldi.Vivaldi" }],
];

/** The call apps among the comma-separated bundle IDs `meeting-rec --watch` prints, so dictation and Siri never count as a meeting */
export function callAppsIn(listening: string) {
  const found = new Map<string, CallApp>();
  for (const id of listening.toLowerCase().split(","))
    for (const [prefix, app] of callApps)
      if (id.startsWith(prefix)) {
        found.set(app.name, app);
        break;
      }
  return [...found.values()];
}

const meetingUrls = [
  /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}\b/,
  /^https:\/\/teams\.(microsoft|live)\.com\//,
  /^https:\/\/([\w-]+\.)?zoom\.us\/wc\//,
  /^https:\/\/whereby\.com\/[\w-]+/,
  /^https:\/\/meet\.jit\.si\/[\w-]+/,
];

/** Whether a browser tab is in a call, not on a meeting app's home page */
export const isMeetingUrl = (url: string) =>
  meetingUrls.some((pattern) => pattern.test(url));
