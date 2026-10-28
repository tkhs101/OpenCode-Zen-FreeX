// The system prompts OpenCode CLI sessions send, and the protocol-aware
// injection that puts one in front of a host's own instructions.
//
// Zen's free tier accepts only agent-shaped traffic and checks the request
// against the CLI's prompt, so a request from any other host has to carry it.
// Each generation's base text is OpenCode's own (MIT), captured verbatim:
// 1.x is 1.19.3's, 2.x is 2.1.4's — the 2.1 line rewrote the prompt as new
// prose, so it is its own file and not a derivation from the 1.x text. The
// environment block names the requested model, the working directory, the
// platform and the UTC date.

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_TOOL_PREFIX } from "./official-tools.mjs";

const PROMPT_V1 = new URL("./opencode-prompt-v1.txt", import.meta.url);
const PROMPT_V2 = new URL("./opencode-prompt-v2.txt", import.meta.url);

// The sentence every copy of a generation's prompt carries. A body that
// already holds either one came from an OpenCode-shaped client and is left
// alone, so repeated shaping cannot duplicate the prompt — and either
// generation's marker counts, because a body already carrying the 1.x prompt
// is shaped, not half-shaped, whatever lane the request then takes.
export const OPENCODE_PROMPT_MARKER = "You are opencode, an interactive CLI tool";
export const OPENCODE_PROMPT_MARKER_V2 = "You are an AI agent running in OpenCode";

function readPrompt(url, label) {
  try {
    return readFileSync(url, "utf8");
  } catch (error) {
    const reason =
      error.code === "ENOENT"
        ? "is missing"
        : `could not be read (${error.code ?? error.message})`;
    throw new Error(`official-prompt: the ${label} prompt at ${url.pathname} ${reason}`, {
      cause: error,
    });
  }
}

const V1 = readPrompt(PROMPT_V1, "1.x");
// The 2.1.4 capture with placeholders for the model it names, the UTC date
// above the environment block, and the environment block itself. Everything
// else is byte for byte what the CLI sent, except its skill listing, which is
// gone for the reason below.
const V2 = readPrompt(PROMPT_V2, "2.x");

// No skill listing follows the environment block, though the CLI's own prompt
// carries one. A host that is not OpenCode has none of OpenCode's built-in
// skills: the listing 0.5.4 appended named `customize-opencode`, and a model
// that read it on 2026-10-25 called the official `skill` tool for that name
// twice — DeepSeek Harness answered `skill "customize-opencode" is unknown or
// no longer available`, because the skill does not exist outside OpenCode. The
// 2.2.0 capture of 2026-10-28 carries the same kind of block, listing the
// built-ins `opencode` and `report`, and it is stripped for the same reason:
// whatever the CLI ships in its own install, a magpie host has none of it.
// The listing is not part of the shape Zen is known to read: opencode2api's
// field-deployed prompts end at `</env>` with no skills named. An advertised
// skill is a call waiting to happen, and there is no tool behind it here.

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// The date the CLI writes: `Sun Oct 25 2026`, in UTC.
function utcDate(value) {
  return `${DAYS[value.getUTCDay()]} ${MONTHS[value.getUTCMonth()]} ${String(
    value.getUTCDate(),
  ).padStart(2, "0")} ${value.getUTCFullYear()}`;
}

// The <env> block. Options are for tests; a request uses the process's own
// directory and platform and the current UTC date.
export function officialEnvironment(model, options = {}) {
  const raw = options.cwd ?? process.cwd();
  const directory = typeof raw === "string" && raw && raw !== "." ? raw : "/workspace";
  const platform = options.platform ?? process.platform;
  const name = platform === "windows" ? "win32" : platform;
  const apiModel =
    typeof model === "string" && model.startsWith("opencode/")
      ? model.slice("opencode/".length).trim()
      : typeof model === "string"
        ? model.trim()
        : "";
  const named = apiModel || "unknown";
  const now = options.now instanceof Date ? options.now : new Date();
  return [
    `You are powered by the model named ${named}. The exact model ID is opencode/${named}`,
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${directory}`,
    `  Is directory a git repo: ${options.gitRepository === false ? "no" : "yes"}`,
    `  Platform: ${name}`,
    `  Today's date: ${utcDate(now)}`,
    "</env>",
  ].join("\n");
}

// The name the 2.x prompt's model section carries. The CLI writes the model's
// display name there ("DeepSeek V4.1 Flash Free"); this package knows the id,
// so the id is titled — right for deepseek, imperfect for glm, and the tier
// has not been measured to read this line at all (the whole 1.x-style
// environment answered on the 2.x lane on 2026-10-25, so the section is
// fidelity, not a pass requirement).
function displayName(model) {
  return model
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

// The <env> block the 2.1 line sends: no date inside (it moved to the line
// above the block) and a "Prefer" line naming the CLI's own temp directory.
export function officialEnvironmentV2(model, options = {}) {
  const raw = options.cwd ?? process.cwd();
  const directory = typeof raw === "string" && raw && raw !== "." ? raw : "/workspace";
  const platform = options.platform ?? process.platform;
  const name = platform === "windows" ? "win32" : platform;
  const temp = options.tempDir ?? join(tmpdir(), "opencode");
  return [
    "<env>",
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${directory}`,
    `  Is directory a git repo: ${options.gitRepository === false ? "no" : "yes"}`,
    `  Platform: ${name}`,
    `  Prefer ${temp} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
    "</env>",
  ].join("\n");
}

// The complete prompt for one generation. The 1.x text is followed by its
// environment block, which carries the model's own two lines; the 2.x text
// carries its model section, its date and its environment block through the
// placeholders they were captured with.
export function officialSystemPrompt(generation, model, options = {}) {
  if (generation === "1.x") return `${V1}${officialEnvironment(model, options)}`;
  if (generation === "2.x") {
    const apiModel =
      typeof model === "string" && model.startsWith("opencode/")
        ? model.slice("opencode/".length).trim()
        : typeof model === "string"
          ? model.trim()
          : "";
    const named = apiModel || "unknown";
    const now = options.now instanceof Date ? options.now : new Date();
    return V2.replaceAll("{{MODEL_NAME}}", displayName(named))
      .replaceAll("{{MODEL_ID}}", named)
      .replaceAll("{{DATE}}", utcDate(now))
      .replaceAll("{{ENV}}", officialEnvironmentV2(model, options));
  }
  throw new Error(
    `official-prompt: no prompt for generation ${JSON.stringify(generation)}`,
  );
}

const isTable = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Flatten a system or instruction value into its text: a string, a list of
// content blocks, or a block carrying text or content.
export function textFragments(value) {
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => textFragments(item));
  if (isTable(value)) {
    if (typeof value.text === "string") return textFragments(value.text);
    if (value.content !== undefined) return textFragments(value.content);
  }
  return [];
}

export function carriesOfficialPrompt(value) {
  return textFragments(value).some(
    (part) =>
      part.includes(OPENCODE_PROMPT_MARKER) || part.includes(OPENCODE_PROMPT_MARKER_V2),
  );
}

function injectChatPrompt(body, prompt) {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  const kept = [];
  const instructions = [];
  for (const message of messages) {
    if (!isTable(message) || (message.role !== "system" && message.role !== "developer")) {
      kept.push(message);
      continue;
    }
    if (carriesOfficialPrompt(message.content)) return false;
    for (const part of textFragments(message.content)) {
      const text = part.trim();
      if (text) instructions.push(text);
    }
  }
  const system = instructions.length ? `${prompt}\n\n${instructions.join("\n")}` : prompt;
  body.messages = [{ role: "system", content: system }, ...kept];
  return true;
}

function injectAnthropicPrompt(body, prompt) {
  const system = body.system;
  if (system !== undefined && system !== null) {
    if (carriesOfficialPrompt(system)) return false;
    if (typeof system === "string") {
      body.system = system.trim() === "" ? prompt : `${prompt}\n\n${system}`;
      return true;
    }
    if (Array.isArray(system)) {
      body.system = [{ type: "text", text: prompt }, ...system];
      return true;
    }
  }
  body.system = prompt;
  return true;
}

function injectResponsesPrompt(body, prompt) {
  const instructions = body.instructions;
  if (instructions !== undefined && instructions !== null) {
    if (carriesOfficialPrompt(instructions)) return false;
    if (typeof instructions === "string") {
      body.instructions =
        instructions.trim() === "" ? prompt : `${prompt}\n\n${instructions}`;
      return true;
    }
  }
  body.instructions = prompt;
  return true;
}

// The truth about tools this injection adds after the official prompt. The
// prompt teaches Code Mode — "use `execute` to call the tools below" — and the
// official set rides in the tools array beside the host's own, so a model that
// believes its prompt calls `execute` first and is answered `unknown tool`
// (measured 2026-10-25 on DeepSeek Harness: `execute`, then `shell`, then it
// found the clint_ names — two failed calls every session). The prompt's own
// convention is that a `<system-reminder>` is harness instruction, so the
// correction travels in one: the callable tools are the host's, under their
// clint_ names, and every unprefixed entry is an OpenCode built-in nothing
// here implements. The names are read from the body as it stands — the
// request path renames the host's tools before the prompt goes in, so the
// clint_ names the note lists are the wire names the model must call.
function toolAvailabilityNote(body) {
  const names = [];
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    const name = isTable(tool) ? (isTable(tool.function) ? tool.function.name : tool.name) : undefined;
    if (typeof name === "string" && name.startsWith(CLIENT_TOOL_PREFIX)) names.push(name);
  }
  const callable = names.length
    ? `The tools you can call are the host's own, under their ${CLIENT_TOOL_PREFIX} names: ${names.join(", ")}.`
    : "This host implements no tools at all; answer without tool calls.";
  return [
    "<system-reminder>",
    "Code Mode is not active in this session: this host is not OpenCode, and the built-in tools described above - `execute` and every entry of the catalog - are not implemented here. A call to one is answered with an unknown-tool error and nothing else.",
    `${callable} Every other entry in the tools array is an OpenCode built-in nothing here runs: read that array as the host's own list, not as OpenCode's.`,
    "</system-reminder>",
  ].join("\n");
}

// Put the official prompt in front of a shaped body. The protocol decides where
// its system text lives: Chat folds system and developer messages into one
// leading system message, Anthropic uses the top-level system value, and
// Responses uses instructions. A body that already carries the marker is left
// untouched and answers false. The prompt is followed by the tool availability
// note, so the model meets the correction before it meets the host's own
// instructions.
export function injectOfficialPrompt(body, protocol, generation) {
  if (!isTable(body)) return false;
  const prompt = `${officialSystemPrompt(generation, body.model)}\n\n${toolAvailabilityNote(body)}`;
  if (protocol === "chat") return injectChatPrompt(body, prompt);
  if (protocol === "anthropic") return injectAnthropicPrompt(body, prompt);
  if (protocol === "responses") return injectResponsesPrompt(body, prompt);
  throw new Error(`official-prompt: unknown protocol ${JSON.stringify(protocol)}`);
}
