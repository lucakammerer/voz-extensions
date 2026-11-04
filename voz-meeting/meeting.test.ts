import { describe, expect, test } from "bun:test";
import type { Transcript } from "voz";
import { enhance, lines, render, split } from "./enhance";
import {
  callAppsIn,
  isMeetingUrl,
  meetingFiles,
  merge,
  shift,
  transcriptMarkdown,
} from "./meeting";

const transcript = (turns: Transcript["turns"]): Transcript => ({
  text: turns.map((turn) => turn.text).join(" "),
  seconds: turns.at(-1)?.end ?? 0,
  speakers: 1,
  turns,
});

describe("meeting", () => {
  test("joins sessions on one timeline", () => {
    const first = transcript([
      { speaker: 0, you: true, start: 0, end: 2, text: "Hi all." },
    ]);
    const second = transcript([
      { speaker: 1, start: 1, end: 3, text: "Welcome back." },
    ]);
    const joined = merge([
      shift({ offset: 0, transcript: first }),
      shift({ offset: 60, transcript: second }),
    ]);
    expect(joined.turns.map((turn) => turn.start)).toEqual([0, 61]);
    expect(joined.seconds).toBe(63);
    expect(transcriptMarkdown(joined)).toBe(
      "**[00:00:00] You:** Hi all.\n\n**[00:01:01] Speaker 1:** Welcome back.",
    );
  });

  test("names the folder after the meeting and leaves out empty files", () => {
    const meeting = {
      title: "",
      date: new Date(2026, 10, 3, 9, 30),
      summary: "",
      notes: "ship fri",
      transcript: "",
    };
    expect(meetingFiles(meeting)).toEqual({
      folder: "2026-11-03 Meeting 0930",
      files: [["Notes.md", "# Notes\n\nship fri\n"]],
    });
    const titled = meetingFiles({
      ...meeting,
      title: "Q4/Q1: pricing",
      summary: "- Raise it",
    });
    expect(titled.folder).toBe("2026-11-03 Q4-Q1- pricing");
    expect(titled.files[0]).toEqual([
      "Summary.md",
      "# Q4/Q1: pricing\n\n- Raise it\n",
    ]);
  });
});

describe("enhance", () => {
  test("splits long transcripts into parts of whole lines", () => {
    const parts = split(["a b c", "d e", "f g h i j"], 5);
    expect(parts).toEqual(["a b c\nd e", "f g h i j"]);
    expect(split(["a b c d e f g"], 3)).toEqual(["a b c", "d e f", "g"]);
  });

  test("labels your lines", () => {
    const heard = transcript([
      { speaker: 0, you: true, start: 0, end: 1, text: "Ship Friday?" },
      { speaker: 2, start: 1, end: 2, text: "Yes." },
    ]);
    expect(lines(heard)).toEqual(["You: Ship Friday?", "Speaker 2: Yes."]);
  });

  test("renders sections and to-dos as Markdown", () => {
    const markdown = render(
      [
        { heading: "Release", bullets: ["Ships Friday"] },
        { heading: "Empty", bullets: [] },
      ],
      ["Milan: write the changelog"],
    );
    expect(markdown).toBe(
      "### Release\n- Ships Friday\n\n### To-dos\n- [ ] Milan: write the changelog",
    );
  });

  test("asks once per part, then once to write the notes from your notes", async () => {
    const prompts: string[] = [];
    const generate = (async (request: { prompt: string }) => {
      prompts.push(request.prompt);
      if (request.prompt.startsWith("My notes:\nship fri\n\nFrom")) {
        return {
          title: "Release plan",
          sections: [
            { heading: "Ship Friday", bullets: ["Milan owns the changelog"] },
          ],
        };
      }
      return {
        points: ["Milan owns the changelog"],
        todos: ["Milan: changelog", "milan: changelog!"],
      };
    }) as never;
    const long = transcript(
      Array.from({ length: 3 }, (_, index) => ({
        speaker: 1,
        start: index,
        end: index + 1,
        text: "word ".repeat(600),
      })),
    );
    const summary = await enhance(generate, "ship fri", long);
    expect(prompts.length).toBe(4);
    expect(summary).toEqual({
      title: "Release plan",
      markdown:
        "### Ship Friday\n- Milan owns the changelog\n\n### To-dos\n- [ ] Milan: changelog",
    });
  });
});

describe("callAppsIn", () => {
  const names = (listening: string) =>
    callAppsIn(listening).map((app) => app.name);

  test("names the call apps among the apps using a microphone", () => {
    expect(names("com.apple.CoreSpeech,us.zoom.xos")).toEqual(["Zoom"]);
    expect(names("com.google.Chrome.helper,com.google.Chrome")).toEqual([
      "Google Chrome",
    ]);
    expect(names("COM.HNC.DISCORD,company.thebrowser.Browser")).toEqual([
      "Discord",
      "Arc",
    ]);
  });

  test("ignores dictation, Siri and nothing at all", () => {
    expect(names("com.joelheile.voz,com.apple.CoreSpeech")).toEqual([]);
    expect(names("")).toEqual([]);
  });

  test("reads tabs only for browsers", () => {
    expect(callAppsIn("com.apple.WebKit.GPU")[0]?.tabs).toBe(
      "com.apple.Safari",
    );
    expect(callAppsIn("us.zoom.xos")[0]?.tabs).toBeUndefined();
  });
});

describe("isMeetingUrl", () => {
  test("knows calls in the browser", () => {
    expect(
      isMeetingUrl("https://meet.google.com/abc-defg-hij?authuser=0"),
    ).toBe(true);
    expect(isMeetingUrl("https://teams.microsoft.com/v2/")).toBe(true);
    expect(isMeetingUrl("https://app.zoom.us/wc/123456789/join")).toBe(true);
    expect(isMeetingUrl("https://whereby.com/team-sync")).toBe(true);
    expect(isMeetingUrl("https://meet.jit.si/standup")).toBe(true);
  });

  test("ignores home pages and other sites", () => {
    expect(isMeetingUrl("https://meet.google.com/landing")).toBe(false);
    expect(isMeetingUrl("https://zoom.us/pricing")).toBe(false);
    expect(isMeetingUrl("https://whereby.com/")).toBe(false);
    expect(isMeetingUrl("https://www.youtube.com/watch?v=meet")).toBe(false);
  });
});
