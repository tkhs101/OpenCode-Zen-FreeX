import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { PROFILES, agentFor, generationOf } from "./core-tools.mjs";
import {
  OFFICIAL_SETS,
  officialTool,
  officialToolNames,
} from "./official-tools.mjs";
import { OPENCODE_PROMPT_MARKER, OPENCODE_PROMPT_MARKER_V2 } from "./official-prompt.mjs";
import { readDiscoveryCache, writeDiscoveryCache } from "./models.mjs";
import { clearInstalledSnapshot, snapshotState } from "./limits.mjs";
import { protocols, declaredTools, toolReply } from "./tool-fixtures.mjs";
import { requestFor } from "./tools-smoke.mjs";

// The limits this plugin learns live in a file in the operator's cache
// directory, and a test run may not read or write it: every case below would
// otherwise answer from whatever the last run of the suite happened to leave
// behind, which is the one thing a suite may not depend on. An empty value is
// the documented way to keep the state in memory, and the case that tests the
// file itself names a path of its own.
process.env.OPENCODE_ZEN_FREE_LIMITS_STATE = "";
// The discovery cache is a file in the operator's cache directory too, and a
// test run may not read what the last run left behind. The cases about the
// cache name a temporary file of their own below.
process.env.OPENCODE_ZEN_FREE_DISCOVERY_CACHE = "";
// The remote limits snapshot is a GitHub URL, and a test run may not depend on
// it — nor ask for it. The cases about the snapshot pass an explicit local URL
// or set the local pinned source themselves.
process.env.OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_URL = "";

// The names the discovery reads are counted by. Zen's own list is also the
// endpoint the fixture's `models` handler answers, so the three are named here
// rather than written out at each assertion: what a test holds is the shape of
// a discovery round, not the spelling of one URL.
const DISCOVERY_READS = ["/v1/models", "/catalog", "/docs"];

// How many of the calls that reached the fixture were discovery reads, and how
// many inference requests went with them. A round of discovery is one of each
// of `DISCOVERY_READS`, so `rounds` is the smallest per-URL count: a case that
// read one URL twice and the others not at all has read no round, and the
// largest count would report that second read as a whole round the listener
// never asked for. The request path's own calls to `/v1/<protocol>` are counted
// apart from it, since a test that drives two of them expects two.
const reads = (state) => {
  const urls = state.calls.map((call) => call.url);
  const discovery = urls.filter((url) => DISCOVERY_READS.includes(url));
  const perURL = DISCOVERY_READS.map((name) => discovery.filter((url) => url === name).length);
  return {
    rounds: Math.min(...perURL),
    discovery: discovery.length,
    inference: urls.filter((url) => url.startsWith("/v1/") && url !== "/v1/models").length,
  };
};

// Hold every read of a discovery at the fixture's gate, and give back the key
// that releases them. A round held here has read nothing yet, so the requests
// driving it are all inside it — which is what makes the counts below about
// concurrency rather than about how fast a loopback answers. Every hold arms a
// gate of its own: the gate a case released is settled, and a second hold handed
// that one would wait on a round there is nothing left to release.
function holdDiscovery(state) {
  state.discoveryHang = true;
  state.discoveryReads = 0;
  state.requests = 0;
  state.discoveryGate = deferred();
  return state.discoveryGate;
}

// Wait until a case's own two counters say the requests it is waiting for have
// arrived. Raced against a watchdog so a request that is never sent reports
// itself instead of hanging the suite. The watchdog is the branch that ends a
// wait early, and the poll it beats is a chain of 1ms timers that nothing
// awaits: `stopped` is what ends that chain, since `clearTimeout` only reaches
// the watchdog. A case that has to watch the watchdog win passes its own
// `watchdogMs` rather than waiting out the default five seconds.
async function awaitReached(state, reached, watchdogMs = WATCHDOG_MS) {
  let watchdog;
  let stopped = false;
  try {
    await Promise.race([
      (async () => {
        while (!stopped && !reached(state)) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      })(),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => {
          stopped = true;
          const { requests, discoveryReads } = state;
          reject(new Error(`${requests} requests and ${discoveryReads} discovery reads arrived, not what was waited for`));
        }, watchdogMs);
      }),
    ]);
  } finally {
    stopped = true;
    clearTimeout(watchdog);
  }
}

// A promise a test can resolve from outside, and the key to it. Written once
// because the fixture's gate and the cases that hold a discovery behind it all
// need the same thing.
function deferred() {
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

const subject = import("./index.mjs").then((module) => ({
  default: { server: module.ZenFreePlugin },
  module,
}));

// Which names a host may read the plugin off. magpie builds one from
// `default.server`; the named exports stay for anything that imported one by
// name. All three are the same read of provider.mjs's own export, so pinning
// them here is what keeps a name that no test uses from being repointed or
// dropped without anything noticing.
test("the plugin is reached by every name this module offers, and the id comes with it", async () => {
  const { module } = await subject;
  assert.equal(typeof module.server, "function");
  assert.equal(module.server, module.ZenFreePlugin);
  assert.equal(module.server, module.default.server);
  assert.equal(typeof module.default.id, "string");
  // The id travels with the named exports as well, so a host that resolves
  // the plugin by one of them has something to key it by — the provider's own
  // id, read from the module rather than written out here.
  assert.equal(module.id, module.default.id);
});

// The guard that reads provider.mjs's export runs when this module is loaded,
// and what it has to catch is a provider.mjs that lost one of the two things
// the plugin has to carry. The real one carries both, so there is nothing for
// the guard to catch in it — the guard is read in a child process with a
// provider.mjs of its own.
//
// The two cases are the two ways it used to wave a plugin through: a value
// inherited from a prototype, which is not something provider.mjs exported at
// all, and an id of nothing but spaces, which is no name to key a plugin by.
test("the plugin guard reads own properties only, and refuses a blank id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zenfree-plugin-guard-"));
  try {
    // This module as it is, so what is under test is the guard and not a copy
    // of it, and a provider.mjs beside it that the copy imports.
    writeFileSync(join(dir, "index.mjs"), readFileSync(new URL("./index.mjs", import.meta.url)));
    const load = (source) => {
      writeFileSync(join(dir, "provider.mjs"), source);
      const script = join(dir, "load.mjs");
      writeFileSync(
        script,
        `import(${JSON.stringify(pathToFileURL(join(dir, "index.mjs")).href)}).then(
  (module) => console.log("THE MODULE LOADED", JSON.stringify(module.id), JSON.stringify(module.default.id)),
  (error) => console.error(String(error && error.message)),
);
`,
      );
      const run = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 60000 });
      return `${run.stdout ?? ""}${run.stderr ?? ""}`;
    };
    // A provider that exports neither half: the factory and the id are
    // inherited, and the export carries nothing of its own.
    const inherited = load(`
      const inherited = { server: () => {}, id: "inherited" };
      export default Object.create(inherited);
    `);
    assert.doesNotMatch(inherited, /THE MODULE LOADED/, "a plugin that carries neither half must not load");
    assert.match(inherited, /server.*factory.*id/, "and the refusal says what is missing");
    // And one that exports a factory and a name of nothing but spaces.
    const blank = load(`
      export default { server: () => {}, id: "   " };
    `);
    assert.doesNotMatch(blank, /THE MODULE LOADED/, "a plugin with a blank id must not load");
    assert.match(blank, /server.*factory.*id/);
    // An id is a name, and the name that goes out is exactly the one that was
    // checked. A padded id is refused rather than trimmed: silently publishing
    // `opencode-zen-free` for a plugin that named itself `"  opencode-zen-free  "`
    // would key the plugin by a name the provider never wrote.
    const padded = load(`
      export default { server: () => {}, id: "  opencode-zen-free  " };
    `);
    assert.doesNotMatch(padded, /THE MODULE LOADED/, "a padded id is not the name that was written");
    assert.match(padded, /surrounding whitespace/, "and the refusal says why");
    // The value the guard reads is the value it exports. The getter below
    // answers a differently padded name on every read; the guard reads it once,
    // and a padded first read is refused rather than published under either
    // spelling.
    const changing = load(`
      let reads = 0;
      const plugin = { server: () => {} };
      Object.defineProperty(plugin, "id", {
        enumerable: false,
        get() { reads += 1; return reads === 1 ? "  first-name  " : "later-name"; },
      });
      export default plugin;
    `);
    assert.doesNotMatch(changing, /THE MODULE LOADED/, "the id the guard read is the id it refuses");
    assert.match(changing, /surrounding whitespace/, "and the first read is what was judged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The watchdog is the one branch that can end a wait without what it waited
// for, and the branch it beats is a chain of 1ms polls that nothing awaits.
// Left running, that chain outlives the failure it reported: a case that never
// reaches its count would fail and go on polling for the rest of the run. The
// predicate below is what says otherwise — it counts its own calls, so a poll
// still running after the watchdog fires is a count that kept rising. The state
// it is raced on is that much and no more: the wait reads the two counters it
// reports in the failure message and nothing else.
test("a wait the watchdog ends stops polling instead of leaving a timer chain", async () => {
  let polls = 0;
  const state = { requests: 0, discoveryReads: 0 };
  const counted = () => {
    polls += 1;
    return false;
  };
  // A watchdog of its own, so proving the chain ends does not cost the default
  // five seconds of a wait that is meant to fail.
  await assert.rejects(
    awaitReached(state, counted, 20),
    /discovery reads arrived, not what was waited for/,
  );
  const atFailure = polls;
  // Long enough that a chain still running would have polled several times,
  // even on a runner that is busy with the rest of the suite.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    polls,
    atFailure,
    "the poll loop kept running after the watchdog ended the wait",
  );
});

// A hold that has been released is not a hold: handing it to a second caller
// would leave that caller waiting on a round whose release has already been
// spent. The fresh gate is checked as pending as well as different, since the
// two readings fail apart — a gate resolved on the way out would be a different
// object and still not a hold.
test("a second hold of a discovery is handed a gate of its own", async () => {
  const state = { discoveryHang: false, discoveryReads: 0, requests: 0, discoveryGate: null };
  const first = holdDiscovery(state);
  first.settle();
  await first.promise;
  const second = holdDiscovery(state);
  assert.notEqual(second, first, "the second hold was handed the gate the first one released");
  assert.equal(
    state.discoveryGate,
    second,
    "the fixture waits on the gate the last hold armed",
  );
  let settled = 0;
  first.promise.then(() => {
    settled += 1;
  });
  await Promise.resolve();
  assert.equal(settled, 1, "the first gate is settled, so a listener on it runs");
  second.promise.then(() => {
    settled += 1;
  });
  await Promise.resolve();
  assert.equal(settled, 1, "the second gate is pending: the round it holds is still held");
  second.settle();
  await second.promise;
});

// `rounds` counts complete rounds, and a round is one read of every URL in
// `DISCOVERY_READS`. Reading one URL twice has not read two rounds, so the
// count is the smallest per-URL count: the largest would report the second read
// of one URL as a round the listener never asked for.
test("a round of discovery is counted only where every URL of it was read", () => {
  const stateOf = (urls) => ({ calls: urls.map((url) => ({ url })) });
  assert.deepEqual(reads(stateOf([...DISCOVERY_READS])), {
    rounds: 1,
    discovery: 3,
    inference: 0,
  });
  assert.deepEqual(reads(stateOf(["/v1/models", "/v1/models"])), {
    rounds: 0,
    discovery: 2,
    inference: 0,
  });
  // A second round of the same URL is not a round while the other two are still
  // on their first read.
  assert.deepEqual(reads(stateOf([...DISCOVERY_READS, "/v1/models"])), {
    rounds: 1,
    discovery: 4,
    inference: 0,
  });
});

// The names the HTTP stack adds on its own rather than the plugin choosing
// them, in one place so the three tests that pin the outbound set cannot drift
// apart from each other. `host` is only excluded where the request is held
// against the gate's own copy of the headers, which does not carry one; the test
// that pins the set by name sends the same list and includes `host` deliberately.
const HTTP_STACK = [
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  // Node's fetch adds these two where Bun's does not. They are the transport's
  // choice either way, so ignoring them here keeps the two runtimes comparable.
  "accept-language",
  "sec-fetch-mode",
];
const HTTP_STACK_WITHOUT_HOST = ["connection", "content-length", "accept-encoding", "accept-language", "sec-fetch-mode"];
const chosenByPlugin = (sent, transport) =>
  Object.keys(sent).filter((name) => !transport.includes(name));

// The header names this plugin chooses for itself, in one place because two
// tests pin the outbound set: a name added to one list and not the other would
// otherwise go uncaught, which is the drift those tests exist to catch.
const PLUGIN_HEADERS = [
  "accept",
  "content-type",
  "user-agent",
  "x-opencode-client",
  "x-opencode-project",
  "x-opencode-session",
  "x-opencode-session-id",
];

// How long a race against a loopback round-trip is given before it is read as
// "it never happened". Generous on purpose: a loaded CI runner is slow, and a
// false failure here says nothing about the behaviour under test.
//
// A configured value that is not a usable number of milliseconds is a mistake
// the environment makes rather than anything about the plugin: `??` keeps an
// exported-but-empty variable (`TEST_WATCHDOG_MS=` parses to 0) and a
// non-numeric one parses to NaN, and either would let every watchdog fire at
// once and fail these races for a reason that is not in this package. Neither
// is trusted; both fall back to the default.
const configuredWatchdog = Number(process.env.TEST_WATCHDOG_MS);
const WATCHDOG_MS =
  Number.isFinite(configuredWatchdog) && configuredWatchdog > 0 ? configuredWatchdog : 5000;

// The User-Agent the capture composes for a generation and protocol
// (core-tools.mjs builds that string). Read from fingerprint.json rather than
// written out here: a re-capture that changes the captured OpenCode version
// should not need several literals edited by hand in this file.
const agentOf = (generation, protocol = "chat") => agentFor(generation, protocol);

// Reading the last recorded call on a run where the plugin never reached
// upstream is a TypeError that hides the real failure: say what is wrong.
function lastCall(state) {
  assert.ok(state.calls.length > 0, "no request reached upstream");
  return state.calls[state.calls.length - 1];
}

async function fixture(t, input = {}, serverOptions = {}) {
  // Every case gets the state its own traffic draws and no more. The adaptive
  // limits are module state — a refusal one case provokes would otherwise move
  // the declaration the next case's model list reports, and the suite would
  // depend on the order its cases ran in.
  const { limitAdaptivity } = await import("./limits.mjs");
  const heldLimits = limitAdaptivity(new Map());
  t.after(() => limitAdaptivity(heldLimits));
  const state = {
    calls: [],
    status: 200,
    // A queue of answers for inference requests, consumed one per attempt. A
    // case that wants "429, then 200" writes it here; when the queue is empty
    // the fixed `status` answers instead.
    statuses: [],
    modelsStatus: 200,
    docsStatus: 200,
    catalogStatus: 200,
    // A barrier a test can hold a discovery behind, and the two counters that
    // say what arrived while it was held. `discoveryHang` holds every read of
    // a discovery at the gate below — the listing, the catalogue and the docs
    // alike — and releasing it lets those same reads go on to be answered, so
    // a case can drive two rounds of discovery and not only look at one.
    discoveryHang: false,
    discoveryGate: null,
    discoveryReads: 0,
    requests: 0,
    // Rows a case wants to add to (or override in) the catalogue's model map,
    // named by id. What the real catalogue writes for a row it could not fill
    // in is `null`, and `[]`, `"junk"` and `7` are the same kind of row; a case
    // that drives one through a partial discovery needs to place it on an id of
    // its own, since a `-free` id resolves without the catalogue either way.
    catalogRows: undefined,
  };
  // Headers an upstream error is served with: a real refusal arrives with a
  // length, an encoding and validators describing its own bytes, and what this
  // plugin hands back is not those bytes.
  const upstreamHeaders = () =>
    state.responseHeaders ? { ...state.responseHeaders } : {};
  // A body that is not JSON is recorded as no body at all rather than thrown
  // out of a request listener, where it would read as a hung request.
  const parseBody = (text) => {
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    state.calls.push({ url: req.url, headers: req.headers, body: parseBody(text), raw: text });
    state.requests += 1;
    if (state.discoveryHang) {
      // Counted before the wait, so a test can tell that a read has arrived
      // without the read having to be released for it to say so. One gate for
      // all three reads of a round: releasing it releases that round, and the
      // requests go on to be answered below rather than being left open.
      state.discoveryReads += 1;
      state.discoveryGate ??= deferred();
      await state.discoveryGate.promise;
    }
    if (req.url === "/v1/models") {
      res.writeHead(state.modelsStatus, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: (state.ids ?? ["chat-free", "responses-free", "messages-free", "paid"]).map(
            (id) => ({
              id,
            }),
          ),
        }),
      );
    } else if (req.url === "/catalog") {
      res.writeHead(state.catalogStatus, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          opencode: {
            npm: "@ai-sdk/openai-compatible",
            models: {
              ...(state.omitChat
                ? {}
                : { "chat-free": { name: "Chat Free", limit: { context: 200000, output: 8192 } } }),
              "responses-free": { provider: { npm: "@ai-sdk/openai" } },
              "messages-free": { provider: { npm: "@ai-sdk/anthropic" } },
              paid: { cost: { input: 3, output: 10 } },
              "late-free": {},
              ...(state.catalogRows ?? {}),
            },
          },
        }),
      );
    } else if (req.url === "/docs") {
      res.writeHead(state.docsStatus);
      res.end(
        state.docsText ??
          `| Model | chat-free | \`https://opencode.ai/zen/v1/${state.chatProtocol ?? "chat/completions"}\` | sdk |`,
      );
    } else if (state.hangBody) {
      // Headers and a length, then silence: the read this plugin makes of a
      // refusal is bounded in time as well as in size, and what it does when
      // the boundary is a body that never arrives is what this branch pins.
      res.writeHead(state.status ?? 403, {
        "content-type": "application/json",
        "content-length": "999",
        ...upstreamHeaders(),
      });
      res.flushHeaders();
    } else if (state.destroyInference) {
      // The socket dies before a byte of the answer is written: fetch rejects
      // with the runtime's own transport error rather than resolving a
      // Response, which is what a proxy mid-restart produces.
      req.socket.destroy();
    } else if (state.body !== undefined) {
      res.writeHead(state.status ?? 403, { "content-type": "application/json", ...upstreamHeaders() });
      res.end(state.body);
    } else if (state.reply) {
      res.writeHead(200, { "content-type": state.contentType ?? "text/event-stream" });
      res.end(state.reply);
    } else if (state.hang) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": heartbeat\n\n");
    } else if (state.statuses?.length) {
      // A queue of answers for inference requests, one per attempt, so a case
      // can say "429 and then 200" and prove a retry happened rather than
      // inferring it from a count. An empty queue falls through to `status`,
      // which is what a case whose first answer is also its last wants.
      const next = state.statuses.shift();
      if (next === 200) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          'data: {"id":"chat-1","model":"chat-free","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      } else {
        res.writeHead(next, {
          "content-type": "application/json",
          "retry-after": "30",
          ...upstreamHeaders(),
        });
        res.end('{"error":{"message":"limited","type":"rate_limit_error"}}');
      }
    } else if (state.status !== 200) {
      res.writeHead(state.status, {
        "content-type": "application/json",
        "retry-after": "30",
        ...upstreamHeaders(),
      });
      res.end('{"error":{"message":"limited","type":"rate_limit_error"}}');
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        'data: {"id":"chat-1","model":"chat-free","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const module = await subject;
  assert.equal(typeof module.default?.server, "function", "plugin hooks must be implemented");
  const plugin = await module.default.server(input, {
    baseURL: `${origin}/v1`,
    catalogURL: `${origin}/catalog`,
    docsURL: `${origin}/docs`,
    // No second opinion by default: these cases are about what the catalogue
    // and the route say, and reaching models.dev from each of them would put a
    // third party in the middle of every assertion. The cases that are ABOUT the
    // second opinion serve it from this same origin.
    modelsDevURL: null,
    // The remote limits snapshot, for the cases that are about it. Undefined
    // here leaves the operator's/env defaults, which the suite has already
    // turned off above.
    ...serverOptions,
  });
  return { plugin, state, origin };
}

const publicAuth = async () => ({ type: "api", key: "public" });

for (const { protocol, path, model } of protocols) {
  for (const stream of [true, false]) {
    for (const upstreamSSE of [true, false]) {
      test(`${protocol}: guards tool names with client stream=${stream}, upstream SSE=${upstreamSSE}`, async (t) => {
        const { plugin, state, origin } = await fixture(t);
        await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
        const loader = await plugin.auth.loader(publicAuth);
        const tools = declaredTools(protocol);
        state.contentType = upstreamSSE ? "text/event-stream" : "application/json";
        const send = () =>
          loader.fetch(`${origin}/v1/${path}`, {
            method: "POST",
            body: JSON.stringify({ model, stream, tools }),
          });
        for (const [upstream, expected] of [
          ["bash", "Bash"],
          ["read", "Read"],
          ["Bash", "Bash"],
          // The request now names its client tools clint_<name> on the wire,
          // so a reply naming the wire spelling is the likeliest one. It has
          // to reach the host as the name the host declared.
          ["clint_Bash", "Bash"],
          ["clint_read", "Read"],
        ]) {
          state.reply = toolReply(protocol, upstream, upstreamSSE);
          const response = await send();
          assert.equal(response.status, 200);
          const text = await response.text();
          assert.match(text, new RegExp(`"name"\\s*:\\s*"${expected}"`));
          assert.doesNotMatch(text, /"name"\s*:\s*"(?:bash|read)"/);
        }
        const outbound = lastCall(state).body.tools;
        const renamed = tools.map((tool) => {
          const name = tool.function?.name ?? tool.name;
          if (protocol === "chat") {
            // The 2.x client writes strict:false on every function it sends,
            // so a host tool that said nothing about strict leaves with one.
            return {
              ...tool,
              function: { strict: false, ...tool.function, name: `clint_${name}` },
            };
          }
          return { ...tool, name: `clint_${name}` };
        });
        assert.deepEqual(outbound.slice(0, tools.length), renamed);
        for (const raw of outbound.slice(tools.length)) {
          const tool = protocol === "chat" ? raw.function : raw;
          // Zen reads the body as well as the headers: the appended set is
          // OpenCode's own definitions, not placeholders. The set is the 2.1.4
          // capture, and the shell's wording moves with the platform, so the
          // expectation is the renderer's own output rather than the stored
          // text.
          assert.ok(OFFICIAL_SETS["2.x"].tools[tool.name], `${tool.name} is not one of the tools Zen reads`);
          assert.equal(
            tool.description,
            officialTool("chat", tool.name, "2.x").function.description,
            `${tool.name} is not described as OpenCode describes it`,
          );
          assert.ok(Object.keys((tool.parameters ?? tool.input_schema).properties).length > 0);
        }
        // A call of a tool the agent doesn't have reaches the agent as
        // called, as a tool call, so the agent answers it with its own
        // unknown-tool error and the model goes on; it neither fails the
        // turn (#76) nor ends it as a plain answer (#209).
        state.reply = toolReply(protocol, "edit", upstreamSSE);
        const handed = await send();
        assert.equal(handed.status, 200);
        const text = await handed.text();
        assert.match(text, /"name"\s*:\s*"edit"/);
        assert.match(text, /"tool_calls"|"tool_use"|"function_call"/);
        // The id the model's call came with is the client's handle on it, and
        // the call is handed on with it: Chat and Messages as `id`, Responses
        // as `call_id`.
        assert.match(text, /"(?:call_)?id"\s*:\s*"call_1"/);
        assert.doesNotMatch(text, /"error"|The call was left out/);
      });
    }
  }
}

test("keeps declared tools isolated between requests using the same loader", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.reply = toolReply("chat", "bash");
  const send = (tools) =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", stream: false, tools }),
    });
  assert.equal((await send(declaredTools("chat"))).status, 200);
  const undeclared = await send([]);
  assert.equal(undeclared.status, 200);
  const text = await undeclared.text();
  assert.doesNotMatch(text, /"name"\s*:\s*"Bash"/);
  assert.match(text, /"name"\s*:\s*"bash"/);
});

// toolReply refuses to write a call with no name — the shape a case reaching
// for a tool name most easily gets by accident — so the one case that wants
// that shape takes the name off the reply that builder wrote. Every protocol
// writes the name where its wire does, so this stays on the shapes the other
// cases here use; the assert is what keeps a builder that stopped writing the
// name from leaving a named call to be asserted about instead.
function namelessReply(protocol, sse) {
  const written = `"name":${JSON.stringify("NAMELESS")}`;
  const reply = toolReply(protocol, "NAMELESS", sse);
  assert.ok(reply.includes(written), `${protocol} writes the tool name as ${written}`);
  return reply.split(written).join('"name":""');
}

// The half of the guard that survives #209: a call the model gave no name to
// names nothing a host could key a result by, so it is still left out of the
// reply and the reply's text says so, where the client reads it (#76). The call
// itself never reaches the client, and a turn left with no call ends as a plain
// stop rather than tool use — hold it apart from the case above, where a *named*
// call the agent has no spelling of now goes on as called. Where the note lands
// is the protocol's own: Chat keeps it in the message's text, Responses answers
// a text item in the call's place, Messages a text block.
const leftOutShape = {
  chat: {
    note: /"content"\s*:\s*"\(The model called a tool without a name\./,
    finish: /"finish_reason"\s*:\s*"stop"/,
  },
  responses: { note: /"type"\s*:\s*"output_text"/, finish: /"type"\s*:\s*"message"/ },
  anthropic: { note: /"type"\s*:\s*"text"/, finish: /"stop_reason"\s*:\s*"end_turn"/ },
};

for (const { protocol, path, model } of protocols) {
  for (const stream of [true, false]) {
    for (const upstreamSSE of [true, false]) {
      test(`${protocol}: a call with no name is left out, said in the text, with client stream=${stream}, upstream SSE=${upstreamSSE}`, async (t) => {
        const { plugin, state, origin } = await fixture(t);
        await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
        const loader = await plugin.auth.loader(publicAuth);
        state.contentType = upstreamSSE ? "text/event-stream" : "application/json";
        state.reply = namelessReply(protocol, upstreamSSE);
        const response = await loader.fetch(`${origin}/v1/${path}`, {
          method: "POST",
          body: JSON.stringify({ model, stream, tools: declaredTools(protocol) }),
        });
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.match(text, /The model called a tool without a name\. The call was left out\./);
        assert.doesNotMatch(text, /"tool_calls"|"tool_use"|"function_call"/);
        const shape = leftOutShape[protocol];
        assert.ok(shape, `no left-out shape is written for ${protocol}`);
        assert.match(text, shape.note);
        assert.match(text, shape.finish);
      });
    }
  }
}

for (const [input, supplied, expected, label] of [
  [{}, undefined, /^[0-9a-f]{40}$/, "its own fresh hash"],
  [{ project: { id: "magpie" } }, undefined, /^[0-9a-f]{40}$/, "its own fresh hash"],
  [{ project: { id: "abc123", vcs: "git" } }, undefined, "abc123", "abc123"],
  [{}, "client-project", "client-project", "client-project"],
]) {
  test(`uses OpenCode project identity ${label}`, async (t) => {
    const { plugin, state, origin } = await fixture(t, input);
    await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
    const loader = await plugin.auth.loader(publicAuth);
    const response = await loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: supplied ? { "x-opencode-project": supplied } : {},
      body: JSON.stringify({ model: "chat-free", stream: true }),
    });
    await response.text();
    if (expected instanceof RegExp) {
      // The tier's quota is ledged per project id and egress together
      // (measured 2026-10-26), and the old default `global` was shared by
      // every freeriding plugin user — its buckets on popular exits arrived
      // pre-burned. A host that names no project gets a git-hash-shaped id of
      // its own per request, so its ledger is nobody else's.
      const first = lastCall(state).headers["x-opencode-project"];
      assert.match(first, expected);
      const again = await loader.fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "chat-free", stream: true }),
      });
      await again.text();
      assert.match(lastCall(state).headers["x-opencode-project"], expected);
      assert.notEqual(lastCall(state).headers["x-opencode-project"], first, "two requests are two project ids");
    } else {
      assert.equal(lastCall(state).headers["x-opencode-project"], expected);
    }
    assert.equal(lastCall(state).headers["user-agent"], agentOf("2.x"));
  });
}

// The headers OpenCode's release binary sends to opencode.ai/zen/v1, captured
// on each protocol: these and no others, whatever the caller sent. The
// User-Agent each protocol sends is composed from the capture rather than
// written here, since the capture is what says which OpenCode it was taken from.
for (const [path, model, protocol, key] of [
  ["chat/completions", "chat-free", "chat", ["authorization"]],
  ["responses", "responses-free", "responses", ["authorization"]],
  ["messages", "messages-free", "anthropic", ["anthropic-version", "x-api-key"]],
]) {
  test(`${path}: sends OpenCode's own headers and none of the caller's`, async (t) => {
    const { plugin, state, origin } = await fixture(t);
    // The names this protocol authenticates with are the test's premise, so
    // they are checked against the request that actually went out: a name that
    // stopped being sent would otherwise be asserted about nothing.
    for (const name of key)
      assert.ok(!HTTP_STACK.includes(name), `${name} is not one the transport adds`);
    await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
    const loader = await plugin.auth.loader(publicAuth);
    const response = await loader.fetch(`${origin}/v1/${path}`, {
      method: "POST",
      headers: {
        "user-agent": "claude-cli/2.1.0",
        "x-stainless-lang": "js",
        "x-session-affinity": "header-parity-conversation",
        "x-magpie-work-dir": "/tmp/x",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ model, stream: true }),
    });
    await response.text();
    const sent = lastCall(state).headers;
    assert.equal(sent["user-agent"], agentOf("2.x", protocol));
    assert.equal(sent.accept, "*/*");
    const own = chosenByPlugin(sent, HTTP_STACK);
    assert.deepEqual(
      own.sort(),
      [...PLUGIN_HEADERS, ...key].sort(),
    );
    assert.equal(sent["x-opencode-session-id"], sent["x-opencode-session"]);
    // x-opencode-request, x-session-affinity and x-session-id are in OpenCode's
    // own header set upstream, and none of them is needed: measured 2026-10-15,
    // each answers on its own and x-opencode-request with x-session-affinity is
    // refused. So the set above stays a strict subset of what has been seen
    // accepted (#4842 of decolua/9router).
    assert.equal(sent["x-opencode-request"], undefined);
  });
}

// The gate is what says whether this plugin still works, so it has to ask with
// the request the plugin makes. It used to build its own copy of the headers,
// and that copy had already drifted - it was missing `accept` - with nothing
// failing on it. Both generations are held here against what the plugin was
// observed to send, so the gate cannot go back to asking with a shape of its own.
for (const [generation, profile] of Object.entries(PROFILES)) {
  test(`the gate asks Zen with the ${generation} request this plugin sends`, async (t) => {
    const { plugin, state, origin } = await fixture(t);
    await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
    const loader = await plugin.auth.loader(publicAuth);
    const names = [...profile.required];
    const tools = names.map((name) => ({ type: "function", function: profile.tools[name] }));
    const response = await loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "user-agent": "claude-cli/2.1.0" },
      body: JSON.stringify({ model: "chat-free", stream: true, tools }),
    });
    await response.text();

    const sent = lastCall(state).headers;
    const wire = chosenByPlugin(sent, HTTP_STACK);
    const gate = requestFor(generation, profile, names).headers;
    const gateNames = [...gate.keys()].filter((name) => !HTTP_STACK.includes(name));
    assert.deepEqual(gateNames.sort(), wire.sort());
    if (generation === "2.x") {
      assert.equal(gate.get("user-agent"), sent["user-agent"]);
    } else {
      // The 1.x lane is retired (2026-10-25): the gate still asks about it,
      // but the plugin presents the 2.x agent whatever the tools say, so
      // parity is the 2.x lane's alone.
      assert.equal(sent["user-agent"], agentFor("2.x"));
      assert.notEqual(gate.get("user-agent"), sent["user-agent"]);
    }
    // Parity is only parity if each side sent something: an empty header set on
    // one side would otherwise compare equal to nothing at all on the other.
    assert.ok(wire.length > 0 && !gate.keys().next().done);
    // The tools the floor is asked with have to name the generation they came
    // from, or the plugin would present itself as the other one.
    assert.equal(generationOf(tools), generation);
  });
}

test("aborts discovery immediately when the inference caller cancels", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  const loader = await plugin.auth.loader(publicAuth);
  const controller = new AbortController();
  const gate = holdDiscovery(state);
  const request = loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    signal: controller.signal,
    body: JSON.stringify({ model: "chat-free", stream: true }),
  });
  const rejected = assert.rejects(request, /abort/i);
  let timer;
  let settled = false;
  // Released once. The read that was parked at the gate is what the abort has to
  // reach, and letting it through before the cancellation is asserted is what
  // would make this pass for the wrong reason: the discovery would finish while
  // the abort was still propagating.
  const settle = () => {
    if (settled) return;
    settled = true;
    gate.settle();
  };
  try {
    // A run in which the discovery request is never sent is a failure of what
    // this test is about, and waiting on the read alone would report it as a
    // suite that never finishes: the wait below is raced, so the regression
    // fails here instead.
    await awaitReached(state, (now) => now.discoveryReads > 0);
  } catch (error) {
    // The wait is what failed, and it is what this case reports: the reads are
    // released so the failure does not also hang the run, and the abort is sent
    // for the same reason. The error itself is rethrown rather than replaced by
    // a promise that answered because the gate was opened.
    controller.abort();
    settle();
    throw error;
  }
  controller.abort();
  try {
    await Promise.race([
      rejected,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("discovery ignored caller cancellation")), WATCHDOG_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // After the assertion, which is about the caller's own promise: the release
    // is what lets the reads that were still arriving finish being served.
    settle();
  }
});

test("partial discovery never restores a model explicitly changed to SystemOne", async (t) => {
  const { plugin, state } = await fixture(t);
  state.omitChat = true;
  const before = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.ok(before["chat-free"]);
  state.catalogStatus = 503;
  state.chatProtocol = "systemone";
  // A second read is asked for outright: the hook's own budget would answer
  // from the list just read, and this case is about what a read that does
  // happen makes of a model the catalogue no longer describes as chat.
  const after = await plugin.refresh();
  assert.equal(after["chat-free"], undefined);
});

// A host that names its conversations gets one Zen session each, whatever the
// two conversations happened to open with. The signal is read first and the
// opening is only a fallback for a host that sends none, so the same "hi" in
// two named conversations is two sessions rather than one — the fold the
// version this replaces was described as making. What is asserted here is the
// contract at the wire, where the id that actually reaches Zen is what matters.
test("two conversations opening the same way keep separate Zen sessions", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const body = JSON.stringify({
    model: "chat-free",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  const ask = async (conversation) => {
    const response = await loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-session-id": conversation },
      body,
    });
    await response.text();
    return lastCall(state).headers["x-opencode-session"];
  };
  const first = await ask("conversation-one");
  const second = await ask("conversation-two");
  assert.ok(first && second, "both requests have to reach upstream");
  assert.notEqual(first, second, "the same opening is not the same conversation");
  // The signal is not passed on as it arrived: x-session-id is in OpenCode's
  // own header set and is never sent (see outboundHeaders), so what separates
  // these two upstream is an id of this plugin's own making.
  assert.notEqual(first, "conversation-one");
});

// The opening that is absent and the opening that is empty are the same fact:
// there is nothing in it to key by. `input: null` is how a Responses host writes
// "no history", and while the seed guard read only the empty string and the
// missing field, every such body keyed one shared session — two unrelated
// conversations with its affinity and quota between them. Each one is now given
// an id of its own, as any body with no opening is.
test("two bodies that open with nothing keep separate Zen sessions", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const ask = async () => {
    const response = await loader.fetch(`${origin}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "responses-free", input: null, stream: true }),
    });
    await response.body?.cancel();
    return lastCall(state).headers["x-opencode-session"];
  };
  const first = await ask();
  const second = await ask();
  assert.ok(first && second, "both requests have to reach upstream");
  assert.notEqual(first, second, "no opening is no key to share");
});

// A cold instance, two requests for a model it has never heard of, arriving
// together. Each of them found a list that did not have the model and asked for
// a new one, so both read the listing, the catalogue and the docs — six reads
// for one answer — and then raced to write `known`, `metadata` and `protocols`,
// so which of the two survived was whichever settled last.
//
// The round is held at the fixture's gate, and the second request is sent while
// it is held: `listedAt` cannot move until the reads finish, so neither request
// can skip the gate, and the counts below are about two requests that really
// are racing rather than about which one a loopback happened to serve first.
test("two concurrent unknown-model requests share one round of discovery", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  const loader = await plugin.auth.loader(publicAuth);
  const gate = holdDiscovery(state);
  const ask = (question) =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", stream: true, messages: [{ role: "user", content: question }] }),
    });
  const sent = [ask("a"), ask("b")];
  try {
    // Both inference requests have arrived, so both have taken their turn at the
    // gate: the round they joined read three times, and no fourth read was sent
    // by the second one.
    await awaitReached(state, (now) => now.discoveryReads === 3);
  } finally {
    // Released on the failing path too: the two requests are waiting on this
    // gate, and a case that failed while holding it would leave them parked
    // there for the rest of the run instead of reporting what it saw.
    gate.settle();
  }
  const responses = await Promise.all(sent);
  for (const response of responses) await response.text();
  assert.deepEqual(reads(state), { rounds: 1, discovery: 3, inference: 2 });
});

// The models hook has no signal to cancel with, and a host that opens its model
// selector twice while the first answer is still coming is asking a question
// that is already being answered. It waits for that answer instead of starting
// a second round of reads beside it — the two calls are one round of discovery,
// not two. The `undefined` the hook would have to pass to be treated as a
// cancelling caller is not passed at all: `leased` reads it as "no way out".
test("the models hook shares a discovery already in flight", async (t) => {
  const { plugin, state } = await fixture(t);
  const gate = holdDiscovery(state);
  const asked = [
    plugin.provider.models({ models: {} }, { auth: await publicAuth() }),
    plugin.provider.models({ models: {} }, { auth: await publicAuth() }),
  ];
  // One round of three reads for two calls, and the second call is already
  // inside it: no fourth read has been sent beside the round in flight.
  await awaitReached(state, (now) => now.discoveryReads === 3);
  gate.settle();
  const models = await Promise.all(asked);
  for (const answered of models) assert.ok(answered["chat-free"]);
  assert.deepEqual(reads(state), { rounds: 1, discovery: 3, inference: 0 });
  // Nothing to cancel with, so the reads run to completion and are not aborted:
  // the hook has no signal, and `undefined` is never passed on as one.
  assert.equal(state.calls.length, 3);
});

// The hook spends RELIST_AFTER: a host that opens its model chooser twice in a
// minute is served the list read the first time, for the three reads the first
// open cost, instead of a second round beside it. What is offered is still the
// live list — the first call read it — so this costs the host no freshness it
// did not already have.
test("the models hook reads within the RELIST_AFTER budget only once", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  const first = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(first).sort(), ["chat-free", "messages-free", "responses-free"]);
  assert.deepEqual(reads(state), { rounds: 1, discovery: 3, inference: 0 });
  const second = await plugin.provider.models({ models: first }, { auth: await publicAuth() });
  // Still three reads: the second open was answered from the list already read
  // rather than from a second round upstream.
  assert.deepEqual(reads(state), { rounds: 1, discovery: 3, inference: 0 });
  assert.deepEqual(Object.keys(second).sort(), Object.keys(first).sort());
  assert.equal(second["chat-free"].api.url, `${origin}/v1`);
});

test("refresh asks for the listing again, and joins a refresh already in flight", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.deepEqual(reads(state), { rounds: 1, discovery: 3, inference: 0 });
  // The budget would answer from `known`; asked for on purpose, the listing is
  // read again — three more reads for three before.
  await plugin.refresh();
  assert.deepEqual(reads(state), { rounds: 2, discovery: 6, inference: 0 });
  // Two refreshes at once are still one round: the forced read goes through the
  // same single flight, so it is not a way around the coalescing either.
  const gate = holdDiscovery(state);
  const together = [plugin.refresh(), plugin.refresh()];
  await awaitReached(state, (now) => now.discoveryReads === 3);
  gate.settle();
  const answers = await Promise.all(together);
  // The same map, not two equal ones: one round has one result, and both
  // callers are handed that one.
  assert.equal(answers[0], answers[1]);
  assert.deepEqual(reads(state), { rounds: 3, discovery: 9, inference: 0 });
  // And a refresh does not make the request path read again either: the budget
  // it just reset is the same one every path spends.
  const loader = await plugin.auth.loader(publicAuth);
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "chat-free", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  await response.text();
  assert.deepEqual(reads(state), { rounds: 3, discovery: 9, inference: 1 });
});

// A discovery that fails is one answer too, and two callers asking at once get
// that one: the same fallback object, not two reads that failed separately. The
// failed ask sets `listedAt` like a successful one (the contract stated on it),
// so a request that follows within the interval is answered from the last list
// rather than asking again — and the second half of this case is what says the
// budget is really spent by a failure, since a discovery that had not written
// it would read the three again.
test("a failed discovery is shared by concurrent callers and still spends the budget", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  state.modelsStatus = 503;
  const asked = [
    plugin.provider.models({ models: {} }, { auth: await publicAuth() }),
    plugin.provider.models({ models: {} }, { auth: await publicAuth() }),
  ];
  const [first, second] = await Promise.all(asked);
  assert.equal(first[Symbol.for("magpie.fellBack")], true);
  assert.equal(second, first, "one failed read, one answer for both callers");
  assert.deepEqual(reads(state), { rounds: 1, discovery: 3, inference: 0 });
  // The listing was asked for and could not be read, so `listedAt` moved. A
  // request for a model the (unchanged) list does not have asks again only
  // after RELIST_AFTER, and this one is inside it — which is the whole of what
  // this half proves, so it is the discovery reads that are counted: a request
  // answered 404 never reaches upstream.
  const loader = await plugin.auth.loader(publicAuth);
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "gone-free", stream: true }),
  });
  assert.equal(response.status, 404);
  assert.deepEqual(reads(state), { rounds: 1, discovery: 3, inference: 0 });
});

// ---- discovery cache wiring ------------------------------------------------
//
// models.mjs owns the file format (its own cases pin the parse); these cases pin
// what the provider does with it: the cache is the first `known`/`protocols`
// map, a live discovery replaces and remembers it, and a listing failure hands
// the map back with its age beside `magpie.fellBack`. Every case names a
// temporary file through OPENCODE_ZEN_FREE_DISCOVERY_CACHE, so the operator's
// own cache is never read or written.

// The shape buildModels writes and configModels reads: a cache row is a model
// record, not a listing entry, because that is what the previous process kept.
function cachedModel(id) {
  return {
    id,
    providerID: "opencode-zen-free",
    name: "Cached Free",
    api: { id, url: "https://opencode.ai/inference/v1", npm: "@ai-sdk/openai-compatible" },
    limit: { context: 123456, output: 7890 },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    variants: {},
    options: {},
    headers: {},
    status: "active",
    release_date: "",
    free: true,
  };
}

// A fresh directory per case, removed with the test that made it.
function discoveryTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "zenfree-discovery-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Point the provider at this case's file for the length of this case. The value
// is read when `server()` starts, so it has to be set before `fixture()`.
function useCacheFile(t, file) {
  const previous = process.env.OPENCODE_ZEN_FREE_DISCOVERY_CACHE;
  process.env.OPENCODE_ZEN_FREE_DISCOVERY_CACHE = file;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_ZEN_FREE_DISCOVERY_CACHE;
    else process.env.OPENCODE_ZEN_FREE_DISCOVERY_CACHE = previous;
  });
}

// The write after a successful discovery is deliberately not awaited (a disk
// must not delay the answer), so a case that wants to read it waits for it.
async function waitForCache(file) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const cache = await readDiscoveryCache(file);
    if (cache !== undefined) return cache;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}

test("a cold start reads the discovery cache and answers from it without asking the route", async (t) => {
  const file = join(discoveryTempDir(t), "discovery.json");
  const cached = cachedModel("cached-free");
  // Fresh enough that discovery's RELIST_AFTER budget is spent: this is the
  // "restart, previous process read the list a moment ago" shape, and the whole
  // point is that the process answers without a round of upstream reads.
  assert.equal(
    await writeDiscoveryCache(file, {
      models: { "cached-free": cached },
      protocols: { "cached-free": "chat" },
      listedAt: new Date().toISOString(),
    }),
    true,
  );
  useCacheFile(t, file);
  const { plugin, state } = await fixture(t);
  const models = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.deepEqual(
    models["cached-free"],
    cached,
    "the model the cache remembered is not the one the host was offered",
  );
  assert.equal(
    models["muse-spark-1.3-contributor-free"],
    undefined,
    "a retired id only the older shipped table knows is not advertised from the cache start",
  );
  assert.deepEqual(state.calls, [], "a cold start with a fresh cache went to the route");
});

test("a listing failure falls back to the cache, flagged and aged", async (t) => {
  const file = join(discoveryTempDir(t), "discovery.json");
  const cached = cachedModel("cached-free");
  const cachedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  assert.equal(
    await writeDiscoveryCache(file, {
      models: { "cached-free": cached },
      protocols: { "cached-free": "chat" },
      listedAt: cachedAt,
    }),
    true,
  );
  useCacheFile(t, file);
  const { plugin, state } = await fixture(t);
  state.modelsStatus = 503;
  const fallback = await plugin.refresh();
  assert.equal(fallback[Symbol.for("magpie.fellBack")], true, "the answer is not said as a fallback");
  assert.deepEqual(fallback["cached-free"], cached, "the cache row was dropped by the fallback");
  // The age is the cache's own date, within a minute of the two hours it was
  // written back. It is a fact about the map, non-enumerable, so a host that
  // keys models by `Object.keys` or serializes the map does not see it.
  const age = fallback[Symbol.for("magpie.discoveryAgeMs")];
  assert.ok(
    Number.isFinite(age) && age > 2 * 60 * 60 * 1000 - 60_000 && age < 2 * 60 * 60 * 1000 + 60_000,
    `the fallback's age is ${age}`,
  );
  const descriptor = Object.getOwnPropertyDescriptor(fallback, Symbol.for("magpie.discoveryAgeMs"));
  assert.equal(descriptor.enumerable, false, "the age is enumerable");
  assert.equal(Object.keys(fallback).includes("magpie.discoveryAgeMs"), false);
});

test("a missing or invalid discovery cache is no cache, and the bootstrap table stands", async (t) => {
  const dir = discoveryTempDir(t);
  const cases = [
    ["missing", async () => {}],
    [
      "bad JSON",
      async (file) => writeFileSync(file, "{ this is not json", "utf8"),
    ],
    [
      "a foreign version",
      async (file) =>
        writeFileSync(
          file,
          JSON.stringify({
            version: 99,
            models: { "poison-free": cachedModel("poison-free") },
            protocols: { "poison-free": "chat" },
            listedAt: new Date().toISOString(),
          }),
          "utf8",
        ),
    ],
  ];
  const previous = process.env.OPENCODE_ZEN_FREE_DISCOVERY_CACHE;
  let bootstrapKeys;
  try {
    for (const [label, prepare] of cases) {
      const file = join(dir, `${label.replace(/\W+/g, "-")}.json`);
      await prepare(file);
      // Set directly rather than through `useCacheFile`: this case names a file
      // per iteration, and one restore at the end is what leaves the variable
      // where it started.
      process.env.OPENCODE_ZEN_FREE_DISCOVERY_CACHE = file;
      const { plugin, state } = await fixture(t);
      state.modelsStatus = 503;
      const fallback = await plugin.refresh();
      assert.equal(fallback[Symbol.for("magpie.fellBack")], true, `${label}: not a fallback`);
      assert.equal(
        Object.hasOwn(fallback, "poison-free"),
        false,
        `${label}: a cache this build cannot read was used`,
      );
      // With no cache and no successful read there is no age to state: the maps
      // are the bootstrap table, not something remembered from a process.
      assert.equal(
        fallback[Symbol.for("magpie.discoveryAgeMs")],
        undefined,
        `${label}: an age was stated for maps nobody remembered`,
      );
      const keys = Object.keys(fallback).sort();
      if (bootstrapKeys === undefined) {
        bootstrapKeys = keys;
        assert.ok(bootstrapKeys.length > 0, "the bootstrap table is empty");
      } else {
        assert.deepEqual(keys, bootstrapKeys, `${label}: the bootstrap table changed`);
      }
    }
  } finally {
    process.env.OPENCODE_ZEN_FREE_DISCOVERY_CACHE = previous;
  }
});

test("a successful discovery writes the cache for the next process", async (t) => {
  const file = join(discoveryTempDir(t), "discovery.json");
  useCacheFile(t, file);
  const { plugin } = await fixture(t);
  const models = await plugin.refresh();
  const cache = await waitForCache(file);
  assert.ok(cache, "the successful discovery was not remembered");
  // `Object.keys` never yields a symbol, so the fallback flag the map may carry
  // is already outside this list and there is nothing to filter out.
  assert.deepEqual(
    Object.keys(cache.models).sort(),
    Object.keys(models).sort(),
    "the cache holds a different list than the discovery answered with",
  );
  assert.deepEqual(cache.models["chat-free"], models["chat-free"]);
  // The protocol map travels beside the models: the docs table in the fixture
  // names chat-free at the chat endpoint.
  assert.equal(cache.protocols["chat-free"], "chat");
  const age = Date.now() - Date.parse(cache.listedAt);
  assert.ok(Number.isFinite(age) && age >= 0 && age < 60_000, `the cache states an old read: ${age}`);
});

// ---- remote limits snapshot wiring ----------------------------------------
//
// limits.mjs owns the fetch, the parser and the installed Map (its own cases
// pin those). These cases pin the provider's side: the synchronous cache read
// at start-up, the background refresh with its TTL and its failure memory, and
// the diagnostics symbol on the answer. A local HTTP server stands in for
// GitHub in every one of them; the suite guard at the top of this file keeps
// the other cases from reaching the real URL.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await sleep(5);
  }
  assert.fail(`timed out waiting for ${what}`);
}

// A document the real sweep could have written: one or more rows in the shape
// limits-observed.json carries. The parser rounds servedTokens down to 1000, so
// the windows below are the numbers the route would publish.
function snapshotDocument(rows) {
  return `${JSON.stringify({ version: 1, models: rows }, null, 2)}\n`;
}

const snapshotRow = (tokens) => ({
  servedTokens: tokens,
  servedChars: tokens * 4,
  wall: "bracketed",
  at: "2026-10-21",
});

// The remote source, local. Every request is counted so a case can say "one
// fetch" and mean it. The server is closed with the test, connections included,
// so a handler that never answers cannot keep the run open.
async function snapshotOrigin(t, handler) {
  let fetches = 0;
  const server = createServer((req, res) => {
    fetches += 1;
    handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/limits-observed.json`,
    hits: () => fetches,
  };
}

// The local pinned source outranks an installed remote answer in measuredWalls,
// and an installed answer is process-global. A case about the remote removes the
// pin for its length — absence is "nothing named here, use the installed
// answer", while `""` is the operator's "no snapshot at all" and must not let an
// installed map through — and drops the installed map afterwards whether it
// passed or not, so no later case inherits either.
function useInstalledSnapshot(t) {
  const previous = process.env.OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT;
  delete process.env.OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT;
  t.after(() => {
    clearInstalledSnapshot();
    if (previous === undefined) delete process.env.OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT;
    else process.env.OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT = previous;
  });
}

test("a cold start installs the snapshot cache without fetching until the TTL elapses", async (t) => {
  useInstalledSnapshot(t);
  const file = join(discoveryTempDir(t), "remote-limits.json");
  // A fresh cache: its mtime is the answer's age, and the TTL is an hour, so
  // neither start-up nor the first model list may spend a request on it.
  writeFileSync(file, snapshotDocument({ "chat-free": snapshotRow(500_000) }), "utf8");
  const { url, hits } = await snapshotOrigin(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(snapshotDocument({ "chat-free": snapshotRow(700_000) }));
  });
  const { plugin } = await fixture(
    t,
    {},
    {
      limitsSnapshotURL: url,
      limitsSnapshotCachePath: file,
      limitsSnapshotRefreshMs: 3_600_000,
    },
  );
  assert.equal(snapshotState()?.source, "cache", "the cache was not installed at start-up");
  const models = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  // The cache was installed before the bootstrap table was built, so the first
  // list this process answers with already carries the cached window.
  assert.equal(models["chat-free"].limit.context, 500_000, "the cached wall did not reach the list");
  const state = models[Symbol.for("magpie.limitsSnapshot")];
  assert.equal(state.source, "cache");
  assert.equal(state.url, undefined, "a cache file does not record which URL wrote it, so it must not claim the current one");
  assert.ok(state.ageMs >= 0, `the state has no age: ${JSON.stringify(state)}`);
  const descriptor = Object.getOwnPropertyDescriptor(models, Symbol.for("magpie.limitsSnapshot"));
  assert.equal(descriptor.enumerable, false, "the diagnostics symbol is enumerable");
  assert.equal(JSON.stringify(models).includes("magpie.limitsSnapshot"), false);
  await sleep(30);
  assert.equal(hits(), 0, "a cache inside its TTL was fetched again");
});

test("a remote snapshot refresh changes a model's context limit on a later models() call", async (t) => {
  useInstalledSnapshot(t);
  const file = join(discoveryTempDir(t), "remote-limits.json");
  writeFileSync(file, snapshotDocument({ "chat-free": snapshotRow(500_000) }), "utf8");
  // Older than the TTL, so start-up is the moment the process asks again.
  const old = new Date(Date.now() - 2 * 3_600_000);
  utimesSync(file, old, old);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { url, hits } = await snapshotOrigin(t, async (req, res) => {
    await gate;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(snapshotDocument({ "chat-free": snapshotRow(700_000) }));
  });
  const { plugin } = await fixture(
    t,
    {},
    {
      limitsSnapshotURL: url,
      limitsSnapshotCachePath: file,
      limitsSnapshotRefreshMs: 3_600_000,
      limitsSnapshotTimeoutMs: 5_000,
    },
  );
  // The stale cache is the first answer: the refresh is in the air and the list
  // does not wait for it.
  const before = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.equal(before["chat-free"].limit.context, 500_000, "the first answer was not the cache's");
  assert.equal(snapshotState()?.source, "cache");
  release();
  await waitFor(() => snapshotState()?.source === "remote", "the remote snapshot to install");
  // A live listing after the install re-reads measuredWalls(), so the model list
  // that follows carries the remote window.
  const refreshed = await plugin.refresh();
  assert.equal(refreshed["chat-free"].limit.context, 700_000);
  const models = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.equal(models["chat-free"].limit.context, 700_000, "a later list still had the old window");
  assert.equal(models[Symbol.for("magpie.limitsSnapshot")].source, "remote");
  assert.equal(hits(), 1, "the one refresh was fetched more than once");
});

for (const [label, handler, settle] of [
  [
    "404",
    (req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"gone"}');
    },
    50,
  ],
  [
    "bad JSON",
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{ this is not a snapshot");
    },
    50,
  ],
  [
    "timeout",
    () => {
      /* never answers: the fetch's own deadline ends it */
    },
    250,
  ],
]) {
  test(`a failed remote refresh (${label}) keeps the cache and the model list works`, async (t) => {
    useInstalledSnapshot(t);
    const file = join(discoveryTempDir(t), "remote-limits.json");
    writeFileSync(file, snapshotDocument({ "chat-free": snapshotRow(500_000) }), "utf8");
    const old = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(file, old, old);
    const { url, hits } = await snapshotOrigin(t, handler);
    const { plugin } = await fixture(
      t,
      {},
      {
        limitsSnapshotURL: url,
        limitsSnapshotCachePath: file,
        limitsSnapshotRefreshMs: 3_600_000,
        limitsSnapshotTimeoutMs: 100,
      },
    );
    await waitFor(() => hits() === 1, `the ${label} refresh to be attempted`);
    await sleep(settle);
    // The failure did not replace the cache and did not fall back to the
    // bundled table: the cache is still the answer, and the last attempt is
    // remembered so the next model list does not retry it.
    assert.equal(snapshotState()?.source, "cache", `${label}: the cache was lost`);
    const models = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
    assert.equal(models["chat-free"].limit.context, 500_000, `${label}: the cached wall was lost`);
    assert.ok(Object.keys(models).length > 0, `${label}: the model list is empty`);
    assert.equal(snapshotState()?.source, "cache");
    await sleep(30);
    assert.equal(hits(), 1, `${label}: the failure was retried on a model-list call`);
  });
}

test("the snapshot TTL allows one fetch across repeated model-list calls", async (t) => {
  useInstalledSnapshot(t);
  const { url, hits } = await snapshotOrigin(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(snapshotDocument({ "chat-free": snapshotRow(600_000) }));
  });
  const { plugin } = await fixture(
    t,
    {},
    {
      limitsSnapshotURL: url,
      // No cache: this case is about the TTL, not the file.
      limitsSnapshotCachePath: "",
      limitsSnapshotRefreshMs: 3_600_000,
      limitsSnapshotTimeoutMs: 5_000,
    },
  );
  await waitFor(() => snapshotState()?.source === "remote", "the first remote snapshot");
  assert.equal(hits(), 1);
  for (let call = 0; call < 3; call += 1)
    await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.equal(hits(), 1, "a fetch inside the TTL was repeated");
});

test("a null snapshot URL and a local pinned snapshot both leave the remote unread", async (t) => {
  useInstalledSnapshot(t);
  const dir = discoveryTempDir(t);
  const { url, hits } = await snapshotOrigin(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(snapshotDocument({ "chat-free": snapshotRow(900_000) }));
  });
  // A cache file that would be read were the URL not disabled. With a null URL
  // there is no cache read at all, so it must not reach the list either.
  const cache = join(dir, "unused-cache.json");
  writeFileSync(cache, snapshotDocument({ "chat-free": snapshotRow(500_000) }), "utf8");
  const off = await fixture(
    t,
    {},
    {
      limitsSnapshotURL: null,
      limitsSnapshotCachePath: cache,
      limitsSnapshotRefreshMs: 1,
      limitsSnapshotTimeoutMs: 100,
    },
  );
  assert.equal(snapshotState(), undefined, "a disabled snapshot installed something");
  const offModels = await off.plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.equal(offModels["chat-free"].limit.context, 200_000, "the cache was read with the remote off");
  assert.equal(hits(), 0, "a disabled snapshot was fetched");

  // The local pinned source is the other way the remote is off: with a snapshot
  // path pinned, limitsSnapshotURL answers no URL, so there is no cache read and
  // no fetch — and measuredWalls() reads the pinned file instead.
  const local = join(dir, "pinned-limits.json");
  writeFileSync(local, snapshotDocument({ "chat-free": snapshotRow(400_000) }), "utf8");
  const previousURL = process.env.OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_URL;
  const previousPinned = process.env.OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT;
  delete process.env.OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_URL;
  process.env.OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT = local;
  try {
    const pinned = await fixture(t);
    assert.equal(snapshotState(), undefined, "a pinned local source still installed a remote answer");
    const pinnedModels = await pinned.plugin.provider.models({ models: {} }, { auth: await publicAuth() });
    assert.equal(pinnedModels["chat-free"].limit.context, 400_000, "the pinned file was not the source");
  } finally {
    if (previousURL === undefined) delete process.env.OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_URL;
    else process.env.OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_URL = previousURL;
    if (previousPinned === undefined) delete process.env.OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT;
    else process.env.OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT = previousPinned;
  }
  assert.equal(hits(), 0, "the pinned local source was fetched");
});

test("a slow remote snapshot does not delay the model list", async (t) => {
  useInstalledSnapshot(t);
  const { url, hits } = await snapshotOrigin(t, () => {
    /* never answers: the fetch may hang for the length of this case */
  });
  const { plugin } = await fixture(
    t,
    {},
    {
      limitsSnapshotURL: url,
      limitsSnapshotCachePath: "",
      limitsSnapshotRefreshMs: 3_600_000,
      limitsSnapshotTimeoutMs: 5_000,
    },
  );
  const started = Date.now();
  const models = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const elapsed = Date.now() - started;
  assert.ok(Object.keys(models).length > 0, "the model list is empty");
  assert.ok(elapsed < 1_000, `the model list waited ${elapsed}ms on the snapshot`);
  assert.equal(hits(), 1, "the startup refresh was not started");
  assert.equal(snapshotState(), undefined, "a hanging fetch installed something");
});

test("registers without overwriting user config and enables public access without a secret", async (t) => {
  const { plugin } = await fixture(t);
  const cfg = {};
  await plugin.config(cfg);
  assert.equal(cfg.provider["opencode-zen-free"].name, "OpenCode Zen Free");
  cfg.provider["opencode-zen-free"].name = "My name";
  await plugin.config(cfg);
  assert.equal(cfg.provider["opencode-zen-free"].name, "My name");
  assert.deepEqual(await plugin.auth.methods[0].authorize(), { type: "success", key: "public" });
  assert.deepEqual(await plugin.auth.loader(async () => undefined), {});
  await assert.rejects(
    plugin.auth.loader(async () => ({ type: "api", key: "paid-secret" })),
    /public/i,
  );
  assert.deepEqual((await plugin.auth.usage(publicAuth)).windows, []);
});

test("discovers protocols and free models, caches success, marks failed refresh as fallback", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  const provider = { models: {} };
  const models = await plugin.provider.models(provider, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(models).sort(), ["chat-free", "messages-free", "responses-free"]);
  assert.equal(models["responses-free"].api.npm, "@ai-sdk/openai");
  assert.equal(models["messages-free"].api.npm, "@ai-sdk/anthropic");
  assert.equal(models["chat-free"].api.url, `${origin}/v1`);
  state.modelsStatus = 503;
  // `refresh()`, not a second `models()`: the hook spends the RELIST_AFTER
  // budget now, and a test that wants the listing read again has to ask for it
  // rather than get it by accident. What is being tested here — a failed read
  // coming back as the last list, said as fallen back — is unchanged.
  const fallback = await plugin.refresh();
  assert.equal(fallback[Symbol.for("magpie.fellBack")], true);
  assert.deepEqual(Object.keys(fallback).sort(), Object.keys(models).sort());
});

// A catalogue row the catalogue itself could not fill in — `null` is what it
// writes — must not be read as a description of the model. Read by truthiness
// it was not: `!null` is true, so the row answered "the catalogue says nothing
// about this id", while a row that is truthy but is not an object at all (`[]`,
// `"junk"`, `7`) answered the opposite — "the catalogue describes this" — for a
// row that describes nothing. models.mjs reads a row as a description only when
// it is an object; this is the same rule on the reading side of discovery.
//
// The shape below is the one that reaches the reading: a model the catalogue
// described as free last time (`cost` of zero is what `isFree` reads, and it is
// what puts the model in `known`), whose row is now one the catalogue could not
// fill in, on a partial discovery. Read as "not described" the row means the
// same as no row and the verified model is kept; read as "described" it is
// dropped. `late-free` is the control: its row is still a description, so it is
// kept by the listing itself rather than by the preservation above.
for (const blankRow of [null, [], "junk", 7]) {
  test(`a catalog row that is not a description does not drop a verified model (${JSON.stringify(blankRow)})`, async (t) => {
    const { plugin, state } = await fixture(t);
    state.ids = ["dirty", "late-free"];
    state.catalogRows = { dirty: { cost: { input: 0, output: 0 }, provider: { npm: "@ai-sdk/openai-compatible" } } };
    // First read: the catalogue describes `dirty` as a free model, which is what
    // puts it in `known` and brings it back to life below.
    const first = await plugin.refresh();
    assert.ok(first["dirty"], "the catalogue's own free row is what makes this id known");
    assert.ok(first["late-free"]);
    // The row becomes one the catalogue could not fill in, and the docs go out
    // of reach so this round is partial and the reader runs.
    state.catalogRows = { dirty: blankRow };
    state.docsStatus = 503;
    const second = await plugin.refresh();
    assert.ok(
      second["dirty"],
      `a row that describes nothing is not a description (${JSON.stringify(blankRow)})`,
    );
    assert.deepEqual(Object.keys(second).sort(), ["dirty", "late-free"]);
    // Not said as fallen back: Zen's own list was read, and a partial catalogue
    // must not make a host keep an older list instead of this one.
    assert.equal(second[Symbol.for("magpie.fellBack")], undefined);
  });
}

// An id is upstream's word, and upstream's word may be a name the prototype
// already has. `known`, `protocols`, `discovered` and the catalogue's map are
// plain objects, so `protocols["toString"]` is not "nothing" — it is
// `Object.prototype.toString`, read through the chain — and `!protocols[id]`
// was false for it, so the entry was skipped for a model no catalogue ever
// described. `Object.hasOwn` is the rule models.mjs and limits.mjs read their
// maps by, and it is what the entry is decided by here now.
//
// The id carries no `-free` suffix on purpose: `isFree` reads a `-free` name as
// free however the catalogue describes it, so a `-free` id is resolved without
// the catalogue and the loop never decides anything about it. The catalogue
// describes this one as free in the round above (a `cost` of zero is what
// `isFree` reads) and describes nothing in the read below, which is the shape
// that leaves the entry to this loop.
test("a prototype member name is an id like any other in the preservation path", async (t) => {
  const { plugin, state } = await fixture(t);
  state.ids = ["toString", "__proto__"];
  state.catalogRows = { toString: { cost: { input: 0, output: 0 } } };
  const first = await plugin.refresh();
  assert.ok(Object.hasOwn(first, "toString"), "the catalogue's own free row makes it a known model");
  // Read as an own property, not as a key: `first["__proto__"]` is the getter
  // that answers the map's prototype, which is not a model and never was.
  assert.equal(Object.hasOwn(first, "__proto__"), false, "no catalogue ever described it");
  // The row becomes one that describes nothing, and the docs go out of reach so
  // this round is partial and the loop runs.
  state.catalogRows = { toString: [] };
  state.docsStatus = 503;
  const second = await plugin.refresh();
  assert.ok(
    Object.hasOwn(second, "toString"),
    "a verified model must not be dropped because its id names something on Object.prototype",
  );
  // The map is the plugin's own: `__proto__` is not an entry, and an id from
  // upstream must not have moved the map's prototype. That is the whole of what
  // a `map["__proto__"] = model` write would do — the entry would not be stored,
  // and the model would be the map's prototype instead.
  assert.deepEqual(Object.keys(second), ["toString"]);
  assert.equal(Object.getPrototypeOf(second), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
});

test("partial catalog failure retains previously verified models rather than dropping them", async (t) => {
  const { plugin, state } = await fixture(t);
  // The model this case is about is one only the catalogue describes as free,
  // and one the snapshot does not know: a `-free` id (like the fixture's own
  // three) is resolved without the catalogue, so keeping it through a partial
  // read proves nothing about the preservation branch. `verified` is in the
  // listing, was made free by its catalogue row, and is not in the bootstrap
  // snapshot — with the branch gone it is not in the second answer at all.
  state.ids = ["verified", "chat-free"];
  state.catalogRows = {
    verified: { cost: { input: 0, output: 0 }, provider: { npm: "@ai-sdk/openai-compatible" } },
  };
  const models = await plugin.refresh();
  assert.ok(models["verified"], "the catalogue's own free row is what makes this id known");
  assert.ok(models["chat-free"]);
  // The second round is partial: the docs are out of reach, and the catalogue
  // answers but no longer describes `verified` — the row that made it free is
  // gone, which is the shape the preservation branch is for (a catalogue row
  // that cannot be read says nothing about the model, so the model verified
  // last round must not silently disappear). The catalogue staying reachable
  // matters: with it unreachable, `metadata` keeps the row the first round
  // read and `buildModels` would produce `verified` without the branch, which
  // is how this case passed while the branch was dead.
  state.catalogRows = {};
  state.docsStatus = 503;
  // `refresh()`, not a second `models()`: the hook spends the RELIST_AFTER
  // budget now, so a second call inside that minute is answered from the cache
  // — the 503 below would never be read, and the whole preserve-on-a-partial-
  // read branch this case exists for would not run. A case that asks through
  // the hook therefore pins the cached list, not the branch.
  const partial = await plugin.refresh();
  assert.deepEqual(Object.keys(partial).sort(), ["chat-free", "verified"]);
  // The second round really read the failing catalogue and docs: two discovery
  // rounds, one per ask. Read from the cache this count is 1, which is the bug
  // the second `models()` call used to hide in.
  assert.deepEqual(reads(state), { rounds: 2, discovery: 6, inference: 0 });
  // and it is not said as fallen back: Zen's own list was read, and a host that
  // cannot reach the catalogue or the docs must still see what that list says
  assert.equal(partial[Symbol.for("magpie.fellBack")], undefined);
});

// The reporter of yetone/magpie#2305 saw only the three models the plugin
// knew offline: the catalog and the docs out of reach dropped every listed
// free model they didn't name. The coverage the other tests here cannot see,
// because theirs all name synthetic ids the fixture catalog supplies — these
// are the real ones only bootstrapProvider covers. A listed free model now
// takes its endpoint from the snapshot of OpenCode's console docs; Jev is a
// SystemOne decision model and stays out, and a paid one is not offered.
test("listed free models are offered when the catalog and the docs can't be read", async (t) => {
  const { plugin, state } = await fixture(t);
  state.catalogStatus = 503;
  state.docsStatus = 404;
  state.ids = ["big-pickle", "step-5-preview-free", "cat-jam-free", "jev-1.13-free", "paid"];
  const models = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(models).sort(), ["big-pickle", "cat-jam-free", "step-5-preview-free"]);
  assert.equal(models["step-5-preview-free"].api.npm, "@ai-sdk/openai-compatible");
  assert.equal(models["step-5-preview-free"].name, "Step 5 Preview Free");
  assert.equal(models["step-5-preview-free"].limit.context, 1000000);
  // offered, not said as fallen back: the listing was read, so a host that can't
  // reach the catalogue or the docs still gets every model Zen lists (#2385)
  assert.equal(models[Symbol.for("magpie.fellBack")], undefined);
});

// The floor is not a rival to the docs: what they name wins, and only what
// they no longer name falls back to the snapshot. The snapshot calls Muse
// Spark a Responses model; the docs calling it Anthropic is what is sent.
test("the console docs' table wins over the bootstrap snapshot", async (t) => {
  const { plugin, state } = await fixture(t);
  state.ids = ["cat-jam-free", "muse-spark-1.3-contributor-free"];
  state.docsText =
    "| Muse Spark 1.3 Contributor Free | muse-spark-1.3-contributor-free | `https://opencode.ai/inference/v1/messages` | `@ai-sdk/anthropic` |";
  const models = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.equal(models["muse-spark-1.3-contributor-free"].api.npm, "@ai-sdk/anthropic");
  assert.equal(models["cat-jam-free"].api.npm, "@ai-sdk/openai-compatible");
});

test("forces upstream streaming, preserves existing tools and returns the SSE body unbuffered", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const bash = {
    type: "function",
    function: {
      name: "bash",
      description: "real bash",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    },
  };
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer client-key",
      "x-session-id": "session_123",
      "content-length": "1",
    },
    body: JSON.stringify({
      model: "chat-free",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
      tools: [bash],
    }),
  });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.match(await response.text(), /\[DONE\]/);
  const sent = lastCall(state);
  assert.equal(sent.headers.authorization, "Bearer public");
  assert.match(sent.headers["x-opencode-session"], /^ses_[0-9a-f]{9}ff[0-9a-f][0-9A-Za-z]{14}$/);
  // OpenCode sends neither to its own gateway; a caller's never goes on.
  assert.equal(sent.headers["x-session-affinity"], undefined);
  assert.equal(sent.headers["x-session-id"], undefined);
  assert.equal(sent.headers["x-opencode-session-id"], sent.headers["x-opencode-session"]);
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.stream_options.include_usage, true);
  assert.deepEqual(sent.body.tools[0].function.parameters, bash.function.parameters);
  // The host's tool keeps its own wording and parameters; only its name moves
  // under the clint_ prefix so it cannot collide with the official set.
  assert.equal(sent.body.tools[0].function.name, "clint_bash");
  assert.equal(sent.body.tools[0].function.description, "real bash");
  assert.deepEqual(sent.body.tools.map((tool) => tool.function.name), [
    "clint_bash",
    ...officialToolNames("2.x"),
  ]);
});

// Zen's free tier reads the system prompt in the body as well as the headers
// and tools. A host that is not OpenCode has no reason to carry OpenCode's
// prompt, so the request path puts it in front of whatever the host wrote.
// Each protocol keeps its system text in a different field, and the test reads
// the one the protocol actually sends.
test("a host's request carries the official prompt in its protocol's field", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  for (const { protocol, path, model } of protocols) {
    const body = { model, stream: false };
    if (protocol === "chat") body.messages = [{ role: "user", content: "hi" }];
    if (protocol === "anthropic") {
      body.messages = [{ role: "user", content: "hi" }];
      body.max_tokens = 16;
    }
    if (protocol === "responses") body.input = "hi";
    const response = await loader.fetch(`${origin}/v1/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    await response.text();
    const sent = lastCall(state).body;
    const prompt =
      protocol === "chat"
        ? sent.messages[0].content
        : protocol === "anthropic"
          ? sent.system
          : sent.instructions;
    if (protocol === "chat") assert.equal(sent.messages[0].role, "system");
    assert.equal(typeof prompt, "string", `${protocol} carries a prompt`);
    assert.ok(prompt.startsWith(OPENCODE_PROMPT_MARKER_V2), `${protocol} prompt starts as OpenCode's`);
    // The model section names the model this request is actually for, not
    // a package default: the model that answers is the one the body names.
    assert.match(prompt, new RegExp(`- Name: .+\\n- Provider ID: opencode\\n- Model ID: ${model}`));
    // No skill listing rides with the prompt: a host that is not OpenCode has
    // none of OpenCode's built-in skills, and the one 0.5.4 advertised was
    // called by a model that read it (2026-10-25, DeepSeek Harness).
    assert.doesNotMatch(prompt, /<available_skills>/);
    // The availability note follows the official prompt: the truth about which
    // tools this host runs, before the host's own instructions (0.5.7 taught
    // Code Mode and the model called execute and shell to two unknown-tool
    // errors before finding the clint_ names).
    assert.match(prompt, /Code Mode is not active in this session/);
    // These bodies declare no tools of their own, so the note says so rather
    // than naming built-ins nothing here runs.
    assert.match(prompt, /This host implements no tools at all/);
    assert.ok(prompt.endsWith("</system-reminder>"));
    assert.equal(
      prompt.split(OPENCODE_PROMPT_MARKER_V2).length - 1,
      1,
      `${protocol} prompt is there once`,
    );
    // The rest of the request is still the request that was made.
    assert.equal(sent.model, model);
    assert.equal(sent.stream, true);
  }
});

test("the host's own system instructions follow the official prompt", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({
      model: "chat-free",
      messages: [
        { role: "system", content: "Host rule." },
        { role: "user", content: "hi" },
        { role: "developer", content: "Second rule." },
      ],
    }),
  });
  await response.text();
  const messages = lastCall(state).body.messages;
  assert.deepEqual(
    messages.map((message) => message.role),
    ["system", "user"],
    "system and developer text fold into the one leading message",
  );
  assert.ok(messages[0].content.startsWith(OPENCODE_PROMPT_MARKER_V2));
  assert.ok(messages[0].content.endsWith("\n\nHost rule.\nSecond rule."));
  assert.equal(messages[1].content, "hi");
});

test("a body that already carries the official prompt is not shaped twice", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const own = `${OPENCODE_PROMPT_MARKER} and a host's own continuation`;
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({
      model: "chat-free",
      messages: [
        { role: "system", content: own },
        { role: "user", content: "hi" },
      ],
    }),
  });
  await response.text();
  const messages = lastCall(state).body.messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, own, "the host's prompt is left as it was sent");
  assert.equal(messages[0].content.split(OPENCODE_PROMPT_MARKER).length - 1, 1);
});

test("collapses SSE for a non-streaming client and preserves upstream HTTP errors", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const send = () =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hello" }] }),
    });
  const response = await send();
  assert.equal((await response.json()).choices[0].message.content, "hello");
  state.status = 429;
  const error = await send();
  assert.equal(error.status, 429);
  assert.equal(error.headers.get("retry-after"), "30");
  assert.equal((await error.json()).error.message, "limited");
});

// The tier ledgers its free quota per project id and egress together, so a spent
// bucket is not a spent exit: measured 2026-10-26, the same exit answered 429 to
// one project id and 200 to a fresh random one, twice. A host ends the whole
// turn on a 429 and calls the quota exhausted, so the plugin asks again with a
// ledger nothing has spent before it hands that 429 on.
test("a 429 is retried with a fresh project id, and the retry's answer is the turn", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  // The first answer is the rate limit; the second is the turn.
  state.statuses = [429, 200];
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(response.status, 200, "the retry's answer is the one the caller gets");
  assert.equal((await response.json()).choices[0].message.content, "hello");
  const inference = state.calls.filter((call) => call.url === "/v1/chat/completions");
  assert.equal(inference.length, 2, "the refused attempt and the retry, and no third");
  const [first, second] = inference;
  assert.notEqual(
    first.headers["x-opencode-project"],
    second.headers["x-opencode-project"],
    "the retry asks under a project id the spent bucket does not cover",
  );
  assert.match(
    second.headers["x-opencode-project"],
    /^[0-9a-f]{40}$/,
    "and that id is in the git-hash shape the CLI sends",
  );
  // The body is the same body: a retry is the same request under a new ledger,
  // not a re-shaped one.
  assert.equal(second.raw, first.raw, "the retry sends the bytes the first attempt sent");
});

// A host that names its own project keeps that name on every attempt. The name
// is the host's statement about itself, and re-minting it to dodge a limit would
// be this package answering a question the host was asked.
test("a retry keeps a project id the host named itself", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.statuses = [429, 200];
  await (
    await loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-opencode-project": "host-named-project" },
      body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hello" }] }),
    })
  ).text();
  const inference = state.calls.filter((call) => call.url === "/v1/chat/completions");
  assert.equal(inference.length, 2);
  for (const call of inference)
    assert.equal(call.headers["x-opencode-project"], "host-named-project");
});

// Under `OPENCODE_ZEN_FREE_SESSION_AFFINITY=1` the first attempt of a request
// carries the session the conversation is keyed to, and only a retry mints a
// new one. The first attempt was told apart by `attempts === 0`, but the counter
// moved before the headers were built, so the branch never matched: the id
// `sessionID()` chose was thrown away and a retry re-minted a session nothing
// had spent.
test("an affinity session is kept on the first attempt and only a retry mints a new one", async (t) => {
  const held = process.env.OPENCODE_ZEN_FREE_SESSION_AFFINITY;
  process.env.OPENCODE_ZEN_FREE_SESSION_AFFINITY = "1";
  t.after(() => {
    if (held === undefined) delete process.env.OPENCODE_ZEN_FREE_SESSION_AFFINITY;
    else process.env.OPENCODE_ZEN_FREE_SESSION_AFFINITY = held;
  });
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const send = () =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-session-id": "affinity-conversation" },
      body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hello" }] }),
    });
  await (await send()).text();
  await (await send()).text();
  const inference = state.calls.filter((call) => call.url === "/v1/chat/completions");
  assert.equal(inference.length, 2);
  assert.equal(
    inference[0].headers["x-opencode-session"],
    inference[1].headers["x-opencode-session"],
    "two turns of one conversation share the session affinity keeps for it",
  );
  // The retry is the one attempt that must not reuse it: the tier files what it
  // thinks of this traffic against the session, and the refused one is spent.
  state.statuses = [429, 200];
  const retried = await send();
  assert.equal(retried.status, 200);
  await retried.text();
  const [first, retry] = state.calls.filter((call) => call.url === "/v1/chat/completions").slice(-2);
  assert.equal(
    first.headers["x-opencode-session"],
    inference[0].headers["x-opencode-session"],
    "the retried request's first attempt still opens under the conversation's session",
  );
  assert.notEqual(
    retry.headers["x-opencode-session"],
    first.headers["x-opencode-session"],
    "the retry asks under a session nothing has spent",
  );
});

// A 429 whose body names abuse of the egress is a block, and no project id
// answers a block. Retrying one would spend the caller's patience and the
// route's budget to arrive at the same refusal.
test("a 429 that names egress abuse is not retried", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.status = 429;
  state.body = JSON.stringify({
    error: { message: "free models aren't available from your current network" },
  });
  const refused = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(refused.status, 429);
  await refused.text();
  const inference = state.calls.filter((call) => call.url === "/v1/chat/completions");
  assert.equal(inference.length, 1, "a blocked exit is not asked again");
});

// The retry is opt-out, and the switch is read per request so an operator
// reaches for it exactly when a quota problem happens.
test("the 429 retry can be turned off", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  const held = process.env.OPENCODE_ZEN_FREE_RETRY_429;
  process.env.OPENCODE_ZEN_FREE_RETRY_429 = "0";
  t.after(() => {
    if (held === undefined) delete process.env.OPENCODE_ZEN_FREE_RETRY_429;
    else process.env.OPENCODE_ZEN_FREE_RETRY_429 = held;
  });
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.status = 429;
  const refused = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(refused.status, 429, "with the retry off the 429 is handed on as before");
  await refused.text();
  const inference = state.calls.filter((call) => call.url === "/v1/chat/completions");
  assert.equal(inference.length, 1);
});

// The defaults are what a host with nothing behind a 429 wants: two retries,
// a short wait, and the refusal soon after. A deployment that does have
// something behind one — something only a longer wait can reach — needs the
// wait to reach it, and that number
// belongs to the deployment. Both the first wait and the ceiling are settable,
// and neither default moves for everyone else.
test("the retry wait and its ceiling are settable, and the defaults stay short", async () => {
  const { retryWaitMs, retryWaitCeilingMs, retry429Count } = await import("./provider.mjs");
  // Defaults: unchanged, and short enough that a plain host is not parked.
  assert.equal(retry429Count(undefined), 2);
  assert.equal(retryWaitMs(undefined), 1200);
  assert.equal(retryWaitCeilingMs(undefined), 5000);
  // A deployment with a longer wait to spend says so, and gets waits that reach it.
  assert.equal(retryWaitMs("5000"), 5000);
  assert.equal(retryWaitCeilingMs("30000"), 30000);
  // The ceiling never falls below the first wait, whatever the two variables say
  // relative to each other — otherwise the second wait would be shorter than the
  // first and the backoff would not be one.
  const held = process.env.OPENCODE_ZEN_FREE_RETRY_WAIT_MS;
  process.env.OPENCODE_ZEN_FREE_RETRY_WAIT_MS = "20000";
  try {
    assert.ok(
      retryWaitCeilingMs("1000") >= 20000,
      "a ceiling below the first wait was allowed to shorten the backoff",
    );
  } finally {
    if (held === undefined) delete process.env.OPENCODE_ZEN_FREE_RETRY_WAIT_MS;
    else process.env.OPENCODE_ZEN_FREE_RETRY_WAIT_MS = held;
  }
  // Out-of-range values fall back rather than reaching the timer.
  assert.equal(retryWaitMs("999999999"), 1200);
  assert.equal(retryWaitCeilingMs("999999999"), 5000);
});

// A request that never gets an answer is a different failure from a refusal, and
// it used to end the turn: a fetch that throws produces no Response, so the 429
// branch never saw it and the exception went straight to the host, which reports
// it as a quota failure. Measured 2026-10-27, dsh reported
// `429 … QUOTA` for `dial tcp 127.0.0.1:1: connection refused` — a request
// that never left the machine, and a turn lost to a path that came back four
// seconds later. What is pinned here is that the loop spends its retries before
// handing the failure on: the waits alone are longer than the bound below.
test("a connection that never came up is retried before the failure is handed on", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  // The socket dies before any header is written, which surfaces as a thrown
  // `fetch failed` rather than a Response — the shape a proxy mid-restart
  // produces. The fixture's discovery paths still answer, so the model is known
  // and the request is built and sent.
  state.destroyInference = true;
  const started = Date.now();
  await assert.rejects(
    async () =>
      loader.fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: "chat-free",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    /fetch failed|socket|ECONNRESET/i,
  );
  const elapsed = Date.now() - started;
  // Two retries at the defaults are 1200ms and 2400ms of waiting. Anything that
  // came back faster did not spend them.
  assert.ok(
    elapsed >= 3000,
    `the failure came back in ${elapsed}ms, so the retries were not spent`,
  );
});

// A caller's own cancellation is not a failure to retry. It is the one thing the
// caller said about this request, and a retry that ignored it would keep asking
// for a turn that was already given up on.
test("an aborted request is not retried", async (t) => {
  const { plugin, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const control = new AbortController();
  const started = Date.now();
  const call = loader
    .fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }] }),
      signal: control.signal,
    })
    .catch(() => {});
  control.abort(new Error("cancelled by the caller"));
  await call;
  // The first wait is 1200ms by default. An abort that exited the loop shows up
  // as a call that came back well inside one wait.
  assert.ok(
    Date.now() - started < 900,
    "the aborted request waited out a retry pause instead of ending",
  );
});

// Zen accepts a request only when every part of it belongs to one generation of
// OpenCode, and a header belonging to none is enough to lose it. x-session-
// affinity and x-session-id are in OpenCode's own header set upstream but are
// not needed, so the outbound set is pinned by name rather than by comment:
// measured 2026-10-15, either alone answers and the two together are refused
// (#131).
test("sends exactly the headers one generation of OpenCode sends", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }] }),
  });
  const sent = lastCall(state).headers;
  // accept-encoding, connection and content-length are the HTTP stack's, not
  // this plugin's, so what is pinned here is the set the plugin chooses. `host`
  // is left in on purpose: the stack adds it too, but this is the test that says
  // by name which names go out, and it is one of them.
  const chosen = chosenByPlugin(sent, HTTP_STACK_WITHOUT_HOST).sort();
  assert.deepEqual(chosen, [...PLUGIN_HEADERS, "authorization", "host"].sort());
  // x-opencode-request is not needed either: measured 2026-10-15, it answers on
  // its own and it is the pair x-opencode-request + x-session-affinity that is
  // refused, so the set above has to stay a strict subset of what has been seen
  // accepted (#4842 of decolua/9router).
  assert.equal(sent["x-opencode-request"], undefined);
  // The two that upstream sends and this plugin does not, named here so that
  // adding one is a deliberate act rather than an accident.
  assert.equal(sent["x-session-affinity"], undefined);
  assert.equal(sent["x-session-id"], undefined);
  assert.equal(sent["x-opencode-parent-session-id"], undefined);
});

test("presents the 2.x generation whatever the tools say, and a host that names its own", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const send = (tools, headers) =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }], tools }),
    });
  const tool = (name, description) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties: { a: { type: "string" } } } },
  });

  // The 1.x lane is retired (2026-10-25), so the generation a request presents
  // is no longer read out of the tools: every shaped request leaves as 2.x,
  // including one from a host that declares 1.x's own names or carries none of
  // them by name.
  await send();
  assert.match(
    lastCall(state).headers["user-agent"],
    /^opencode\/[a-z-]+\/[1-9][^/]*\/[^/]+$/,
  );

  // A host declaring 2.x tools is answered as 2.x, without a gap being filled.
  await send([tool("shell", "Execute a shell command and return its output."), tool("read", "Read the contents of a file or directory.")]);
  const two = lastCall(state);
  // Derived from the capture, not written out: the 2.x User-Agent is composed
  // from fingerprint.json's own channel/version/client, so a re-capture moves
  // this expectation with the code instead of leaving a literal behind.
  assert.equal(two.headers["user-agent"], agentOf("2.x"));
  assert.deepEqual(
    two.body.tools.map((t) => t.function.name),
    ["clint_shell", "clint_read", ...officialToolNames("2.x")],
  );

  // A host that is OpenCode itself already says which it is; that is above
  // whatever floor Zen is holding, so it is passed on rather than pinned.
  await send(undefined, { "user-agent": "opencode/stable/1.2.3/desktop" });
  assert.equal(lastCall(state).headers["user-agent"], "opencode/stable/1.2.3/desktop");

  // A host on a development build is not something Zen accepts, so its word is
  // not taken.
  await send(undefined, { "user-agent": "opencode/dev/0.0.0-dev-1/cli" });
  assert.match(lastCall(state).headers["user-agent"], /^opencode\/[a-z-]+\/[1-9][^/]*\/[^/]+$/);

  // The pass-through above is not a 2.x privilege: a 1.x host says which it is
  // in its own shape, and pinning that one back to the captured version is how
  // a host newer than Zen's floor ends up being told the plugin is too old.
  const oneX = "opencode/1.20.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";
  await send(undefined, { "user-agent": oneX });
  assert.equal(lastCall(state).headers["user-agent"], oneX);
  // Whatever a host says about itself, it is not its word that decides which
  // generation the body belongs to: no host's does any more, so the 2.x names
  // go out beside its own.
  assert.deepEqual(
    lastCall(state).body.tools.map((tool) => tool.function.name),
    officialToolNames("2.x"),
  );
});

// A host that sent one protocol's tool shape to another's endpoint has still
// declared those tools. Reading the name out of only one shape would fill a
// gap that is not one, and the tool would go out twice (#131).
test("reads a tool's name out of either shape, so nothing is filled twice", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  await loader.fetch(`${origin}/v1/responses`, {
    method: "POST",
    body: JSON.stringify({
      model: "responses-free",
      input: "hi",
      // The chat shape, on the responses endpoint. `shell` is the 2.x `bash`,
      // and the profile carries it, so there is no shape to fall back to.
      tools: [
        { type: "function", function: PROFILES["2.x"].tools.shell },
        { type: "function", function: PROFILES["2.x"].tools.read },
      ],
    }),
  });
  const tools = lastCall(state).body.tools;
  const names = tools.map((tool) => tool.function?.name ?? tool.name);
  // The two declarations supplied in the other shape are still declarations:
  // they are renamed under clint_, not sent a second time by their client name.
  assert.equal(
    tools.length,
    2 + officialToolNames("2.x").length,
    "the host's tools go out once each, followed by the official set",
  );
  assert.deepEqual(names, ["clint_shell", "clint_read", ...officialToolNames("2.x")]);
});

// A chat host may still declare its tools the legacy way, in the top-level
// `functions` array. Those tools are declared — the host has them — so none of
// them may be stood in for, and the same tool must not go out twice (#131).
//
// The declaration goes out in `tools` as well, because `tools` is the array
// Zen reads: a host that declared its tools only the old way sent `tools: []`
// with its real declarations in an array Zen may not read, while the filling
// only ever pushed into `tools`. And the legacy array is dropped, because a
// declaration left in it is a tool sent twice — once with OpenCode's wording
// and once with the host's.
test("a tool declared through the legacy functions array is folded in and renamed once", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({
      model: "chat-free",
      messages: [{ role: "user", content: "hi" }],
      functions: [{ name: "bash", description: "the host's own", parameters: { type: "object", properties: {} } }],
    }),
  });
  const sent = lastCall(state).body;
  const names = sent.tools.map((tool) => tool.function.name);
  // The legacy declaration is one declaration: it goes out under clint_bash
  // once, and the official set that follows it carries no bash at all — its
  // shell is the 2.x name, a different tool from a different lane.
  assert.deepEqual(names, ["clint_bash", ...officialToolNames("2.x")]);
  assert.equal(names.filter((name) => name === "bash").length, 0);
  // The declaration keeps the host's own wording and parameters: it is the tool
  // that will run, and only its wire name moved.
  assert.equal(sent.tools[0].function.description, "the host's own");
  assert.deepEqual(sent.tools[0].function.parameters, { type: "object", properties: {} });
  // The legacy array is gone: left in place it would be a second declaration
  // Zen may not read.
  assert.equal(sent.functions, undefined, "the legacy array does not go out beside `tools`");
});

// The names a request carries are the names Zen reads, whichever array they
// arrived in. A host that declares `shell` the legacy way is the 2.x host it
// says it is: reading the generation from `tools` alone answered the 1.x
// floor — the 1.x stand-in names and the 1.x User-Agent — for a request that
// named a 2.x tool.
test("a legacy declaration counts towards the generation the request is sent as", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({
      model: "chat-free",
      messages: [{ role: "user", content: "hi" }],
      functions: [{ name: "shell", description: "the host's own", parameters: { type: "object", properties: {} } }],
    }),
  });
  const sent = lastCall(state);
  assert.equal(sent.headers["user-agent"], agentOf("2.x"), "the tools say 2.x, so the request is 2.x");
  assert.deepEqual(
    sent.body.tools.map((tool) => tool.function.name),
    ["clint_shell", ...officialToolNames("2.x")],
    "the 1.x stand-in names are not added to a 2.x request",
  );
});

// One tool, declared twice: in `tools` and in the legacy array. It is one
// declaration under two spellings, so it goes out once — in the array Zen
// reads, and with the wording Zen reads.
test("a tool declared in both arrays goes out once", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({
      model: "chat-free",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: { name: "bash", description: "the host's own", parameters: { type: "object", properties: {} } },
        },
      ],
      functions: [{ name: "bash", description: "the host's own", parameters: { type: "object", properties: {} } }],
    }),
  });
  const sent = lastCall(state).body;
  assert.deepEqual(
    sent.tools.map((tool) => tool.function.name),
    ["clint_bash", ...officialToolNames("2.x")],
    "the tool is sent once, not once per array it was declared in",
  );
  assert.equal(sent.functions, undefined);
  assert.equal(sent.tools[0].function.description, "the host's own");
});
// A host that is not OpenCode describes its tools in its own names and words.
// Those tools still run, so their parameters and wording are left alone; they
// go out under clint_ names, and the complete official set is appended after
// them so the request reads as an OpenCode session.
test("renames the host's tools and appends the complete official set", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const send = (tools) =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }], tools }),
    });
  const hostTool = (name, description, properties) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required: Object.keys(properties) } },
  });
  const own = [
    hostTool("bash", "Run a shell command and return what it printed.", { cmd: { type: "string" } }),
    hostTool("read", "Load a file into context.", { path: { type: "string" } }),
    hostTool("glob", "Find files by pattern.", { pattern: { type: "string" } }),
    hostTool("grep", "Search file contents.", { pattern: { type: "string" } }),
    hostTool("write", "Save a file.", { path: { type: "string" }, contents: { type: "string" } }),
  ];

  assert.equal((await send()).status, 200);
  assert.deepEqual(
    lastCall(state).body.tools.map((tool) => tool.function.name),
    officialToolNames("2.x"),
    "a host with no tools gets the official set",
  );

  assert.equal((await send(own)).status, 200);
  const sent = lastCall(state).body.tools;
  const renamed = sent.slice(0, own.length);
  assert.deepEqual(
    renamed.map((tool) => tool.function.name),
    own.map((tool) => `clint_${tool.function.name}`),
    "the host's tools go out once each, under the client prefix",
  );
  for (const [at, tool] of renamed.entries()) {
    assert.equal(tool.function.description, own[at].function.description, "host wording is kept");
    assert.deepEqual(tool.function.parameters, own[at].function.parameters, "host parameters are kept");
  }
  const official = sent.slice(own.length);
  assert.deepEqual(official.map((tool) => tool.function.name), officialToolNames("2.x"));
  for (const tool of official) {
    // The renderer's own output, not the stored text: the shell's wording
    // moves with the platform.
    assert.equal(
      tool.function.description,
      officialTool("chat", tool.function.name, "2.x").function.description,
      `${tool.function.name} carries the official definition`,
    );
    assert.ok(tool.function.parameters);
  }
});

// A host may put a tool in the other protocol's shape. The name is read from
// either, so the declaration is renamed rather than left to collide with the
// official name of the same tool.
test("renames a tool sent in the other shape where its name sits", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({
      model: "chat-free",
      messages: [{ role: "user", content: "hi" }],
      // The responses shape, on the chat endpoint.
      tools: [{ type: "function", name: "bash", description: "Run a command.", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
    }),
  });
  const sent = lastCall(state).body.tools;
  const bash = sent[0];
  // Left in the shape it arrived in, with the name moved where that shape
  // carries it so it cannot be read as the official bash.
  assert.equal(bash.function, undefined);
  assert.equal(bash.name, "clint_bash");
  assert.equal(bash.description, "Run a command.");
  assert.deepEqual(bash.parameters.properties, { cmd: { type: "string" } });
  assert.deepEqual(sent.map((tool) => tool.name ?? tool.function?.name), ["clint_bash", ...officialToolNames("2.x")]);
});

// The appended tools are the official definitions themselves, not placeholders:
// the free tier reads their wording, and a note telling the model not to call
// them was measured to stop it using its own tools too.
test("appends the official definitions without placeholder wording", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const send = (tools) =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }], tools }),
    });

  await send();
  const sent = lastCall(state).body.tools;
  assert.deepEqual(sent.map((tool) => tool.function.name), officialToolNames("2.x"));
  for (const tool of sent) {
    // The renderer's own output, not the stored text: the shell's wording
    // moves with the platform.
    assert.equal(
      tool.function.description,
      officialTool("chat", tool.function.name, "2.x").function.description,
      `${tool.function.name} carries the official definition`,
    );
    assert.doesNotMatch(tool.function.description, /placeholder|do not call it/i);
  }

  // The host's own tool keeps its own wording; the official read beside it is
  // the one that carries OpenCode's.
  const own = { type: "function", function: { name: "read", description: "Load a file.", parameters: { type: "object", properties: { path: { type: "string" } } } } };
  await send([own]);
  const tools = lastCall(state).body.tools;
  const hostRead = tools.find((tool) => tool.function.name === "clint_read");
  const officialRead = tools.find((tool) => tool.function.name === "read");
  assert.equal(hostRead.function.description, "Load a file.");
  assert.ok(officialRead.function.description.startsWith(OFFICIAL_SETS["2.x"].tools.read.description.slice(0, 80)));
});

// The 2.1 Chat client sends a completion ceiling even when its user did not
// ask for one. The value is the client's default, so an explicit limit in
// either spelling still wins, and no other lane grows the field.
test("a 2.x chat request carries the client's completion ceiling unless the caller set one", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const tool = (name) => ({
    type: "function",
    function: {
      name,
      description: `The host's ${name}.`,
      parameters: { type: "object", properties: { command: { type: "string" } } },
    },
  });
  const send = (tools, extra = {}) =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "chat-free",
        messages: [{ role: "user", content: "hi" }],
        tools,
        ...extra,
      }),
    });

  await send([tool("shell")]);
  let sent = lastCall(state).body;
  assert.equal(sent.max_completion_tokens, 32000, "an omitted ceiling is filled");
  assert.equal(sent.max_tokens, undefined, "the filled field is the one 2.x writes");

  await send([tool("shell")], { max_tokens: 123 });
  sent = lastCall(state).body;
  assert.equal(sent.max_tokens, 123);
  assert.equal(sent.max_completion_tokens, undefined, "an explicit max_tokens is not overridden");

  await send([tool("shell")], { max_completion_tokens: 456 });
  sent = lastCall(state).body;
  assert.equal(sent.max_completion_tokens, 456);
  assert.equal(sent.max_tokens, undefined);

  // A host that declares bash used to travel the 1.x lane, which writes
  // neither field; that lane is retired (2026-10-25), so its ceiling is the
  // 2.x one like everyone else's.
  await send([tool("bash")]);
  sent = lastCall(state).body;
  assert.equal(sent.max_completion_tokens, 32000);
  assert.equal(sent.max_tokens, undefined);

  // And the field belongs to Chat: a 2.x Responses request does not grow it.
  await loader.fetch(`${origin}/v1/responses`, {
    method: "POST",
    body: JSON.stringify({
      model: "responses-free",
      input: "hi",
      tools: [{ type: "function", name: "shell", description: "Run a command.", parameters: { type: "object" } }],
    }),
  });
  assert.equal(lastCall(state).body.max_completion_tokens, undefined);
});

test("a 2.x chat request marks every tool strict:false, and 1.x marks none", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const tool = (name, strict) => {
    const fn = {
      name,
      description: `The host's ${name}.`,
      parameters: { type: "object", properties: {} },
    };
    if (strict !== undefined) fn.strict = strict;
    return { type: "function", function: fn };
  };
  const send = (tools) =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }], tools }),
    });

  await send([tool("shell", undefined), tool("read", true)]);
  const two = lastCall(state).body.tools;
  assert.equal(two[0].function.name, "clint_shell");
  assert.equal(two[0].function.strict, false, "an omitted strict is filled");
  assert.equal(two[1].function.name, "clint_read");
  assert.equal(two[1].function.strict, true, "a stated strict is kept");
  for (const entry of two.slice(2)) {
    assert.equal(entry.function.strict, false, `${entry.function.name} carries strict:false`);
  }

  await send([tool("bash", undefined)]);
  const one = lastCall(state).body.tools;
  for (const entry of one) {
    // The 1.x lane — which wrote no strict — is retired (2026-10-25), so a
    // bash-declaring host travels the 2.x lane and its strict marking too.
    assert.equal(entry.function.strict, false, `${entry.function.name} carries strict:false`);
  }
});

test("a 2.x chat body writes the client's key order", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  // The host's own order is deliberately unlike the client's: the shaping
  // reorders the body it sends, not the body it received.
  const body = JSON.stringify({
    user: "conversation-a",
    temperature: 0.2,
    tools: [
      {
        type: "function",
        function: {
          name: "shell",
          description: "Run a command.",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    stream: false,
    messages: [{ role: "user", content: "hi" }],
    model: "chat-free",
  });
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body,
  });
  await response.text();
  const sent = lastCall(state);
  assert.deepEqual(Object.keys(JSON.parse(sent.raw)), [
    "model",
    "messages",
    "tools",
    "stream",
    "stream_options",
    "max_completion_tokens",
    "temperature",
    "user",
  ]);
  assert.deepEqual(JSON.parse(sent.raw), sent.body);
});

test("a refusal names the prompt and tools to update rather than the headers", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.status = 403;
  state.body = JSON.stringify({
    type: "error",
    error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode." },
  });
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 403);
  const { error } = await response.json();
  assert.equal(error.type, "FreeTierError");
  assert.match(error.message, /prompt/i);
  assert.match(error.message, /edit, glob, grep, question, read, shell, skill, subagent, webfetch, websearch, write, execute/);
  assert.match(error.message, new RegExp(PROFILES["2.x"].agent.opencode.replace(/\./g, "\\.")));
  // Zen's own wording, which sends people off to change headers, is replaced.
  assert.doesNotMatch(error.message, /can only be used from within OpenCode/);
});

// The bytes a refusal is replaced with are not the bytes that arrived, so the
// headers describing them have to be the new ones. This is the message a user
// reads when the free tier stops answering, and a body re-served under the
// upstream's `content-encoding` cannot be read at all — the caller that honours
// the header fails to decompress it.
//
// The body here is one the reader can read to its end, because a refusal that
// was read whole is the one that gets replaced: a body that never ends is
// relayed as it was read, and that is the case below.
test("a rewritten refusal carries headers for the body it actually returns", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.status = 403;
  state.body = JSON.stringify({
    type: "error",
    error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode." },
  });
  state.responseHeaders = {
    "content-encoding": "identity",
    // The upstream's own length, for the upstream's own bytes: they describe
    // what arrived, and the reply below carries different bytes.
    "content-length": String(state.body.length),
    etag: '"stale-validator"',
    "last-modified": "Wed, 01 Oct 2026 00:00:00 GMT",
    // Hop-by-hop framing the connection names rather than a header this file
    // knows: a field the connection ends at is not reply data, so dropping the
    // word that named it and forwarding the header is not dropping it.
    connection: "x-hop",
    "x-hop": "1",
  };
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 403);
  for (const name of [
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "etag",
    "last-modified",
    "x-hop",
  ]) {
    assert.equal(response.headers.get(name), null, `${name} still describes the old body`);
  }
  assert.equal(response.headers.get("content-type"), "application/json");
  // And the body is the diagnostic, readable as JSON by a caller that trusted
  // the headers it was given.
  const { error } = await response.json();
  assert.match(error.message, /prompt/i);
});

// A refusal whose body was not read to its end is not a refusal this package
// has read: what it has is an opening, and the opening may or may not say the
// whole story. Here it does say `FreeTierError` — inside the part that was
// read — so the diagnosis would have been built from it, and the caller would
// have been told a refusal was complete when the read never reached the end of
// it. The one rule this package keeps for a body that was not read to its end
// is the refusal that says so: it carries the upstream's own words, and it does
// not claim to be more than it read.
test("a refusal whose body was cut short keeps the refusal that says so", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.status = 403;
  // Past the reader's budget, so the read stops short of the end of it — and
  // the words that name the free tier are inside the part that was read.
  const long = `{"error":{"type":"FreeTierError","message":"${"x".repeat(5000)}"}}`;
  state.body = long;
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 403, "the upstream's status is the answer's status");
  const { error } = await response.json();
  assert.match(error.message, /was not read to the end/);
  assert.match(error.message, /the \d+ characters read before the read stopped/);
  // The upstream's own words are carried along, so nothing about the refusal
  // is lost — including the one that names the free tier.
  assert.equal(error.upstream, long.slice(0, 512) + "…");
  assert.match(error.upstream, /FreeTierError/);
  // And the diagnosis is not substituted for it: it says the refusal was about
  // the wording of the tools, and this one was never read to its end.
  assert.doesNotMatch(error.message, /wording/i);
});

// A 403 that is not the free tier's is somebody else's answer, and nothing here
// invents a diagnosis for it: the message relayed is the one that arrived. Its
// headers are another matter. By the time it is relayed the body has been read
// once and written again, so the length, the encoding and the validators the
// upstream sent describe bytes this package no longer has — "left as it
// arrived" cannot include them, or a caller that trusted them would fail to
// read a message that is perfectly readable.
test("a 403 that is not the free tier's keeps its message, under headers for the bytes relayed", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.status = 403;
  state.responseHeaders = {
    etag: '"someone-elses"',
    "content-length": "999",
    "content-encoding": "identity",
    connection: "x-hop",
    "x-hop": "1",
  };
  state.body = JSON.stringify({ error: { message: "quota exhausted for this account" } });
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 403);
  for (const name of ["etag", "content-length", "content-encoding", "x-hop"]) {
    assert.equal(
      response.headers.get(name),
      null,
      `${name} still describes the upstream's bytes, not the relayed ones`,
    );
  }
  assert.match(await response.text(), /quota exhausted for this account/);
});

// The free tier blocks an egress IP in its own words: it reports abusive
// traffic, or says its free models are not available from the caller's current
// network. That is not a refusal of anything this package sends — no wording,
// session or retry changes the IP — so explain() diagnoses it before the
// FreeTierError branch. Left in that branch instead, the caller would be sent
// to capture tool wording again for a block that has nothing to do with tools.
test("an IP-abuse 403 is diagnosed as a blocked network, not a wording refusal", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const ask = () =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }] }),
    });
  // The three wordings the upstream has been seen to use, mixed case: the rule
  // is case-insensitive prose, and the third pairs two phrases — only both of
  // them together are a block, which the next case pins from the other side.
  for (const message of [
    "We detected ABUSIVE TRAFFIC from this network.",
    "Free models aren't available from your current network.",
    "Access is limited because of abuse of traffic from your current network.",
  ]) {
    state.status = 403;
    state.body = JSON.stringify({ error: { type: "upstream_error", message } });
    state.responseHeaders = { etag: '"abuse"', "content-length": String(state.body.length) };
    const response = await ask();
    assert.equal(response.status, 403, "the upstream's status is the answer's status");
    const { type, error } = await response.json();
    assert.equal(type, "error");
    assert.equal(error.type, "FreeTierError", `${message}: the block was not named`);
    assert.match(error.message, /egress IP/i, `${message}: the blocked IP is not named`);
    assert.match(error.message, /abuse of traffic/i, message);
    assert.match(error.message, /switch networks|VPN exit/i, `${message}: no way out is named`);
    assert.match(error.message, /wait/i, `${message}: waiting is not named`);
    assert.match(error.message, /cannot succeed/i, `${message}: a retry is not ruled out`);
    assert.match(error.message, /no local cooldown/i, `${message}: a local cooldown is implied`);
    assert.doesNotMatch(
      error.message,
      /wording/i,
      `${message}: the abuse refusal was read as a tool-wording refusal`,
    );
    // The body is this package's, so the upstream's validators are gone and
    // the content type is the one the new bytes are written as.
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("etag"), null, "the new body kept the upstream's validator");
  }
});

// The two halves of the network phrase are a block together and a retirement
// notice apart. A body that carries one of them, or nothing that names the
// free tier, is somebody else's 403 and is relayed exactly as it arrived —
// the diagnosis must not be invented from a partial match.
test("a 403 that only looks like a network block is relayed unchanged", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.status = 403;
  for (const body of [
    JSON.stringify({ error: { message: "free models aren't available for this account" } }),
    JSON.stringify({ error: { message: "forbidden: blocked by upstream policy" } }),
    JSON.stringify({ error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode." } }),
  ]) {
    state.body = body;
    const response = await loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 403, body);
    const text = await response.text();
    if (body.includes("FreeTierError"))
      assert.doesNotMatch(text, /egress IP/i, "a tool-wording refusal was read as a network block");
    else assert.equal(text, body, "a 403 that is not a block was rewritten");
  }
});

// What is read of a refusal is bounded, and a body past that budget is not the
// body: relaying the slice as though it were the reply hands a host a broken
// JSON document with nothing saying anything is missing. The answer keeps the
// upstream's status, says what happened, and carries the opening that was read.
test("an error body past the read budget is relayed as a refusal that says so", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const long = `{"error":{"message":"${"x".repeat(5000)}"}}`;
  state.status = 400;
  state.responseHeaders = { etag: '"long-body"', "content-length": String(long.length) };
  state.body = long;
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 400, "the upstream's status is the answer's status");
  assert.equal(response.headers.get("etag"), null, "and its validator does not describe these bytes");
  assert.equal(response.headers.get("content-type"), "application/json");
  const { error } = await response.json();
  assert.match(error.message, /HTTP 400/);
  // Not the cause: a budget the reader reached, a deadline, a read that failed
  // and a caller that aborted all arrive as the same prefix, so the message
  // states the fact it holds — the body was not read to its end — and how much
  // of it was read.
  assert.match(error.message, /was not read to the end/);
  assert.match(error.message, /the \d+ characters read before the read stopped/);
  // And it names none of those causes: one named here would be a guess about
  // something this side of the wire cannot see (provider.mjs, `relayedRefusal`).
  assert.doesNotMatch(error.message, /budget|ran past|deadline|timeout|timed out|abort/i);
  assert.equal(error.upstream, long.slice(0, 512) + "…", "the opening that was read is carried along");
});

// A body that cannot be read at all is not an empty body. Handing the caller an
// empty answer says the upstream replied with nothing, which is a different
// fact and a misleading one — and the bytes cannot be gone back for, since this
// read is the body's only reader.
test(
  "an error body that cannot be read is answered as unreadable, not as empty",
  { timeout: 15_000 },
  async (t) => {
    const { plugin, state, origin } = await fixture(t);
    await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
    const loader = await plugin.auth.loader(publicAuth);
    state.status = 403;
    state.hangBody = true;
    const response = await loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 403);
    const { error } = await response.json();
    assert.match(error.message, /could not be read at all/);
  },
);

for (const [path, model, key] of [
  ["responses", "responses-free", "parameters"],
  ["messages", "messages-free", "input_schema"],
]) {
  test(`normalizes ${path} tools and authentication using native protocol`, async (t) => {
    const { plugin, state, origin } = await fixture(t);
    await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
    const loader = await plugin.auth.loader(publicAuth);
    const response = await loader.fetch(`${origin}/v1/${path}`, {
      method: "POST",
      body: JSON.stringify({ model, stream: true }),
    });
    await response.text();
    const sent = lastCall(state);
    // No host tool was declared, so the first tool out is the official set's
    // own first: `edit`, where the retired 1.x lane used to lead with `bash`.
    assert.equal(sent.body.tools[0].name, "edit");
    assert.equal(sent.body.tools[0][key].type, "object");
    if (path === "messages") {
      assert.equal(sent.headers["x-api-key"], "public");
      assert.equal(sent.headers["anthropic-version"], "2023-06-01");
      assert.equal(sent.headers.authorization, undefined);
    }
  });
}

// The two Anthropic headers a host gets to choose. `anthropic-version` is the
// wire version the host's own SDK was built against, and `anthropic-beta` names
// the features it was written for: an answer in a version this plugin picked
// instead is a shape the host did not ask for, and a beta it named and did not
// get is a field it was waiting on. Neither is the plugin's to overrule, and
// nothing here said so until now — the only assertion about either header was
// the default at index.test.mjs:981, so forcing that default unconditionally
// broke no test in the file.
test("a host's own anthropic headers reach Zen unchanged", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const response = await loader.fetch(`${origin}/v1/messages`, {
    method: "POST",
    headers: {
      // Deliberately not the default this plugin would otherwise pick: a host
      // pinned to an older wire version gets that version or the test is not
      // about passing anything through.
      "anthropic-version": "2023-01-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
    },
    body: JSON.stringify({ model: "messages-free", stream: true }),
  });
  await response.text();
  const sent = lastCall(state).headers;
  assert.equal(
    sent["anthropic-version"],
    "2023-01-01",
    "the host's version, not a default chosen here",
  );
  assert.equal(
    sent["anthropic-beta"],
    "prompt-caching-2024-07-31",
    "the beta the host asked for is forwarded",
  );
});

// The other half: a host that names no version is answered in the default, and
// one that names no beta is not sent a beta it did not ask for. Both are the
// same request path as the test above, so the pair is what pins the branch.
test("a host that names no anthropic version is served the default", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const response = await loader.fetch(`${origin}/v1/messages`, {
    method: "POST",
    body: JSON.stringify({ model: "messages-free", stream: true }),
  });
  await response.text();
  const sent = lastCall(state).headers;
  assert.equal(sent["anthropic-version"], "2023-06-01", "the version every Anthropic host speaks");
  assert.equal(sent["anthropic-beta"], undefined, "and no beta nobody named");
});

test("rejects paid models, wrong protocol and foreign URLs before sending inference", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const before = state.calls.length;
  const paid = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "paid", stream: true }),
  });
  assert.equal(paid.status, 404);
  for (const [url, model] of [
    [`${origin}/v1/responses`, "chat-free"],
    ["https://other.example/v1/chat/completions", "chat-free"],
  ]) {
    await assert.rejects(
      loader.fetch(url, { method: "POST", body: JSON.stringify({ model, stream: true }) }),
    );
  }
  assert.equal(state.calls.length, before);
});

test("accepts Request input and aborts a streaming request", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.hang = true;
  const controller = new AbortController();
  const req = new Request(`${origin}/v1/chat/completions`, {
    method: "POST",
    signal: controller.signal,
    body: JSON.stringify({ model: "chat-free", stream: true }),
  });
  const response = await loader.fetch(req);
  const body = response.text();
  controller.abort();
  // The fixture never ends this response, so a regression in abort propagation
  // leaves `body` neither settled nor rejected — and node:test has no default
  // timeout, so the whole suite would hang instead of failing here.
  let timer;
  try {
    await Promise.race([
      assert.rejects(body, /abort/i),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("abort did not reach the stream")), WATCHDOG_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
});

test("chat headers name the session the way the free tier wants", async (t) => {
  const { plugin } = await fixture(t);
  const out = { headers: {} };
  await plugin["chat.headers"]({ model: { providerID: "other" }, sessionID: "s1" }, out);
  assert.deepEqual(out.headers, {});
  await plugin["chat.headers"](
    { model: { providerID: "opencode-zen-free" }, sessionID: "s1" },
    out,
  );
  assert.deepEqual(out.headers, { "x-opencode-session": "s1", "x-opencode-session-id": "s1" });
});

test("a refresh drops a model Zen no longer lists and adds one it lists now", async (t) => {
  const { plugin, state } = await fixture(t);
  const before = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(before).sort(), ["chat-free", "messages-free", "responses-free"]);
  state.ids = ["chat-free", "messages-free", "late-free"];
  // Each step that changes what upstream lists asks for a read outright: the
  // hook would answer from the list it read a moment ago, and what this case is
  // about is what a read that really happens does with a changed listing.
  const after = await plugin.refresh();
  assert.deepEqual(Object.keys(after).sort(), ["chat-free", "late-free", "messages-free"]);
  assert.equal(after[Symbol.for("magpie.fellBack")], undefined);
  // a failed list keeps the last one, said as fallen back
  state.modelsStatus = 503;
  const kept = await plugin.refresh();
  assert.deepEqual(Object.keys(kept).sort(), ["chat-free", "late-free", "messages-free"]);
  assert.equal(kept[Symbol.for("magpie.fellBack")], true);
});

test("a model no longer free is answered 404 naming the free ones, so only it is set aside", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const before = state.calls.length;
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "gone-free", stream: true }),
  });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.match(body.error.message, /Model gone-free is not available/);
  assert.match(body.error.message, /chat-free, messages-free, responses-free/);
  // listed a moment ago: the list isn't asked again for it
  assert.equal(state.calls.length, before);
});

test("a model made free since the list was read is served after the list is asked again", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.ids = ["chat-free", "late-free"];
  state.chatProtocol = "chat/completions";
  // Scoped to this test by the runner, so the shift cannot outlive it however
  // this file's hooks change later.
  const realNow = Date.now;
  t.mock.method(Date, "now", () => realNow() + 61_000);
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "late-free", stream: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(lastCall(state).body.model, "late-free");
});

test("a Chat stream Zen closes before its [DONE] ends cut short for a streaming client and fails for one that doesn't (#91)", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.reply =
    'data: {"id":"x2","object":"chat.completion.chunk","created":1,"model":"chat-free","choices":[{"index":0,"delta":{"role":"assistant"}}],"usage":null}\n\n' +
    'data: {"id":"x2","object":"chat.completion.chunk","created":1,"model":"chat-free","choices":[{"index":0,"delta":{"content":"Installed successfully and all"}}],"usage":null}\n\n' +
    'data: {"id":"x2","object":"chat.completion.chunk","created":1,"model":"chat-free","choices":[{"index":0,"delta":{"content":" other plugins are intact."}}],"usage":null}\n\n';
  const send = (stream) =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", stream, messages: [{ role: "user", content: "hi" }] }),
    });
  const streamed = await send(true);
  assert.equal(streamed.status, 200);
  const text = await streamed.text();
  assert.match(text, /other plugins are intact\./);
  assert.match(text, /The reply was cut short.*"finish_reason":"stop"/);
  assert.match(text, /data: \[DONE\]\n\n$/);
  assert.doesNotMatch(text, /"error"/);
  const whole = await send(false);
  assert.notEqual(whole.status, 200);
  assert.match(await whole.text(), /without a completion marker \(reply x2, 3 events/);
});

// A refusal is the one place this route states its own window, and the plugin
// reads it on its way past (observeRouteStatement, called from the provider's
// fetch). The window in this fixture is one no measurement ever produced, so
// only the live path can put it there: a unit test of the reader would pass
// with the call site missing, which is exactly how the last plugin lost a
// mechanism it had already shipped and tested.
test("a refusal that names a window reaches the declaration, not only the caller", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.status = 400;
  state.body = JSON.stringify({
    error: {
      type: "invalid_request_error",
      message:
        "This model's maximum context length is 900000 tokens. However, you requested 1000000 tokens (900000 in the messages, 100000 in the completion).",
    },
  });
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "chat-free", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /maximum context length is 900000 tokens/);
  const { limitOverrides } = await import("./limits.mjs");
  assert.equal(limitOverrides("chat-free", { context: 200000, output: 8192 }).context, 900000);
});

// One turn end to end, over the paths a real host walks in order: register,
// discover, ask, be refused as not-OpenCode, and be told which wording to
// update — with the refusal readable and carrying headers for the bytes it
// returns. Each piece is covered above on its own; this is the wiring between
// them, which is what a refactor of any one module breaks.
test("one turn end to end: discover, ask, be refused, be told what to update", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  const config = {};
  await plugin.config(config);
  assert.equal(config.provider["opencode-zen-free"].api, `${origin}/v1`);

  const listed = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.ok(listed["chat-free"], "the listing's free model is offered");

  const loader = await plugin.auth.loader(publicAuth);
  state.status = 403;
  // A refusal as a proxy serves it: compressed, with a length and a validator
  // that describe bytes this plugin replaces before the caller sees them.
  state.responseHeaders = {
    "content-encoding": "identity",
    etag: '"stale"',
    "last-modified": "Wed, 01 Oct 2026 00:00:00 GMT",
  };
  state.body = JSON.stringify({
    type: "error",
    error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode." },
  });
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({
      model: "chat-free",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
      tools: declaredTools("chat"),
    }),
  });
  assert.equal(response.status, 403);
  for (const name of ["content-encoding", "content-length", "etag", "last-modified"])
    assert.equal(response.headers.get(name), null, `${name} describes bytes that were replaced`);
  const { error } = await response.json();
  assert.equal(error.type, "FreeTierError");
  assert.match(error.message, /prompt/i);
  assert.match(error.message, /this package's, for OpenCode \d/);

  // The request that was refused is still the request the plugin makes: the
  // host's tools go out under the client prefix, and the complete official set
  // follows them.
  const sent = lastCall(state);
  assert.ok(sent.headers["user-agent"].startsWith("opencode/"), sent.headers["user-agent"]);
  assert.equal(sent.headers["x-opencode-session"], sent.headers["x-opencode-session-id"]);
  const names = sent.body.tools.map((tool) => tool.function.name);
  assert.deepEqual(names, [
    ...declaredTools("chat").map((tool) => `clint_${tool.function.name}`),
    ...officialToolNames("2.x"),
  ]);
  assert.equal(new Set(names).size, names.length, "no name goes out twice");
  assert.equal(sent.body.stream, true, "upstream streaming is forced even for a client that does not stream");
});

// The adaptive half of the limits reader, driven through the plugin rather than
// through limits.mjs: a bracket is worth nothing unless the request path is what
// fills it, and unless what it learns is what the next model list declares. The
// case below is the whole loop — a served request, a refused one, and the model
// list answering differently afterwards — with the sizes read from the request's
// own text the way the plugin reads them.

test("a served request and a refusal move what the model list declares", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  // A window large enough for the official prompt and tool set plus a test
  // payload: 40000 tokens is about 186000 characters at the ratio the
  // estimator uses, and the shaped request carries roughly 10000 tokens of
  // prompt and definitions before the first user word.
  state.ids = ["small-free"];
  state.catalogRows = {
    "small-free": { name: "Small Free", cost: { input: 0, output: 0 }, limit: { context: 40000, output: 1024 } },
  };
  const models = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.equal(models["small-free"].limit.context, 40000, "the catalogue's own window, to begin with");
  const loader = await plugin.auth.loader(publicAuth);
  const send = (text) =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "small-free", stream: true, messages: [{ role: "user", content: text }] }),
    });
  // A served request is proof of a floor, and the host has not filled the
  // declaration yet, so the next list still declares exactly what it declared.
  const served = await send("a".repeat(10000)); // about 2146 tokens
  await served.text();
  // `refresh()` rather than `models()`: a list rebuilt inside the relist budget
  // is the list the host was already given, and what this case is about is what
  // a rebuilt list says.
  const afterServe = await plugin.refresh();
  assert.equal(afterServe["small-free"].limit.context, 40000, "a floor is not a reason to move a window");
  // ...and then the route refuses one that is over the wall. What the list
  // declares afterwards is the largest size the route is known to have served,
  // which is the only number a refusal leaves standing.
  state.status = 400;
  state.body = JSON.stringify({
    error: {
      message:
        "Your request resulted in more tokens than this model's maximum context length allows. Please reduce the length of the messages or run compaction.",
      type: "invalid_request_error",
      code: "context_length_exceeded",
    },
  });
  const refused = await send("a".repeat(200000)); // about 42918 tokens of text, plus the shaped body
  assert.equal(refused.status, 400, "the refusal is the route's, and it is handed on");
  await refused.text();
  const afterRefusal = await plugin.refresh();
  // The rule, not the number: the declaration comes back to the largest size
  // the route is known to have served, and stays under the window it began with.
  // The numbers themselves are not written into this case because the size of a
  // request is read from the whole prompt — the tool descriptions this plugin
  // fills in for a host that has none of them are part of what the route counts,
  // and a case that pinned a total would be pinning fingerprint.json's wording
  // as much as the reader.
  const { limitBracket } = await import("./limits.mjs");
  const bracket = limitBracket("small-free");
  assert.ok(bracket.floor > 0, "the served request proved a floor");
  assert.ok(bracket.floor < 40000, "and it is under the window the catalogue declared");
  assert.equal(
    afterRefusal["small-free"].limit.context,
    bracket.floor,
    "the declaration is back at the floor the route proved",
  );
  assert.ok(bracket.ceil >= bracket.floor, "and the refusal put a bound above the floor");
  // The output axis is not the one that moved: a window refusal says nothing
  // about the completion ceiling, and the catalogue's is left where it was.
  assert.equal(afterRefusal["small-free"].limit.output, 1024);
});

test("a refusal that is not about the window leaves the window where it was", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  state.ids = ["faulted-free"];
  state.catalogRows = {
    "faulted-free": {
      name: "Faulted Free",
      cost: { input: 0, output: 0 },
      limit: { context: 40000, output: 1024 },
    },
  };
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const send = (text) =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "faulted-free", stream: true, messages: [{ role: "user", content: text }] }),
    });
  // A served request first, so the bracket has a floor and a refusal would have
  // something to pull the declaration back down to. Without one this case could
  // pass on a bracket that never moved because it never could.
  const served = await send("a".repeat(10000));
  await served.text();
  const { limitBracket } = await import("./limits.mjs");
  assert.ok(limitBracket("faulted-free").floor > 0, "the route served something to begin with");
  // Three answers this route really sends and none of which is about length: the
  // endpoint failing, a 400 that names nothing, and a 400 about the completion
  // ceiling. On 2026-10-19 nemotron-3.5-super-vl-free answered the first to two
  // asks and then served the identical requests, and space-bunny-free answered
  // the second when it was asked for a ceiling of 1000000.
  const faults = [
    [500, ""],
    [
      400,
      '{"error":{"type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] invalid request"}}',
    ],
    [
      400,
      'data: {"error":{"param":"max_tokens is too large: 1000000. This model supports at most 131072 completion tokens, whereas you provided 1000000.","type":"server_error","message":"Streaming response failed: [400] Param Incorrect"}}',
    ],
  ];
  for (const [status, body] of faults) {
    state.status = status;
    state.body = body;
    const refused = await send("a".repeat(200000)); // about 42918 tokens of text, plus the shaped body
    assert.equal(refused.status, status, "the answer is the route's, and it is handed on");
    await refused.text();
  }
  const bracket = limitBracket("faulted-free");
  assert.equal(bracket.refusals, 0, "none of the three was a refusal about the window");
  assert.equal(bracket.ceil, undefined, "so none of them put a bound under the declaration");
  const after = await plugin.refresh();
  assert.equal(after["faulted-free"].limit.context, 40000, "and the window is the one it began with");
  // The completion ceiling the third answer named is still read, on its own axis.
  // It is a refusal and it is worth knowing; it is just not about the window, and
  // a declaration pulled down by it would be a window narrowed over a number that
  // was never about the window at all.
  assert.equal(after["faulted-free"].limit.output, 131072);
});
