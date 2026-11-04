import type { Context, Transcript } from "voz";

type Generate = Context["generate"];

// Apple's on-device model holds about 4,000 tokens, prompt and answer together, so each request stays well under that
const wordsPerPart = 1100;

const pointsSchema = {
  type: "object",
  properties: {
    points: {
      type: "array",
      items: {
        type: "string",
        description:
          "One concrete fact, number, decision, reason or open question, in the meeting's own words",
      },
    },
    todos: {
      type: "array",
      items: {
        type: "string",
        description:
          "A task someone took on or was asked to do, such as 'Milan sends the deck by Friday'. Name a person or date only when the meeting said it.",
      },
    },
  },
  required: ["points", "todos"],
} as const;

const summarySchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "Three to six words naming what the meeting was about",
    },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: {
            type: "string",
            description:
              "Two to five words naming the topic, in the meeting's own term for it. Taken from the user's notes when they have one.",
          },
          bullets: {
            type: "array",
            items: {
              type: "string",
              description:
                "One short point, ten words or fewer, with no full stop at the end",
            },
          },
        },
        required: ["heading", "bullets"],
      },
    },
  },
  required: ["title", "sections"],
} as const;

const extract = `You read one part of a meeting transcript and pull out what matters.
- Take only what was said. Never add advice, and never turn a maybe into a decision.
- Keep names, numbers, dates and the meeting's own words for things.
- "You" is the person taking the notes. "Speaker 1" and the like are labels, not names, so never write them.
- The transcript comes from speech recognition, so read past misheard words.
- The user's notes show what they care about. Look for details that belong to them.
- Skip small talk and repetition. Write in the language most of the transcript is in.`;

const write = `You turn a user's meeting notes into finished notes, using points from the meeting.
- The user's notes come first. Keep every heading and item from them, in their order, and fix their typos.
- Under each one, add the points that belong to it. Add a section only for another topic the meeting spent time on.
- Use only the points given. Never add advice, generic topics or a summary of the meeting as an event.
- Headings name the thing itself, never "Overview", "Discussion" or "Updates".
- Plain words, active voice, one point per bullet, no bold, no "key" or "important".
- Write in the language of the notes, or of the meeting when there are no notes.`;

export type Summary = { title: string; markdown: string };

/** Writes notes from the user's notes and the transcript, in a few small requests to the on-device model */
export async function enhance(
  generate: Generate,
  notes: string,
  transcript: Transcript,
): Promise<Summary> {
  const parts = split(lines(transcript), wordsPerPart);
  const points: string[] = [];
  const todos: string[] = [];
  for (const [index, part] of parts.entries()) {
    const found = await generate({
      instructions: extract,
      prompt: `${notes.trim() ? `My notes:\n${notes.trim()}\n\n` : ""}Transcript, part ${index + 1} of ${parts.length}:\n${part}`,
      schema: pointsSchema,
    });
    points.push(...found.points);
    todos.push(...found.todos);
  }
  const summary = await generate({
    instructions: write,
    prompt: `My notes:\n${notes.trim() || "(none)"}\n\nFrom the meeting:\n${shorten(
      points,
      wordsPerPart,
    )
      .map((point) => `- ${point}`)
      .join("\n")}`,
    schema: summarySchema,
  });
  return {
    title: summary.title.trim(),
    markdown: render(summary.sections, unique(todos)),
  };
}

export function lines(transcript: Transcript) {
  return transcript.turns.map(
    (turn) => `${turn.you ? "You" : `Speaker ${turn.speaker}`}: ${turn.text}`,
  );
}

/** Groups whole lines into parts of about `words` words. A longer line gets cut. */
export function split(lines: string[], words: number) {
  const parts: string[] = [];
  let current: string[] = [];
  let count = 0;
  for (const line of lines.flatMap((line) => cut(line, words))) {
    const size = wordCount(line);
    if (count + size > words && current.length) {
      parts.push(current.join("\n"));
      current = [];
      count = 0;
    }
    current.push(line);
    count += size;
  }
  if (current.length) parts.push(current.join("\n"));
  return parts;
}

export function render(
  sections: { heading: string; bullets: string[] }[],
  todos: string[],
) {
  const blocks = sections
    .filter((section) => section.bullets.length)
    .map(
      (section) =>
        `### ${section.heading.trim()}\n${section.bullets.map((bullet) => `- ${bullet.trim()}`).join("\n")}`,
    );
  if (todos.length)
    blocks.push(
      `### To-dos\n${todos.map((todo) => `- [ ] ${todo.trim()}`).join("\n")}`,
    );
  return blocks.join("\n\n");
}

function cut(line: string, words: number) {
  const tokens = line.split(/\s+/);
  if (tokens.length <= words) return [line];
  const pieces: string[] = [];
  for (let start = 0; start < tokens.length; start += words)
    pieces.push(tokens.slice(start, start + words).join(" "));
  return pieces;
}

// A long meeting can find more points than one request holds. Every few points survive, spread over the meeting.
function shorten(points: string[], words: number) {
  const total = points.reduce((sum, point) => sum + wordCount(point), 0);
  if (total <= words) return points;
  const keep = words / total;
  return points.filter(
    (_, index) =>
      Math.floor(index * keep) !== Math.floor((index + 1) * keep) ||
      index === 0,
  );
}

function unique(items: string[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.toLowerCase().replace(/\W+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;
