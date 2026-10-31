import { defineExtension } from "voz";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const watcher = join(import.meta.dir, "edit-watch");
const claude = [join(homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find(existsSync);

type Pair = { from: string; to: string };
type Learned = { rules: Pair[]; rejected: Pair[]; candidates: Record<string, Pair & { count: number; kept: number; example: string }> };

const key = ({ from, to }: Pair) => `${from.toLowerCase()}→${to.toLowerCase()}`;
const normalize = (word: string) => word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function parsePairs(text: string): Pair[] {
  return text
    .split(";")
    .map((pair) => pair.split("=").map((part) => part.trim()))
    .filter(([from, to]) => from && to)
    .map(([from, to]) => ({ from, to }));
}

function compile(pairs: Pair[]) {
  return [...pairs]
    .sort((a, b) => b.from.length - a.from.length)
    // Whole words only, plural "s" allowed, so "Cloudflare" stays but "Cloud-Account" changes
    .map(({ from, to }) => [new RegExp(`(?<![\\p{L}\\p{N}])${escape(from)}(?=s?(?![\\p{L}\\p{N}]))`, "giu"), to] as const);
}

// Word-level LCS between the dictation and the edited field. Each short gap between matched words is a correction.
function corrections(dictated: string, edited: string): Pair[] {
  const a = dictated.split(/\s+/).filter(Boolean);
  const b = edited.split(/\s+/).filter(Boolean);
  const na = a.map(normalize);
  const nb = b.map(normalize);
  const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lengths[i][j] = na[i] && na[i] === nb[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);

  const matches: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (na[i] && na[i] === nb[j]) matches.push([i++, j++]);
    else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++;
    else j++;
  }

  const pairs: Pair[] = [];
  const clean = (word: string) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  const anchors = [[-1, -1], ...matches, [a.length, b.length]];
  for (let k = 1; k < anchors.length; k++) {
    const [i0, j0] = anchors[k - 1];
    const [i1, j1] = anchors[k];
    const from = a.slice(i0 + 1, i1);
    let to = b.slice(j0 + 1, j1);
    // At the edges the field can hold other text, so only take as many words as were dictated
    if (k === 1) to = to.slice(-from.length);
    if (k === anchors.length - 1) to = to.slice(0, from.length);
    if (!from.length || !to.length || from.length > 3 || to.length > 3) continue;
    const split = from.length === to.length ? from.map((word, n) => [[word], [to[n]]]) : [[from, to]];
    for (const [f, t] of split) {
      const pair = { from: f.map(normalize).join(" "), to: t.map(clean).join(" ") };
      if (pair.from && pair.to && pair.from !== pair.to.toLowerCase()) pairs.push(pair);
    }
  }
  return pairs;
}

// Returns the replacement as written mid-sentence, or undefined when Claude thinks the user changed what they meant
async function confirmedByClaude(pair: Pair, count: number, kept: number, example: string): Promise<string | undefined> {
  if (!claude) return pair.to;
  const prompt = `A speech recognizer wrote "${pair.from}". This user corrected it to "${pair.to}" ${count} times and kept it ${kept} times. Example dictation: "${example}"
Does this look like a speech recognition error, where the recognizer confused similar sounding words, rather than the user changing what they meant?
A different time, date, number, amount or a different word choice is the user changing what they meant.
If yes, answer only with the corrected word or words as written in the middle of a sentence. If no, answer only: no`;
  const run = Bun.spawn([claude, "-p", "--model", "haiku", prompt], { stdout: "pipe", stderr: "ignore" });
  const answer = (await new Response(run.stdout).text()).trim().replace(/^["'„“]+|["'“”.]+$/g, "");
  if ((await run.exited) !== 0 || !answer || /^no\b/i.test(answer) || answer.split(/\s+/).length > 4) return undefined;
  return answer;
}

export default defineExtension((voz) => {
  const settings = voz.settings({
    pairs: { type: "string", title: "Replacements", description: "wrong=right, separated by ;", default: "" },
    learn: { type: "boolean", title: "Learn from my corrections", default: true },
    threshold: { type: "number", title: "Corrections before a rule is learned", default: 2 },
    confirm: { type: "boolean", title: "Ask Claude Code before learning a rule", description: "Uses the claude CLI and your subscription. Sends only the word pair and one example sentence", default: true },
  });
  const learnedPath = join(voz.paths.data, "learned.json");
  const load = (): Learned => (existsSync(learnedPath) ? JSON.parse(readFileSync(learnedPath, "utf8")) : { rules: [], rejected: [], candidates: {} });
  let rules = compile([...parsePairs(settings.pairs), ...load().rules]);
  const apply = (text: string) =>
    rules.reduce(
      (result, [pattern, to]) =>
        result.replace(pattern, (_, offset: number, whole: string) =>
          /(^|[.!?]\s+)$/.test(whole.slice(0, offset)) ? to[0].toUpperCase() + to.slice(1) : to,
        ),
      text,
    );

  voz.on("beforeInsert", ({ text }) => ({ text: apply(text) }));

  async function learn(dictated: string, notify: (text: string) => void) {
    const watch = Bun.spawn([watcher, "120"], { stdin: new Blob([dictated]), stdout: "pipe", stderr: "ignore" });
    const edited = await new Response(watch.stdout).text();
    if ((await watch.exited) !== 0) return;

    const learned = load();
    // A word the user leaves as dictated counts against learning it
    const spaced = (text: string) => ` ${text.split(/\s+/).map(normalize).join(" ")} `;
    for (const candidate of Object.values(learned.candidates))
      if (spaced(dictated).includes(` ${candidate.from} `) && spaced(edited).includes(` ${candidate.from} `)) candidate.kept++;

    const known = new Set([...learned.rules, ...learned.rejected, ...parsePairs(settings.pairs)].map(key));
    for (const pair of corrections(dictated, edited)) {
      if (known.has(key(pair))) continue;
      const candidate = (learned.candidates[key(pair)] ??= { ...pair, count: 0, kept: 0, example: dictated });
      candidate.count++;
      if (candidate.count < settings.threshold || candidate.kept * 3 > candidate.count) continue;
      delete learned.candidates[key(pair)];
      const to = settings.confirm ? await confirmedByClaude(pair, candidate.count, candidate.kept, candidate.example) : pair.to;
      if (!to) {
        learned.rejected.push(pair);
        console.log(`Rejected ${pair.from} → ${pair.to}`);
        continue;
      }
      learned.rules.push({ from: pair.from, to });
      notify(`Learned: ${pair.from} → ${to}`);
    }
    writeFileSync(learnedPath, JSON.stringify(learned, null, 2));
    rules = compile([...parsePairs(settings.pairs), ...learned.rules]);
  }

  // Awaited so ctx.notify still reaches the user when a rule is learned minutes later
  voz.on("afterInsert", async ({ text }, ctx) => {
    if (settings.learn) await learn(text, ctx.notify).catch((error) => console.log(`Learning failed: ${error}`));
  });
});
