import {
  defineExtension,
  type ActionHandle,
  type Context,
  type LiveTranscription,
  type Note,
  type RunningActivity,
  type Transcript,
} from "voz";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { enhance } from "./enhance";
import {
  callAppsIn,
  isMeetingUrl,
  type CallApp,
  meetingFiles,
  merge,
  shift,
  summaryFile,
  transcriptMarkdown,
  type Part,
} from "./meeting";

const recorder = join(import.meta.dir, "meeting-rec");

// The audio file is the backup: when live transcription fails, Voz transcribes the file instead
type Recording = {
  pid: number;
  name: string;
  audio: string;
  started: number;
  notes: string;
  parts: Part[];
  /** What the running live session heard so far, saved as it comes in */
  current?: Part;
  /** Milliseconds spent paused, so the timer leaves them out */
  pausedFor?: number;
  pausedAt?: number;
};

// A call app holding the microphone this long has joined a call, not just tested it
const suggestAfter = 3_000;
// How often a browser using the microphone gets its tabs read, until one is on a meeting
const tabsEvery = 5_000;
// Asks about the same app once in this window, so a dropped call that rejoins stays quiet
const cooldown = 10 * 60_000;
// The call app that started a recording has let go of the microphone this long when the call ended
const endedAfter = 15_000;
// Waits between attempts to start live transcription. The last ones skip system audio, so the microphone still gets transcribed.
const retries = [0, 2_000, 5_000, 15_000, 30_000];
const micOnlyFrom = 3;

const osascript = (script: string) =>
  Bun.spawn(["/usr/bin/osascript", "-e", script], {
    stdout: "pipe",
    stderr: "ignore",
  });
const banner = (text: string) =>
  osascript(`display notification ${JSON.stringify(text)} with title "Voz"`);

// Voz before API 8 has no voz.ask, so it gets a dialog instead of the card under the notch
async function confirmInDialog() {
  const run = osascript(
    'display dialog "A meeting seems to have started. Record it?" with title "Voz" buttons {"Not now", "Record"} default button "Record" cancel button "Not now" giving up after 60',
  );
  return (await new Response(run.stdout).text()).includes(
    "button returned:Record",
  );
}

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const signal = (pid: number, name: NodeJS.Signals) => {
  if (isRunning(pid)) process.kill(pid, name);
};

const copy = (text: string) =>
  Bun.spawn(["/usr/bin/pbcopy"], {
    stdin: new Blob([text]),
    env: { LANG: "en_US.UTF-8" },
  }).exited;

export default defineExtension((voz) => {
  const settings = voz.settings({
    hotkey: {
      type: "string",
      title: "Hotkey",
      description: "Starts and stops a recording",
      default: "ctrl+opt+m",
    },
    folder: {
      type: "string",
      title: "Folder",
      description:
        "Where meeting notes and recordings go, such as a Google Drive or iCloud folder",
      default: join(homedir(), "Documents/Voz Meetings"),
      folder: true,
    },
    summary: {
      type: "boolean",
      title: "Write a summary",
      description:
        "Combines your notes with the transcript on your Mac when the meeting ends",
      default: true,
    },
    clipboard: {
      type: "boolean",
      title: "Copy the summary to the clipboard",
      default: true,
    },
    suggest: {
      type: "boolean",
      title: "Suggest recording meetings",
      description:
        "Asks to record when another app uses the microphone for a while",
      default: true,
    },
  });
  const folder = settings.folder.replace(/^~(?=\/|$)/, homedir());
  // Kept on disk so a running meeting, its notes and what was said so far survive extension reloads
  const statePath = join(voz.paths.data, "recording.json");
  const read = (): Recording => JSON.parse(readFileSync(statePath, "utf8"));
  const save = (recording: Recording) =>
    writeFileSync(statePath, JSON.stringify(recording));
  let activity: RunningActivity | undefined;
  let button: ActionHandle | undefined;
  let live:
    | { transcription?: LiveTranscription; latest?: Transcript; offset: number }
    | undefined;

  // A meeting started from the card has no ctx, and Voz before API 8 has no voz.openNote
  let notes: Note | undefined;
  function openNotes(ctx?: Context) {
    notes = (ctx ?? voz).openNote?.({
      title: "Meeting notes",
      text: existsSync(statePath) ? read().notes : "",
      onChange: (notes) => existsSync(statePath) && save({ ...read(), notes }),
    });
  }

  function showRecording(recording: Recording) {
    if (recording.current) {
      recording = {
        ...recording,
        parts: [...recording.parts, recording.current],
        current: undefined,
      };
      save(recording);
    }
    // A reload can't bring the pause back, so the meeting goes on recording
    if (recording.pausedAt) recording = resumed(recording);
    activity = voz.startActivity({
      title: "Recording meeting",
      since: recording.started + (recording.pausedFor ?? 0),
      stop,
      open: openNotes,
      pause,
      resume,
    });
    button?.update({ hidden: true });
    listen(activity, recording).catch((error) =>
      console.log(`Live transcription stopped trying: ${error}`),
    );
  }

  function resumed(recording: Recording): Recording {
    signal(recording.pid, "SIGUSR2");
    const pausedFor =
      (recording.pausedFor ?? 0) +
      Date.now() -
      (recording.pausedAt ?? Date.now());
    const next = { ...recording, pausedFor, pausedAt: undefined };
    save(next);
    return next;
  }

  function pause() {
    if (!existsSync(statePath)) return;
    const recording = read();
    signal(recording.pid, "SIGUSR1");
    save({ ...recording, pausedAt: Date.now() });
  }

  function resume() {
    if (existsSync(statePath)) resumed(read());
  }

  async function listen(current: RunningActivity, recording: Recording) {
    const offset = (Date.now() - recording.started) / 1000;
    const session: NonNullable<typeof live> = { offset };
    live = session;
    for (const [attempt, wait] of retries.entries()) {
      await Bun.sleep(wait);
      if (activity !== current) return;
      const systemAudio = attempt < micOnlyFrom;
      try {
        session.transcription = await current.transcribeLive({
          systemAudio,
          speakers: true,
          you: true,
          onTranscript: (transcript) => {
            session.latest = transcript;
            if (existsSync(statePath))
              save({ ...read(), current: { offset, transcript } });
          },
        });
        if (!systemAudio)
          banner("Voz can't hear the call, it transcribes your microphone");
        return;
      } catch (error) {
        console.log(
          `Live transcription attempt ${attempt + 1} failed: ${error}`,
        );
      }
    }
    banner(
      "Live transcription failed, Voz transcribes the recording when the meeting ends",
    );
  }

  function start(notify: (text: string) => void, ctx?: Context) {
    mkdirSync(folder, { recursive: true });
    const name = new Date()
      .toLocaleString("sv-SE")
      .slice(0, 16)
      .replace(" ", "-")
      .replace(":", "");
    const audio = join(folder, `${name}.m4a`);
    const child = Bun.spawn([recorder, audio], {
      stdout: "ignore",
      stderr: "pipe",
    });
    child.unref();
    return Bun.sleep(1000).then(async () => {
      if (child.exitCode !== null) {
        console.log(
          `Recorder failed: ${await new Response(child.stderr).text()}`,
        );
        return notify("Meeting recording failed");
      }
      const recording: Recording = {
        pid: child.pid,
        name,
        audio,
        started: Date.now(),
        notes: "",
        parts: [],
      };
      save(recording);
      showRecording(recording);
      openNotes(ctx);
    });
  }

  // Ends the live session and keeps what it heard, so a reload or a stop never loses it
  async function finishLive(recording: Recording) {
    const session = live;
    live = undefined;
    if (!session) return recording;
    const final = await session.transcription?.stop().catch((error) => {
      console.log(`Stopping live transcription failed: ${error}`);
      return undefined;
    });
    const heard = final ?? session.latest;
    if (!heard?.turns.length) return { ...recording, current: undefined };
    return {
      ...recording,
      current: undefined,
      parts: [
        ...recording.parts,
        { offset: session.offset, transcript: heard },
      ],
    };
  }

  async function stop(ctx: Context) {
    if (!existsSync(statePath)) return;
    const started = read();
    // Saving starts before recording ends, so the notch never empties between them
    const saving = voz.startActivity({ title: "Saving meeting" });
    activity?.end();
    activity = undefined;
    notes?.close();
    notes = undefined;
    recordedFrom = undefined;
    clearTimeout(ending);
    ending = undefined;
    try {
      const recording = await finishLive(started);
      rmSync(statePath);
      button?.update({ hidden: false });
      signal(recording.pid, "SIGTERM");
      const path = await write(recording, ctx);
      ctx.notify(`Saved ${path.split("/").pop()}`);
    } catch (error) {
      console.log(`Saving the meeting failed: ${error}`);
      ctx.notify(
        "Saving the meeting failed, the recording is in the meeting folder",
      );
    } finally {
      saving.end();
    }
  }

  async function write(recording: Recording, ctx: Context) {
    let transcript = merge(recording.parts.map(shift));
    if (!transcript.turns.length) transcript = await fromAudio(recording, ctx);
    const notes = recording.notes.trim();
    let summary = { title: "", markdown: "" };
    if (settings.summary && transcript.turns.length) {
      summary = await enhance(ctx.generate, notes, transcript).catch(
        (error) => {
          console.log(`Summary failed: ${error}`);
          return summary;
        },
      );
    }
    const transcriptText = transcriptMarkdown(transcript);
    const meeting = meetingFiles({
      title: summary.title,
      date: new Date(recording.started),
      summary: summary.markdown,
      notes,
      transcript: transcriptText,
    });
    let path = join(folder, meeting.folder);
    for (let copy = 2; existsSync(path); copy++)
      path = join(folder, `${meeting.folder} ${copy}`);
    mkdirSync(path);
    for (const [name, text] of meeting.files)
      writeFileSync(join(path, name), text);
    await moveAudio(recording, path);
    const main = summary.markdown || notes || transcriptText;
    const copies = [
      { name: "Notes", text: notes },
      { name: "Transcript", text: transcriptText },
    ].filter((part) => part.text && part.text !== main);
    // A meeting where nobody spoke and nothing was written has nothing to keep in history
    if (main) {
      voz.addHistory({
        text: main,
        seconds: transcript.seconds,
        file: path,
        copies,
      });
      if (settings.clipboard) await copy(main);
    }
    if (summary.markdown) {
      ctx.openNote({
        title: summary.title || "Summary",
        text: summary.markdown,
        onChange: (markdown) =>
          writeFileSync(
            join(path, "Summary.md"),
            summaryFile(summary.title, markdown),
          ),
      });
    }
    return path;
  }

  // The recorder mixes both tracks after it stops, which takes a few seconds for long meetings
  async function recorded(recording: Recording) {
    while (isRunning(recording.pid)) await Bun.sleep(250);
  }

  async function moveAudio(recording: Recording, into: string) {
    await recorded(recording);
    if (existsSync(recording.audio))
      renameSync(recording.audio, join(into, "Recording.m4a"));
  }

  async function fromAudio(recording: Recording, ctx: Context) {
    await recorded(recording);
    if (!existsSync(recording.audio)) throw new Error("No recording");
    return ctx.transcribe(recording.audio, { speakers: true });
  }

  button = voz.registerAction({
    id: "meeting",
    name: "Record meeting",
    icon: "audio-lines",
    hotkey: settings.hotkey,
    hidden: existsSync(statePath),
    run: (ctx) => (existsSync(statePath) ? stop(ctx) : start(ctx.notify, ctx)),
  });
  // Voz ends activities when it reloads extensions. The recording keeps running, and what live transcription heard is kept.
  if (existsSync(statePath)) showRecording(read());

  const calls = new Map<string, Timer>();
  const asked = new Map<string, number>();
  let recordedFrom: string | undefined;
  let ending: Timer | undefined;

  async function onMeetingTab(browser: string) {
    const urls = await new Response(
      osascript(
        `if application id "${browser}" is running then tell application id "${browser}" to get URL of every tab of every window`,
      ).stdout,
    ).text();
    return (urls.match(/https?:\/\/[^\s,{}]+/g) ?? []).some(isMeetingUrl);
  }

  async function suggest(app: CallApp) {
    if (!calls.has(app.name) || existsSync(statePath)) return;
    if (Date.now() - (asked.get(app.name) ?? 0) < cooldown) return;
    if (app.tabs && !(await onMeetingTab(app.tabs))) {
      if (calls.has(app.name))
        calls.set(
          app.name,
          setTimeout(() => suggest(app), tabsEvery),
        );
      return;
    }
    asked.set(app.name, Date.now());
    const record = voz.ask
      ? (
          await voz.ask({
            title: `${app.name} call started`,
            message: "Record the meeting and take notes?",
            icon: "audio-lines",
            buttons: ["Not now", "Record"],
          })
        )?.button === "Record"
      : await confirmInDialog();
    if (!record || !calls.has(app.name) || existsSync(statePath)) return;
    recordedFrom = app.name;
    await start(banner);
  }

  async function offerStop(app: string) {
    if (recordedFrom !== app || calls.has(app) || !voz.ask) return;
    const answer = await voz.ask({
      title: `${app} call ended`,
      message: "Stop recording and save the meeting?",
      icon: "audio-lines",
      buttons: ["Keep recording", "Stop"],
    });
    if (answer?.button === "Stop" && recordedFrom === app && !calls.has(app))
      activity?.stop?.();
  }

  function heard(listening: string) {
    const now = new Map(callAppsIn(listening).map((app) => [app.name, app]));
    for (const [name, timer] of calls)
      if (!now.has(name)) {
        clearTimeout(timer);
        calls.delete(name);
      }
    for (const [name, app] of now)
      if (!calls.has(name))
        calls.set(
          name,
          setTimeout(
            () =>
              suggest(app).catch((error) =>
                console.log(`Meeting suggestion failed: ${error}`),
              ),
            suggestAfter,
          ),
        );
    if (!recordedFrom || calls.has(recordedFrom)) {
      clearTimeout(ending);
      ending = undefined;
    } else if (!ending) {
      const app = recordedFrom;
      ending = setTimeout(() => {
        ending = undefined;
        offerStop(app).catch((error) =>
          console.log(`Offering to stop failed: ${error}`),
        );
      }, endedAfter);
    }
  }

  async function watchMicrophone() {
    const watcher = Bun.spawn([recorder, "--watch"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    for await (const chunk of watcher.stdout.pipeThrough(
      new TextDecoderStream(),
    ))
      heard(chunk.trim().split("\n").at(-1) ?? "");
    console.log(
      `Meeting detection stopped: ${await new Response(watcher.stderr).text()}`,
    );
  }
  if (settings.suggest)
    watchMicrophone().catch((error) =>
      console.log(`Meeting detection failed: ${error}`),
    );
});
