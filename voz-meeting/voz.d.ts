/** `website` is the hostname of the focused web page, such as "github.com", in Safari and Chromium browsers. */
export type App = { bundleID?: string; name?: string; website?: string };

export type Paths = { data: string };

export type Schema =
  | { type: "string"; description?: string; enum?: readonly string[] }
  | { type: "number" | "integer" | "boolean"; description?: string }
  | { type: "array"; description?: string; items: Schema }
  | {
      type: "object";
      description?: string;
      properties: Record<string, Schema>;
      required?: readonly string[];
    };

export type Generated<S extends Schema> = S extends {
  type: "string";
  enum: readonly (infer Choice)[];
}
  ? Choice
  : S extends { type: "string" }
    ? string
    : S extends { type: "number" | "integer" }
      ? number
      : S extends { type: "boolean" }
        ? boolean
        : S extends { type: "array"; items: infer Item extends Schema }
          ? Generated<Item>[]
          : S extends {
                type: "object";
                properties: infer Properties extends Record<string, Schema>;
              }
            ? {
                [Key in keyof Properties as Key extends RequiredKeys<S>
                  ? Key
                  : never]: Generated<Properties[Key]>;
              } & {
                [Key in keyof Properties as Key extends RequiredKeys<S>
                  ? never
                  : Key]?: Generated<Properties[Key]>;
              }
            : never;

export type ObjectSchema = Extract<Schema, { type: "object" }>;

type RequiredKeys<S> = S extends { required: readonly (infer Key)[] }
  ? Key
  : never;

export type GenerateRequest<S extends Schema> = {
  prompt: string;
  instructions?: string;
  schema: S;
};

export type TranscribeOptions = { speakers?: boolean };
export type Turn = {
  speaker: number;
  start: number;
  end: number;
  text: string;
  /** True on turns from the user's own microphone, with `you` in `transcribeLive`. Their `speaker` is 0. */
  you?: boolean;
};
export type Transcript = {
  text: string;
  seconds: number;
  speakers: number;
  turns: Turn[];
};
/** `systemAudio` mixes everything the Mac plays, such as a call, into the microphone. With `you`, Voz keeps the microphone apart, marks its turns and drops the call's echo from it. `onTranscript` gets the whole transcript so far, a few seconds behind speech. Earlier turns can change. */
export type LiveTranscribeOptions = TranscribeOptions & {
  systemAudio?: boolean;
  you?: boolean;
  onTranscript?(transcript: Transcript): void;
};
export type LiveTranscription = { stop(): Promise<Transcript> };
/** A small note window the user can move. `onChange` gets the full text after the user pauses typing. */
export type NoteOptions = {
  title?: string;
  text?: string;
  onChange?(text: string): void;
};
export type Note = { close(): void };
/** A field the user can edit in `ctx.ask`. A `date` value is milliseconds since 1970. */
export type AskField =
  | { id: string; label: string; type: "text"; value: string }
  | { id: string; label: string; type: "date"; value: number }
  | {
      id: string;
      label: string;
      type: "choice";
      value: string;
      options: string[];
    };
/** The last button is the main one. */
export type AskOptions = {
  title: string;
  /** A line under the title */
  message?: string;
  /** A Lucide icon name, such as `"audio-lines"`, shown beside the title */
  icon?: string;
  fields?: AskField[];
  buttons: string[];
};
/** `null` when the user closes the card. `values` holds each field by `id`. */
export type Answer = {
  button: string;
  values: Record<string, string | number>;
} | null;

export type TransformContext = { app: App };

export type Context = TransformContext & {
  insert(text: string): void;
  press(key: string): void;
  notify(text: string): void;
  generate<const S extends Schema>(
    request: GenerateRequest<S>,
  ): Promise<Generated<S>>;
  transcribe(path: string, options?: TranscribeOptions): Promise<Transcript>;
  openNote(note: NoteOptions): Note;
  /** Shows a card under the notch and waits for the user to press a button. The handler's time stops while it waits. */
  ask(options: AskOptions): Promise<Answer>;
};

/** `light` only removes fillers and fixes punctuation. `heavy` also applies the prompt, self-corrections, numbers and lists. */
export type CleanupMode = "light" | "heavy";
export type BeforeCleanupEvent = { prompt: string; mode: CleanupMode };
export type BeforeCleanupResult = {
  prompt?: string;
  mode?: CleanupMode;
} | void;
export type BeforeInsertEvent = { text: string; raw: string };
export type BeforeInsertResult = { text: string } | void;
export type CommandEvent = { text: string };
export type RecordingEvent = { path: string; seconds: number };
export type AfterInsertEvent = { text: string; raw: string };
export type AudioDropEvent = { path: string };
export type TranscribeEvent = { path: string; seconds: number };
export type CleanEvent = { text: string; prompt: string };
export type CleanupStepEvent = { text: string };

export type SpeechModel = {
  id: string;
  name: string;
  transcribe(event: TranscribeEvent, ctx: Context): Awaitable<{ text: string }>;
};

export type CleanupModel = {
  id: string;
  name: string;
  clean(event: CleanEvent, ctx: Context): Awaitable<{ text: string }>;
};

export type CleanupStep = {
  id: string;
  name: string;
  run(
    event: CleanupStepEvent,
    ctx: TransformContext,
  ): Awaitable<{ text: string } | void>;
};

export type Command = {
  phrase: string;
  /** "anywhere" runs when the phrase is any whole words of the dictation and passes the whole text. Since API 7. */
  at?: "start" | "end" | "anywhere";
  run(event: CommandEvent, ctx: Context): Awaitable<void>;
};

export type Action = {
  id: string;
  name: string;
  hotkey?: string;
  hidden?: boolean;
  /** A Lucide icon name, such as `"audio-lines"`, shown next to the name in the Voz panel. API 8. */
  icon?: string;
  run(ctx: Context): Awaitable<void>;
};

/**
 * Agents and the terminal call a tool as `voz <extension> <id>`, and AI apps see it over MCP. Return JSON.
 * Group tools with `/` in the id: `issues/create` runs as `voz jira issues create`.
 */
export type Tool<S extends ObjectSchema = ObjectSchema> = {
  id: string;
  description: string;
  /** Leave out when the tool takes no input. */
  input?: S;
  /** Inputs you can type without a flag, in order: `["key"]` lets you run `voz jira issue PROJ-1`. */
  positional?: readonly (keyof S["properties"] & string)[];
  /** Set when the tool only reads, so agents can call it without asking you. */
  readOnly?: boolean;
  /** Return within 60 seconds. After that the caller gets an error. */
  run(input: Generated<S>, ctx: Context): Awaitable<unknown>;
};

export type ActionHandle = {
  update(changes: { hidden?: boolean }): void;
};

export type Activity = {
  title: string;
  since?: number;
  stop?(ctx: Context): Awaitable<void>;
  /** Runs when the user clicks the activity in the notch or the Voz panel. */
  open?(ctx: Context): Awaitable<void>;
  /** With `resume`, Voz shows Pause next to Stop. Live transcription for the activity stops hearing until `resume`, and the timer stands still. Pause anything else you record here. API 8. */
  pause?(ctx: Context): Awaitable<void>;
  resume?(ctx: Context): Awaitable<void>;
};

export type RunningActivity = {
  end(): void;
  /** Stops the activity as if the user pressed Stop, so its `stop` handler runs with a `ctx` */
  stop(): void;
  /** Listens until `stop()` or until the activity ends. */
  transcribeLive(options?: LiveTranscribeOptions): Promise<LiveTranscription>;
};

/** Another part of an entry the user can copy on its own, such as a meeting's notes. */
export type HistoryCopy = { name: string; text: string };
export type HistoryEntry = { text: string; seconds?: number; file?: string; copies?: HistoryCopy[] };

type SettingBase = { title: string; description?: string };

export type Setting =
  | (SettingBase & {
      type: "string";
      default: string;
      options?: string[];
      secret?: boolean;
      /** Shows a folder picker. The value is the folder's full path. */
      folder?: boolean;
      required?: boolean;
    })
  | (SettingBase & { type: "number"; default: number })
  | (SettingBase & { type: "boolean"; default: boolean });

export type SettingsSchema = Record<string, Setting>;

export type SettingsValues<Schema extends SettingsSchema> = {
  [Key in keyof Schema]: Schema[Key]["default"];
};

type Awaitable<T> = T | Promise<T>;

export type ExtensionAPI = {
  name: string;
  paths: Paths;
  on(
    event: "beforeCleanup",
    handler: (
      event: BeforeCleanupEvent,
      ctx: TransformContext,
    ) => Awaitable<BeforeCleanupResult>,
  ): void;
  on(
    event: "beforeInsert",
    handler: (
      event: BeforeInsertEvent,
      ctx: TransformContext,
    ) => Awaitable<BeforeInsertResult>,
  ): void;
  on(
    event: "afterRecording",
    handler: (event: RecordingEvent, ctx: Context) => Awaitable<void>,
  ): void;
  on(
    event: "afterInsert",
    handler: (event: AfterInsertEvent, ctx: Context) => Awaitable<void>,
  ): void;
  on(
    event: "audioDrop",
    handler: (event: AudioDropEvent, ctx: Context) => Awaitable<void>,
  ): void;
  registerCommand(command: Command): void;
  registerSpeechModel(model: SpeechModel): void;
  registerCleanupModel(model: CleanupModel): void;
  registerCleanupStep(step: CleanupStep): void;
  registerAction(action: Action): ActionHandle;
  registerTool<const S extends ObjectSchema>(tool: Tool<S>): void;
  startActivity(activity: Activity): RunningActivity;
  /** Like `ctx.ask` and `ctx.openNote`, for moments no handler runs, such as when a meeting starts */
  ask(options: AskOptions): Promise<Answer>;
  openNote(note: NoteOptions): Note;
  addHistory(entry: HistoryEntry): void;
  settings<Schema extends SettingsSchema>(
    schema: Schema,
  ): SettingsValues<Schema>;
};

export type Extension = (voz: ExtensionAPI) => Awaitable<void>;

export const apiVersion: 8;

export function defineExtension(extension: Extension): Extension;
