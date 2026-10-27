import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BYTES, collapseResponse } from "./stream.mjs";
import { cutShortNote, droppedNote, guardToolResponse } from "./tool-response.mjs";

const encoder = new TextEncoder();
// The policy every test in this file guards against, at module scope so the
// loops that build the tests and the tests themselves share one value. A test
// body runs after module evaluation, so a `const` read from one is
// initialized by then whatever order the callbacks were registered in.
const policy = {
  declared: new Set(["Bash", "Read"]),
  injected: new Set(["bash", "read", "shell"]),
};
const protocols = ["chat", "responses", "anthropic"];
const event = (data, name) =>
  `${name ? `event: ${name}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
const terminal = (protocol) =>
  event(
    protocol === "chat"
      ? "[DONE]"
      : { type: protocol === "responses" ? "response.completed" : "message_stop" },
  );

for (const type of [
  "custom_tool_call",
  "computer_call",
  "local_shell_call",
  "shell_call",
  "mcp_call",
  "apply_patch_call",
]) {
  test(`Responses rejects unsupported ${type} in JSON and streaming snapshots`, async () => {
    const item = { type, name: "undeclared_command", call_id: "call1", input: "run" };
    const json = await guardToolResponse(Response.json({ output: [item] }), "responses", policy);
    assert.equal(json.status, 502);
    assertError("responses", await json.json(), false);
    for (const data of [
      { type: "response.output_item.added", item },
      { type: "response.output_item.done", item },
      { type: "response.completed", response: { output: [item] } },
    ]) {
      const response = await guardToolResponse(
        sse(event(data) + terminal("responses")),
        "responses",
        policy,
      );
      const text = await response.text();
      assert.doesNotMatch(text, /undeclared_command/);
      assertError("responses", parse(text)[0].data);
    }
  });
}
const chat = (delta, finish_reason = null, index = 0) => ({
  choices: [{ index, delta, finish_reason }],
});
const call = (name, index = 0, args = "{}") => ({
  index,
  id: `call-${index}`,
  type: "function",
  function: { name, arguments: args },
});
const tool = (protocol, name) =>
  protocol === "chat"
    ? call(name)
    : protocol === "responses"
      ? { type: "function_call", name, call_id: "call", arguments: "{}" }
      : { type: "tool_use", name, id: "call", input: {} };
function snapshot(protocol, names) {
  const tools = names.map((name) => tool(protocol, name));
  if (protocol === "chat")
    return { choices: [{ message: { role: "assistant", tool_calls: tools } }] };
  return protocol === "responses" ? { output: tools } : { type: "message", content: tools };
}
function streamSnapshot(protocol, names) {
  if (protocol === "chat")
    return chat({ tool_calls: names.map((name, index) => call(name, index)) }, "tool_calls");
  if (protocol === "responses")
    return { type: "response.completed", response: snapshot(protocol, names) };
  return { type: "message_start", message: snapshot(protocol, names) };
}
function namesIn(protocol, data) {
  if (protocol === "chat")
    return (data.choices ?? [])
      .flatMap((choice) => (choice.message ?? choice.delta)?.tool_calls ?? [])
      .map((value) => value.function.name);
  return (
    protocol === "responses" ? (data.response ?? data).output : (data.message ?? data).content
  ).map((value) => value.name);
}
// Every item shaped like a call, whichever kind it is: the three names the
// guard reads, and the shapes it rejects or replaces (custom_tool_call,
// local_shell_call, mcp_call, apply_patch_call, and whatever is added next).
// A leak assertion that only knew the three would not see the others.
const callShaped = (type) =>
  typeof type === "string" &&
  (type.endsWith("_call") || type === "tool_use" || type === "server_tool_use");
// The calls a reply (JSON, or every SSE frame's data) hands the agent: a Chat
// choice's tool_calls, a Responses output array or a frame's own item, or a
// Messages content array or content block. One walk, so the two readers below
// draw from the same items and a protocol added to one is added to both.
function callItems(protocol, values) {
  return values.flatMap((data) => {
    if (protocol === "chat")
      return (data.choices ?? []).flatMap(
        (choice) => (choice.message ?? choice.delta)?.tool_calls ?? [],
      );
    const items =
      protocol === "responses"
        ? [...((data.response ?? data).output ?? []), ...(data.item ? [data.item] : [])]
        : [
            ...((data.message ?? data).content ?? []),
            ...(data.content_block ? [data.content_block] : []),
          ];
    return items.filter((item) => callShaped(item.type));
  });
}
// The names those calls were made under (callsIn), and the words the agent
// keys a call's result by (idsIn): a Chat client matches a tool/result by the
// call's id, a Responses item carries the call_id the route named it by (and
// an id of its own), and a Messages block is keyed by its id. A call the guard
// hands on has one — it leaves with an id (ensureCallIDs) — and the note left
// in a nameless call's place is not a call at all.
function callsIn(protocol, values) {
  const name = protocol === "chat" ? (value) => value.function?.name : (value) => value.name;
  return callItems(protocol, values).map(name);
}
function idsIn(protocol, values) {
  const word = protocol === "chat" ? (value) => value.id : (value) => value.call_id ?? value.id;
  return callItems(protocol, values).map(word).filter(Boolean);
}
function textIn(protocol, values) {
  if (protocol === "chat")
    return values
      .flatMap((data) => data.choices ?? [])
      .map((choice) => (choice.message ?? choice.delta)?.content ?? "")
      .join("");
  // A stream's text is its deltas; a reply or snapshot's is its text parts.
  const deltas = values.filter((data) =>
    protocol === "responses"
      ? data.type === "response.output_text.delta"
      : data.type === "content_block_delta" && data.delta?.type === "text_delta",
  );
  if (deltas.length)
    return deltas.map((data) => (protocol === "responses" ? data.delta : data.delta.text)).join("");
  const snapshot = values
    .map((data) =>
      protocol === "responses" ? (data.response ?? data).output : (data.message ?? data).content,
    )
    .filter(Array.isArray)
    .at(-1);
  return (snapshot ?? [])
    .flatMap((item) =>
      protocol === "responses"
        ? item.type === "message"
          ? item.content.map((part) => part.text)
          : []
        : item.type === "text"
          ? [item.text]
          : [],
    )
    .join("");
}
const frameData = (text) =>
  parse(text)
    .map((frame) => frame.data)
    .filter((data) => data && data !== "[DONE]");
// One call streamed the way Zen streams it. Chat's is step-5-preview-free's
// own shape (2026-10-11): the name whole in the first delta with empty
// arguments, the arguments in pieces, and two tool_calls finishes.
function toolStream(protocol, name) {
  if (protocol === "chat") {
    const id = { id: "chatcmpl-1", model: "step-5-preview-free" };
    return (
      event({ ...id, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }) +
      event({
        ...id,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_773767abbc494d2a82872502",
                  type: "function",
                  function: { name, arguments: "" },
                },
              ],
            },
          },
        ],
      }) +
      ["", "{", '"command": "ls"', "}"]
        .map((part) =>
          event({
            ...id,
            choices: [
              { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: part } }] } },
            ],
          }),
        )
        .join("") +
      event({ ...id, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
      event({
        ...id,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }) +
      "data: [DONE]\n\n"
    );
  }
  if (protocol === "responses") {
    const item = { id: "fc_1", type: "function_call", call_id: "call_1", name, arguments: "" };
    const done = { ...item, arguments: '{"command":"ls"}', status: "completed" };
    const where = { item_id: "fc_1", output_index: 0 };
    return [
      { type: "response.created", response: { id: "r1", status: "in_progress", output: [] } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress" },
      },
      { type: "response.function_call_arguments.delta", ...where, delta: '{"command":' },
      { type: "response.function_call_arguments.delta", ...where, delta: '"ls"}' },
      { type: "response.function_call_arguments.done", ...where, arguments: '{"command":"ls"}' },
      { type: "response.output_item.done", output_index: 0, item: done },
      { type: "response.completed", response: { id: "r1", status: "completed", output: [done] } },
    ]
      .map((value) => event(value, value.type))
      .join("");
  }
  return [
    {
      type: "message_start",
      message: { id: "m1", type: "message", role: "assistant", content: [] },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "t1", name, input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"command":' },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '"ls"}' },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]
    .map((value) => event(value, value.type))
    .join("");
}
// An event no undeclared name can explain: a call of a kind the agent
// can't be handed, beside a declared one. Messages has no unsupported call
// kind of its own — a block that is not a call is not one — and an entry that
// is not a block is skipped by both paths now (a malformed snapshot is skipped,
// never fatal). The refusal left for it is the walk's own: a frame that is
// itself a call with no name and no holder to put the note in (checkSnapshots).
function badMixed(protocol) {
  if (protocol === "chat")
    return chat({ tool_calls: [call("Read"), { ...call("x", 1), type: "custom" }] }, "tool_calls");
  if (protocol === "responses")
    return {
      type: "response.completed",
      response: { output: [tool(protocol, "Read"), { type: "custom_tool_call", name: "x" }] },
    };
  return { type: "tool_use", name: "", id: "t1" };
}
function parse(text) {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r\n\r\n|\n\n|\r\r/)
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split(/\r\n|\r|\n/);
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      return {
        name: lines
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim(),
        data: !data || data === "[DONE]" ? data : JSON.parse(data),
      };
    });
}
// The shape of a guard failure, and the code that says which failure it was:
// only a call of no tool the agent has is an undeclared one. Every protocol
// carries the code: the guard computes it and used to drop it for the chat
// and the Messages arm, and a client on those two could not tell an
// undeclared tool from a size limit or a transport failure.
function assertError(protocol, data, stream = true, code = "upstream_error") {
  if (protocol === "chat") {
    assert.equal(data.error.type, "upstream_error");
    assert.equal(data.error.code, code);
  }
  if (protocol === "responses") {
    if (stream) {
      assert.equal(data.type, "error");
      assert.equal(data.code, code);
    } else {
      assert.equal(data.error.type, "upstream_error");
      assert.equal(data.error.code, code);
    }
  }
  if (protocol === "anthropic") {
    assert.equal(data.type, "error");
    assert.equal(data.error.type, "api_error");
    assert.equal(data.error.code, code);
  }
  assert.equal(typeof (data.message ?? data.error?.message), "string");
}
// The shape of a reply that dropped a call, whichever protocol and whichever
// path built it: no error in the reply, exactly the calls it kept, the note
// standing in for the one it left out, and no call-shaped item left without a
// name. Written once, so a change to the note's text or to what counts as a
// call cannot leave the suites disagreeing about the same behaviour. Since
// #209 the one call still left out is a nameless one, so the note is the
// nameless note and the leak check is a call that reached the client with no
// name to key it by; it is over the whole value on purpose, because callsIn
// reads only the call shapes it knows.
function assertOnlyDropped(protocol, values, kept) {
  assert.ok(!values.some((data) => data.type === "error" || data.error));
  assert.deepEqual(callsIn(protocol, values), kept);
  assert.equal(textIn(protocol, values), droppedNote(""));
  assert.ok(
    callsIn(protocol, values).every((name) => typeof name === "string" && name !== ""),
    "a call left with no name reached the reply",
  );
}
// A stream that never ends on its own is waited on with a budget: a hang is
// then reported as one instead of stalling the run. A loaded machine can push
// a real read past any fixed number, so the budget is per call and generous.
async function withTimeout(promise, ms = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("stream waited for EOF")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
// The server's own log, read back: the guard writes a failure it does not
// tell the client in full there, and a test reads what it wrote. The sink is
// put back whatever the run does.
async function withLog(run) {
  const logged = [];
  const sink = console.error;
  console.error = (...args) => {
    logged.push(args.map((value) => String(value)).join(" "));
  };
  try {
    return { logged, value: await run() };
  } finally {
    console.error = sink;
  }
}
// One factory for every upstream mock below: a Response whose body is a
// stream built from `pull`, the chunks it handed out counted, and the way a
// test pushes into it. The scaffolding is written once, so a fix to it applies
// to all of the mocks at once. There is no `close` here: every caller ends its
// stream from inside `pull`, and a member nothing calls is one the next reader
// has to prove dead before touching this.
function upstream(
  pull,
  { cancel = () => {}, headers = {}, status = 200, highWaterMark = 1 } = {},
) {
  let controller;
  let pulls = 0;
  const response = new Response(
    new ReadableStream(
      {
        start(value) {
          controller = value;
        },
        pull(value) {
          pulls++;
          return pull(value, pulls);
        },
        cancel,
      },
      { highWaterMark },
    ),
    { status, headers: { "content-type": "text/event-stream", ...headers } },
  );
  return {
    response,
    pulls: () => pulls,
    push: (value) => controller.enqueue(encoder.encode(value)),
  };
}
function sse(text, { chunkSize = 31, headers = {}, status = 200 } = {}) {
  const bytes = encoder.encode(text);
  let offset = 0;
  return upstream(
    (controller) => {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
    { status, headers },
  ).response;
}
function openSource(text, cancel = () => {}) {
  let first = true;
  return upstream(
    (controller) => {
      if (!first) return;
      first = false;
      controller.enqueue(encoder.encode(text));
    },
    { cancel, highWaterMark: 0 },
  );
}
// A chunked upstream the guard has to stop reading itself: it hands out
// `bytes` in `chunkSize` pieces, then leaves the stream open. `pulls` is how
// many chunks it took to be stopped.
function chunkedStream(bytes, { chunkSize = bytes.length, cancel = () => {} } = {}) {
  let offset = 0;
  return upstream(
    (controller) => {
      if (offset === bytes.length) return;
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
    { cancel, highWaterMark: 0 },
  );
}
// The same, for an upstream that never runs out: `chunk` is the bytes of
// every pull, or a function of the pull count when the payload has to differ
// each time.
function endlessStream(chunk, { cancel = () => {} } = {}) {
  const next = typeof chunk === "function" ? chunk : () => chunk;
  return upstream((controller, pulls) => controller.enqueue(next(pulls - 1)), {
    cancel,
    highWaterMark: 0,
  });
}
// A body whose read fails while the body itself stays alive. The guard uses
// nothing of one but read/cancel/releaseLock, and a real stream errors itself
// when its read rejects — where a cancel is a no-op against the error already
// stored — so this is the only way to see whether that failure cancels what
// is left of the body or only releases it (#47). The content type says which
// arm of the guard reads it: a stream is read event by event, a JSON body in
// one read, and both arms answer the same failure the same way.
function failingBody(cause, cancel = () => {}, contentType = "text/event-stream") {
  const handle = { cancellations: [], released: false, reads: 0 };
  handle.response = {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": contentType }),
    body: {
      getReader: () => ({
        read: () => {
          handle.reads++;
          return Promise.reject(cause);
        },
        cancel: (reason) => {
          handle.cancellations.push(reason);
          return cancel(reason);
        },
        releaseLock: () => {
          handle.released = true;
        },
      }),
    },
  };
  return handle;
}

for (const protocol of protocols) {
  test(`${protocol}: JSON maps injected casing and retains declared names`, async () => {
    for (const names of [
      ["bash", "read"],
      ["Bash", "Read"],
    ]) {
      const result = await guardToolResponse(
        Response.json(snapshot(protocol, names)),
        protocol,
        policy,
      );
      assert.equal(result.status, 200);
      assert.deepEqual(namesIn(protocol, await result.json()), ["Bash", "Read"]);
    }
  });

  // #209: an unknown name is no longer a call to leave out. Every name the
  // model wrote that the agent has no spelling of — unknown, injected but not
  // declared, an ambiguous fold, a fold onto a semantic alias — reaches the
  // agent as called, so the agent answers it with its own unknown-tool error
  // and the model corrects the name instead of reading a finished turn.
  test(`${protocol}: JSON hands on unknown, non-injected, ambiguous and semantic aliases as called (#209)`, async () => {
    for (const [name, rules] of [
      ["unknown", policy],
      ["shell", policy],
      ["bash", { declared: new Set(["Read", "Bash", "BASH"]), injected: new Set(["bash"]) }],
      [
        "todowrite",
        { declared: new Set(["Read", "todo_write", "todo-write"]), injected: new Set() },
      ],
      ["bash", { declared: new Set(["Read"]), injected: new Set(["bash"]) }],
    ]) {
      const response = await guardToolResponse(
        Response.json(snapshot(protocol, ["Read", name])),
        protocol,
        rules,
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(!body.error, `${name}: the reply is an error, not a reply`);
      assert.deepEqual(
        callsIn(protocol, [body]),
        ["Read", name],
        `${name} was left out or handed on under another name`,
      );
      assert.equal(textIn(protocol, [body]), "", `${name} drew a note`);
    }
  });

  // #76, tkhs101's table of 2026-10-10, and #209, xiotbox's DSH sessions of
  // 2026-10-16/17: the names step-5-preview-free called that DSH has no tool
  // for, and no spelling of one either. Each used to be left out with the turn
  // going on — and a reply of only such a call ended an autonomous agent's turn
  // as a plain answer, which its host read as "the task is done". Each is now
  // handed on as called, with its id and a tool-call finish, so the agent
  // answers it with its own unknown-tool error and the model corrects the name.
  //
  // The last is the table's own spelling, doubled "cat" and all, kept
  // verbatim rather than "fixed": it names a different server than the
  // declared mcp__netcatty-external__list_hosts, and that is what the table
  // recorded — a name with no spelling of a declared tool. The near miss
  // beside it (that same server, a tool it does not have) is the test below.
  const tableRules = {
    declared: new Set([
      "bash",
      "read",
      "edit",
      "glob",
      "grep",
      "write",
      "todo_write",
      "mcp__netcatty-external__list_hosts",
    ]),
    injected: new Set(),
  };
  test(`${protocol}: a call of a tool the agent doesn't have reaches it as called, with its id and a tool-call finish (#76, #209)`, async () => {
    for (const name of ["bedit", "bcp", "ash", "mcp__netcatcatty__unused"]) {
      // Beside a call the agent has (#209's case B), and alone (case A).
      const mixed = await guardToolResponse(
        Response.json(snapshot(protocol, ["bash", name])),
        protocol,
        tableRules,
      );
      assert.equal(mixed.status, 200);
      const body = await mixed.json();
      assert.deepEqual(callsIn(protocol, [body]), ["bash", name], `${name} was not handed on as called`);
      assert.equal(textIn(protocol, [body]), "", `${name} drew a note`);
      const alone = await guardToolResponse(
        Response.json(snapshot(protocol, [name])),
        protocol,
        tableRules,
      );
      assert.equal(alone.status, 200);
      const only = await alone.json();
      assert.deepEqual(callsIn(protocol, [only]), [name]);
      assert.ok(idsIn(protocol, [only]).length > 0, `${name} reached the agent with no id to key it by`);
      for (const bytes of [
        event(streamSnapshot(protocol, [name])) + terminal(protocol),
        toolStream(protocol, name),
      ]) {
        const streamed = await guardToolResponse(sse(bytes), protocol, tableRules);
        assert.equal(streamed.status, 200);
        const values = frameData(await streamed.text());
        assert.ok(!values.some((data) => data.type === "error" || data.error));
        assert.deepEqual([...new Set(callsIn(protocol, values))], [name]);
        assert.equal(textIn(protocol, values), "");
        assert.ok(idsIn(protocol, values).length > 0, `${name} reached the agent with no id to key it by`);
        assert.doesNotMatch(JSON.stringify(values), /The call was left out/);
      }
      // Zen's own stream comes through as it was sent: every call in it is
      // named, so nothing in it is rewritten. Chat is compared by value — its
      // buffer republishes each call as one whole delta — and the other two
      // frame for frame.
      const raw = toolStream(protocol, name);
      const passed = frameData(await (await guardToolResponse(sse(raw), protocol, tableRules)).text());
      if (protocol !== "chat") assert.deepEqual(passed, frameData(raw));
      else {
        const choices = passed.flatMap((data) => data.choices ?? []);
        assert.deepEqual(
          choices.flatMap((choice) => choice.delta?.tool_calls ?? []).map((call) => call.function.name),
          [name],
        );
        assert.ok(
          choices.some((choice) => choice.finish_reason === "tool_calls"),
          "the flush told the client the turn ended in tool use",
        );
      }
    }
  });

  // The near miss the table's mangled name cannot cover: the declared server,
  // with a tool it does not have. A call is folded whole — case and
  // separators only — so sharing a server prefix is never enough to answer it
  // with another tool's name, and a name no declared tool folds to is handed
  // on as called (#209).
  test(`${protocol}: a tool the declared server does not have is handed on as called, not matched by prefix`, async () => {
    const name = "mcp__netcatty-external__unused";
    const json = await guardToolResponse(
      Response.json(snapshot(protocol, ["bash", name])),
      protocol,
      tableRules,
    );
    assert.equal(json.status, 200);
    const body = await json.json();
    assert.ok(!body.error);
    assert.deepEqual(callsIn(protocol, [body]), ["bash", name]);
    assert.equal(textIn(protocol, [body]), "");
    const streamed = await guardToolResponse(
      sse(event(streamSnapshot(protocol, [name])) + terminal(protocol)),
      protocol,
      tableRules,
    );
    assert.equal(streamed.status, 200);
    const values = frameData(await streamed.text());
    assert.ok(!values.some((data) => data.type === "error" || data.error));
    assert.deepEqual([...new Set(callsIn(protocol, values))], [name]);
    assert.equal(textIn(protocol, values), "");
  });

  // #76: DSH declares all five core tools (so nothing is injected) and
  // todo_write; step-5-preview-free opens with OpenCode's todowrite.
  test(`${protocol}: an OpenCode tool name is given the agent's own spelling of it (#76)`, async () => {
    const rules = {
      declared: new Set([
        "bash",
        "read",
        "edit",
        "glob",
        "grep",
        "write",
        "todo_write",
        "web_fetch",
        "TodoRead",
      ]),
      injected: new Set(),
    };
    for (const [asked, given] of [
      ["todowrite", "todo_write"],
      ["webfetch", "web_fetch"],
      ["todoread", "TodoRead"],
      ["BASH", "bash"],
    ]) {
      const json = await guardToolResponse(
        Response.json(snapshot(protocol, [asked])),
        protocol,
        rules,
      );
      assert.equal(json.status, 200);
      assert.deepEqual(namesIn(protocol, await json.json()), [given]);
      const streamed = await guardToolResponse(
        sse(event(streamSnapshot(protocol, [asked])) + terminal(protocol)),
        protocol,
        rules,
      );
      const frames = parse(await streamed.text()).filter(
        (frame) => frame.data && frame.data !== "[DONE]",
      );
      assert.deepEqual(namesIn(protocol, frames[0].data), [given]);
    }
  });

  // The one call that is still left out: a call with no name at all. Nothing
  // keys a result by it and no agent can run it, so it is replaced by the note
  // saying so (#76), and the note's text is the whole of what the reply says.
  test(`${protocol}: a call with no name is left out, and the reply's text says so (#76)`, async () => {
    const json = await guardToolResponse(
      Response.json(snapshot(protocol, [""])),
      protocol,
      policy,
    );
    assert.equal(json.status, 200);
    assert.equal(textIn(protocol, [await json.json()]), droppedNote(""));
    const streamed = await guardToolResponse(
      sse(event(streamSnapshot(protocol, [""])) + terminal(protocol)),
      protocol,
      policy,
    );
    assert.equal(textIn(protocol, frameData(await streamed.text())), droppedNote(""));
    assert.equal(
      droppedNote("x".repeat(300)),
      `(The model called a tool this agent doesn't have: "${"x".repeat(128)}". The call was left out.)`,
    );
    assert.equal(
      droppedNote(""),
      "(The model called a tool without a name. The call was left out.)",
    );
  });

  test(`${protocol}: exact matches win over ambiguous casing`, async () => {
    const rules = { declared: new Set(["bash", "Bash"]), injected: new Set(["bash"]) };
    const result = await guardToolResponse(
      Response.json(snapshot(protocol, ["bash"])),
      protocol,
      rules,
    );
    assert.deepEqual(namesIn(protocol, await result.json()), ["bash"]);
  });

  test(`${protocol}: SSE maps injected casing and retains declared names`, async () => {
    for (const names of [
      ["bash", "read"],
      ["Bash", "Read"],
    ]) {
      const result = await guardToolResponse(
        sse(event(streamSnapshot(protocol, names)) + terminal(protocol)),
        protocol,
        policy,
      );
      assert.equal(result.status, 200);
      const frames = parse(await result.text()).filter(
        (frame) => frame.data && frame.data !== "[DONE]",
      );
      const tools = frames.find(
        (frame) =>
          protocol !== "chat" || frame.data.choices?.some((choice) => choice.delta?.tool_calls),
      );
      assert.deepEqual(namesIn(protocol, tools.data), ["Bash", "Read"]);
      assert.ok(!frames.some((frame) => frame.name === "error" || frame.data.error));
    }
  });

  test(`${protocol}: a refused SSE snapshot never leaks a tool and cancels immediately`, async () => {
    let cancelled = false;
    const source = openSource(
      event(badMixed(protocol)) + event({ sentinel: "must not escape" }),
      () => {
        cancelled = true;
      },
    );
    const result = await guardToolResponse(source.response, protocol, policy);
    const frames = parse(await withTimeout(result.text()));
    assert.equal(frames.length, 1);
    // The code says which failure it was: the Messages arm's refusal is a
    // call the guard cannot name at all (an undeclared one), the other two an
    // unsupported kind of call. The Messages arm used to be told the same as
    // the other two, the code was dropped for it, and a client could not tell
    // the two failures apart.
    assertError(
      protocol,
      frames[0].data,
      true,
      protocol === "anthropic" ? "undeclared_tool" : "upstream_error",
    );
    if (protocol !== "chat") assert.equal(frames[0].name, "error");
    assert.equal(cancelled, true);
    assert.equal(source.response.body.locked, false);
  });

  test(`${protocol}: a mixed SSE snapshot hands on every named call and leaves out a nameless one (#76, #209)`, async () => {
    for (const name of ["unknown", "shell", "todowrite"]) {
      const result = await guardToolResponse(
        sse(event(streamSnapshot(protocol, ["Read", name])) + terminal(protocol)),
        protocol,
        policy,
      );
      const values = frameData(await result.text());
      assert.ok(!values.some((data) => data.type === "error" || data.error));
      assert.deepEqual(callsIn(protocol, values), ["Read", name]);
      assert.equal(textIn(protocol, values), "");
    }
    // The same snapshot with the second call nameless: that one is still left
    // out, and the first is untouched.
    const result = await guardToolResponse(
      sse(event(streamSnapshot(protocol, ["Read", ""])) + terminal(protocol)),
      protocol,
      policy,
    );
    assertOnlyDropped(protocol, frameData(await result.text()), ["Read"]);
  });

  test(`${protocol}: upstream SSE errors pass through byte-for-byte and cancel open streams`, async () => {
    const errors =
      protocol === "responses"
        ? [
            {
              type: "response.failed",
              response: {
                status: "failed",
                error: { code: "rate_limit_exceeded", message: "slow down 中文🙂" },
              },
            },
            { type: "error", code: "rate_limit_exceeded", message: "slow down 中文🙂" },
            { response: { status: "failed", error: { code: "server_error", message: "failed" } } },
          ]
        : protocol === "anthropic"
          ? [{ type: "error", error: { type: "overloaded_error", message: "busy 中文🙂" } }]
          : [
              {
                error: {
                  code: "rate_limit_exceeded",
                  type: "rate_limit_error",
                  message: "slow down 中文🙂",
                  param: null,
                },
              },
            ];
    const rawFrames = errors.map(
      (data) =>
        `\uFEFF: upstream\r\nid: err-7\r\nretry: 200\r\ndata: {\r\ndata: ${JSON.stringify(data).slice(1)}\r\n\r\n`,
    );
    if (protocol === "responses") {
      rawFrames.push(
        event({ response: { error: { code: "rate_limit_exceeded" } } }, "response.failed"),
      );
    }
    rawFrames.push(
      "\uFEFFevent:error\r\ndata: not JSON 中文🙂\r\ndata: second line\r\n\r\n",
      "event: error\ndata: {broken\n\n",
      "event: error\ndata: [DONE]\n\n",
      "event: error\n\n",
    );
    for (const raw of rawFrames) {
      for (const newline of ["\r\n", "\n", "\r"]) {
        const text = raw.replace(/\r\n|\n/g, newline);
        const bytes = encoder.encode(text);
        for (const chunkSize of [1, 2, 7, bytes.length - 1, bytes.length + 1024]) {
          let cancellations = 0;
          const trailing = encoder.encode(event(streamSnapshot(protocol, ["unknown"])));
          const all = new Uint8Array(bytes.length + trailing.length);
          all.set(bytes);
          all.set(trailing, bytes.length);
          const source = chunkedStream(all, {
            chunkSize,
            cancel: () => {
              cancellations++;
            },
          });
          const result = await guardToolResponse(source.response, protocol, policy);
          // One guard run per chunk size in this loop, on a machine that may
          // be running the 32 MiB tests beside it: more headroom than the
          // default budget, so a slow read is not reported as a hang.
          const actual = new Uint8Array(await withTimeout(result.arrayBuffer(), 15_000));
          assert.deepEqual(actual, bytes);
          assert.equal(cancellations, 1);
          assert.equal(source.response.body.locked, false);
          // The chunks the frame was read in, plus at most the one more a CR
          // at a chunk's end makes the reader look ahead for.
          const expected = Math.ceil(bytes.length / chunkSize);
          assert.ok(
            source.pulls() <= expected + 1,
            `read ${source.pulls()} chunks for ${expected} chunks of bytes`,
          );
        }
        // The open-stream half is skipped for CR-only endings, and this is
        // why: the parser has to see the byte after a lone CR to know the
        // frame ended (feed() looks one past it), and a source with
        // highWaterMark 0 that is never pulled again cannot supply it — the
        // guard would wait for an EOF that never comes (reproduced: it hung
        // until the 5 s budget). The chunked half above closes its stream and
        // so covers CR.
        if (newline === "\r") continue;
        let cancelled = false;
        const source = openSource(text, () => {
          cancelled = true;
        });
        const result = await guardToolResponse(source.response, protocol, policy);
        assert.deepEqual(new Uint8Array(await withTimeout(result.arrayBuffer())), bytes);
        assert.equal(cancelled, true);
        assert.equal(source.pulls(), 1);
      }
    }
  });

  test(`${protocol}: upstream SSE errors preserve cancellation failures`, async () => {
    for (const asynchronous of [false, true]) {
      const cause = new DOMException("cancel failed", "AbortError");
      const source = openSource(event("not JSON", "error"), () => {
        if (asynchronous) return Promise.reject(cause);
        throw cause;
      });
      const result = await guardToolResponse(source.response, protocol, policy);
      await assert.rejects(withTimeout(result.arrayBuffer()), (error) => error === cause);
      assert.equal(source.response.body.locked, false);
      assert.equal(source.pulls(), 1);
    }
  });

  test(`${protocol}: HTTP failures return the original unread response`, async () => {
    const source = sse(event(streamSnapshot(protocol, ["unknown"])), { status: 429 });
    assert.equal(await guardToolResponse(source, protocol, policy), source);
    assert.equal(source.bodyUsed, false);
  });

  test(`${protocol}: JSON and SSE remove stale entity headers, retain request metadata`, async () => {
    const headers = {
      "content-length": "42",
      "content-encoding": "gzip",
      "transfer-encoding": "chunked",
      "content-md5": "md5",
      etag: 'W/"stream"',
      "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT",
      "retry-after": "30",
      "x-request-id": "req",
    };
    for (const source of [
      Response.json(snapshot(protocol, ["bash"]), { headers }),
      sse(event(streamSnapshot(protocol, ["bash"])) + terminal(protocol), { headers }),
    ]) {
      const result = await guardToolResponse(source, protocol, policy);
      // What described the upstream's own bytes cannot describe a body this
      // guard may have written again, whichever path wrote it.
      for (const name of [
        "content-length",
        "content-encoding",
        "transfer-encoding",
        "content-md5",
        "etag",
        "last-modified",
      ])
        assert.equal(result.headers.get(name), null, name);
      assert.equal(result.headers.get("retry-after"), "30");
      assert.equal(result.headers.get("x-request-id"), "req");
      await result.text();
    }
  });

  test(`${protocol}: truncated streams emit a protocol error`, async () => {
    for (const text of ["", event({ harmless: true }), 'data: {"unfinished":']) {
      const result = await guardToolResponse(sse(text), protocol, policy);
      assertError(protocol, parse(await result.text()).at(-1).data);
    }
  });

  // The framing of the last event of a stream. The event-stream format
  // dispatches an event on an empty line and discards what is left at the end
  // of the stream; this guard does not, and neither does stream.mjs's
  // collapse path: an event whose lines are whole is an event, and only the
  // empty line that would dispatch it is missing. The guard read that as a
  // stream cut inside an event, and a reply that had been delivered whole was
  // answered with a 502 that threw the text away (measured on the same
  // bytes: two newlines answered 200 with the reply, one newline answered 502
  // with nothing — and the 502 was the guard's own, not the collapse path's).
  test(`${protocol}: a whole last event is read though no empty line follows it`, async () => {
    const whole = event(streamSnapshot(protocol, ["bash"])) + terminal(protocol).replace(/\n\n$/, "\n");
    const guarded = await guardToolResponse(sse(whole), protocol, policy);
    assert.equal(guarded.status, 200, `${protocol}: a whole reply was refused`);
    const text = await guarded.text();
    assert.deepEqual(callsIn(protocol, frameData(text)), ["Bash"], `${protocol}: the call was lost`);
    // The deployment path: the collapse path over the guard's own bytes
    // answers the same reply.
    const collapsed = await collapseResponse(sse(text), protocol);
    assert.equal(collapsed.status, 200, `${protocol}: the collapsed copy refused it`);
    assert.deepEqual(
      callsIn(protocol, [(await collapsed.json())]),
      ["Bash"],
      `${protocol}: the collapsed copy lost the call`,
    );
  });

  // The same reply, one framing difference further: the last line arrives
  // without even its terminator. The bytes of the line are whole, and the
  // event they state is whole — the completion marker is the upstream's own end
  // of the reply — so it is an event, and the two paths over one stream answer
  // one reply. The question is about the content, not about the framing: a line
  // cut in the middle of a JSON is not an event, and that is the other half
  // below.
  test(`${protocol}: a whole last event is read though no terminator follows it`, async () => {
    const whole = event(streamSnapshot(protocol, ["bash"])) + terminal(protocol).replace(/\n\n$/, "");
    const guarded = await guardToolResponse(sse(whole), protocol, policy);
    assert.equal(guarded.status, 200, `${protocol}: a whole reply was refused`);
    const text = await guarded.text();
    assert.deepEqual(callsIn(protocol, frameData(text)), ["Bash"], `${protocol}: the call was lost`);
    const collapsed = await collapseResponse(sse(text), protocol);
    assert.equal(collapsed.status, 200, `${protocol}: the collapsed copy refused it`);
  });

  // The other half of that rule: a stream cut in the middle of its last
  // event is still a cut one. Half a JSON is not an event, and the failure
  // says which of the two it is.
  test(`${protocol}: a last event cut in the middle still fails, and says it was cut`, async () => {
    const cut = event(streamSnapshot(protocol, ["bash"])) + 'data: {"unfinished":';
    const guarded = await guardToolResponse(sse(cut), protocol, policy);
    const frames = parse(await guarded.text());
    const last = frames.at(-1).data;
    assertError(protocol, last);
    assert.match(
      last.message ?? last.error?.message ?? "",
      /stream ended before an event was complete/,
      `${protocol}: the failure does not say the stream was cut before an event was complete`,
    );
  });

  test(`${protocol}: downstream cancellation propagates its reason without pre-reading`, async () => {
    const reason = new Error("client stopped");
    let received;
    const source = openSource(event({ harmless: true }), (value) => {
      received = value;
    });
    const result = await guardToolResponse(source.response, protocol, policy);
    assert.equal(source.pulls(), 0);
    await result.body.cancel(reason);
    assert.equal(received, reason);
    assert.equal(source.pulls(), 0);
    assert.equal(source.response.body.locked, false);
  });

  test(`${protocol}: a transport failure is told in the guard's own shape, not handed over raw`, async () => {
    const cause = new TypeError("upstream aborted");
    const source = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(cause);
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const result = await guardToolResponse(source, protocol, policy);
    const { logged } = await withLog(async () => {
      const text = await result.text();
      // The client reads a failure it can parse, and not the text of the
      // failure inside the guard: an aborted body told it nothing at all, and
      // the message of an internal failure reached it as it came.
      assertError(protocol, parse(text).at(-1).data);
      assert.ok(
        !text.includes("upstream aborted"),
        `the internal failure reached the client: ${text}`,
      );
    });
    // The raw failure is the server's own business, and the server's own log
    // is where it went.
    assert.ok(
      logged.some((line) => line.includes("upstream aborted")),
      `the server's log did not keep the raw failure: ${logged.join(" | ")}`,
    );
    assert.equal(source.body.locked, false);
  });

  // The sentence a host reads is the one it decides from. The transport error
  // behind it stays in the server's log, so the sentence itself has to say
  // what the client did not get: the stream ended before the reply was
  // complete. DeepSeek Harness reads that shape as a transport failure and
  // asks again; "Upstream request failed" alone fell outside every class its
  // retry policy names, so the turn ended there. Both arms say the same
  // sentence: a host that reads a stream and one that reads a whole reply are
  // told the same thing about the same failure.
  test(`${protocol}: an upstream failure says the stream ended before the reply was complete`, async () => {
    const sentence =
      "Upstream request failed: the stream ended before the reply was complete";
    const cause = new TypeError("upstream aborted");
    const streamed = failingBody(cause);
    const { value: text } = await withLog(async () =>
      (await guardToolResponse(streamed.response, protocol, policy)).text(),
    );
    const last = parse(text).at(-1).data;
    assertError(protocol, last);
    assert.equal(
      last.message ?? last.error?.message,
      sentence,
      `${protocol}: the streamed failure does not carry the sentence a host retries on`,
    );
    // The phrase, not just the fact of a failure, is what a host keys on: a
    // rewording that loses it puts the turn back where it was.
    assert.match(last.message ?? last.error?.message, /stream ended (?:before|without)\b/i);

    const whole = failingBody(cause, () => {}, "application/json");
    const { value: response } = await withLog(() =>
      guardToolResponse(whole.response, protocol, policy),
    );
    assert.equal(response.status, 502);
    const body = await response.json();
    assertError(protocol, body, false);
    assert.equal(
      body.message ?? body.error?.message,
      sentence,
      `${protocol}: the whole-reply failure says something else about the same failure`,
    );
  });

  // The other kind of failure that is not the guard's own: the client asked
  // for the request to stop, and the reason it stopped by is a reason it
  // already knows. It is handed over as it came, and it is not the failure
  // the shape above is about.
  test(`${protocol}: an abort the client asked for is handed over as it came`, async () => {
    const cause = new DOMException("The operation was aborted.", "AbortError");
    const source = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(cause);
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const result = await guardToolResponse(source, protocol, policy);
    await assert.rejects(result.text(), (error) => error === cause);
    assert.equal(source.body.locked, false);
  });

  // A Node stream raises its cancellation with a code rather than an
  // `AbortError` name. The streaming arm has to recognise that too, or the
  // client's own cancellation is answered as an upstream failure — a 502 event
  // it cannot act on, for a request it stopped itself.
  test(`${protocol}: a cancellation with Node's code is handed over on the stream`, async () => {
    const cause = Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" });
    const source = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(cause);
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const result = await guardToolResponse(source, protocol, policy);
    await assert.rejects(result.text(), (error) => error === cause);
    assert.equal(source.body.locked, false);
  });

  test(`${protocol}: a transport failure cancels the body rather than only releasing it (#47)`, async () => {
    const cause = new TypeError("terminated");
    const body = failingBody(cause);
    const result = await guardToolResponse(body.response, protocol, policy);
    const { value: text } = await withLog(() => result.text());
    assertError(protocol, parse(text).at(-1).data);
    // The release alone left what was left of the body writing into a socket
    // nobody reads; the cancel is what stops it, and it carries the failure.
    assert.deepEqual(body.cancellations, [cause]);
    assert.equal(body.released, true);
  });

  test(`${protocol}: a failing cancel does not replace the transport error (#47)`, async () => {
    const cause = new TypeError("terminated");
    const body = failingBody(cause, () => {
      throw new Error("cancel failed");
    });
    const result = await guardToolResponse(body.response, protocol, policy);
    const { logged } = await withLog(() => result.text());
    // The cancel's own failure does not stand in for the one that got here:
    // the client is told the failure in the shape every other failure is
    // told in, and the server's log keeps the one that got here.
    assert.ok(
      logged.some((line) => line.includes("terminated")),
      `the server's log did not keep the raw failure: ${logged.join(" | ")}`,
    );
    assert.ok(
      !logged.some((line) => line.includes("cancel failed")),
      `the cancel's failure took the transport failure's place: ${logged.join(" | ")}`,
    );
    assert.equal(body.released, true);
  });

  test(`${protocol}: cancel failures propagate rather than being swallowed`, async () => {
    const cause = new Error("cancel failed");
    for (const badTool of [false, true]) {
      const source = openSource(event(badMixed(protocol)), () => {
        throw cause;
      });
      const result = await guardToolResponse(source.response, protocol, policy);
      await assert.rejects(
        badTool ? result.text() : result.body.cancel("stop"),
        (error) => error === cause,
      );
      assert.equal(source.response.body.locked, false);
    }
  });

  test(`${protocol}: malformed JSON is a protocol-shaped 502`, async () => {
    const result = await guardToolResponse(
      new Response("{broken", { headers: { "content-type": "application/json" } }),
      protocol,
      policy,
    );
    assert.equal(result.status, 502);
    assertError(protocol, await result.json(), false);
  });

  // The whole-reply arm used to rethrow every failure that was not the guard's
  // own, while the streaming arm cancelled the body, logged the raw failure and
  // answered a protocol-shaped 502. One upstream transport failure was then a
  // 502 to a client that streamed and an unhandled rejection to one that did
  // not. The body is read once, and then cancelled and let go of.
  test(`${protocol}: a transport failure in a whole reply is a protocol-shaped 502`, async () => {
    const cause = new TypeError("terminated");
    const body = failingBody(cause, () => {}, "application/json");
    const { logged, value: result } = await withLog(() =>
      guardToolResponse(body.response, protocol, policy),
    );
    assert.equal(result.status, 502);
    assertError(protocol, await result.json(), false);
    assert.ok(
      logged.some((line) => line.includes("terminated")),
      `the server's log did not keep the raw failure: ${logged.join(" | ")}`,
    );
    // The failure cancelled what was left of the body rather than only letting
    // go of the reader (readBounded cancels without a reason), and the body was
    // not read again after the read that failed. A cancellation without a
    // reason is what the read already does, so the reason is what separates
    // this arm from it.
    assert.equal(body.cancellations.length, 1, "the failing body was not cancelled");
    assert.equal(
      body.cancellations[0],
      cause,
      "the failure was not the reason the body was cancelled for",
    );
    assert.equal(body.reads, 1, "the guard kept reading a body whose read had failed");
    assert.equal(body.released, true);
  });

  // The other kind of failure that is not the guard's own, in the whole-reply
  // arm: the client asked for the request to stop. It is handed over as it
  // came, and it is not an upstream failure to log.
  test(`${protocol}: an abort during a whole reply is handed over as it came`, async () => {
    const cause = new DOMException("The operation was aborted.", "AbortError");
    const body = failingBody(cause, () => {}, "application/json");
    const { logged } = await withLog(async () => {
      await assert.rejects(
        guardToolResponse(body.response, protocol, policy),
        (error) => error === cause,
      );
    });
    assert.deepEqual(logged, [], "the client's own abort was logged as an upstream failure");
    assert.equal(body.reads, 1);
    assert.equal(body.released, true);
  });

  // A Node stream raises its cancellation as an `ABORT_ERR`, not as an
  // `AbortError`, and recognising only the name answered a client's own
  // cancellation as a 502 it could not act on.
  test(`${protocol}: a cancellation with Node's code is the client's own`, async () => {
    const cause = Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" });
    const body = failingBody(cause, () => {}, "application/json");
    const { logged } = await withLog(async () => {
      await assert.rejects(
        guardToolResponse(body.response, protocol, policy),
        (error) => error === cause,
      );
    });
    assert.deepEqual(logged, [], "a cancellation with a code was logged as an upstream failure");
  });
}

test("an unsupported protocol is refused before the upstream's status is read (#48)", async () => {
  // The check used to sit behind the !response.ok return, so the same caller
  // mistake was a TypeError over a 200 and an untouched upstream error over a
  // 500: the upstream's status decided whether the mistake was reported.
  for (const status of [200, 500]) {
    await assert.rejects(
      guardToolResponse(Response.json({}, { status }), "bogus", policy),
      (error) => error instanceof TypeError && /Unsupported protocol/.test(error.message),
    );
  }
});

// The names the guard reads the policy for. `new Set(undefined)` does not
// throw — it answers an empty set — so a field that was renamed, or a policy
// built by mistake, used to turn every call of every reply into "a tool this
// agent doesn't have": chat lost every tool call, and Responses and Messages
// calls were rewritten into explanation text, with nothing thrown and nothing
// logged to say why. A policy the guard cannot read is a caller's mistake and
// is refused by name — the same rule, and the same place, as the protocol
// above: before the upstream's status decides whether it is reported.
test("a policy whose declared field cannot be read is refused by name", async () => {
  const rejected = [
    ["a policy with no declared field", {}],
    ["no policy at all", undefined],
    ["a null declared field", { declared: null }],
    ["a declared field that is a string", { declared: "Bash" }],
    ["a declared field that is an object", { declared: { Bash: true } }],
    ["an array holding something that is not a name", { declared: ["Bash", 7] }],
    ["a Set holding something that is not a name", { declared: new Set(["Bash", null]) }],
  ];
  for (const [what, bad] of rejected) {
    for (const status of [200, 500]) {
      await assert.rejects(
        guardToolResponse(Response.json({}, { status }), "chat", bad),
        (error) =>
          error instanceof TypeError &&
          !error.code &&
          /policy\.declared/.test(error.message),
        `${what} was read as a policy of no tools`,
      );
    }
  }
  // The two shapes it does read: what this package's own producer builds, and
  // an array of names — and the guard works the same with either.
  for (const declared of [new Set(["Bash"]), ["Bash"]]) {
    const result = await guardToolResponse(
      Response.json({
        choices: [
          { message: { tool_calls: [{ type: "function", id: "c1", function: { name: "bash", arguments: "{}" } }] } },
        ],
      }),
      "chat",
      { declared },
    );
    assert.equal(result.status, 200);
    assert.equal((await result.json()).choices[0].message.tool_calls[0].function.name, "Bash");
  }
});

// An item id stands in for the item, so two calls left out of one reply that
// arrived without ids cannot be handed the same one: a Responses client keys
// by it, and the streamed path suppresses arguments by it (#49). Both calls
// are nameless — the one shape still left out (#209) — and carry no id of
// their own, so nothing but the place each holds tells the two apart.
test("Responses: dropped calls without ids are replaced by items with distinct ids", async () => {
  const output = [0, 1].map(() => ({ type: "function_call", name: "", arguments: "{}" }));
  const json = await guardToolResponse(Response.json({ output }), "responses", policy);
  assert.equal(json.status, 200);
  const items = (await json.json()).output;
  assert.deepEqual(
    items.map((item) => item.content[0].text),
    [droppedNote(""), droppedNote("")],
  );
  assert.equal(new Set(items.map((item) => item.id)).size, 2, "two items shared one id");
  const streamed = await guardToolResponse(
    sse(
      event({ type: "response.output_item.added", output_index: 0, item: output[0] }) +
        event({ type: "response.output_item.added", output_index: 1, item: output[1] }) +
        event({ type: "response.completed", response: { output } }, "response.completed"),
    ),
    "responses",
    policy,
  );
  assert.equal(streamed.status, 200);
  const added = frameData(await streamed.text()).filter(
    (data) => data.type === "response.output_item.added",
  );
  assert.equal(new Set(added.map((data) => data.item.id)).size, 2, "two added items shared one id");
});

// One call is replaced more than once — the frame that opens it, the frame that
// closes it, and the copy inside the terminal response's output — and a client
// keys an item by its id. A counter that gave every replacement a fresh id made
// one call into several items and left the arguments frames of it unmatched: the
// call's place in the reply is the same in all three, so that is what the
// invented id names. The call is nameless, so the three copies are all that
// say it is one call, and an id of `undefined` on all three would satisfy a
// set-equality check while proving nothing: the id is asserted to exist.
test("Responses: one dropped call keeps one id across its added, done and terminal copies", async () => {
  const call = { type: "function_call", name: "", arguments: "{}" };
  const streamed = await guardToolResponse(
    sse(
      event({ type: "response.output_item.added", output_index: 0, item: call }) +
        event({ type: "response.output_item.done", output_index: 0, item: call }) +
        event({ type: "response.completed", response: { output: [call] } }, "response.completed"),
    ),
    "responses",
    policy,
  );
  assert.equal(streamed.status, 200);
  const data = frameData(await streamed.text());
  const replaced = data
    .filter(
      (value) =>
        value.type === "response.output_item.added" ||
        value.type === "response.output_item.done",
    )
    .map((value) => value.item.id);
  // Not named `terminal`: this file's `terminal(protocol)` helper is the module's
  // own, and a frame called by the same name would have hidden it from here on.
  const terminalFrame = data.find((value) => value.type === "response.completed");
  assert.equal(replaced.length, 2, "both item frames are answered");
  for (const id of replaced)
    assert.equal(typeof id, "string", `a replacement was handed no id: ${id}`);
  assert.equal(new Set(replaced).size, 1, "one call became several items");
  assert.equal(
    terminalFrame.response.output[0].id,
    replaced[0],
    "and the terminal's copy is that same item",
  );
});

// Both arms invent ids within one reply, so they cannot share a word: a counter
// that reached another call's index handed two unrelated calls the same item —
// the failure the counter itself exists to prevent — and a client that keys by
// id then reads one call's arguments as the other's.
test("Responses: a call the reply places nowhere never shares an id with a placed one", async () => {
  const placed = Array.from({ length: 64 }, () => ({
    type: "function_call",
    name: "",
    arguments: "{}",
  }));
  const response = await guardToolResponse(
    Response.json({
      item: { type: "function_call", name: "", arguments: "{}" },
      output: placed,
    }),
    "responses",
    policy,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  const ids = [body.item, ...body.output].map((item) => item.id);
  assert.equal(ids.length, placed.length + 1);
  assert.equal(
    new Set(ids).size,
    ids.length,
    `two dropped calls shared an id: ${ids.filter((id, at) => ids.indexOf(id) !== at).join(", ")}`,
  );
  assert.match(
    body.item.id,
    /^msg_anon_\d+$/,
    "the placeless call is the counter's, under a word of its own",
  );
});

// The id an item is keyed by has to be the same one every time the same call
// is replaced, and the frames of the reply are all the guard has to tell one
// call from another: a stream that carries no output_index and no item id
// leaves the place of each call to the order it opens them in. A counter per
// rewrite made one dropped call three items to the client — its added frame,
// its done frame and the terminal's copy of it each answered a different id —
// and left the call's arguments frames, which name an item the reply never
// opened an item for, forwarded to describe an item that was replaced.
// Collapsing the same bytes for a client that reads no stream then refused
// them ("an unknown item without an output index") where the streaming client
// was given a reply, so the two paths disagreed about the same upstream.
test("Responses: a dropped call the frames place nowhere answers one id, in both paths", async () => {
  const call = { type: "function_call", name: "", arguments: "" };
  const text =
    event({ type: "response.output_item.added", item: call }) +
    event({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"a"' }) +
    event({
      type: "response.function_call_arguments.done",
      item_id: "fc_1",
      arguments: '{"a":1}',
    }) +
    event({ type: "response.output_item.done", item: { ...call, arguments: '{"a":1}' } }) +
    event(
      { type: "response.completed", response: { status: "completed", output: [{ ...call, arguments: '{"a":1}' }] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const data = frameData(await streamed.text());
  const items = [
    ...data.filter((value) => value.item).map((value) => value.item),
    ...(data.find((value) => value.type === "response.completed")?.response.output ?? []),
  ];
  assert.equal(new Set(items.map((item) => item.id)).size, 1, "one call became several items");
  assert.equal(items[0].id, items[1].id, "the done frame answers the added frame's id");
  assert.ok(
    !data.some((value) => value.type?.startsWith("response.function_call_arguments")),
    "the arguments of a call that was left out reached the client",
  );
  assert.deepEqual(callsIn("responses", data), []);
  assert.equal(textIn("responses", data), droppedNote(""));
  // The bytes the same upstream sent, collapsed for a client that reads no
  // stream: a reply saying the call was left out, not a 502 about an item.
  const collapsed = await collapseResponse(
    await guardToolResponse(sse(text), "responses", policy),
    "responses",
  );
  assert.equal(collapsed.status, 200);
  const body = await collapsed.json();
  assert.equal(body.output.length, 1);
  assert.equal(body.output[0].content[0].text, droppedNote(""));
});

// The other side of that rule: a call the reply named nowhere is not the only
// item a stream can hold, and the frames of one the agent does have must not
// be swallowed with it — a frame naming an item the reply did name on an item
// of its own belongs to that item. The frames of the call that was left out
// are left out with it (they used to be forwarded, describing an item the
// client was told was replaced by a note). The call left out is nameless — the
// one shape still left out (#209) — so what must not leak is not a name but
// the call itself: its item and the arguments frames that describe it.
test("Responses: a placeless call's arguments are left out with it, and one the agent has keeps its own", async () => {
  const kept = { type: "function_call", name: "bash", arguments: "" };
  const text =
    event({ type: "response.output_item.added", item: { type: "function_call", name: "", arguments: "" } }) +
    event({ type: "response.function_call_arguments.delta", item_id: "fc_dropped", delta: "{}" }) +
    event({ type: "response.output_item.added", item: kept }) +
    event({ type: "response.function_call_arguments.delta", item_id: "fc_kept", delta: '{"command":"ls"}' }) +
    event({ type: "response.function_call_arguments.done", item_id: "fc_kept", arguments: '{"command":"ls"}' }) +
    event({ type: "response.output_item.done", item: kept }) +
    event({ type: "response.completed", response: { status: "completed", output: [kept] } }, "response.completed");
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const data = frameData(await streamed.text());
  const forwarded = data.filter((value) =>
    value.type?.startsWith("response.function_call_arguments"),
  );
  assert.deepEqual(
    forwarded.map((value) => value.item_id),
    ["fc_kept", "fc_kept"],
    "the kept call's arguments frames were left out with another call",
  );
  // The kept call is copied into its added frame, its done frame and the
  // terminal response, so its name is read once per copy; the call left out is
  // replaced by the note, and no item shaped like a call is left without a
  // name — that is the whole of what is left of it.
  assert.deepEqual([...new Set(callsIn("responses", data))], ["Bash"]);
  assert.ok(
    !data.some((value) => value.item && callShaped(value.item.type) && !value.item.name),
    "the nameless call's item reached the client",
  );
  assert.equal(textIn("responses", data), droppedNote(""));
});

// F2 (review, v0.2.16): the suppression above matched a call left out by the
// output_index its own frame gave or by an invented id, and the arguments
// frames of the measured route carry neither — the item is numbered, and the
// frames after it name it by an id. Those frames went to the client, telling
// it about an item it had been told was replaced by a note, and the guard's
// own bytes could not be read back at all: the collapse path took the frame
// for one naming an unknown item without an index and refused the whole reply
// (502), where the upstream's own bytes are a 200. Every word the call is
// named by is what its frames are matched by now, and a declared call beside
// it keeps every one of its own.
test("Responses: a dropped call that gave an index keeps its arguments frames out, in both paths", async () => {
  const dropped = { type: "function_call", call_id: "call_x", name: "", arguments: "" };
  const kept = { id: "fc_2", type: "function_call", call_id: "call_2", name: "bash", arguments: "" };
  const completed = (item, extra) => ({ ...item, arguments: extra, status: "completed" });
  const text =
    event(
      { type: "response.output_item.added", output_index: 0, item: { ...dropped, status: "in_progress" } },
      "response.output_item.added",
    ) +
    event(
      { type: "response.function_call_arguments.delta", item_id: "call_x", delta: '{"a"' },
      "response.function_call_arguments.delta",
    ) +
    event(
      { type: "response.function_call_arguments.done", item_id: "call_x", arguments: '{"a":1}' },
      "response.function_call_arguments.done",
    ) +
    event(
      { type: "response.output_item.added", output_index: 1, item: { ...kept, status: "in_progress" } },
      "response.output_item.added",
    ) +
    event(
      { type: "response.function_call_arguments.delta", item_id: "fc_2", output_index: 1, delta: '{"command":' },
      "response.function_call_arguments.delta",
    ) +
    event(
      { type: "response.function_call_arguments.done", item_id: "fc_2", output_index: 1, arguments: '{"command":"ls"}' },
      "response.function_call_arguments.done",
    ) +
    event({ type: "response.output_item.done", output_index: 0, item: completed(dropped, '{"a":1}') }) +
    event({ type: "response.output_item.done", output_index: 1, item: completed(kept, '{"command":"ls"}') }) +
    event(
      {
        type: "response.completed",
        response: { id: "r1", status: "completed", output: [completed(dropped, '{"a":1}'), completed(kept, '{"command":"ls"}')] },
      },
      "response.completed",
    );
  // The same bytes upstream, collapsed for a client that reads no stream: a
  // reply, not a refusal.
  assert.equal((await collapseResponse(sse(text), "responses")).status, 200);
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const guarded = await streamed.text();
  const data = frameData(guarded);
  // (c) no frame describes the call that was replaced by a note, and (d) the
  // declared call's arguments are all there.
  assert.deepEqual(
    data
      .filter((value) => value.type?.startsWith("response.function_call_arguments"))
      .map((value) => value.item_id),
    ["fc_2", "fc_2"],
    "a call left out kept its arguments frames, or a kept call lost its own",
  );
  // The words the client is handed: the note item's invented id, and the kept
  // call's own. The dropped call's call_id is nowhere on its own — the frames
  // that named it are the ones that were left out.
  assert.deepEqual(
    [
      ...new Set([
        ...data.flatMap((value) => (value.item_id !== undefined ? [value.item_id] : [])),
        ...data.filter((value) => value.item).map((value) => value.item.id),
        ...(data.find((value) => value.type === "response.completed")?.response.output ?? []).map(
          (item) => item.id,
        ),
      ]),
    ].sort(),
    ["fc_2", "msg_call_x"],
  );
  assert.equal(textIn("responses", data), droppedNote(""));
  // (b) The guard's own bytes, read back: the same reply, not the 502 they
  // were refused with, and the same items the stream handed the client.
  const collapsed = await collapseResponse(sse(guarded), "responses");
  assert.equal(collapsed.status, 200);
  const items = (await collapsed.json()).output.map((item) => `${item.id}:${item.type}`).sort();
  const handed = [
    ...new Set([
      ...data.filter((value) => value.item).map((value) => `${value.item.id}:${value.item.type}`),
      ...(data.find((value) => value.type === "response.completed")?.response.output ?? []).map(
        (item) => `${item.id}:${item.type}`,
      ),
    ]),
  ].sort();
  assert.deepEqual(items, handed, "the streamed reply and its collapsed copy disagree");
  assert.deepEqual(items, ["fc_2:function_call", "msg_call_x:message"]);
});

// The other half of that shape: the frame that opens the call can carry
// nothing at all to name it by, and the id only turns up on the arguments
// frames and the frame that closes it. Those frames name an item the reply
// names nowhere else, and the stream inside the call is what says whose they
// are. The call answers one id throughout — the id its opening frame was
// replaced by, which is what the client already has.
test("Responses: a dropped call its frames name nowhere else answers the one id it was given", async () => {
  const bare = { type: "function_call", name: "", arguments: "" };
  const named = { ...bare, id: "fc_9", arguments: '{"a":1}', status: "completed" };
  const text =
    event(
      { type: "response.output_item.added", output_index: 0, item: { ...bare, status: "in_progress" } },
      "response.output_item.added",
    ) +
    event(
      { type: "response.function_call_arguments.delta", item_id: "fc_9", delta: '{"a"' },
      "response.function_call_arguments.delta",
    ) +
    event(
      { type: "response.function_call_arguments.done", item_id: "fc_9", arguments: '{"a":1}' },
      "response.function_call_arguments.done",
    ) +
    event({ type: "response.output_item.done", output_index: 0, item: named }) +
    event(
      { type: "response.completed", response: { id: "r1", status: "completed", output: [named] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const guarded = await streamed.text();
  const data = frameData(guarded);
  assert.deepEqual(
    data.filter((value) => value.type?.startsWith("response.function_call_arguments")).map((v) => v.item_id),
    [],
    "the arguments of a call that was left out reached the client",
  );
  const ids = [
    ...data.filter((value) => value.item).map((value) => value.item.id),
    ...(data.find((value) => value.type === "response.completed")?.response.output ?? []).map(
      (item) => item.id,
    ),
  ];
  assert.deepEqual(ids, ["msg_dropped_0", "msg_dropped_0", "msg_dropped_0"]);
  const collapsed = await collapseResponse(sse(guarded), "responses");
  assert.equal(collapsed.status, 200);
  assert.deepEqual(
    (await collapsed.json()).output.map((item) => item.id),
    ["msg_dropped_0"],
  );
});

// The difference the suppression above makes: an id the reply later names on
// an item of its own is that item's, whatever a call left out was named by
// before it. A kept call whose arguments frames name the id it was opened
// with keeps them, though a call left out of the same reply answered the same
// word.
test("Responses: a kept call's arguments survive an id a dropped call was named by", async () => {
  const dropped = { type: "function_call", call_id: "shared", name: "", arguments: "" };
  const kept = { id: "shared", type: "function_call", call_id: "call_2", name: "bash", arguments: "" };
  const text =
    event(
      { type: "response.output_item.added", output_index: 0, item: { ...dropped, status: "in_progress" } },
      "response.output_item.added",
    ) +
    event(
      { type: "response.function_call_arguments.delta", item_id: "shared", delta: '{"a"' },
      "response.function_call_arguments.delta",
    ) +
    event(
      { type: "response.output_item.added", output_index: 1, item: { ...kept, status: "in_progress" } },
      "response.output_item.added",
    ) +
    event(
      { type: "response.function_call_arguments.delta", item_id: "shared", delta: '{"command":' },
      "response.function_call_arguments.delta",
    ) +
    event(
      { type: "response.function_call_arguments.done", item_id: "shared", arguments: '{"command":"ls"}' },
      "response.function_call_arguments.done",
    ) +
    event({ type: "response.output_item.done", output_index: 1, item: { ...kept, arguments: '{"command":"ls"}', status: "completed" } }) +
    event(
      { type: "response.completed", response: { id: "r1", status: "completed", output: [{ ...kept, arguments: '{"command":"ls"}', status: "completed" }] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const data = frameData(await streamed.text());
  assert.deepEqual(
    data
      .filter((value) => value.type?.startsWith("response.function_call_arguments"))
      .map((value) => [value.type.replace("response.function_call_arguments.", ""), value.item_id]),
    [
      ["delta", "shared"],
      ["done", "shared"],
    ],
    "the kept call's arguments were left out with another call",
  );
});

// F4 (review, v0.2.16): "" is not a name. `identified` read a call_id of ""
// as an identity, so the call was not given a place, while inPlaceOf's
// `call_id ?? …` read the same "" as present — and two such calls of one
// reply became the one item `msg_`, with their arguments frames matching
// neither. The three places that ask whether a call has an identity ask it
// the same way now: a non-empty string, or nothing. The two calls are
// nameless — the one shape still left out (#209) — so the empty call_id is the
// only word either of them carries, and it names neither.
test('Responses: two calls with a call_id of "" are two items, not one', async () => {
  const output = [0, 1].map(() => ({
    type: "function_call",
    call_id: "",
    name: "",
    arguments: "{}",
  }));
  const json = await guardToolResponse(Response.json({ output }), "responses", policy);
  assert.equal(json.status, 200);
  const items = (await json.json()).output;
  assert.deepEqual(
    items.map((item) => item.content[0].text),
    [droppedNote(""), droppedNote("")],
  );
  assert.deepEqual(
    items.map((item) => item.id),
    ["msg_dropped_0", "msg_dropped_1"],
    "an empty call_id named nothing, yet the two calls became one item",
  );
  // The streamed shape: the calls are placeless (nothing names them), so each
  // answers a token of its own, and the arguments frames naming "" are left
  // out with them rather than describing the notes in their place.
  const bare = () => ({ type: "function_call", call_id: "", name: "", arguments: "" });
  const text =
    event({ type: "response.output_item.added", item: bare() }, "response.output_item.added") +
    event({ type: "response.function_call_arguments.delta", item_id: "", delta: "{}" }, "response.function_call_arguments.delta") +
    event({ type: "response.output_item.added", item: bare() }, "response.output_item.added") +
    event({ type: "response.function_call_arguments.done", item_id: "", arguments: "{}" }, "response.function_call_arguments.done") +
    event({ type: "response.output_item.done", item: bare() }) +
    event({ type: "response.output_item.done", item: bare() }) +
    event(
      { type: "response.completed", response: { status: "completed", output: [bare(), bare()] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const data = frameData(await streamed.text());
  // Every call answers one id across the three copies of it: the frame that
  // opens it, the frame that closes it, and the copy inside the terminal. The
  // copies arrive in the stream's own order, so the ids are read per group and
  // each call must own exactly one of each — the first call's closing copy
  // answering the second call's id (which is what matching the last entry of
  // the name alone did) leaves the first call unclosed and this fails.
  const added = data
    .filter((value) => value.type === "response.output_item.added")
    .map((value) => value.item.id);
  const done = data
    .filter((value) => value.type === "response.output_item.done")
    .map((value) => value.item.id);
  const terminal = (
    data.find((value) => value.type === "response.completed")?.response.output ?? []
  ).map((item) => item.id);
  assert.equal(added.length, 2, "the stream opened two calls");
  assert.equal(new Set(added).size, 2, `two calls shared one item: ${added.join(", ")}`);
  assert.deepEqual(
    [...done].sort(),
    [...added].sort(),
    `the closing copies answered ids the added frames never opened: ${done.join(", ")}`,
  );
  assert.deepEqual(
    terminal,
    added,
    `the terminal's copies answered other ids than the frames: ${terminal.join(", ")}`,
  );
  for (const id of added)
    assert.equal(
      done.filter((value) => value === id).length,
      1,
      `call ${id} was closed ${done.filter((value) => value === id).length} times: ${done.join(", ")}`,
    );
  assert.deepEqual(
    data.filter((value) => value.type?.startsWith("response.function_call_arguments")).map((v) => v.item_id),
    [],
    "the arguments frames of the calls left out reached the client",
  );
});

// A closing copy that arrives twice is one call, not two. The first copy
// answers the entry and settles it; the second has no unsettled entry of that
// name left to match, so the name itself is the only thing it can be read by.
// A rule that preferred unsettled entries and had no settled fallback would
// fall through to the minting path here and hand the client a second item for
// one call, while the terminal's copy of it answered the first id. This is the
// case that keeps that simplification from being made.
test("Responses: a closing copy that arrives twice answers the call it closes", async () => {
  const bare = () => ({ type: "function_call", name: "", arguments: "{}" });
  const text =
    event({ type: "response.output_item.added", item: bare() }, "response.output_item.added") +
    event({ type: "response.output_item.done", item: bare() }) +
    event({ type: "response.output_item.done", item: bare() }) +
    event(
      { type: "response.completed", response: { status: "completed", output: [bare()] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const data = frameData(await streamed.text());
  const added = data.filter((value) => value.type === "response.output_item.added").map((v) => v.item.id);
  const done = data.filter((value) => value.type === "response.output_item.done").map((v) => v.item.id);
  const terminal = (data.find((value) => value.type === "response.completed")?.response.output ?? [])
    .map((item) => item.id);
  assert.equal(added.length, 1, "the stream opened one call");
  assert.equal(done.length, 2, "both closing copies reached the client");
  assert.deepEqual(
    [...done, ...terminal],
    [added[0], added[0], added[0]],
    `the copies of one call answered more than one id: added ${added.join(", ")}, done ${done.join(", ")}, terminal ${terminal.join(", ")}`,
  );
});

// A snapshot's output list is not always the reply's whole output: a
// `response.created` can carry the one item the stream is working on, at a
// position that means nothing about the order the stream opened its calls in.
// The place is read first, but an entry the stream has already answered there
// is not the call this copy belongs to — the copy that follows the closing
// frame of the first call is the second one's, and answering by place alone
// handed the second call the first call's id.
test("Responses: a partial snapshot's copy answers the call the stream is still inside", async () => {
  const bare = (name) => ({ type: "function_call", name, arguments: "" });
  const text =
    event({ type: "response.output_item.added", item: bare("") }, "response.output_item.added") +
    event({ type: "response.output_item.done", item: bare("") }) +
    event({ type: "response.output_item.added", item: bare("") }, "response.output_item.added") +
    // The snapshot carries the second call only, and puts it first.
    event(
      {
        type: "response.created",
        response: { id: "r1", status: "in_progress", output: [bare("")] },
      },
      "response.created",
    ) +
    event(
      { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const data = frameData(await streamed.text());
  const added = data
    .filter((value) => value.type === "response.output_item.added")
    .map((value) => value.item.id);
  const done = data.find((value) => value.type === "response.output_item.done").item.id;
  const snapshot = data.find((value) => value.type === "response.created").response.output[0].id;
  assert.equal(added.length, 2, "the stream opened two calls");
  assert.notEqual(added[0], added[1], "the two calls answered one id");
  assert.equal(done, added[0], "the closing copy did not answer the call it closes");
  assert.equal(
    snapshot,
    added[1],
    "the partial snapshot's copy answered the call the stream had already closed",
  );
});

// The same call read the other way round: a call_id of null was never an
// identity, and two of those calls were two items already. It is what the
// empty string has to read like, so the two shapes are pinned side by side.
test("Responses: two calls with a call_id of null are two items, as they always were", async () => {
  const output = [0, 1].map(() => ({
    type: "function_call",
    call_id: null,
    name: "",
    arguments: "{}",
  }));
  const response = await guardToolResponse(Response.json({ output }), "responses", policy);
  assert.equal(response.status, 200);
  const items = (await response.json()).output;
  assert.deepEqual(
    items.map((item) => item.id),
    ["msg_dropped_0", "msg_dropped_1"],
  );
  const collapsed = await collapseResponse(Response.json({ output }), "responses");
  assert.equal(collapsed.status, 200);
});

// F5 (review, v0.2.16): one call is replaced more than once — the frame that
// opens it, the frame that closes it, and the copy inside the terminal
// response — and a client keys an item by the id it was handed. The measured
// route names the call only partway through: the added frame carries no id,
// and the done frame and the terminal's copy carry one. Answering that id
// where the call's place had already answered a token made one call two items
// to the client. The id a stream has answered for a call is what every later
// copy of it answers.
test("Responses: a dropped call answers one id, though a later copy carries its own", async () => {
  const opened = { type: "function_call", name: "", arguments: "" };
  const named = { ...opened, id: "fc_1", call_id: "call_1", arguments: '{"a":1}', status: "completed" };
  const text =
    event(
      { type: "response.output_item.added", item: { ...opened, status: "in_progress" } },
      "response.output_item.added",
    ) +
    event({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"a"' }, "response.function_call_arguments.delta") +
    event({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"a":1}' }, "response.function_call_arguments.done") +
    event({ type: "response.output_item.done", item: named }) +
    event(
      { type: "response.completed", response: { id: "r1", status: "completed", output: [named] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const guarded = await streamed.text();
  const data = frameData(guarded);
  const ids = [
    ...data.filter((value) => value.item).map((value) => value.item.id),
    ...(data.find((value) => value.type === "response.completed")?.response.output ?? []).map(
      (item) => item.id,
    ),
  ];
  assert.equal(ids.length, 3, "the added frame, the done frame and the terminal's copy");
  assert.equal(new Set(ids).size, 1, `one call became ${new Set(ids).size} items: ${ids.join(", ")}`);
  assert.match(ids[0], /^msg_anon_\d+$/, "the id the frames answered is the one kept");
  // And the guard's own bytes read back as the same item, not as two.
  const collapsed = await collapseResponse(sse(guarded), "responses");
  assert.equal(collapsed.status, 200);
  assert.deepEqual(
    (await collapsed.json()).output.map((item) => item.id),
    [ids[0]],
  );
});

// task-11, residual 2: a dropped call with nothing to place it by, and then a
// call the reply numbered. The note the guard puts in the first one's place is
// an item of its own with no index, and the collapse path's "next free slot"
// gave it the very slot the numbered call then claimed: the streaming client
// was told the call had been left out, the client that reads no stream never
// heard of it. The bytes the guard answers with are a reply to both, which is
// the invariant this file's every rewrite is measured against.
test("Responses: a dropped placeless call beside a numbered one is one reply to both clients", async () => {
  const dropped = { type: "function_call", id: "d1", name: "", arguments: "" };
  const kept = { id: "k1", type: "function_call", name: "bash", arguments: "" };
  const text =
    event({ type: "response.output_item.added", item: { ...dropped, status: "in_progress" } }) +
    event({ type: "response.function_call_arguments.delta", item_id: "d1", delta: '{"x":3}' }) +
    event({ type: "response.function_call_arguments.done", item_id: "d1", arguments: '{"x":3}' }) +
    event({ type: "response.output_item.done", item: { ...dropped, arguments: '{"x":3}', status: "completed" } }) +
    event({ type: "response.output_item.added", output_index: 0, item: { ...kept, arguments: "", status: "in_progress" } }) +
    event({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "k1", delta: '{"k":1}' }) +
    event({ type: "response.function_call_arguments.done", output_index: 0, item_id: "k1", arguments: '{"k":1}' }) +
    event({ type: "response.output_item.done", output_index: 0, item: { ...kept, arguments: '{"k":1}', status: "completed" } }) +
    event(
      { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const guarded = await streamed.text();
  const data = frameData(guarded);
  const collapsed = await collapseResponse(sse(guarded), "responses");
  assert.equal(collapsed.status, 200, "the guard's own bytes are not a reply");
  const items = (await collapsed.json()).output;
  assert.equal(items.length, 2, "the note and the declared call are two items, not one");
  assert.deepEqual(
    items.map((item) => (item.type === "message" ? "message" : `${item.id}:${item.type}`)).sort(),
    ["k1:function_call", "message"],
  );
  // The note answers a token of the guard's own (its count is the process's,
  // so the shape is what is pinned here), and it is the text of the call that
  // was left out.
  assert.match(items.find((item) => item.type === "message").id, /^msg_anon_\d+$/);
  assert.equal(textIn("responses", data), droppedNote(""), "the note reached the stream");
  assert.deepEqual(
    data
      .filter((value) => value.type?.startsWith("response.function_call_arguments"))
      .map((value) => [value.item_id, value.type.endsWith(".done") ? value.arguments : value.delta]),
    [
      ["k1", '{"k":1}'],
      ["k1", '{"k":1}'],
    ],
    "the declared call's arguments, or a call left out kept its own",
  );
});

// task-11, residual 3: one id, two items — the kept call is named X by the
// reply, and so is the call the guard leaves out. The dropped call's frames
// describe an item that was replaced by a note, so they are left out in either
// order; the answer used to be read off two sets of words subtracted from each
// other, which made it depend on which call came first — the kept call's word
// let the dropped call's frames through when the kept call was the first one.
// It is read off the places the reply's items hold now. The note is the guard's
// own item and is named in the guard's own namespace, so the word the kept
// item holds names one item again, and both clients read the same reply.
test("Responses: one id on two items leaves the dropped call's frames out in both orders", async () => {
  const frames = (name, index, payload, argsShape) => {
    const where = argsShape === "both" ? { output_index: index, item_id: "X" } : { item_id: "X" };
    return [
      event({
        type: "response.output_item.added",
        output_index: index,
        item: { type: "function_call", id: "X", name, arguments: "" },
      }),
      event({ type: "response.function_call_arguments.delta", ...where, delta: payload }),
      event({ type: "response.function_call_arguments.done", ...where, arguments: payload }),
      event({
        type: "response.output_item.done",
        output_index: index,
        item: { type: "function_call", id: "X", name, arguments: payload, status: "completed" },
      }),
    ].join("");
  };
  const kept = frames("bash", 0, '{"k":1}', "both");
  const dropped = frames("", 1, '{"d":1}', "item_id");
  const end = event(
    { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
    "response.completed",
  );
  for (const [what, text] of [
    ["the kept call first", kept + dropped + end],
    ["the dropped call first", dropped + kept + end],
  ]) {
    const streamed = await guardToolResponse(sse(text), "responses", policy);
    assert.equal(streamed.status, 200, what);
    const guarded = await streamed.text();
    const data = frameData(guarded);
    // The dropped call's frames carry its own payload and no place of their
    // own; the kept call's carry theirs and their place.
    assert.deepEqual(
      data
        .filter((value) => value.type?.startsWith("response.function_call_arguments"))
        .map((value) => [value.item_id, value.output_index, value.delta ?? value.arguments]),
      [
        ["X", 0, '{"k":1}'],
        ["X", 0, '{"k":1}'],
      ],
      `${what}: a call left out kept its arguments frames`,
    );
    assert.ok(
      !JSON.stringify(data).includes('"d":1'),
      `${what}: the dropped call's arguments reached the client`,
    );
    // The note does not take the word the kept item holds: one id, one item.
    const ids = [
      ...data.filter((value) => value.item).map((value) => value.item.id),
      ...(data.find((value) => value.type === "response.completed")?.response.output ?? []).map(
        (item) => item.id,
      ),
    ];
    assert.deepEqual([...new Set(ids)].sort(), ["X", "msg_dropped_1"], what);
    const collapsed = await collapseResponse(sse(guarded), "responses");
    assert.equal(collapsed.status, 200, `${what}: the guard's own bytes are not a reply`);
    assert.deepEqual(
      (await collapsed.json()).output.map((item) => `${item.id}:${item.type}`).sort(),
      ["X:function_call", "msg_dropped_1:message"],
      `${what}: the streamed reply and its collapsed copy disagree`,
    );
  }
});

// F5, second round: the frame that closes a call can carry nothing at all — no
// word of its own and no index — while the frame that opened it named the call
// by a call_id and gave it no index. Recognising the closing frame used to
// need a word in the opening frame, so it minted an id of its own: one call
// answered two ids, one of which no added frame had ever opened, and the
// guard's own bytes could not be collapsed (502 — the invariant F2 exists for).
// The entry a placeless call leaves in the stream is what says which call a
// frame with nothing to name it by belongs to, and it carries the id the guard
// answered for it, whichever word the opening frame had.
test("Responses: a dropped call whose closing frame carries nothing answers the id it opened with", async () => {
  const T = (output) =>
    event(
      {
        type: "response.completed",
        response: { id: "r1", status: "completed", ...(output === undefined ? {} : { output }) },
      },
      "response.completed",
    );
  const added = (item) => event({ type: "response.output_item.added", item });
  const done = (item) => event({ type: "response.output_item.done", item });
  const dropped = { type: "function_call", name: "", arguments: '{"d":1}', status: "completed" };
  const shapes = {
    "named by a call_id": [
      added({ type: "function_call", call_id: "c1", name: "", arguments: "" }),
      event({ type: "response.function_call_arguments.delta", item_id: "c1", delta: '{"d":1}' }),
      event({ type: "response.function_call_arguments.done", item_id: "c1", arguments: '{"d":1}' }),
      done(dropped),
      T([]),
    ],
    "named by an id, with the terminal's copy carrying nothing": [
      added({ type: "function_call", id: "i1", name: "", arguments: "" }),
      event({ type: "response.function_call_arguments.delta", item_id: "i1", delta: '{"d":1}' }),
      event({ type: "response.function_call_arguments.done", item_id: "i1", arguments: '{"d":1}' }),
      done(dropped),
      T([{ ...dropped }]),
    ],
    "beside a declared call": [
      added({ type: "function_call", call_id: "c1", name: "", arguments: "" }),
      event({ type: "response.function_call_arguments.delta", item_id: "c1", delta: '{"d":1}' }),
      event({ type: "response.function_call_arguments.done", item_id: "c1", arguments: '{"d":1}' }),
      done(dropped),
      added({ type: "function_call", id: "k1", name: "bash", arguments: "" }),
      event({ type: "response.function_call_arguments.delta", item_id: "k1", delta: '{"k":1}' }),
      event({ type: "response.function_call_arguments.done", item_id: "k1", arguments: '{"k":1}' }),
      done({ type: "function_call", id: "k1", name: "bash", arguments: '{"k":1}', status: "completed" }),
      T([]),
    ],
  };
  for (const [what, text] of Object.entries(shapes)) {
    const streamed = await guardToolResponse(sse(text.join("")), "responses", policy);
    assert.equal(streamed.status, 200, what);
    const guarded = await streamed.text();
    const data = frameData(guarded);
    const replaced = data
      .filter((value) => value.item?.type === "message")
      .map((value) => value.item.id);
    assert.equal(replaced.length, 2, `${what}: the added frame and the done frame`);
    assert.equal(new Set(replaced).size, 1, `${what}: one call answered ${JSON.stringify(replaced)}`);
    // Every frame the guard's own item answers with names that same id, and
    // the terminal's copy of it does too.
    const named = [
      ...new Set(
        data
          .map((value) => value.item_id)
          .filter((id) => typeof id === "string" && id.startsWith("msg_")),
      ),
    ];
    const terminal = (data.find((value) => value.type === "response.completed")?.response.output ?? [])
      .filter((item) => item.type === "message")
      .map((item) => item.id);
    assert.deepEqual(named, [replaced[0]], what);
    for (const id of terminal) assert.equal(id, replaced[0], what);
    // And the bytes are a reply the collapse path reads back as that one item
    // (plus the declared call, where there is one).
    const collapsed = await collapseResponse(sse(guarded), "responses");
    assert.equal(collapsed.status, 200, `${what}: the guard's own bytes are not a reply`);
    const items = (await collapsed.json()).output;
    assert.equal(items.length, what === "beside a declared call" ? 2 : 1, what);
    assert.deepEqual(
      items.map((item) => [item.type, item.id]),
      what === "beside a declared call"
        ? [
            ["message", replaced[0]],
            ["function_call", "k1"],
          ]
        : [["message", replaced[0]]],
      what,
    );
  }
});

// Two items stating one output_index, one of them a call left out: the place
// cannot say whose arguments frame it is, and reading it alone swallowed the
// declared call's frames along with the dropped call's. The word the frame
// names is what is left to read, and a word the reply kept an item under is
// that item's.
test("Responses: two items stating one index leave the declared call its arguments", async () => {
  const text =
    event({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "d1", name: "", arguments: "" } }) +
    event({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "d1", delta: '{"dropped":1}' }) +
    event({ type: "response.function_call_arguments.done", output_index: 1, item_id: "d1", arguments: '{"dropped":1}' }) +
    event({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "k1", name: "bash", arguments: "" } }) +
    event({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "k1", delta: '{"kept":1}' }) +
    event({ type: "response.function_call_arguments.done", output_index: 1, item_id: "k1", arguments: '{"kept":1}' }) +
    event(
      { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const guarded = await streamed.text();
  const data = frameData(guarded);
  assert.deepEqual(
    data
      .filter((value) => value.type?.startsWith("response.function_call_arguments"))
      .map((value) => [value.item_id, value.output_index, value.delta ?? value.arguments]),
    [
      ["k1", 1, '{"kept":1}'],
      ["k1", 1, '{"kept":1}'],
    ],
    "the declared call's frames were left out with the call that shares its index",
  );
  assert.equal((await collapseResponse(sse(guarded), "responses")).status, 200);
});

// A reply at odds with itself about where one call sits: the frame that opens
// it gives no index and the frame that closes it gives one, or the other way
// round, or the two give two different ones. The guard answers the call one id
// and one place, because the copies leave the placing to the stream's own
// answer — the place the frame that opened the call was answered at — and the
// id they all answer is what the collapse path finds them by. Reading each
// copy's own index instead gave the streaming client one item and the client
// that reads no stream two, which is the split F2 exists to close.
test("Responses: a dropped call whose copies disagree about the place is one item to both clients", async () => {
  const dropped = { type: "function_call", call_id: "c9", name: "", arguments: '{"d":1}', status: "completed" };
  const opened = (index) =>
    event({
      type: "response.output_item.added",
      ...(index === undefined ? {} : { output_index: index }),
      item: { type: "function_call", call_id: "c9", name: "", arguments: "" },
    });
  const args = (handle, type) =>
    event({ type, ...handle, ...(type.endsWith(".delta") ? { delta: '{"d":1}' } : { arguments: '{"d":1}' }) });
  const shapes = {
    "the opening frame gives no index, the closing frame gives one": [
      opened(undefined),
      args({ item_id: "c9" }, "response.function_call_arguments.delta"),
      args({ item_id: "c9" }, "response.function_call_arguments.done"),
      event({ type: "response.output_item.done", output_index: 7, item: { ...dropped } }),
    ],
    "the opening frame gives one, the closing frame gives none": [
      opened(7),
      args({ output_index: 7, item_id: "c9" }, "response.function_call_arguments.delta"),
      args({ output_index: 7, item_id: "c9" }, "response.function_call_arguments.done"),
      event({ type: "response.output_item.done", item: { ...dropped } }),
    ],
    "the two frames give two different indices": [
      opened(7),
      args({ output_index: 7, item_id: "c9" }, "response.function_call_arguments.delta"),
      args({ output_index: 7, item_id: "c9" }, "response.function_call_arguments.done"),
      event({ type: "response.output_item.done", output_index: 9, item: { ...dropped } }),
    ],
    // The closing copy names nothing at all — no word of its own and no index —
    // so the call the stream is closing is the only thing left to read it by.
    "the opening frame gives one, the closing frame names nothing": [
      opened(7),
      args({ output_index: 7, item_id: "c9" }, "response.function_call_arguments.delta"),
      args({ output_index: 7, item_id: "c9" }, "response.function_call_arguments.done"),
      event({
        type: "response.output_item.done",
        item: { type: "function_call", name: "", arguments: '{"d":1}', status: "completed" },
      }),
    ],
  };
  for (const [what, frames] of Object.entries(shapes)) {
    const text =
      frames.join("") +
      event(
        { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
        "response.completed",
      );
    const streamed = await guardToolResponse(sse(text), "responses", policy);
    assert.equal(streamed.status, 200, what);
    const guarded = await streamed.text();
    const data = frameData(guarded);
    const replaced = data.filter((value) => value.item?.type === "message");
    assert.equal(replaced.length, 2, `${what}: the added frame and the done frame`);
    assert.deepEqual(
      replaced.map((value) => value.item.id),
      [replaced[0].item.id, replaced[0].item.id],
      `${what}: one call answered more than one id`,
    );
    assert.equal(replaced[1].output_index, undefined, `${what}: the closing copy kept a place of its own`);
    // One item to the streaming client, and one to the client that reads no
    // stream: the same item, by the same id.
    const streamedItems = new Set(replaced.map((value) => value.item.id));
    const collapsed = await collapseResponse(sse(guarded), "responses");
    assert.equal(collapsed.status, 200, `${what}: the guard's own bytes are not a reply`);
    const items = (await collapsed.json()).output;
    assert.equal(items.length, streamedItems.size, `${what}: a split between the two paths`);
    assert.deepEqual(
      items.map((item) => [item.type, item.id]),
      [["message", replaced[0].item.id]],
      what,
    );
  }
});

// The third word the suppression reads, pinned on its own: a frame that gives
// an index nothing in the reply holds, and names a word a call left out was
// named by. That index is the upstream's own numbering of a call the guard
// replaced with a note — it says nothing about any item the reply kept — and
// nothing else in the reply accounts for the frame, so it is left out with the
// call. Removing that rule let these frames through to the client, describing
// an item it had been told was replaced (the repo had no test that noticed).
test("Responses: a dropped call's frames are left out though they give an index nobody declared", async () => {
  const text =
    event({ type: "response.output_item.added", item: { type: "function_call", call_id: "c9", name: "", arguments: "" } }) +
    event({ type: "response.function_call_arguments.delta", output_index: 7, item_id: "c9", delta: '{"d"' }) +
    event({ type: "response.function_call_arguments.done", output_index: 7, item_id: "c9", arguments: '{"d":1}' }) +
    event({ type: "response.output_item.done", item: { type: "function_call", call_id: "c9", name: "", arguments: '{"d":1}', status: "completed" } }) +
    event(
      { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const guarded = await streamed.text();
  const data = frameData(guarded);
  assert.deepEqual(
    data.filter((value) => value.type?.startsWith("response.function_call_arguments")),
    [],
    "a call left out kept its arguments frames",
  );
  assert.equal(textIn("responses", data), droppedNote(""));
  const collapsed = await collapseResponse(sse(guarded), "responses");
  assert.equal(collapsed.status, 200);
  assert.deepEqual(
    (await collapsed.json()).output.map((item) => [item.type, item.id]),
    [["message", "msg_c9"]],
  );
});

// [DONE] is the sentinel a Chat stream ends with, and a Responses or Messages
// stream may be handed one after it has reported its own terminal event — a
// gateway in front of the upstream appends it. That is an ending. Before the
// terminal event it claims an ending the protocol never reported, and the
// reply is refused. The collapse path reads the same bytes the same way (its
// half of this test is in stream.test.mjs).
test("a [DONE] marker is an ending only where the reply already ended", async () => {
  for (const protocol of ["responses", "anthropic"]) {
    // Named for the frame it is, not `terminal`: that name is this file's
    // `terminal(protocol)` helper, and this loop is inside the module it lives in.
    const terminalFrame =
      protocol === "responses"
        ? event(
            { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
            "response.completed",
          )
        : event({ type: "message_stop" }, "message_stop");
    const marker = "data: [DONE]\n\n";
    const good = await guardToolResponse(sse(terminalFrame + marker), protocol, policy);
    const out = await good.text();
    assert.equal(good.status, 200);
    assert.ok(out.endsWith(marker), "the marker is forwarded as it arrived");
    assert.ok(
      !parse(out).some((frame) => frame.data?.type === "error" || frame.data?.error),
      "an ending the protocol reported is not an error",
    );
    const bare = await guardToolResponse(sse(marker), protocol, policy);
    const frames = parse(await bare.text());
    assert.equal(frames.length, 1);
    assertError(protocol, frames[0].data);
    assert.equal(
      frames[0].data.message ?? frames[0].data.error.message,
      "Unexpected upstream completion marker",
    );
  }
});

// The contract both paths implement, pinned here for the path that streams to
// a client. The terminal marker still ends the reply where it stands and is
// still forwarded as it arrived; an event after it is not part of the reply —
// this path used to forward one the collapse path dropped, so the same
// upstream answered two different replies; and a failure after it still failed
// the turn, which is why the ignore sits below the error branch. The collapse
// path's half of this test is in stream.test.mjs.
test("an event after the terminal marker is ignored, and a failure after it is not", async () => {
  const cases = {
    chat: [
      event({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }),
      event("[DONE]"),
      event({ choices: [{ index: 0, delta: { content: "TAIL" } }] }),
    ],
    responses: [
      event({ type: "response.completed", response: { status: "completed", output: [] } }, "response.completed"),
      event({
        type: "response.output_text.delta",
        item_id: "m",
        output_index: 0,
        content_index: 0,
        delta: "TAIL",
      }),
    ],
    anthropic: [
      event({ type: "message_stop" }, "message_stop"),
      event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "TAIL" } }),
    ],
  };
  for (const [protocol, frames] of Object.entries(cases)) {
    const result = await guardToolResponse(sse(frames.join("")), protocol, policy);
    assert.equal(result.status, 200);
    const out = await result.text();
    assert.doesNotMatch(out, /TAIL/, `${protocol}: an event after the terminal marker was forwarded`);
    assert.ok(
      out.includes(protocol === "chat" ? "data: [DONE]" : frames[0].trim()),
      `${protocol}: the terminal marker is forwarded as it arrived`,
    );
  }
  for (const [protocol, terminal] of [
    ["chat", event("[DONE]")],
    ["responses", event({ type: "response.completed", response: { output: [] } })],
    ["anthropic", event({ type: "message_stop" })],
  ]) {
    const result = await guardToolResponse(
      sse(terminal + event({ error: { message: "late error" } })),
      protocol,
      policy,
    );
    assert.match(
      JSON.stringify(frameData(await result.text())),
      /late error/,
      `${protocol}: a failure after the terminal marker was ignored too`,
    );
    // And a frame the guard cannot read at all is a failure either way, as it
    // was before the marker: ignoring the event after an ending must not
    // become reading a body nothing checked.
    const broken = await guardToolResponse(sse(terminal + "data: {broken\n\n"), protocol, policy);
    assert.match(JSON.stringify(frameData(await broken.text())), /Invalid JSON/);
  }
});

test("Responses codes a call with no name where a snapshot was expected as an undeclared one, and nothing else", async () => {
  // A call where a snapshot was expected, so it cannot be put in place of
  // by a note: the reply fails and says which failure it was. A call of a tool
  // the agent doesn't have is no longer a failure of any kind (#209) — it is
  // handed on — so the one shape that still fails this way is a nameless call.
  const bare = { type: "function_call", name: "", call_id: "call1", arguments: "{}" };
  const undeclared = await guardToolResponse(Response.json(bare), "responses", policy);
  assert.equal(undeclared.status, 502);
  assertError("responses", await undeclared.json(), false, "undeclared_tool");
  // The same call with a name no declared tool folds to: a reply, handed on as
  // called, not a failure.
  const named = { type: "function_call", name: "unknown", call_id: "call1", arguments: "{}" };
  const handed = await guardToolResponse(Response.json(named), "responses", policy);
  assert.equal(handed.status, 200);
  assert.deepEqual(await handed.json(), named);
  // An upstream that failed, or a call of a kind the agent can't be handed,
  // is a failure of another sort.
  const malformed = await guardToolResponse(
    new Response("{broken", { headers: { "content-type": "application/json" } }),
    "responses",
    policy,
  );
  assertError("responses", await malformed.json(), false);
  const unsupported = await guardToolResponse(
    Response.json({ output: [{ type: "computer_call", name: "x", call_id: "call1" }] }),
    "responses",
    policy,
  );
  assertError("responses", await unsupported.json(), false);
});

test("chat: JSON checks every choice, legacy function_call and missing tool names", async () => {
  const result = await guardToolResponse(
    Response.json({ choices: [{ message: { function_call: { name: "read", arguments: "{}" } } }] }),
    "chat",
    policy,
  );
  assert.equal((await result.json()).choices[0].message.function_call.name, "Read");
  // A legacy function_call of a name the agent doesn't have is handed on as
  // called, with its finish (#209), like every other named call.
  const unknown = await guardToolResponse(
    Response.json({
      choices: [
        {
          message: { function_call: { name: "unknown", arguments: "{}" } },
          finish_reason: "function_call",
        },
      ],
    }),
    "chat",
    policy,
  );
  assert.deepEqual((await unknown.json()).choices[0], {
    message: { function_call: { name: "unknown", arguments: "{}" } },
    finish_reason: "function_call",
  });
  // The shapes still left out: a legacy function_call with no name at all, and
  // a tool call whose function object carries no name either. Both are named
  // in the reply's text and finish as a plain stop.
  for (const [message, name] of [
    [{ function_call: { name: "" } }, ""],
    [{ tool_calls: [{ type: "function", function: {} }] }, undefined],
  ]) {
    const source = Response.json({
      choices: [
        { message: { content: "ok" } },
        {
          index: 1,
          message,
          finish_reason: message.function_call ? "function_call" : "tool_calls",
        },
      ],
    });
    const result = await guardToolResponse(source, "chat", policy);
    assert.equal(result.status, 200);
    const [first, second] = (await result.json()).choices;
    assert.deepEqual(first.message, { content: "ok" });
    assert.deepEqual(second.message, { content: droppedNote(name) });
    assert.equal(second.finish_reason, "stop");
  }
  const custom = Response.json({
    choices: [{ message: { tool_calls: [{ type: "custom", custom: { name: "unknown" } }] } }],
  });
  assert.equal((await guardToolResponse(custom, "chat", policy)).status, 502);
});

test("Responses: nested JSON responses and all streaming snapshots are checked", async () => {
  const nested = await guardToolResponse(
    Response.json({ response: { response: snapshot("responses", ["bash"]) } }),
    "responses",
    policy,
  );
  assert.equal((await nested.json()).response.response.output[0].name, "Bash");
  for (const type of [
    "response.output_item.added",
    "response.output_item.done",
    "response.created",
    "response.in_progress",
    "response.completed",
    "response.incomplete",
    "vendor.snapshot",
  ]) {
    for (const name of ["read", "unknown", ""]) {
      const data = type.includes("output_item")
        ? { type, item: tool("responses", name) }
        : { type, response: snapshot("responses", [name]) };
      const result = await guardToolResponse(
        sse(event(data, type) + terminal("responses")),
        "responses",
        policy,
      );
      const frames = parse(await result.text());
      if (name === "") {
        const raw = frames.map((frame) => frame.data);
        assert.ok(!raw.some((data) => data.type === "error" || data.error));
        assert.deepEqual(callsIn("responses", raw), []);
        const message = raw[0].item ?? raw[0].response.output[0];
        assert.equal(message.type, "message");
        assert.equal(message.id, "msg_call");
        const said =
          type === "response.output_item.added"
            ? textIn("responses", raw)
            : message.content[0].text;
        assert.equal(said, droppedNote(""));
      } else
        // A declared name in the agent's own spelling, and one it has no tool
        // for handed on as called (#209): neither is rewritten to the other.
        assert.equal(
          frames[0].data.item?.name ?? frames[0].data.response.output[0].name,
          name === "read" ? "Read" : name,
        );
    }
  }
});

test("Anthropic: content_block_start, message_start and server_tool_use are guarded", async () => {
  for (const type of ["tool_use", "server_tool_use"]) {
    for (const name of ["bash", "unknown", ""]) {
      const block = { type, name, id: "t", input: {} };
      const json = await guardToolResponse(
        Response.json({ content: [block] }),
        "anthropic",
        policy,
      );
      assert.equal(json.status, 200);
      if (name === "")
        assert.deepEqual((await json.json()).content, [{ type: "text", text: droppedNote("") }]);
      else if (name === "unknown")
        // No declared tool folds to it: handed on as called (#209).
        assert.deepEqual((await json.json()).content, [block]);
      for (const data of [
        { type: "content_block_start", index: 0, content_block: block },
        { type: "message_start", message: { content: [block] } },
      ]) {
        const response = await guardToolResponse(
          sse(event(data) + terminal("anthropic")),
          "anthropic",
          policy,
        );
        const frames = parse(await response.text());
        if (name === "") {
          const values = frames.map((frame) => frame.data);
          assert.ok(!values.some((value) => value.type === "error"));
          assert.deepEqual(callsIn("anthropic", values), []);
          assert.equal(textIn("anthropic", values), droppedNote(""));
        } else
          assert.equal(
            frames[0].data.content_block?.name ?? frames[0].data.message.content[0].name,
            name === "bash" ? "Bash" : name,
          );
      }
    }
  }
});

test("chat: buffers names and arguments by choice/index, including arguments before name", async () => {
  const values = [
    chat({
      tool_calls: [
        { index: 1, function: { arguments: '{"x":' } },
        { index: 0, id: "first", type: "function", function: { name: "ba", arguments: "{}" } },
      ],
    }),
    chat({ tool_calls: [{ index: 0, function: { name: "re", arguments: "{}" } }] }, null, 1),
    chat({
      content: "你好",
      tool_calls: [
        { index: 1, id: "second", type: "function", function: { name: "re", arguments: "1}" } },
        { index: 0, function: { name: "sh" } },
      ],
    }),
    chat({ tool_calls: [{ index: 0, function: { name: "ad" } }] }, "tool_calls", 1),
    chat({ tool_calls: [{ index: 1, function: { name: "ad" } }] }, "tool_calls"),
  ];
  const result = await guardToolResponse(
    sse(values.map((value) => event(value)).join("") + terminal("chat"), { chunkSize: 1 }),
    "chat",
    policy,
  );
  const choices = parse(await result.text()).flatMap((frame) => frame.data.choices ?? []);
  const toolChoices = choices.filter((choice) => choice.delta?.tool_calls);
  assert.equal(toolChoices.length, 2);
  assert.deepEqual(toolChoices.find((choice) => choice.index === 0).delta.tool_calls, [
    { index: 0, id: "first", type: "function", function: { name: "Bash", arguments: "{}" } },
    { index: 1, id: "second", type: "function", function: { name: "Read", arguments: '{"x":1}' } },
  ]);
  assert.equal(
    toolChoices.find((choice) => choice.index === 1).delta.tool_calls[0].function.name,
    "Read",
  );
  assert.equal(
    choices
      .filter((choice) => choice.delta?.content)
      .map((choice) => choice.delta.content)
      .join(""),
    "你好",
  );
});

// R2 (opencode2api free-tier comparison): the guard buffers the same Chat name
// fragments as the collapse path. Read as a blind append while the collapse
// path merged prefix-wise, the guard answered `ReadRead` for a name the
// collapsed reply had got right — a streamed reply and its own collapse
// disagreeing about one upstream stream. Both now call stream.mjs's
// `mergeFunctionName`.
test("chat: repeated, grown and re-prefixed function names merge instead of appending twice", async () => {
  const namesOf = async (fragments) => {
    const frames = fragments.map((name) =>
      event(
        chat({
          tool_calls: [
            { index: 0, id: "call-0", type: "function", function: { name } },
          ],
        }),
      ),
    );
    const result = await guardToolResponse(
      sse(frames.join("") + event(chat({}, "tool_calls")) + terminal("chat"), { chunkSize: 1 }),
      "chat",
      policy,
    );
    const values = parse(await result.text()).map((frame) => frame.data);
    assert.ok(!values.some((value) => value.error), "a name shape must not fail the reply");
    return values
      .flatMap((value) => value.choices ?? [])
      .flatMap((choice) => choice.delta?.tool_calls ?? [])
      .map((call) => call.function.name);
  };

  for (const [label, fragments] of [
    ["a repeated full name", ["Read", "Read"]],
    ["a growing prefix", ["Re", "Read"]],
    ["true fragments", ["Re", "ad"]],
    ["a shorter prefix after a longer name", ["Read", "Re"]],
  ])
    assert.deepEqual(await namesOf(fragments), ["Read"], label);
});

// Upstream zen-free 0.1.12 (#252): some OpenAI-compatible vendors send
// `"name": null` or `"arguments": null` in a later delta of a call whose
// fragments are already buffered. A null field carries no new bytes, so it
// must not reset or fail the fragments already accumulated; the buffered name
// and arguments are completed by the following string fragments.
for (const legacy of [false, true]) {
  const kind = legacy ? "function_call" : "tool_calls";
  const delta = (fragment) =>
    legacy
      ? { function_call: fragment }
      : { tool_calls: [{ index: 0, id: "call-0", type: "function", function: fragment }] };
  const functions = (values) =>
    values.flatMap((value) => value.choices ?? []).flatMap((choice) =>
      legacy
        ? (choice.delta?.function_call ? [choice.delta.function_call] : [])
        : (choice.delta?.tool_calls ?? []).map((value) => value.function),
    );

  test(`chat: ${kind} ignores null fields while preserving name and argument fragments`, async () => {
    const fragments = [
      { name: null, arguments: null },
      { name: "Re", arguments: null },
      { name: null, arguments: '{"path":' },
      { name: "ad", arguments: null },
      { name: null, arguments: '"example.txt"}' },
      { name: null, arguments: null },
    ];
    const result = await guardToolResponse(
      sse(
        fragments.map((fragment) => event(chat(delta(fragment)))).join("") +
          event(chat({}, kind)) +
          terminal("chat"),
        { chunkSize: 1 },
      ),
      "chat",
      policy,
    );
    const values = parse(await result.text()).map((frame) => frame.data);
    assert.ok(!values.some((value) => value.error));
    assert.deepEqual(functions(values), [{ name: "Read", arguments: '{"path":"example.txt"}' }]);
  });

  test(`chat: ${kind} still drops a call whose name stays null`, async () => {
    const result = await guardToolResponse(
      sse(event(chat(delta({ name: null, arguments: "{}" }))) + terminal("chat")),
      "chat",
      policy,
    );
    const values = parse(await result.text()).map((frame) => frame.data);
    assert.ok(!values.some((value) => value.error));
    assert.deepEqual(functions(values), []);
    assert.equal(textIn("chat", values), droppedNote(""));
  });
}

// Upstream zen-free 0.1.13 (#188, #259): a call's id streamed first and then
// repeated as null or "" in a later delta must keep the id already buffered.
// A spread would let the later empty value clobber it, and the host would
// answer the call with an empty tool_call_id.
test("chat: later null or empty tool IDs do not replace buffered IDs", async () => {
  const text = [
    event(
      chat({
        tool_calls: [
          { index: 0, id: "call_0", type: "function", function: { name: "read", arguments: "{}" } },
          { index: 1, id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      }),
    ),
    event(chat({ tool_calls: [{ index: 0, id: null }, { index: 1, id: "" }] })),
    event(chat({ tool_calls: [{ index: 2, function: { name: "read", arguments: "{}" } }] })),
    event(chat({ tool_calls: [{ index: 2, id: "call_late" }] })),
    event(
      chat(
        {
          tool_calls: [
            {
              index: 0,
              id: "choice_1_call",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
        },
        null,
        1,
      ),
    ),
    event(chat({ tool_calls: [{ index: 0, id: null }] }, null, 1)),
    event(chat({}, "tool_calls", 0)),
    event(chat({}, "tool_calls", 1)),
    terminal("chat"),
  ].join("");
  const response = await guardToolResponse(sse(text, { chunkSize: 1 }), "chat", policy);
  const values = parse(await response.text()).map((frame) => frame.data);
  assert.ok(!values.some((value) => value.error));
  const choices = values.flatMap((value) => value.choices ?? []);
  const callsFor = (index) =>
    choices
      .filter((choice) => choice.index === index)
      .flatMap((choice) => choice.delta?.tool_calls ?? []);
  assert.deepEqual(
    callsFor(0).map((value) => value.id),
    ["call_0", "call_1", "call_late"],
  );
  assert.deepEqual(callsFor(1).map((value) => value.id), ["choice_1_call"]);
  assert.deepEqual(callsFor(0).map((value) => value.function.name), ["Read", "Read", "Read"]);
});

test("chat: legacy fragments flush at DONE, but truncated pending calls never escape", async () => {
  const prefix =
    event(chat({ function_call: { arguments: "{}" } })) +
    event(chat({ function_call: { name: "ba" } })) +
    event(chat({ function_call: { name: "sh" } }));
  const success = await guardToolResponse(sse(prefix + terminal("chat")), "chat", policy);
  const frames = parse(await success.text());
  const calls = frames
    .flatMap((frame) => frame.data.choices ?? [])
    .filter((choice) => choice.delta?.function_call);
  assert.deepEqual(
    calls.map((choice) => choice.delta.function_call),
    [{ name: "Bash", arguments: "{}" }],
  );
  const failure = await guardToolResponse(sse(prefix), "chat", policy);
  const failed = parse(await failure.text());
  assert.equal(failed.length, 1);
  assertError("chat", failed[0].data);
});

test("chat: text and usage flow immediately while tools wait, without reading the conversation", async () => {
  let cancelled = false;
  const text = event(chat({ content: "first", tool_calls: [call("ba")] }));
  const source = openSource(text, () => {
    cancelled = true;
  });
  const result = await guardToolResponse(source.response, "chat", policy);
  const reader = result.body.getReader();
  const first = await withTimeout(reader.read());
  const firstData = parse(new TextDecoder().decode(first.value))[0].data;
  assert.equal(firstData.choices[0].delta.content, "first");
  assert.equal(firstData.choices[0].delta.tool_calls, undefined);
  assert.equal(source.pulls(), 1);
  source.push(event({ choices: [], usage: { total_tokens: 12 } }));
  const usage = await withTimeout(reader.read());
  assert.equal(parse(new TextDecoder().decode(usage.value))[0].data.usage.total_tokens, 12);
  await reader.cancel("enough");
  assert.equal(cancelled, true);
});

test("chat: one chunk containing many text events still obeys downstream backpressure", async () => {
  let cancelled = false;
  const source = openSource(
    event(chat({ content: "one" })) +
      event(chat({ content: "two" })) +
      event(chat({ tool_calls: [{ ...call("unknown"), type: "custom" }] }, "tool_calls")),
    () => {
      cancelled = true;
    },
  );
  const result = await guardToolResponse(source.response, "chat", policy);
  const reader = result.body.getReader();
  assert.equal(
    parse(new TextDecoder().decode((await reader.read()).value))[0].data.choices[0].delta.content,
    "one",
  );
  assert.equal(cancelled, false);
  assert.equal(
    parse(new TextDecoder().decode((await reader.read()).value))[0].data.choices[0].delta.content,
    "two",
  );
  assert.equal(cancelled, false);
  assertError("chat", parse(new TextDecoder().decode((await reader.read()).value))[0].data);
  assert.equal(cancelled, true);
});

test("SSE handles UTF8, BOM, CRLF, CR-only, multiline data and arbitrary chunks", async () => {
  const raw =
    '\uFEFF: ping\r\nid: 7\r\nevent: message\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"中文🙂"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  for (const text of [raw, raw.replaceAll("\r\n", "\r"), raw.replaceAll("\r\n", "\n")]) {
    for (const chunkSize of [1, 2, 3, 7, 1024]) {
      const result = await guardToolResponse(sse(text, { chunkSize }), "chat", policy);
      const frames = parse(await result.text());
      assert.equal(frames[0].data.choices[0].delta.content, "中文🙂");
      assert.equal(frames[1].data, "[DONE]");
    }
  }
});

test("ordinary events retain SSE metadata without buffering", async () => {
  for (const protocol of protocols) {
    const text = ': keepalive\nid: 8\nretry: 200\nevent: vendor.text\ndata: {"text":"hello"}\n\n';
    const source = openSource(text);
    const result = await guardToolResponse(source.response, protocol, policy);
    const reader = result.body.getReader();
    assert.equal(new TextDecoder().decode((await withTimeout(reader.read())).value), text);
    await reader.cancel();
  }
});

// 32+ MiB through the guard, like the CRLF test below: not held to bun's 5 s default
test("single SSE event limit is 32 MiB and cancels an unterminated upstream", { timeout: 60_000 }, async () => {
  let cancelled = false;
  const bytes = encoder.encode("x".repeat(1024 * 1024));
  const source = endlessStream(bytes, {
    cancel: () => {
      cancelled = true;
    },
  });
  const result = await guardToolResponse(source.response, "chat", policy);
  const frames = parse(await result.text());
  assertError("chat", frames[0].data);
  assert.match(frames[0].data.error.message, /32 MiB|limit/i);
  assert.equal(cancelled, true);
  // The 33rd chunk is the one that carries the count past the limit, and the
  // source queues nothing ahead of the reader.
  assert.ok(
    source.pulls() <= MAX_BYTES / bytes.length + 1,
    `pulled ${source.pulls()} chunks before the limit`,
  );
});

// 32+ MiB through the guard, like the CRLF test below: not held to bun's 5 s default
test("cumulative pending chat tools are limited across choices and calls", { timeout: 60_000 }, async () => {
  let cancelled = false;
  const argumentsChunk = "x".repeat(1024 * 1024);
  const source = endlessStream(
    (pulls) =>
      encoder.encode(
        event(chat({ tool_calls: [call("bash", pulls, argumentsChunk)] }, null, pulls % 2)),
      ),
    {
      cancel: () => {
        cancelled = true;
      },
    },
  );
  const result = await guardToolResponse(source.response, "chat", policy);
  const frames = parse(await result.text());
  assert.equal(frames.length, 1);
  assertError("chat", frames[0].data);
  assert.match(frames[0].data.error.message, /32 MiB|limit/i);
  assert.equal(cancelled, true);
  // Each event's arguments are charged whole, so the limit falls within a
  // chunk or two of 32 MiB of them, and the source queues nothing ahead.
  assert.ok(
    source.pulls() <= MAX_BYTES / argumentsChunk.length + 1,
    `pulled ${source.pulls()} chunks before the pending-tool limit`,
  );
});

// 32+ MiB through the guard, not held to bun's 5 s default: a reply that is
// not a stream is read through the same limit a streamed one's events are,
// and the body it abandons is cancelled rather than left writing into a
// socket nobody reads.
test("a non-streaming reply is read through the 32 MiB limit", { timeout: 60_000 }, async () => {
  const bytes = encoder.encode("x".repeat(1024 * 1024));
  let cancelled = 0;
  const source = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(bytes);
      },
      cancel() {
        cancelled++;
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  const result = await guardToolResponse(source, "chat", policy);
  assert.equal(result.status, 502);
  assert.match((await result.json()).error.message, /32 MiB|limit/i);
  assert.equal(cancelled, 1);
  assert.equal(source.body.locked, false);
});

// A body abandoned without its cancel being awaited leaves an upstream writing
// into a socket nobody reads. A cancel that then fails must not stand in for
// what ended the read: the oversized body is the 502 this path promises, and an
// opaque transport error in its place is the failure [#4] was about — the
// caller cannot tell a limit from a dead connection, and the documented answer
// disappears. The cancel's own failure rides along as that error's cause, so
// nothing is swallowed, and the lock is released either way.
test("a cancel failure does not replace the 502 an oversized body becomes", async () => {
  const cause = new DOMException("cancel failed", "AbortError");
  const bytes = encoder.encode("x".repeat(1024 * 1024));
  const { response } = upstream((controller) => controller.enqueue(bytes), {
    headers: { "content-type": "application/json" },
    highWaterMark: 0,
    cancel() {
      throw cause;
    },
  });
  const result = await guardToolResponse(response, "chat", policy);
  assert.equal(result.status, 502, "the limit is still the answer, not the cancel");
  assert.match((await result.json()).error.message, /32 MiB|limit/i);
  assert.equal(response.body.locked, false);
});

test("chat: each pending choice is settled on its own, an unknown final name handed on and a missing one left out", async () => {
  for (const ending of [
    terminal("chat"),
    event({
      choices: [
        { index: 0, delta: {}, finish_reason: "tool_calls" },
        { index: 1, delta: {}, finish_reason: "tool_calls" },
      ],
    }) + terminal("chat"),
  ]) {
    for (const name of ["unknown", ""]) {
      const text =
        event(chat({ tool_calls: [call("bash")] })) +
        event(chat({ tool_calls: [call(name)] }, null, 1)) +
        ending;
      const response = await guardToolResponse(sse(text), "chat", policy);
      const values = frameData(await response.text());
      assert.ok(!values.some((data) => data.error));
      const choices = values.flatMap((data) => data.choices ?? []);
      const of = (index) => choices.filter((choice) => choice.index === index);
      assert.deepEqual(callsIn("chat", [{ choices: of(0) }]), ["Bash"]);
      // The call of choice 1 is a name the agent doesn't have: handed on as
      // called, with its own finish (#209). A nameless one is still left out,
      // in the note, under a plain stop.
      assert.deepEqual(callsIn("chat", [{ choices: of(1) }]), name ? [name] : []);
      assert.equal(textIn("chat", [{ choices: of(1) }]), name ? "" : droppedNote(name));
      const finishes = (index) =>
        of(index)
          .map((choice) => choice.finish_reason)
          .filter(Boolean);
      if (ending !== terminal("chat")) {
        assert.deepEqual(finishes(0), ["tool_calls"]);
        assert.deepEqual(finishes(1), [name ? "tool_calls" : "stop"]);
      }
    }
  }
});

test("chat: a choice whose every call was left out finishes as a stop, again and again (#76)", async () => {
  // step-5-preview-free sends its tool_calls finish twice, the second with
  // usage (seen 2026-10-11); neither may tell the agent to run a tool.
  const response = await guardToolResponse(sse(toolStream("chat", "")), "chat", policy);
  const values = frameData(await response.text());
  const finishes = values
    .flatMap((data) => data.choices ?? [])
    .map((choice) => choice.finish_reason)
    .filter(Boolean);
  assert.deepEqual(finishes, ["stop", "stop"]);
  assert.equal(textIn("chat", values), droppedNote(""));
  assert.ok(values.some((data) => data.usage?.completion_tokens === 5));
});

test("chat: a round whose only call was left out does not decide the round after it (#76)", async () => {
  // Round 1 calls a tool with no name at all and ends in tool use; round 2, in
  // the same stream, calls a declared one. The first round ends
  // as a plain stop (#76) — and the second is judged on its own, not on the
  // round before it: a client that keys execution off finish_reason never
  // runs a call published under "stop".
  const round = (name) => event(chat({ tool_calls: [call(name)] }, "tool_calls"));
  const two = await guardToolResponse(
    sse(round("") + round("bash") + terminal("chat")),
    "chat",
    policy,
  );
  const choices = frameData(await two.text()).flatMap((data) => data.choices ?? []);
  assert.deepEqual(
    choices.map((choice) => choice.finish_reason),
    ["stop", "tool_calls"],
  );
  assert.deepEqual(callsIn("chat", [{ choices }]), ["Bash"]);
  assert.equal(textIn("chat", [{ choices }]), droppedNote(""));
  // The control: the same round on its own, where nothing preceded it.
  const one = await guardToolResponse(sse(round("bash") + terminal("chat")), "chat", policy);
  assert.deepEqual(
    frameData(await one.text())
      .flatMap((data) => data.choices ?? [])
      .map((choice) => choice.finish_reason),
    ["tool_calls"],
  );
});

test("chat: buffered calls flushed at [DONE] say the turn ended in tool use", async () => {
  // The case this buffer exists for: an upstream that closes with [DONE]
  // before sending a finish chunk. A null finish_reason reads as no ending at
  // all, so the reason is derived from what the flush publishes.
  const flush = async (delta) => {
    const text = event(chat(delta)) + terminal("chat");
    const values = frameData(await (await guardToolResponse(sse(text), "chat", policy)).text());
    return values.flatMap((data) => data.choices ?? [])[0];
  };
  const calls = await flush({ tool_calls: [call("bash")] });
  assert.equal(calls.finish_reason, "tool_calls");
  assert.deepEqual(
    calls.delta.tool_calls.map((value) => value.function.name),
    ["Bash"],
  );
  const legacy = await flush({ function_call: { name: "bash", arguments: "{}" } });
  assert.equal(legacy.finish_reason, "function_call");
  assert.equal(legacy.delta.function_call.name, "Bash");
  // A call with no name is left out, and what is left is a plain stop.
  const dropped = await flush({ tool_calls: [call("")] });
  assert.equal(dropped.finish_reason, "stop");
  assert.equal(dropped.delta.tool_calls, undefined);
  assert.equal(dropped.delta.content, droppedNote(""));
});

// 2026-10-17, measured through this plugin: deepseek-v4.1-flash-free's reply
// named a call on its first frame and put `"id": null` on a continuation
// frame, and the flushed call reached its host id-less. dsh then keyed a
// tool/result record by the empty id — failing that turn ("toolCallId
// matching its tool source"), and the whole session on the next reload. What
// the first frame gave is not a later frame's to take away.
test("chat: a later frame's `\"id\": null` does not take the id the first frame gave", async () => {
  const first = { index: 0, id: "call-0", type: "function", function: { name: "bash", arguments: "" } };
  const continuation = { index: 0, id: null, function: { arguments: "{}" } };
  const text =
    event(chat({ tool_calls: [first] })) +
    event(chat({ tool_calls: [continuation] })) +
    terminal("chat");
  const values = frameData(await (await guardToolResponse(sse(text), "chat", policy)).text());
  const calls = values
    .flatMap((data) => data.choices ?? [])
    .flatMap((choice) => choice.delta?.tool_calls ?? []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "call-0");
  assert.equal(calls[0].function.arguments, "{}", "the continuation still contributed");
});

// The other half of the same malformed shape: a reply that never names the
// call at all (the same flush carried `{"index":0,"id":null,"name":"bash"}`).
// OpenAI's shape requires an id, and a host that matches a result by it has
// nothing to match: a call that reaches the wire leaves with one — invented
// when the route gave none, and never shared between two calls of one reply.
test("chat: a call the route never named still leaves with an id of its own", async () => {
  const flush = async (deltas) => {
    const text = deltas.map((delta) => event(chat(delta))).join("") + terminal("chat");
    const values = frameData(await (await guardToolResponse(sse(text), "chat", policy)).text());
    return values
      .flatMap((data) => data.choices ?? [])
      .flatMap((choice) => choice.delta?.tool_calls ?? []);
  };
  const [unnamed] = await flush([
    { tool_calls: [{ index: 0, id: null, type: "function", function: { name: "bash", arguments: "{}" } }] },
  ]);
  assert.equal(typeof unnamed.id, "string");
  assert.notEqual(unnamed.id, "");
  const both = await flush([
    {
      tool_calls: [
        { index: 0, type: "function", function: { name: "bash", arguments: "{}" } },
        { index: 1, type: "function", function: { name: "read", arguments: "{}" } },
      ],
    },
  ]);
  assert.equal(both.length, 2, "both calls kept");
  assert.notEqual(both[0].id, both[1].id, "two invented ids are two ids");
  for (const kept of both) assert.ok(typeof kept.id === "string" && kept.id !== "");
});

// The same rule where a whole message arrives at once instead of a stream.
test("chat: a call without an id gets one in a whole message too", async () => {
  const body = {
    choices: [
      {
        message: {
          role: "assistant",
          tool_calls: [
            { index: 0, id: null, type: "function", function: { name: "bash", arguments: "{}" } },
          ],
        },
      },
    ],
  };
  const out = await (await guardToolResponse(Response.json(body), "chat", policy)).json();
  const kept = out.choices[0].message.tool_calls[0];
  assert.equal(kept.function.name, "Bash", "the rename still happens");
  assert.ok(typeof kept.id === "string" && kept.id !== "", "and the id is a name a result can carry");
});

// An invented id is only process-unique: the counter behind it is shared with
// every earlier reply, and the route names its own calls by ids of the same
// shape. A call left unnamed beside calls the reply did name could be handed
// one of their ids — two calls of one reply under one id, which is the failure
// the counter exists to prevent, and a host keys its tool results by the id.
// The ids the calls being flushed already carry are read first, and the
// invented one misses them all.
test("chat: an invented call id misses the ids the reply already placed", async () => {
  const flushChat = async (deltas) => {
    const text = deltas.map((delta) => event(chat(delta))).join("") + terminal("chat");
    const values = frameData(await (await guardToolResponse(sse(text), "chat", policy)).text());
    return values
      .flatMap((data) => data.choices ?? [])
      .flatMap((choice) => choice.delta?.tool_calls ?? []);
  };
  const named = (id, index, name) => ({
    index,
    id,
    type: "function",
    function: { name, arguments: "{}" },
  });
  // A call the counter names tells the test what the counter is at: the next
  // invented id is the one after it, and the reply below is built to hold it.
  const probe = await flushChat([{ tool_calls: [named(null, 0, "bash")] }]);
  const last = Number(/(\d+)$/.exec(probe[0].id)?.[1]);
  assert.ok(Number.isSafeInteger(last), `an invented id is readable: ${probe[0].id}`);
  // Every id the counter can reach for a while, all of them the reply's own.
  const held = Array.from({ length: 32 }, (_, index) => `call_${last + index + 1}`);
  const flushed = await flushChat([
    { tool_calls: [...held.map((id, index) => named(id, index, "bash")), named(null, held.length, "read")] },
  ]);
  assert.equal(flushed.length, held.length + 1, "every call is kept");
  const ids = flushed.map((call) => call.id);
  assert.equal(new Set(ids).size, ids.length, `two calls shared an id: ${ids.join(", ")}`);
  const invented = ids.at(-1);
  assert.ok(
    !held.includes(invented),
    `the invented id ${invented} is one the reply already placed`,
  );
});

// The ids a reply holds are the reply's, not one list's. Both places a call
// is published hand the guard one choice's tool_calls at a time, and the set
// the ids were read into held that list alone: a reply whose upstream names
// its calls `call_1`, `call_2` in one choice and leaves a call of another
// unnamed handed that call the id of the first — two calls of one reply under
// one id, and a client keys its results by the id, so one call's result was
// read as the other's. The whole reply's names are read before any id is
// invented, and an invented one misses all of them.
test("chat: an invented call id misses the ids the reply's other choices placed", async () => {
  const named = (id, index, name) => ({
    index,
    id,
    type: "function",
    function: { name, arguments: "{}" },
  });
  const chatIdsOf = (values) =>
    values
      .flatMap((data) => data.choices ?? [])
      .flatMap((choice) => (choice.message ?? choice.delta)?.tool_calls ?? [])
      .map((call) => call.id);
  // The counter's own value, so the reply below can hold the id the counter
  // is about to invent.
  const probe = await (
    await guardToolResponse(
      sse(event(chat({ tool_calls: [named(null, 0, "bash")] })) + terminal("chat")),
      "chat",
      policy,
    )
  ).text();
  const last = Number(/(\d+)$/.exec(chatIdsOf(frameData(probe))[0] ?? "")?.[1]);
  assert.ok(Number.isSafeInteger(last), `an invented id is readable: ${probe}`);
  const held = `call_${last + 1}`;
  const body = {
    choices: [
      { message: { role: "assistant", tool_calls: [named(held, 0, "bash")] } },
      { message: { role: "assistant", tool_calls: [named(null, 0, "read")] } },
    ],
  };
  const out = await (await guardToolResponse(Response.json(body), "chat", policy)).json();
  const ids = out.choices.flatMap((choice) => choice.message.tool_calls.map((call) => call.id));
  assert.equal(ids.length, 2, "both calls are kept");
  assert.equal(new Set(ids).size, 2, `two calls of one reply share an id: ${ids.join(", ")}`);
  assert.notEqual(ids[1], held, "the invented id is one the reply already placed");
});

// The same reply as a stream: the two choices are flushed one after the
// other, and the id invented for the first is published before the second is
// read. The two must still be two ids, or the client keys two calls by one
// word.
test("chat: a streamed reply's invented id misses the id its other choice placed", async () => {
  const named = (id, index, name) => ({
    index,
    id,
    type: "function",
    function: { name, arguments: "{}" },
  });
  const chatIdsOf = (values) =>
    values
      .flatMap((data) => data.choices ?? [])
      .flatMap((choice) => (choice.message ?? choice.delta)?.tool_calls ?? [])
      .map((call) => call.id);
  const probe = await (
    await guardToolResponse(
      sse(event(chat({ tool_calls: [named(null, 0, "bash")] })) + terminal("chat")),
      "chat",
      policy,
    )
  ).text();
  const last = Number(/(\d+)$/.exec(chatIdsOf(frameData(probe))[0] ?? "")?.[1]);
  assert.ok(Number.isSafeInteger(last), `an invented id is readable: ${probe}`);
  const held = `call_${last + 1}`;
  const text =
    event(chat({ tool_calls: [named(null, 0, "bash")] }, null, 0)) +
    event(chat({ tool_calls: [named(held, 0, "read")] }, null, 1)) +
    terminal("chat");
  const values = frameData(await (await guardToolResponse(sse(text), "chat", policy)).text());
  const ids = chatIdsOf(values);
  assert.equal(ids.length, 2, "both calls are kept");
  assert.equal(new Set(ids).size, 2, `two calls of one reply share an id: ${ids.join(", ")}`);
});

// The id of a call left out is the word a Responses client keys the note in
// its place by, and the place a call holds is the index inside one container:
// a call in `output[0]` and a call in `output[1].content[0]` are both at 0 and
// both became `msg_dropped_0` — one item to the client, and the second note
// was never read. A word the reply already holds is missed, and the call is
// given one of the guard's own.
test("Responses: two dropped calls in two containers are two items", async () => {
  const body = {
    output: [
      { type: "function_call", name: "", arguments: "{}" },
      { type: "message", content: [{ type: "function_call", name: "", arguments: "{}" }] },
    ],
  };
  const response = await guardToolResponse(Response.json(body), "responses", policy);
  assert.equal(response.status, 200);
  const items = (await response.json()).output;
  const notes = [
    items[0],
    items[1].content.find((item) => item.type === "message"),
  ].filter(Boolean);
  assert.equal(notes.length, 2, "both calls were left out");
  assert.deepEqual(
    notes.map((note) => note.content[0].text),
    [droppedNote(""), droppedNote("")],
  );
  assert.equal(
    new Set(notes.map((note) => note.id)).size,
    2,
    `two notes of one reply share an id: ${notes.map((note) => note.id).join(", ")}`,
  );
});

// A delta that carries `tool_calls: []` is not a call of anything: a gateway
// re-emitting the shape with a role-only delta sends one, and no call is
// being waited for. Reading it as a call opened a round with nothing in it —
// the choice's `ended` mark was dropped with it, so a later "tool_calls"
// finish stayed a tool use the client waits on forever, a choice the upstream
// never sent was flushed at [DONE], and a stream that then closed without the
// marker failed the whole turn "a tool call unfinished" while nothing was
// pending.
test("chat: an empty tool_calls delta is not a tool call", async () => {
  // The frame is the upstream's own and flows through as it came.
  const alone = frameData(
    await (await guardToolResponse(sse(event(chat({ tool_calls: [] })) + terminal("chat")), "chat", policy)).text(),
  );
  assert.deepEqual(alone, [{ choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: null }] }]);
  // A choice whose every call was left out still ends as a plain stop, though
  // an empty delta arrives after it (#76).
  const text =
    event(chat({ content: "hi" })) +
    event(chat({ tool_calls: [call("")] })) +
    event(chat({}, "tool_calls")) +
    event(chat({ tool_calls: [] })) +
    event(chat({}, "tool_calls")) +
    terminal("chat");
  const values = frameData(await (await guardToolResponse(sse(text), "chat", policy)).text());
  assert.deepEqual(
    values.map((data) => {
      const choice = data.choices[0];
      return [choice.finish_reason, choice.delta?.tool_calls];
    }),
    [
      [null, undefined],
      ["stop", undefined],
      [null, []],
      ["stop", undefined],
    ],
    "the empty delta opened a round, or the choice's ending was lost with it",
  );
  // And a stream that closes without the marker after one blames the ending it
  // did not get, not a call that was never there.
  const cut = event(chat({ content: "hi" })) + event(chat({ tool_calls: [] }));
  const blamed = await (await guardToolResponse(sse(cut), "chat", policy)).text();
  assert.doesNotMatch(blamed, /a tool call unfinished/);
  assert.match(blamed, /stream ended without a completion marker/);
});

test("chat: the note follows the text the model wrote before its call", async () => {
  const text =
    event(chat({ content: "Fixing the stray heredoc marker." })) +
    event(chat({ tool_calls: [call("")] }, "tool_calls")) +
    terminal("chat");
  const response = await guardToolResponse(sse(text), "chat", policy);
  assert.equal(
    textIn("chat", frameData(await response.text())),
    `Fixing the stray heredoc marker.\n\n${droppedNote("")}`,
  );
});

test("chat: a call kept beside one left out is numbered from 0", async () => {
  const text =
    event(chat({ tool_calls: [call("", 0), call("read", 1, '{"path":"a"}')] }, "tool_calls")) +
    terminal("chat");
  const response = await guardToolResponse(sse(text), "chat", policy);
  const values = frameData(await response.text());
  const calls = values
    .flatMap((data) => data.choices ?? [])
    .flatMap((c) => c.delta?.tool_calls ?? []);
  assert.deepEqual(calls, [
    {
      index: 0,
      id: "call-1",
      type: "function",
      function: { name: "Read", arguments: '{"path":"a"}' },
    },
  ]);
  const finishes = values.flatMap((data) => data.choices ?? []).map((c) => c.finish_reason);
  assert.ok(finishes.includes("tool_calls"));
});

// The other half of that rule: a fragment that names no index at all. It is
// read as the first call's — the collapse path reads it the same way, and a
// fragment that names no place has no other one to hold — so the two paths
// over one stream answer one reply. The guard's flush of the same bytes is
// what a client that streams gets, and the collapse of those bytes is what a
// client that does not gets.
test("chat: a fragment that names no index is read the same by both paths", async () => {
  const text =
    event(chat({ tool_calls: [{ index: 0, id: "c0", type: "function", function: { name: "Bash", arguments: "" } }] })) +
    event(chat({ tool_calls: [{ index: 1, id: "c1", type: "function", function: { name: "Read", arguments: "" } }] })) +
    event(chat({ tool_calls: [{ function: { arguments: '{"file":"a"}' } }] })) +
    event(chat({}, "tool_calls")) +
    terminal("chat");
  const streamed = await guardToolResponse(sse(text), "chat", policy);
  const guarded = await streamed.text();
  const calls = frameData(guarded)
    .flatMap((data) => data.choices ?? [])
    .flatMap((choice) => choice.delta?.tool_calls ?? [])
    .map((kept) => `${kept.function.name}${kept.function.arguments}`);
  assert.deepEqual(calls, ['Bash{"file":"a"}', "Read"]);
  const collapsed = await collapseResponse(sse(guarded), "chat");
  assert.equal(collapsed.status, 200);
  const body = await collapsed.json();
  assert.deepEqual(
    (body.choices[0].message.tool_calls ?? []).map(
      (kept) => `${kept.function.name}${kept.function.arguments}`,
    ),
    calls,
    "the streamed reply and its collapsed copy disagree about a fragment with no index",
  );
});

// D1 (review round, DEC-3): the other shape of the same rule — two index-less
// fragments, each naming a different id. Reading every one of them as the
// first slot merged the two calls into one: the second call's id, both names
// run together ("bashread"), and both argument objects on it, while the same
// reply as one JSON body answers two calls. A fragment that names no place is
// placed by the id it carries: an id an open call of this choice already
// answers is that call's slot, and one no open call answers is a call of its
// own, which takes the next unused slot. A fragment with no usable id at all
// is read as the first slot, which the test above pins.
test("chat: index-less fragments naming different ids are two calls, in both paths", async () => {
  const fragments =
    event({
      id: "x",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                id: "call_A",
                type: "function",
                function: { name: "bash", arguments: '{"a":1}' },
              },
            ],
          },
        },
      ],
    }) +
    event({
      id: "x",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                id: "call_B",
                type: "function",
                function: { name: "read", arguments: '{"b":2}' },
              },
            ],
          },
        },
      ],
    }) +
    event({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
    terminal("chat");
  // The same two calls as one JSON body, told apart the way Chat's own shape
  // tells two calls apart: one call per index.
  const body = {
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_A",
              type: "function",
              function: { name: "bash", arguments: '{"a":1}' },
            },
            {
              index: 1,
              id: "call_B",
              type: "function",
              function: { name: "read", arguments: '{"b":2}' },
            },
          ],
        },
      },
    ],
  };
  const words = (calls) =>
    calls.map((kept) => `${kept.id}:${kept.function.name}${kept.function.arguments}`);
  const streamed = await guardToolResponse(sse(fragments), "chat", policy);
  assert.equal(streamed.status, 200);
  const guarded = await streamed.text();
  const kept = frameData(guarded)
    .flatMap((data) => data.choices ?? [])
    .flatMap((choice) => choice.delta?.tool_calls ?? []);
  const calls = words(kept);
  const whole = await guardToolResponse(
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    "chat",
    policy,
  );
  assert.deepEqual(
    calls,
    words((await whole.json()).choices[0].message.tool_calls ?? []),
    "the streamed reply and the one-body reply disagree about two calls that name no index",
  );
  // The collapse path places the two calls by the same ids, each with its own
  // arguments: what it reads of the upstream fragments is what the guard read
  // of them. The names it carries stay as the upstream wrote them — the
  // accumulator has no tool policy — so the two are compared by the calls
  // themselves.
  const collapsed = await collapseResponse(sse(fragments), "chat");
  assert.equal(collapsed.status, 200);
  assert.deepEqual(
    (await collapsed.json()).choices[0].message.tool_calls.map(
      (call) => `${call.id}:${call.function.arguments}`,
    ),
    kept.map((call) => `${call.id}:${call.function.arguments}`),
    "the collapsed reply places the two calls differently from the streamed one",
  );
  // And the bytes the streaming client was handed, collapsed for a client that
  // reads no stream (provider.mjs collapses the guarded stream), are the same
  // reply once more.
  const back = await collapseResponse(sse(guarded), "chat");
  assert.equal(back.status, 200);
  assert.deepEqual(
    words((await back.json()).choices[0].message.tool_calls ?? []),
    calls,
    "the streamed reply and its collapsed copy disagree about two calls that name no index",
  );
});

// D2 (review round, DEC-4): a call the reply left out, then a call it kept —
// and the dropped one's arguments frame arrives while the stream is inside the
// kept one, naming the dropped item by a word its frame never placed. The
// frame was read as the kept item's, so the client was handed the arguments of
// an item it had been told was replaced by a note. A word that names a call
// left out is read before the item the stream is inside, whether or not the
// frame gives a place of its own.
test("Responses: a dropped call's arguments frames are not the kept call's", async () => {
  const dropped = { type: "function_call", id: "fc_1", call_id: "call_1", arguments: "" };
  const kept = {
    type: "function_call",
    id: "fc_2",
    call_id: "call_2",
    name: "bash",
    arguments: "",
  };
  for (const word of ["fc_1", "call_1"]) {
    const text =
      event({ type: "response.output_item.added", item: dropped }) +
      event({ type: "response.output_item.added", output_index: 0, item: kept }) +
      event({
        type: "response.function_call_arguments.delta",
        item_id: word,
        delta: '{"leaked":1}',
      }) +
      event({
        type: "response.function_call_arguments.done",
        item_id: word,
        arguments: '{"leaked":1}',
      }) +
      event({
        type: "response.function_call_arguments.delta",
        item_id: "fc_2",
        delta: '{"k":1}',
      }) +
      event(
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              { ...dropped, arguments: '{"leaked":1}' },
              { ...kept, arguments: '{"k":1}' },
            ],
          },
        },
        "response.completed",
      );
    const streamed = await guardToolResponse(sse(text), "responses", policy);
    assert.equal(streamed.status, 200, `the frame naming ${word} was not a reply`);
    const data = frameData(await streamed.text());
    assert.deepEqual(
      data
        .filter((value) => value.type?.startsWith("response.function_call_arguments"))
        .map((value) => [value.item_id, value.delta ?? value.arguments]),
      [["fc_2", '{"k":1}']],
      `the arguments frame naming ${word} reached the client, or the kept call lost its own`,
    );
    assert.deepEqual([...new Set(callsIn("responses", data))], ["Bash"]);
  }
});

// The shapes a reply's names claim: the fields a client reads as a list, and
// the fields it reads as one item. A frame that hands on a value which is not
// the shape its name claims is a frame a host crashes on — `output[0].id` over
// a null, `choices[0]` over an object — and the collapse path never hands one
// on, so neither may the guard. Walked like the verifier's probe: every array
// entry, at any depth, and every named field the protocol claims.
const CONTAINERS = {
  chat: ["choices", "tool_calls"],
  responses: ["output", "content"],
  anthropic: ["content"],
};
const ITEM_FIELDS = {
  chat: ["message"],
  responses: ["item", "part", "response"],
  anthropic: ["message", "content_block"],
};
function shapeDrift(protocol, values) {
  const found = [];
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((entry, at) => {
        if (entry === null || typeof entry !== "object")
          found.push(`${path}[${at}]=${JSON.stringify(entry)}`);
        else walk(entry, `${path}[${at}]`);
      });
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === "error") continue;
      if (
        CONTAINERS[protocol].includes(key) &&
        entry !== undefined &&
        entry !== null &&
        !Array.isArray(entry)
      )
        found.push(`${path}.${key} is not a list`);
      if (
        ITEM_FIELDS[protocol].includes(key) &&
        entry !== undefined &&
        !(entry && typeof entry === "object" && !Array.isArray(entry))
      )
        found.push(`${path}.${key} is not an item`);
      walk(entry, `${path}.${key}`);
    }
  };
  walk(values, "");
  return found;
}

// The invariant D1 pinned for placement, for shapes: the guard and the
// collapse path read one stream as one reply. A snapshot entry or container
// that cannot be walked is skipped, never a refusal of the whole reply — the
// reading stream.mjs was given for M-43 (a snapshot that is not one stands in
// for nothing) — so a streaming client is never handed an error where the
// client that reads no stream is handed a body. The throw the walk used to
// make on the first value that was not an object took the sound frames of the
// reply with it.
//
// Skipping it in the walk is not enough: the frame goes on as it arrived, and
// the value the guard would not read is the value the client cannot read
// either. No frame hands one on — a list is rebuilt without it, a container
// that is not a list is handed on as an empty one, and a field that is not an
// item is removed — which is what the `shapeDrift` assertion below reads off
// the frames the guard hands on, on top of the two paths answering alike.
//
// Every row below is bytes both paths answer today. A container the collapse
// path reads without a guard of its own — a `choices` or `tool_calls` that is
// not a list, or a content delta whose block never opened — is refused there
// with a TypeError of its own; the guard is deliberately the tolerant one for
// those, and the split is reported to the lead rather than frozen here (the
// `tolerant` list below pins the guard's own answer only).
test("a malformed snapshot entry is skipped, not fatal, in both paths", async () => {
  const message = (content) => ({ type: "message", id: "msg_1", role: "assistant", content });
  const text = (value) => ({ type: "output_text", text: value });
  const opened = (output) =>
    event({ type: "response.created", response: { id: "r1", status: "in_progress", output } });
  const added = (item) => event({ type: "response.output_item.added", output_index: 0, item });
  const part = (value) =>
    event({ type: "response.content_part.added", output_index: 0, content_index: 0, part: value });
  const said = (delta) =>
    event({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta });
  const completed = (output) =>
    event(
      { type: "response.completed", response: { id: "r1", status: "completed", output } },
      "response.completed",
    );
  const chatDelta = (delta) => event({ choices: [{ index: 0, delta }] });
  const chatFinish = (finish_reason) => event({ choices: [{ index: 0, delta: {}, finish_reason }] });
  const chatMessage = (value) => event({ choices: [{ index: 0, message: value }] });
  const began = (content = []) =>
    event(
      { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content } },
      "message_start",
    );
  const block = (content_block) =>
    event({ type: "content_block_start", index: 0, content_block }, "content_block_start");
  const rows = [
    ["responses", "a content part that is a string", [opened([]), part("hello"), said("x")]],
    ["responses", "a terminal output entry that is null", [
      added(message([])),
      said("hi"),
      completed([null, message([text("hi")])]),
    ]],
    ["responses", "an item that is a string", [opened([]), added("not-an-item")]],
    ["responses", "an item that is a number", [opened([]), added(42)]],
    ["responses", "a response that is a string", [
      event({ type: "response.created", response: "not-a-response" }),
    ]],
    ["responses", "an output that is an object", [opened({})]],
    ["responses", "item content that is an object", [added(message({}))]],
    ["chat", "a delta tool_calls that is a string", [
      chatDelta({ tool_calls: "nope" }),
      chatFinish("tool_calls"),
    ]],
    ["chat", "a delta call whose function is a string", [
      chatDelta({ tool_calls: [{ index: 0, id: "c0", type: "function", function: "nope" }] }),
      chatFinish("tool_calls"),
    ]],
    ["chat", "a delta call whose arguments are a number", [
      chatDelta({
        tool_calls: [
          { index: 0, id: "c0", type: "function", function: { name: "bash", arguments: 5 } },
        ],
      }),
      chatFinish("tool_calls"),
    ]],
    ["chat", "a delta function_call that is a string", [
      chatDelta({ function_call: "not-a-call" }),
      chatFinish("function_call"),
    ]],
    ["chat", "a delta function_call whose name is a number", [
      chatDelta({ function_call: { name: 5 } }),
      chatFinish("function_call"),
    ]],
    ["chat", "a snapshot call entry that is a string", [
      chatMessage({ role: "assistant", tool_calls: ["nope"] }),
    ]],
    ["chat", "a snapshot call whose function is a string", [
      chatMessage({
        role: "assistant",
        tool_calls: [{ id: "c0", type: "function", function: "nope" }],
      }),
    ]],
    ["anthropic", "a content block that is a string", [began(), block("nope")]],
    ["anthropic", "a content block that is an array", [began(), block([])]],
    ["anthropic", "a message_start message that is a string", [
      event({ type: "message_start", message: "nope" }, "message_start"),
    ]],
    ["anthropic", "a message content entry that is null", [began([null])]],
    ["anthropic", "a message content that is an object", [began({})]],
  ];
  for (const [protocol, label, frames] of rows) {
    const text_ = frames.join("") + terminal(protocol);
    const streamed = await guardToolResponse(sse(text_), protocol, policy);
    const guarded = await streamed.text();
    assert.equal(streamed.status, 200, `${label}: the guard refused the reply`);
    assert.ok(
      !parse(guarded).some(
        (frame) => frame.name === "error" || frame.data?.type === "error" || frame.data?.error,
      ),
      `${label}: the guard answered an error where the collapse path answers a body`,
    );
    const collapsed = await collapseResponse(sse(text_), protocol);
    assert.equal(collapsed.status, 200, `${label}: the collapse path refused these bytes`);
    assert.ok(!(await collapsed.text()).includes('"error"'), `${label}: the collapse answered an error`);
    assert.deepEqual(
      shapeDrift(protocol, frameData(guarded)),
      [],
      `${label}: a value the client cannot read as the shape its name claims was handed on`,
    );
  }
  // The shapes the collapse path refuses with an unguarded read of its own:
  // the guard answers these, and that answer is what is pinned here. Matching
  // stream.mjs's TypeError would mean failing a reply this decision says to
  // skip.
  const tolerant = [
    ["chat", "a delta tool_calls that is an object", [
      chatDelta({ tool_calls: {} }),
      chatFinish("tool_calls"),
    ]],
    ["chat", "a delta tool_calls entry that is null", [
      chatDelta({ tool_calls: [null] }),
      chatFinish("tool_calls"),
    ]],
    ["chat", "a choices that is an object", [event({ choices: {} })]],
    ["anthropic", "a content delta whose block never opened", [
      began(),
      block("nope"),
      event(
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        "content_block_delta",
      ),
    ]],
  ];
  for (const [protocol, label, frames] of tolerant) {
    const streamed = await guardToolResponse(sse(frames.join("") + terminal(protocol)), protocol, policy);
    const guarded = await streamed.text();
    assert.equal(streamed.status, 200, `${label}: the guard refused the reply`);
    assert.ok(
      !parse(guarded).some(
        (frame) => frame.name === "error" || frame.data?.type === "error" || frame.data?.error,
      ),
      `${label}: the guard answered an error`,
    );
    assert.deepEqual(
      shapeDrift(protocol, frameData(guarded)),
      [],
      `${label}: a value the client cannot read as the shape its name claims was handed on`,
    );
  }
  // The same shapes as one whole reply, where no collapse path is involved:
  // the walk reads them the same way, as a body rather than a 502.
  for (const [label, body] of [
    ["a malformed item", { item: "not-an-item" }],
    ["a malformed output entry", { output: [null] }],
    ["a malformed part", { part: "hello" }],
  ]) {
    const result = await guardToolResponse(Response.json(body), "responses", policy);
    assert.equal(result.status, 200, `${label}: a whole reply was refused`);
  }
});

// The entry that could not be walked does not take the sound ones with it: the
// message beside a null entry is still delivered by both paths, whole.
test("a malformed entry does not take the sound ones with it", async () => {
  const message = { type: "message", id: "msg_1", role: "assistant" };
  const text =
    event({ type: "response.output_item.added", output_index: 0, item: message }) +
    event({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hi" }) +
    event(
      {
        type: "response.completed",
        response: {
          id: "r1",
          status: "completed",
          output: [null, { ...message, content: [{ type: "output_text", text: "hi" }] }],
        },
      },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  assert.equal(textIn("responses", frameData(await streamed.text())), "hi");
  const collapsed = await collapseResponse(sse(text), "responses");
  assert.equal(collapsed.status, 200);
  const body = await collapsed.json();
  assert.deepEqual(body.output.map((item) => item.id), ["msg_1"]);
  assert.equal(body.output[0].content[0].text, "hi");
});

// The frame goes on rewritten, not as it arrived: a client that reads
// `choices[0]`, `output[0].id` or `content[0].type` reads the shape its name
// claims. A list is rebuilt without the entry that is not one, a container
// that is not a list is handed on as an empty one, and a field that is not an
// item is removed — and `changed` is what makes the rewritten frame the frame
// that goes out.
test("a frame hands on the shapes its names claim, rewritten", async () => {
  const message = (content) => ({ type: "message", id: "msg_1", role: "assistant", content });
  const opened = (output) =>
    event({ type: "response.created", response: { id: "r1", status: "in_progress", output } });
  const added = (item) => event({ type: "response.output_item.added", output_index: 0, item });
  const part = (value) =>
    event({ type: "response.content_part.added", output_index: 0, content_index: 0, part: value });
  const completed = (output) =>
    event(
      { type: "response.completed", response: { id: "r1", status: "completed", output } },
      "response.completed",
    );
  const chatDelta = (delta) => event({ choices: [{ index: 0, delta }] });
  const began = (content = []) =>
    event(
      { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content } },
      "message_start",
    );
  const block = (content_block) =>
    event({ type: "content_block_start", index: 0, content_block }, "content_block_start");
  const cases = [
    ["responses", "an output that is an object", [opened({})], (values) => values[0].response.output, []],
    ["responses", "an output entry that is null", [
      completed([null, message([])]),
    ], (values) => values[0].response.output, [message([])]],
    ["responses", "an item that is a string", [added("not-an-item")], (values) => values[0].item, undefined],
    ["responses", "a part that is a string", [
      opened([]),
      added(message([])),
      part("hello"),
    ], (values) => values[2].part, undefined],
    ["responses", "a response that is a string", [
      event({ type: "response.created", response: "not-a-response" }),
    ], (values) => values[0].response, undefined],
    ["responses", "a terminal whose response is null", [
      event({ type: "response.completed", response: null }, "response.completed"),
    ], (values) => values[0].response, undefined],
    ["responses", "item content that is an object", [added(message({}))], (values) => values[0].item.content, []],
    ["responses", "item content that carries null", [added(message([null]))], (values) => values[0].item.content, []],
    ["chat", "a choices that is an object", [
      event({ choices: {} }),
      chatDelta({ content: "hi" }),
    ], (values) => textIn("chat", values), "hi"],
    ["chat", "a choice that is a string", [
      event({ choices: ["nope"] }),
      chatDelta({ content: "hi" }),
    ], (values) => textIn("chat", values), "hi"],
    ["chat", "a delta tool_calls that is an object", [
      chatDelta({ tool_calls: {} }),
    ], (values) => values[0].choices[0].delta.tool_calls, []],
    ["chat", "a delta tool_calls entry that is null", [
      chatDelta({ tool_calls: [null] }),
      chatDelta({ content: "hi" }),
    ], (values) => values.flatMap((value) => value.choices ?? []).flatMap((choice) => choice.delta?.tool_calls ?? []), []],
    ["anthropic", "a content block that is a string", [began(), block("nope")], (values) => values[1].content_block, undefined],
    ["anthropic", "a message content that is an object", [began({})], (values) => values[0].message.content, []],
    ["anthropic", "a message content that carries null", [began([null])], (values) => values[0].message.content, []],
  ];
  for (const [protocol, label, frames, read, wanted] of cases) {
    const streamed = await guardToolResponse(sse(frames.join("") + terminal(protocol)), protocol, policy);
    assert.equal(streamed.status, 200, `${label}: the guard refused the reply`);
    const values = frameData(await streamed.text());
    assert.deepEqual(read(values), wanted, `${label}: the frame was not rewritten`);
    assert.deepEqual(shapeDrift(protocol, values), [], `${label}: the client read a shape its name does not claim`);
  }
});

// The malformed container does not take the sound call with it: a call beside
// a `tool_calls` that is not a list still reaches both clients.
test("a sound call beside a container that is not a list still reaches both clients", async () => {
  const sound =
    event({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: "call_sound", type: "function", function: { name: "bash", arguments: "{}" } },
    ] } }] }) + event({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  const text =
    event({ choices: [{ index: 0, delta: { tool_calls: {} } }] }) + sound + terminal("chat");
  const streamed = await guardToolResponse(sse(text), "chat", policy);
  assert.equal(streamed.status, 200);
  const guarded = await streamed.text();
  const values = frameData(guarded);
  assert.deepEqual([...new Set(callsIn("chat", values))], ["Bash"]);
  assert.deepEqual(shapeDrift("chat", values), []);
  // The client that reads no stream gets the same call from the bytes the
  // streaming client was handed (provider.mjs collapses the guarded stream).
  const collapsed = await collapseResponse(sse(guarded), "chat");
  assert.equal(collapsed.status, 200);
  const body = await collapsed.json();
  assert.deepEqual(
    (body.choices[0].message.tool_calls ?? []).map((call) => call.function.name),
    ["Bash"],
  );
});

// The two rows where the guard arm and the collapse arm still disagreed about
// one upstream reply. A Messages `message_start` types its `content` as a list
// of blocks, and the collapse path fills that field in itself and appends the
// deltas to it: a reply that names null there is an empty list to the client
// that reads no stream, and is handed on as one now.
test("anthropic: a message_start whose content is null reads as an empty list, in both paths", async () => {
  const text =
    event(
      { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: null } },
      "message_start",
    ) + terminal("anthropic");
  const streamed = await guardToolResponse(sse(text), "anthropic", policy);
  assert.equal(streamed.status, 200);
  assert.deepEqual(frameData(await streamed.text())[0].message.content, []);
  const collapsed = await collapseResponse(sse(text), "anthropic");
  assert.equal(collapsed.status, 200);
  assert.deepEqual((await collapsed.json()).content, []);
});

// A Chat `content` that is neither text nor null is no text: the collapse path
// appends only the strings a delta carries and answers an empty message, and
// the guard reads it the same way. Chat's own `content: null` is a spelling of
// its own (a tool-only reply) and is left alone — `tidy` never runs on a chat
// stream, so no rule of its can reach it.
test("chat: a content that is neither text nor null reads as null, in both paths", async () => {
  const cases = [
    ["a snapshot message's content is a list", event({ choices: [{ index: 0, message: { role: "assistant", content: ["a", null] } }] })],
    ["a delta's content is a list", event({ choices: [{ index: 0, delta: { content: ["a", null] } }] })],
    ["a snapshot message's content is a number", event({ choices: [{ index: 0, message: { role: "assistant", content: 7 } }] })],
  ];
  for (const [label, frame] of cases) {
    const text = frame + terminal("chat");
    const streamed = await guardToolResponse(sse(text), "chat", policy);
    assert.equal(streamed.status, 200, label);
    const choice = frameData(await streamed.text())[0]?.choices?.[0];
    const content = choice?.message ? choice.message.content : choice?.delta?.content;
    assert.equal(content, null, `${label}: the guard handed on a content that is not text`);
    const collapsed = await collapseResponse(sse(text), "chat");
    assert.equal(collapsed.status, 200, label);
    assert.equal((await collapsed.json()).choices[0].message.content, null, `${label}: the collapse read it differently`);
  }
  // The shapes left as they are: a null content is text's absence, not a list,
  // and both arms hand it on as null.
  for (const [label, frame, read] of [
    ["a snapshot message's content is null", event({ choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "c0", type: "function", function: { name: "bash", arguments: "{}" } }] } }] }), (values) => values[0].choices[0].message.content],
    ["a delta's content is null", event({ choices: [{ index: 0, delta: { content: null } }] }), (values) => values[0].choices[0].delta.content],
  ]) {
    const streamed = await guardToolResponse(sse(frame + terminal("chat")), "chat", policy);
    assert.equal(read(frameData(await streamed.text())), null, `${label}: a null content was rewritten`);
  }
});

// #209: an ambiguous fold is still never guessed. Both Bash and BASH are
// declared, so "bash" folds to two of the agent's tools and the guard cannot
// tell which one the model meant — it hands the call on as called, and the
// agent (which knows its own tools) is the one to answer it.
test("SSE: an ambiguous injected name is handed on as called, never guessed, in every protocol", async () => {
  const rules = { declared: new Set(["Bash", "BASH"]), injected: new Set(["bash"]) };
  for (const protocol of protocols) {
    const response = await guardToolResponse(
      sse(event(streamSnapshot(protocol, ["bash"])) + terminal(protocol)),
      protocol,
      rules,
    );
    const values = frameData(await response.text());
    assert.ok(!values.some((data) => data.type === "error" || data.error));
    assert.deepEqual(callsIn(protocol, values), ["bash"]);
    assert.equal(textIn(protocol, values), "");
  }
});

// The invariant every rewrite in this file is measured against: a frame the
// guard has nothing to change goes out as the bytes the upstream sent
// (`frame.raw`), and only a frame that carries a call whose name changes is
// re-encoded. The bytes are what a client that does not parse everything
// sees — the event name, the spacing, a number written `1e3` — and a
// re-serialization is exactly where those are lost. So the frames below are
// written with a spacing and an exponent `JSON.stringify` would not produce
// (`event()` writes canonical JSON, which would make a forward and a rewrite
// indistinguishable). A re-encoded frame is asserted by what it must keep —
// its event name, the fields the guard never reads, and the values (`1e3` and
// `1000` are one number) — and never by its bytes.
test("Responses and Messages: a stream with nothing to change is forwarded frame for frame", async () => {
  // One space JSON.stringify would never write (it only ever starts an object
  // with "{"), and a number as an exponent: the two marks of a frame that was
  // forwarded rather than re-encoded. The space is written after the opening
  // brace only, so no string value of the payload is touched.
  const frame = (data, name) =>
    `event: ${name}\ndata: ${JSON.stringify(data)
      .replace(/^\{/, "{ ")
      .replace(/\b1000\b/g, "1e3")}\n\n`;
  const framesOf = (text) => text.split("\n\n").filter(Boolean);
  const callItem = (name, id, extra = {}) => ({
    type: "function_call",
    id,
    call_id: id,
    name,
    arguments: "{}",
    ...extra,
  });
  // Nothing to drop and nothing to fold: "Bash" is declared as written, and
  // "unknown" is handed on as called (#209), so no call of this reply changes.
  const untouched = {
    responses: [
      frame(
        {
          type: "response.created",
          response: { id: "r1", status: "in_progress", x_note: "kept", usage: { total_tokens: 1000 } },
        },
        "response.created",
      ),
      frame(
        {
          type: "response.output_item.added",
          output_index: 0,
          item: callItem("Bash", "fc_1", { x_vendor: { hint: 1000 } }),
        },
        "response.output_item.added",
      ),
      frame(
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 0,
          delta: '{"command":"ls"}',
        },
        "response.function_call_arguments.delta",
      ),
      frame(
        {
          type: "response.output_item.added",
          output_index: 1,
          item: callItem("unknown", "fc_2", { x_vendor: [1, 2, 3] }),
        },
        "response.output_item.added",
      ),
      frame(
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { ...callItem("Bash", "fc_1"), arguments: '{"command":"ls"}', status: "completed" },
        },
        "response.output_item.done",
      ),
      frame(
        { type: "response.output_item.done", output_index: 1, item: { ...callItem("unknown", "fc_2"), status: "completed" } },
        "response.output_item.done",
      ),
      frame(
        {
          type: "response.completed",
          response: {
            id: "r1",
            status: "completed",
            output: [
              { ...callItem("Bash", "fc_1"), arguments: '{"command":"ls"}', status: "completed" },
              { ...callItem("unknown", "fc_2"), status: "completed" },
            ],
          },
        },
        "response.completed",
      ),
    ].join(""),
    anthropic: [
      frame(
        {
          type: "message_start",
          message: {
            id: "m1",
            type: "message",
            role: "assistant",
            content: [],
            x_note: "kept",
            usage: { input_tokens: 1000 },
          },
        },
        "message_start",
      ),
      frame(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "t1", name: "Bash", input: {}, x_vendor: { hint: 1000 } },
        },
        "content_block_start",
      ),
      frame(
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
        "content_block_delta",
      ),
      frame({ type: "content_block_stop", index: 0 }, "content_block_stop"),
      frame(
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t2", name: "unknown", input: {} } },
        "content_block_start",
      ),
      frame({ type: "content_block_stop", index: 1 }, "content_block_stop"),
      frame(
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
        "message_delta",
      ),
      frame({ type: "message_stop" }, "message_stop"),
    ].join(""),
  };
  for (const protocol of ["responses", "anthropic"]) {
    const raw = untouched[protocol];
    const out = await (await guardToolResponse(sse(raw), protocol, policy)).text();
    assert.equal(out, raw, `${protocol}: a reply with nothing to change was re-encoded`);
    // And the reply really held calls: a stream with none would be no test of
    // what a call does to a frame.
    assert.deepEqual([...new Set(callsIn(protocol, frameData(out)))].sort(), ["Bash", "unknown"]);
  }
  // One name to fold: "bash" is the injected spelling of the declared "Bash",
  // so the frames that carry it are the only ones re-encoded — and the ones
  // beside them are still the upstream's own bytes.
  const folded = {
    responses: [
      frame(
        {
          type: "response.created",
          response: { id: "r1", status: "in_progress", x_note: "kept", usage: { total_tokens: 1000 } },
        },
        "response.created",
      ),
      frame(
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...callItem("bash", "call_1"), x_vendor: { hint: 1000 } },
        },
        "response.output_item.added",
      ),
      frame(
        {
          type: "response.completed",
          response: {
            id: "r1",
            status: "completed",
            output: [{ ...callItem("bash", "call_1"), status: "completed" }],
          },
        },
        "response.completed",
      ),
    ].join(""),
    anthropic: [
      frame(
        {
          type: "message_start",
          message: { id: "m1", type: "message", role: "assistant", content: [], x_note: "kept" },
        },
        "message_start",
      ),
      frame(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "t1", name: "bash", input: {}, x_vendor: { hint: 1000 } },
        },
        "content_block_start",
      ),
      frame(
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
        "message_delta",
      ),
      frame({ type: "message_stop" }, "message_stop"),
    ].join(""),
  };
  const renamed = {
    responses: async (out) => {
      const emitted = framesOf(out);
      const added = parse(emitted[1])[0];
      assert.equal(added.name, "response.output_item.added", "the event name was lost");
      assert.equal(added.data.item.name, "Bash");
      assert.equal(added.data.output_index, 0);
      assert.equal(added.data.item.x_vendor.hint, 1000, "a field the guard never reads was lost");
      const ended = parse(emitted[2])[0];
      assert.equal(ended.name, "response.completed");
      assert.equal(ended.data.response.output[0].name, "Bash");
    },
    anthropic: async (out) => {
      const emitted = framesOf(out);
      const started = parse(emitted[1])[0];
      assert.equal(started.name, "content_block_start", "the event name was lost");
      assert.equal(started.data.content_block.name, "Bash");
      assert.equal(started.data.content_block.id, "t1");
      assert.equal(started.data.index, 0);
      assert.equal(started.data.content_block.x_vendor.hint, 1000, "a field the guard never reads was lost");
    },
  };
  for (const protocol of ["responses", "anthropic"]) {
    const raw = folded[protocol];
    const out = await (await guardToolResponse(sse(raw), protocol, policy)).text();
    const upstream = framesOf(raw);
    const emitted = framesOf(out);
    assert.equal(emitted.length, upstream.length, `${protocol}: a frame was added or lost`);
    // response.created / message_start: no call in it, and the upstream's own
    // bytes — which is what says the reply was not re-encoded wholesale.
    assert.equal(emitted[0], upstream[0], `${protocol}: a frame with no call was re-encoded`);
    await renamed[protocol](out);
    // The Messages stream has frames with no call of their own on either side
    // of the rewritten one, and each is still the upstream's own bytes; the
    // Responses stream's terminal frame carries the call too, so it has no
    // untouched neighbour left to pin here.
    if (protocol === "anthropic")
      for (const at of [2, upstream.length - 1])
        assert.equal(emitted[at], upstream[at], `anthropic: frame ${at} was re-encoded`);
  }
});

test("Responses and Messages: a streamed call left out comes as text in its place", async () => {
  const responses = frameData(
    await (
      await guardToolResponse(sse(toolStream("responses", "")), "responses", policy)
    ).text(),
  );
  assert.deepEqual(
    responses.map((data) => data.type),
    [
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ],
  );
  const note = droppedNote("");
  // The note is the guard's own item, named in the guard's own namespace:
  // `msg_` and then the call_id the reply gave it (or the place it holds). It
  // used to take the id of the item it replaced verbatim — `fc_1` here — and a
  // reply that hands one word to two items then answered to that word for both
  // the note and the item it kept, which a client keying by id reads as one
  // item where the reply has two (task-11: the kept call and the dropped call
  // named by one id). Behind `msg_` the word cannot collide with an id of the
  // reply, and the note still answers one id in its item, its text frames and
  // the terminal's copy.
  const message = { type: "message", id: "msg_call_1", role: "assistant", status: "completed" };
  assert.deepEqual(responses[6].item, {
    ...message,
    content: [{ type: "output_text", text: note, annotations: [] }],
  });
  assert.deepEqual(responses[7].response.output, [responses[6].item]);
  for (const data of responses.slice(2, 6)) {
    assert.equal(data.item_id, "msg_call_1");
    assert.equal(data.output_index, 0);
  }
  const messages = frameData(
    await (
      await guardToolResponse(sse(toolStream("anthropic", "")), "anthropic", policy)
    ).text(),
  );
  assert.deepEqual(
    messages.map((data) => data.type),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );
  assert.deepEqual(messages[1].content_block, { type: "text", text: "" });
  assert.deepEqual(messages[2].delta, { type: "text_delta", text: droppedNote("") });
  assert.equal(messages[4].delta.stop_reason, "end_turn");
});

test("Messages: a kept call keeps the tool_use stop beside one left out", async () => {
  const text = [
    {
      type: "message_start",
      message: { id: "m1", type: "message", role: "assistant", content: [] },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "a", name: "", input: {} },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "b", name: "bash", input: {} },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ]
    .map((value) => event(value, value.type))
    .join("");
  const values = frameData(await (await guardToolResponse(sse(text), "anthropic", policy)).text());
  assert.deepEqual(callsIn("anthropic", values), ["Bash"]);
  assert.equal(values.find((data) => data.type === "message_delta").delta.stop_reason, "tool_use");
});

test("downstream cancellation interrupts a pending upstream read", async () => {
  for (const protocol of protocols) {
    let cancelReason;
    const source = openSource(event({ harmless: true }), (reason) => {
      cancelReason = reason;
    });
    const response = await guardToolResponse(source.response, protocol, policy);
    const reader = response.body.getReader();
    await reader.read();
    const waiting = reader.read();
    await Promise.resolve();
    await withTimeout(reader.cancel("abort now"));
    assert.equal((await withTimeout(waiting)).done, true);
    assert.equal(cancelReason, "abort now");
    assert.equal(source.response.body.locked, false);
  }
});

// 32+ MiB through the guard, like the CRLF test below: not held to bun's 5 s default
test("chat: completed tool buffers release their cumulative budget", { timeout: 60_000 }, async () => {
  let count = 0;
  const bytes = encoder.encode(
    event(chat({ tool_calls: [call("bash", 0, "x".repeat(1024 * 1024))] }, "tool_calls")),
  );
  // Enough events of their own to put the stream past the limit the guard
  // reads through, counted from that constant rather than from a literal: a
  // literal would keep sending the old number of bytes after the constant
  // grew and test nothing at the boundary. Every event carries a finished
  // call, so each round's bytes are released as it finishes — which is what
  // lets more than the limit flow through the buffer at all.
  const chunks = Math.ceil(MAX_BYTES / bytes.byteLength) + 1;
  const source = new Response(
    new ReadableStream({
      pull(controller) {
        if (count < chunks) {
          count++;
          return controller.enqueue(bytes);
        }
        if (count++ === chunks) return controller.enqueue(encoder.encode(terminal("chat")));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const response = await guardToolResponse(source, "chat", policy);
  const reader = response.body.getReader();
  let tools = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const data = parse(new TextDecoder().decode(value))[0].data;
    if (data === "[DONE]") continue;
    assert.equal(data.choices[0].delta.tool_calls[0].function.name, "Bash");
    tools++;
  }
  assert.equal(tools, chunks);
});

// 64 MiB through the guard: seconds of work, more under load, so it isn't
// held to bun's 5 s default (it timed out on a machine at load 110)
test(
  "SSE event byte limit includes both bytes of CRLF even across chunks",
  { timeout: 60_000 },
  async () => {
    const prefix = 'data: {"text":"';
    const suffix = '"}\r\n\r\n';
    // A byte over the limit the guard names, whatever MAX_BYTES is: a literal
    // here would keep exercising the old boundary after a change to it.
    const text = prefix + "x".repeat(MAX_BYTES + 1 - prefix.length - suffix.length) + suffix;
    for (const chunkSize of [1024 * 1024, text.length - 1]) {
      const result = await guardToolResponse(sse(text, { chunkSize }), "chat", policy);
      const frames = parse(await result.text());
      assert.equal(frames.length, 1);
      assertError("chat", frames[0].data);
      assert.match(frames[0].data.error.message, /32 MiB|limit/i);
    }
  },
);

// 32+ MiB through the guard, like the CRLF test below: not held to bun's 5 s default
test("text streams larger than 32 MiB are not subject to the pending-tool limit", { timeout: 60_000 }, async () => {
  let count = 0;
  const bytes = encoder.encode(event(chat({ content: "x".repeat(1024 * 1024) })));
  // Enough chunks of a MiB each to put this stream past `MAX_BYTES`, counted
  // from that constant rather than from a literal: a literal would keep sending
  // the old number of bytes after the constant grew and test nothing at the
  // boundary. The assertion below reads the same constant.
  const chunks = Math.ceil(MAX_BYTES / bytes.byteLength) + 1;
  const source = new Response(
    new ReadableStream({
      pull(controller) {
        if (count < chunks) {
          count++;
          return controller.enqueue(bytes);
        }
        if (count++ === chunks) return controller.enqueue(encoder.encode(terminal("chat")));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const result = await guardToolResponse(source, "chat", policy);
  const reader = result.body.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    assert.ok(!new TextDecoder().decode(value).includes('"error"'));
  }
  // More than the limit the guard reads through, taken from the constant: a
  // literal here would keep passing against the old boundary after a change
  // to it.
  assert.ok(total > MAX_BYTES);
});

// #91: Zen closed space-bunny-free's Chat stream after these three frames,
// with no finish_reason, usage or [DONE] (the reporter's bytes).
const cutFrames =
  `data: {"id":"x2","object":"chat.completion.chunk","created":1,"model":"space-bunny-free","choices":[{"index":0,"delta":{"role":"assistant"}}],"usage":null}\n\n` +
  `data: {"id":"x2","object":"chat.completion.chunk","created":1,"model":"space-bunny-free","choices":[{"index":0,"delta":{"content":"Installed successfully and all"}}],"usage":null}\n\n` +
  `data: {"id":"x2","object":"chat.completion.chunk","created":1,"model":"space-bunny-free","choices":[{"index":0,"delta":{"content":" other plugins are intact."}}],"usage":null}\n\n`;
const streaming = { endCutShort: true };

test("chat: a stream cut short after its text ends as one, with a note and [DONE] (#91)", async () => {
  for (const chunkSize of [7, 31, 4096]) {
    const result = await guardToolResponse(sse(cutFrames, { chunkSize }), "chat", policy, streaming);
    const text = await result.text();
    assert.equal(result.status, 200);
    assert.ok(text.startsWith(cutFrames), "what was said goes on unchanged");
    assert.doesNotMatch(text, /"error"/);
    const frames = parse(text);
    assert.equal(frames.at(-1).data, "[DONE]");
    const end = frames.at(-2).data;
    assert.equal(end.id, "x2");
    assert.equal(end.model, "space-bunny-free");
    assert.deepEqual(end.choices, [
      { index: 0, delta: { content: `\n\n${cutShortNote}` }, finish_reason: "stop" },
    ]);
  }
});

// A choice that finished and then started another round is open again: the
// buffer judges a later round for the same choice on what that round holds, and
// the tracker has to agree. Latching the choice shut left a round opened
// afterwards, and cut short, with no note and no `finish_reason` at all — a bare
// `[DONE]` for a choice the client had already been told had stopped.
test("chat: a round opened after a choice finished is still ended by a cut (#91)", async () => {
  const text =
    event(chat({ role: "assistant", content: "one" })) +
    event(chat({}, "stop")) +
    event(chat({ content: "two" }));
  const result = await guardToolResponse(sse(text), "chat", policy, streaming);
  const frames = parse(await result.text());
  assert.equal(frames.at(-1).data, "[DONE]", "the cut is still reported as an ending");
  assert.deepEqual(
    frames.at(-2).data.choices,
    [{ index: 0, delta: { content: `\n\n${cutShortNote}` }, finish_reason: "stop" }],
    "the reopened choice gets the note",
  );
});

test("chat: a stream cut short in its reasoning ends as one too, the note its text (#91)", async () => {
  const text = event(chat({ role: "assistant" })) + event(chat({ reasoning_content: "Let me think" }));
  const result = await guardToolResponse(sse(text), "chat", policy, streaming);
  const frames = parse(await result.text());
  assert.equal(frames.at(-1).data, "[DONE]");
  assert.deepEqual(frames.at(-2).data.choices, [
    { index: 0, delta: { content: cutShortNote }, finish_reason: "stop" },
  ]);
});

test("chat: a stream whose every choice finished is only missing its [DONE] (#91)", async () => {
  const text = cutFrames + event(chat({}, "stop"));
  const result = await guardToolResponse(sse(text), "chat", policy, streaming);
  const out = await result.text();
  assert.equal(out, text + "data: [DONE]\n\n");
});

test("chat: a stream cut short still fails with a call pending, saying nothing, or not streamed (#91)", async () => {
  const cases = [
    [cutFrames + event(chat({ tool_calls: [call("bash", 0, '{"comm')] })), streaming, /tool call unfinished/],
    [event(chat({ role: "assistant" })), streaming, /1 event,/],
    ["", streaming, /0 events, 0 bytes/],
    [cutFrames, {}, /reply x2, 3 events, \d+ bytes/],
  ];
  for (const [text, options, detail] of cases) {
    const result = await guardToolResponse(sse(text), "chat", policy, options);
    const frames = parse(await result.text());
    assert.doesNotMatch(JSON.stringify(frames), /comm/);
    const data = frames.at(-1).data;
    assertError("chat", data);
    assert.match(data.error.message, /^Upstream SSE stream ended without a completion marker \(/);
    assert.match(data.error.message, detail);
  }
});

test("anthropic and responses: a stream cut short still fails, naming the reply (#91)", async () => {
  const cut = {
    anthropic:
      event({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [] } }, "message_start") +
      event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start") +
      event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Installed" } }, "content_block_delta"),
    responses:
      event({ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } }, "response.created") +
      event({ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "Installed" }, "response.output_text.delta"),
  };
  for (const [protocol, text] of Object.entries(cut)) {
    const result = await guardToolResponse(sse(text), protocol, policy, streaming);
    const data = parse(await result.text()).at(-1).data;
    assertError(protocol, data);
    const message = protocol === "anthropic" ? data.error.message : data.message;
    assert.match(message, protocol === "anthropic" ? /reply msg_1/ : /reply resp_1/);
  }
});

// A name made of separators only folds to "" — the bare form of every
// declared name — so it used to be read as a spelling of "_" and handed that
// tool, or, when the fold was ambiguous, left out. Neither: a fold is never a
// guess, and the call reaches the agent under the name the model wrote (#209).
test("a declared name of separators only is never handed another call (#76 follow-up)", async () => {
  const rules = { declared: new Set(["todo_write", "_"]) };
  for (const name of ["--", "-", "__"]) {
    const result = await guardToolResponse(
      Response.json(snapshot("chat", [name])),
      "chat",
      rules,
    );
    const data = await result.json();
    assert.deepEqual(callsIn("chat", [data]), [name], `${name} was handed another call`);
    assert.equal(textIn("chat", [data]), "");
  }
  const exact = await guardToolResponse(Response.json(snapshot("chat", ["_"])), "chat", rules);
  assert.deepEqual(callsIn("chat", [await exact.json()]), ["_"]);
});

// M-45 (review round): namesIn reads a frame that carries no choices the way
// its siblings do — a reply with no choices holds no calls, not a TypeError.
// No caller passes such a frame today; the guard is what keeps the three
// readers one rule.
test("chat: a frame that carries no choices reads as no calls", () => {
  assert.deepEqual(namesIn("chat", {}), []);
  assert.deepEqual(namesIn("chat", { choices: [] }), []);
});

// The bound stream.mjs's `index` reads (65535). The two paths over one
// stream have to refuse the same indexes: this path took any safe integer
// and refused only the negative ones, so a chat frame whose choice sat at
// 70000 was published by the guard and refused by the collapse path — one
// upstream, two answers, and a streaming client and one that reads no stream
// told different things.
test("chat: an index above the bound the collapse path reads is refused on both paths", async () => {
  const text =
    event({
      id: "chatcmpl-1",
      choices: [{ index: 70000, delta: { tool_calls: [call("bash")] } }],
    }) + terminal("chat");
  const guarded = await guardToolResponse(sse(text), "chat", policy);
  const frames = parse(await guarded.text());
  assertError("chat", frames.at(-1).data);
  assert.match(
    frames.at(-1).data.error?.message ?? "",
    /Invalid upstream tool index/,
    "the refusal does not say which index was refused",
  );
  // The collapse path over the same bytes refuses it too.
  const collapsed = await collapseResponse(sse(text), "chat");
  assert.equal(collapsed.status, 502, "the collapse path took the index the guard refused");
});

// The gap MAINTAINING.md records: the ids a client answers a call by were
// minted for the chat shape only, so a Responses item and a Messages block
// that carried none went out as they came — no id, no call_id — and both
// protocols require the field. The client sends its result with the id it
// was handed, and there was none.
test("Responses and Messages: a call that carries no id leaves with one to answer it by", async () => {
  const responses = await guardToolResponse(
    Response.json({ output: [{ type: "function_call", name: "bash", arguments: "{}" }] }),
    "responses",
    policy,
  );
  assert.equal(responses.status, 200);
  const item = (await responses.json()).output[0];
  assert.ok(
    typeof item.call_id === "string" && item.call_id !== "",
    `the call left with no id to answer it with: ${JSON.stringify(item)}`,
  );
  const messages = await guardToolResponse(
    Response.json({
      type: "message",
      content: [{ type: "tool_use", name: "bash", input: {} }],
    }),
    "anthropic",
    policy,
  );
  assert.equal(messages.status, 200);
  const block = (await messages.json()).content[0];
  assert.ok(
    typeof block.id === "string" && block.id !== "",
    `the call left with no id to answer it with: ${JSON.stringify(block)}`,
  );
});

// The id is minted once for the call: the frame that opens it, the frame that
// closes it and the copy inside the terminal response are one call to the
// client, and two ids for it are two calls.
test("Responses: the id a stream invents is one id across the copies of the call", async () => {
  const item = { type: "function_call", name: "bash", arguments: "" };
  const done = { ...item, arguments: "{}", status: "completed" };
  const text =
    event(
      { type: "response.output_item.added", output_index: 0, item },
      "response.output_item.added",
    ) +
    event(
      { type: "response.output_item.done", output_index: 0, item: done },
      "response.output_item.done",
    ) +
    event(
      { type: "response.completed", response: { id: "r1", status: "completed", output: [done] } },
      "response.completed",
    );
  const guarded = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(guarded.status, 200);
  const data = frameData(await guarded.text());
  const ids = [
    ...data.filter((value) => value.item).map((value) => value.item.call_id),
    ...(data.find((value) => value.type === "response.completed")?.response.output ?? []).map(
      (value) => value.call_id,
    ),
  ];
  assert.equal(ids.length, 3, "the added frame, the done frame and the terminal's copy");
  assert.ok(
    ids.every((id) => typeof id === "string" && id !== ""),
    `a copy left with no id to answer it with: ${ids.join(", ")}`,
  );
  assert.equal(new Set(ids).size, 1, `one call answered ${ids.length} ids: ${ids.join(", ")}`);
});

// The code says which failure it was, and every protocol carries it: the
// guard computed it and dropped it for the chat and the Messages arm, and a
// client on those two could not tell an undeclared tool from a size limit or
// a transport failure.
test("every protocol's failure carries the code that says which failure it was", async () => {
  for (const protocol of protocols) {
    const broken = await guardToolResponse(
      new Response("{broken", { headers: { "content-type": "application/json" } }),
      protocol,
      policy,
    );
    assert.equal(broken.status, 502);
    assertError(protocol, await broken.json(), false, "upstream_error");
  }
});

// The chat arm has read two calls of one reply under one word since
// ensureCallIDs ("Two calls of one reply under one word: the client keys the
// result by it, and reads one call's result as the other's"). The
// Responses/Messages arm held every word with `ids.hold` and never asked
// whether it was already held, so two kept calls carrying one upstream
// `call_id` both kept it: a client that answers a call by its call_id could not
// tell the two results apart. The first call to claim a word keeps it; the
// second is answered by an id of its own.
test("Responses: two kept calls of one reply under one upstream call_id do not share it", async () => {
  const reply = {
    output: [
      { id: "fc_1", type: "function_call", call_id: "shared", name: "bash", arguments: "{}" },
      { id: "fc_2", type: "function_call", call_id: "shared", name: "bash", arguments: "{}" },
    ],
  };
  const response = await guardToolResponse(Response.json(reply), "responses", policy);
  assert.equal(response.status, 200);
  const body = await response.json();
  const words = body.output.filter((item) => item.type === "function_call").map((item) => item.call_id);
  assert.equal(words.length, 2);
  // The walk reads the reply's items in its own order, so which of the two
  // keeps the upstream word is not this assertion's business: exactly one does,
  // and the other is answered by an id of the guard's.
  assert.equal(words.filter((word) => word === "shared").length, 1, "two calls answered one call_id");
  const other = words.find((word) => word !== "shared");
  assert.match(other, /^call_\d+$/, "the duplicate was not given an id of the guard's");
});

// The terminal response of a stream can carry both calls of one word in one
// snapshot. Each copy is answered by the id its own frames already answered at
// that place: reading the snapshot's own claim before the reply's would hand the
// second copy a fresh id, so one call would change its word between the frames
// the client already read and the terminal that ends them.
test("Responses: a terminal holding two same-word calls keeps each place's own answer", async () => {
  const one = { type: "function_call", id: "fc_1", call_id: "shared", name: "bash", arguments: "{}" };
  const two = { type: "function_call", id: "fc_2", call_id: "shared", name: "bash", arguments: "{}" };
  const text =
    event({ type: "response.output_item.added", output_index: 0, item: { ...one, status: "in_progress" } }) +
    event({ type: "response.output_item.added", output_index: 1, item: { ...two, status: "in_progress" } }) +
    event({ type: "response.output_item.done", output_index: 0, item: { ...one, status: "completed" } }) +
    event({ type: "response.output_item.done", output_index: 1, item: { ...two, status: "completed" } }) +
    event(
      {
        type: "response.completed",
        response: {
          id: "r2",
          status: "completed",
          output: [
            { ...one, status: "completed" },
            { ...two, status: "completed" },
          ],
        },
      },
      "response.completed",
    );
  const guarded = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(guarded.status, 200);
  const data = frameData(await guarded.text());
  const seen = [new Set(), new Set()];
  for (const value of data) {
    if (value.item && callShaped(value.item.type)) {
      const place = value.item.id === "fc_1" ? 0 : 1;
      seen[place].add(value.item.call_id);
    } else if (value.type === "response.completed") {
      for (const item of value.response.output) {
        seen[item.id === "fc_1" ? 0 : 1].add(item.call_id);
      }
    }
  }
  assert.equal(seen[0].size, 1, `place 0 answered more than one id: ${[...seen[0]].join(", ")}`);
  assert.equal(seen[1].size, 1, `place 1 answered more than one id: ${[...seen[1]].join(", ")}`);
  assert.equal([...seen[0]][0], "shared", "the first call kept the upstream word");
  assert.notEqual([...seen[1]][0], "shared", "the second call did not take it");
});

// A word the guard itself invented is not one an upstream call may take. A call
// left out is answered by a note whose id is `msg_<the call_id it carried>`;
// an upstream that then names a kept call `msg_<that word>` would hand the
// client two items under one id — the note and the call — and the chat arm
// already re-mints such a call (`ids.holds`). This arm kept it as it was. The
// call's added, done and terminal copies must also keep one id between them,
// which is what the claimed state is for.
test("Responses: a kept call whose call_id is an invented word is re-minted, once for its copies", async () => {
  const dropped = { type: "function_call", id: "fc_1", call_id: "x", name: "", arguments: "" };
  const kept = { type: "function_call", id: "fc_2", call_id: "msg_x", name: "bash", arguments: "{}" };
  const text =
    event({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...dropped, status: "in_progress" },
    }) +
    event({
      type: "response.output_item.added",
      output_index: 1,
      item: { ...kept, status: "in_progress" },
    }) +
    event({
      type: "response.output_item.done",
      output_index: 1,
      item: { ...kept, status: "completed" },
    }) +
    event(
      {
        type: "response.completed",
        response: {
          id: "r1",
          status: "completed",
          // The terminal repeats the whole output, the dropped call included:
          // the kept call sits at the place its frames stated only if the item
          // before it is there too.
          output: [{ ...dropped, status: "completed" }, { ...kept, status: "completed" }],
        },
      },
      "response.completed",
    );
  const guarded = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(guarded.status, 200);
  const data = frameData(await guarded.text());
  const note = data.find((value) => value.item?.type === "message");
  assert.equal(note.item.id, "msg_x", "the note's id is the word the dropped call's call_id made");
  const words = [
    ...data.filter((value) => value.item && callShaped(value.item.type)).map((value) => value.item.call_id),
    ...(data.find((value) => value.type === "response.completed")?.response.output ?? [])
      .filter((item) => callShaped(item.type))
      .map((item) => item.call_id),
  ];
  assert.equal(words.length, 3, "the added frame, the done frame and the terminal's copy");
  assert.equal(new Set(words).size, 1, `one call answered more than one id: ${words.join(", ")}`);
  assert.notEqual(words[0], "msg_x", "the kept call took the id of the note in the dropped call's place");
  assert.match(words[0], /^call_\d+$/, "the colliding call was not given an id of the guard's");
});
