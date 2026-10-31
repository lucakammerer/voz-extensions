import { defineExtension, type Context, type RunningActivity, type Transcript } from "voz";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const recorder = join(import.meta.dir, "meeting-rec");

type Recording = { pid: number; name: string; audio: string; started: number };

// Another app holding the microphone this long is most likely a call, not a short voice note
const suggestAfter = 20_000;

const osascript = (script: string) => Bun.spawn(["/usr/bin/osascript", "-e", script], { stdout: "pipe", stderr: "ignore" });
const banner = (text: string) => osascript(`display notification ${JSON.stringify(text)} with title "Voz"`);

async function confirmRecording() {
  const run = osascript('display dialog "A meeting seems to have started. Record it?" with title "Voz" buttons {"Not now", "Record"} default button "Record" cancel button "Not now" giving up after 60');
  return (await new Response(run.stdout).text()).includes("button returned:Record");
}

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Same format as voz-transcribe-file
function markdown(transcript: Transcript) {
  if (transcript.speakers < 2) return `${transcript.text.trim()}\n`;
  return `${transcript.turns.map((turn) => `**[${timestamp(turn.start)}] Speaker ${turn.speaker}:** ${turn.text}`).join("\n\n")}\n`;
}

function timestamp(seconds: number) {
  const whole = Math.floor(seconds);
  return [whole / 3600, (whole % 3600) / 60, whole % 60].map((part) => String(Math.floor(part)).padStart(2, "0")).join(":");
}

export default defineExtension((voz) => {
  const settings = voz.settings({
    hotkey: { type: "string", title: "Hotkey", description: "Starts and stops a recording", default: "ctrl+opt+m" },
    folder: { type: "string", title: "Folder", description: "Where transcripts and recordings go", default: join(homedir(), "Documents/Voz Meetings") },
    clipboard: { type: "boolean", title: "Copy transcript to clipboard", default: true },
    suggest: { type: "boolean", title: "Suggest recording meetings", description: "Asks to record when another app uses the microphone for a while", default: true },
  });
  // Kept on disk so a running recording survives extension reloads
  const statePath = join(voz.paths.data, "recording.json");
  let activity: RunningActivity | undefined;
  const showRecording = (recording: Recording) => {
    activity = voz.startActivity({ title: "Recording meeting", since: recording.started, stop });
  };

  function start(notify: (text: string) => void) {
    mkdirSync(settings.folder, { recursive: true });
    const name = new Date().toLocaleString("sv-SE").slice(0, 16).replace(" ", "-").replace(":", "");
    const audio = join(settings.folder, `${name}.m4a`);
    const child = Bun.spawn([recorder, audio], { stdout: "ignore", stderr: "pipe" });
    child.unref();
    return Bun.sleep(1000).then(async () => {
      if (child.exitCode !== null) {
        console.log(`Recorder failed: ${await new Response(child.stderr).text()}`);
        return notify("Meeting recording failed");
      }
      const recording = { pid: child.pid, name, audio, started: Date.now() };
      writeFileSync(statePath, JSON.stringify(recording));
      showRecording(recording);
      notify("Recording meeting");
    });
  }

  async function stop(ctx: Context) {
    const recording: Recording = JSON.parse(readFileSync(statePath, "utf8"));
    rmSync(statePath);
    if (isRunning(recording.pid)) process.kill(recording.pid, "SIGTERM");
    activity?.end();
    try {
      ctx.notify(`${settings.clipboard ? "Copied and saved" : "Saved"} ${(await transcribe(recording, ctx)).split("/").pop()}`);
    } catch (error) {
      console.log(`Transcription failed: ${error}`);
      ctx.notify("Transcription failed, the recording is in the meeting folder");
    }
  }

  async function transcribe(recording: Recording, ctx: Context) {
    // The recorder mixes both tracks after it stops, which takes a few seconds for long meetings
    while (isRunning(recording.pid)) await Bun.sleep(250);
    if (!existsSync(recording.audio)) throw new Error("No recording");

    const transcript = await ctx.transcribe(recording.audio, { speakers: true });
    const text = markdown(transcript);
    const path = join(settings.folder, `${recording.name}.md`);
    writeFileSync(path, text);
    voz.addHistory({ text, seconds: transcript.seconds, file: path });
    if (settings.clipboard) await Bun.spawn(["/usr/bin/pbcopy"], { stdin: new Blob([text]), env: { LANG: "en_US.UTF-8" } }).exited;
    return path;
  }

  voz.registerAction({
    id: "meeting",
    name: "Record meeting",
    hotkey: settings.hotkey,
    run: (ctx) => (existsSync(statePath) ? stop(ctx) : start(ctx.notify)),
  });
  // Voz ends activities when it reloads extensions, the recording keeps running
  if (existsSync(statePath)) showRecording(JSON.parse(readFileSync(statePath, "utf8")));

  // Asks once each time the microphone becomes busy, so declining or stopping early does not ask again until the call ends
  let busy = false;
  let timer: Timer | undefined;
  async function suggest() {
    if (existsSync(statePath)) return;
    if ((await confirmRecording()) && busy && !existsSync(statePath)) await start(banner);
  }
  async function watchMicrophone() {
    const watcher = Bun.spawn([recorder, "--watch"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    for await (const chunk of watcher.stdout.pipeThrough(new TextDecoderStream())) {
      const next = chunk.trim().endsWith("1");
      if (next === busy) continue;
      busy = next;
      clearTimeout(timer);
      if (busy) timer = setTimeout(() => suggest().catch((error) => console.log(`Meeting suggestion failed: ${error}`)), suggestAfter);
    }
    console.log(`Meeting detection stopped: ${await new Response(watcher.stderr).text()}`);
  }
  if (settings.suggest) watchMicrophone().catch((error) => console.log(`Meeting detection failed: ${error}`));
});
