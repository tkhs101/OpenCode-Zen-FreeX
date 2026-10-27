// The one byte limit a reply held in memory is read through: a streamed one
// event by event, a whole one in one read. Exported because tool-response.mjs
// reads the same bytes through the same limit and names the same number in its
// failures — a second copy of it is a second thing to keep in step.
export const MAX_BYTES = 32 * 1024 * 1024;

// The headers that describe the bytes a reply arrived as. A reply whose body
// is written again — a stream collapsed into one JSON document, or a guarded
// stream whose frames may be rewritten or added to — no longer describes
// those bytes: a length, an encoding, hop-by-hop framing (connection and the
// headers it names, te, trailer, upgrade), the range a partial response
// described, and the validators a cache or a conditional request would
// compare against all describe the old ones only. What says something about
// the reply itself (a retry-after, a request id) is left alone. One list, so
// the two places that write a body again cannot drift apart.
export const STALE_BODY_HEADERS = [
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
  "content-range",
  "content-md5",
  "etag",
  "last-modified",
];

// The headers of a reply whose body is written again, with the hop-by-hop ones
// the upstream's own `Connection` value names removed as well. `Connection` is a
// list of field names the connection ends at, so `Connection: x-hop` beside
// `x-hop: 1` is framing that belongs to the connection and not to the reply:
// dropping the word that named it and forwarding the header it named leaves
// exactly what the list exists to take out. Exported with the list so the two
// places that write a body again cannot drift apart.
export function dropStaleHeaders(response) {
  const headers = new Headers(response.headers);
  for (const name of STALE_BODY_HEADERS) headers.delete(name);
  const named = response.headers.get("connection");
  if (typeof named === "string") {
    for (const word of named.split(",")) {
      const name = word.trim().toLowerCase();
      if (name) headers.delete(name);
    }
  }
  return headers;
}

// How much of an upstream error is answered to the caller. The upstream's own
// error text is relayed as it arrived — the reason a reply failed is the one
// thing the client can act on, and the suite pins the wording — but it is
// bounded: an upstream error may carry a provider's internals, a fragment of
// the request or a credential in a URL, and the 502 body is read by whoever
// asked for the reply. The bound is a length and not a redaction: what the
// upstream said about its own failure stays readable.
//
// The same bound the route keeps for the prefix of an upstream body it
// relays (provider.mjs's KEPT_PREFIX, and the same "…" at the end of it):
// one rule for what is read out of an upstream's own words.
const MAX_ERROR_TEXT = 512;

// The body a failed reply is answered with: the same shape on every protocol,
// and the upstream's own error text in it.
function errorBody(protocol, message) {
  const detail = { type: "upstream_error", message };
  return protocol === "anthropic"
    ? { type: "error", error: detail }
    : { error: { ...detail, param: null, code: null } };
}

function jsonResponse(source, protocol, value, error) {
  const headers = dropStaleHeaders(source);
  headers.set("content-type", "application/json");
  if (error) {
    return new Response(JSON.stringify(errorBody(protocol, error)), { status: 502, headers });
  }
  // The reply is held in memory, and the limit that bounds the bytes read
  // bounds the reply held: a body larger than the limit is not a reply this
  // file can answer with, however small the stream that produced it was. The
  // limit is on bytes, so the body is measured in the bytes it will be written
  // as: `text.length` counts UTF-16 code units, and a code unit carries up to
  // three UTF-8 bytes (four per surrogate pair), so a body of CJK or astral
  // text passed a character count and left as several times the limit. The
  // how-far-over number the reply is refused with is the limit's, not the
  // measurement's, so both readings name the same MiB.
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
    return new Response(
      JSON.stringify(
        errorBody(protocol, `Upstream reply exceeds the ${MAX_BYTES / (1024 * 1024)} MiB limit`),
      ),
      { status: 502, headers },
    );
  }
  // A collapsed body is the whole reply, whatever the upstream said about the
  // bytes it was read from. A 206 describes the part of a stream that arrived,
  // and answering the complete JSON under it — with the partial-range headers
  // the list above deletes — tells the client it holds a fragment of a reply
  // that is in fact all of it; a 204 cannot carry the body it now has. Every
  // other status reached this line because it was `ok` (collapseResponse hands
  // a failure back untouched), and it is the one the client would have had, so
  // it is kept rather than rewritten to 200.
  const status = source.status === 204 || source.status === 206 ? 200 : source.status;
  return new Response(text, { status, headers });
}

function errorMessage(value, fallback = "Upstream stream failed") {
  const text =
    typeof value === "string" && value
      ? value
      : value?.message ||
        (typeof value?.error === "string" ? value.error : value?.error?.message) ||
        fallback;
  if (typeof text !== "string" || !text) return fallback;
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text;
}

// The largest index an upstream may state for an item, a part or a summary.
//
// It is the range of a number the upstream says, not a length this package
// allocates: the accumulator holds the parts by the place the upstream gave
// them and writes them out dense, so a far-off index is a part in a list, not
// a hole-filled array. It is exported because the guard in `tool-response.mjs`
// reads the same number and the two paths have to refuse the same indices —
// the same reply, the same answer.
export const MAX_STREAM_INDEX = 65535;

function index(value) {
  const result = value ?? 0;
  if (!Number.isInteger(result) || result < 0 || result > MAX_STREAM_INDEX) {
    throw new Error("Invalid stream item index");
  }
  return result;
}

// What a streamed call is named by, when it is named at all: a non-empty
// string. The same rule, in the same words, as `identity()` in
// tool-response.mjs and in the Responses accumulator below — one upstream value
// must not be a name to one file and no name to the other, or two calls of one
// reply share a name.
function identity(value) {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Whether a terminal's own list of items names every item the stream
// accumulated. The items of a reply are named by their ids, and one the
// terminal leaves out is an item the reply would lose: the accumulation
// stands in for it. A terminal that names none of them says nothing about
// which items it left out — it may be a gateway that does not repeat the ids
// — and the count of the two lists is what is read then.
function names(terminal, kept) {
  const named = new Set();
  for (const item of terminal) {
    const id = identity(item.id);
    if (id !== undefined) named.add(id);
  }
  if (!named.size) return true;
  return kept.every((item) => {
    const id = identity(item.id);
    return id === undefined || named.has(id);
  });
}

function sorted(map) {
  return [...map].sort(([a], [b]) => a - b).map(([, value]) => value);
}

// How one streamed `function.name` fragment joins what came before it. Chat
// vendors disagree about what a name fragment is: some send the next piece of
// the name, some re-send the name whole on the frame that carries the
// arguments, and some send a name that has grown since the last frame. Appended
// blindly, `Read` followed by `Read` became `ReadRead`, which no declaration
// folds to and which the guard consequently treated as an unknown tool.
//
// The rules, in order:
//
//   * the same bytes again        — the name has already been stated; keep it.
//   * the fragment starts with it — the name has grown (a growing prefix); the
//                                   fragment is the name as far as it is known.
//   * it starts with the fragment — a shorter prefix re-sent; keep the longer
//                                   name that has already been read.
//   * anything else                — a true fragment; append it.
//
// Exported because `tool-response.mjs`'s guard buffers the same Chat fragments
// and has to answer the same name — one rule, not a second copy that could
// drift from this one. `arguments` do not follow this rule: they keep the
// blind append both paths have always given them (see `appendFunction` in each
// file), because a JSON payload is bytes in order, not a name being re-stated.
export function mergeFunctionName(current, fragment) {
  const name = current ?? "";
  if (fragment === name) return name;
  if (fragment.startsWith(name)) return fragment;
  if (name.startsWith(fragment)) return name;
  return name + fragment;
}

function appendFunction(target, delta) {
  // The name is merged by the shared rule; the arguments stay a blind append:
  // an argument fragment is the next bytes of one JSON document, and a repeat
  // of the whole document is not a shape this route has measured.
  if (typeof delta.name === "string") target.name = mergeFunctionName(target.name, delta.name);
  if (typeof delta.arguments === "string")
    target.arguments = (target.arguments ?? "") + delta.arguments;
}

// The rule every streamed text field follows: a .delta appends to what came
// before it, a .done replaces it with the whole text. Written once, so a
// protocol tweak is applied to all of them together rather than five times.
function applyText(target, field, value, isDelta) {
  if (isDelta) target[field] = (target[field] ?? "") + (value ?? "");
  else if (value !== undefined) target[field] = value;
}

// Whether a value can be read as a snapshot of something the stream
// accumulated. A snapshot is the upstream's own view of an item, a block or a
// part; a null, a string or a list is not one, and stands in for nothing.
function isSnapshotObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// How much a value carries, counted in the fields that matter. A string is
// its length; a list is what its entries carry and not how many entries it
// has; an object is the fields it names.
//
// The collection is weighed by what it holds because the reply is read for
// what it holds: `{content: [{}]}` is a part with no text in it, and weighing
// it by its length (one entry) made a snapshot that carries nothing look like
// a whole view of the content the deltas had already delivered — so it stood
// in for it, and the text was dropped without a word.
function weight(value, fields) {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    let total = 0;
    for (const entry of value) total += weight(entry, fields);
    return total;
  }
  // The parts of an item are held by the place the upstream gave them (the
  // Responses accumulator below), and the same weighing reads them there.
  if (value instanceof Map) {
    let total = 0;
    for (const entry of value.values()) total += weight(entry, fields);
    return total;
  }
  if (isSnapshotObject(value)) {
    let total = 0;
    for (const field of fields) {
      if (value[field] !== undefined) total += weight(value[field], fields);
    }
    return total;
  }
  return 0;
}

// Whether a snapshot may stand in for what was accumulated. An upstream puts
// snapshots beside the deltas they describe — a repeated response.created, a
// message_start whose block has not been filled in, a terminal response — and
// one that carries nothing where the accumulation has content is a partial
// view of it rather than a newer one: taking it would discard what the stream
// already delivered.
//
// A snapshot stands in only where it is a whole view of the accumulation: a
// field it carries in a shorter form than the accumulation held is a partial
// view of it, and the accumulation stands. The comparison is field by field,
// because a snapshot may carry more of one field and less of another, and the
// field it carries less of is the one that would be lost. A snapshot holding
// one character where the accumulation holds a sentence is the same view.
//
// One that does carry the collection settles it, which is how
// response.output_item.done and a whole terminal response replace accumulated
// arguments with the complete ones.
function carries(snapshot, accumulated, fields) {
  if (weight(accumulated, fields) === 0) return true;
  for (const field of fields) {
    const before = accumulated?.[field];
    if (before === undefined) continue;
    if (weight(snapshot?.[field], fields) < weight(before, fields)) return false;
  }
  return true;
}

// The usage report a body holds after a snapshot has been spread whole onto it.
// A frame's own top-level report is folded in only when it is an object (the
// same rule, at each accumulator's fold); a snapshot spread whole — a
// message_start's message, a response.created's response — brings its `usage`
// in with every other field, and a string left standing there is spread into
// its characters by the next frame that folds a real report in
// (`{ ...body.usage, ...data.usage }` is `{"0":"a","1":"b","2":"c"}`), or
// answered as itself when no frame follows. A report that is not one states
// none, so the report the body already held stands and a body that held none
// goes on without one — which is what a frame-level report that is not one
// leaves behind. Written once, so the three places that copy a whole snapshot
// cannot drift apart.
function keepUsage(body, held) {
  if (isSnapshotObject(body.usage)) return;
  if (isSnapshotObject(held)) body.usage = held;
  else delete body.usage;
}

function chatAccumulator() {
  const body = { object: "chat.completion", choices: [] };
  const choices = new Map();
  const tools = new Map();
  // The slot a fragmented call sits in. A fragment that states a place states
  // where it belongs. One that states none is placed by the id it carries: an
  // id an open call of this choice already answers is that call — a
  // continuation frame echoing the name the call was opened with — and any
  // other id is a call of its own, taking the lowest slot no call holds, which
  // is the shape a reply that never indexed its calls sends. A fragment with no
  // usable id has nothing to place it by, and is read as the first slot, which
  // is what `index` has always read one as.
  //
  // Read as the first slot whatever it carried, a reply's second call was
  // merged into its first: the second call's id, both names run together and
  // both argument objects on it, where the same reply as one JSON body answers
  // two calls (D1). A repeated `function.name` is deliberately not a placement:
  // a name may legitimately be fragmented across the frames of one call, and
  // only the id tells one call from the next.
  //
  // One rule, read the same way by the guard (tool-response.mjs's `slotFor`,
  // which the chat test "a fragment that names no index is read the same by
  // both paths" pins from both paths): a fragment with no index and no id is
  // read as the first slot, so one stream still answers one reply to a client
  // that streams and one that does not.
  function place(fragment, calls) {
    if (fragment.index !== null && fragment.index !== undefined) return index(fragment.index);
    const id = identity(fragment.id);
    if (id === undefined) return index(fragment.index);
    for (const [slot, call] of calls) {
      if (call.id === id) return slot;
    }
    let slot = 0;
    while (calls.has(slot)) slot++;
    return slot;
  }
  return {
    apply(data) {
      for (const key of ["id", "created", "model", "system_fingerprint", "service_tier"]) {
        if (data[key] !== undefined) body[key] = data[key];
      }
      // A usage report that is not an object states none, and folding one in as
      // it stood invented keys for the client: a string spread answers its
      // characters by index ({"0":"a","1":"b"}) in a field a host reads, and a
      // list does the same by position. Read by shape, like every other value
      // this file takes hold of, and the reply goes on without a usage it was
      // never given.
      if (isSnapshotObject(data.usage)) body.usage = { ...body.usage, ...data.usage };
      // The choices a chunk carries, read the way the guard reads them
      // (tool-response.mjs's `list`, which names this file's reading): a
      // container that is not a list holds no entry to walk, and an entry that
      // is not an object holds nothing to read. Walked as they stood, a
      // `choices` written as an object threw "{} is not iterable" and a null
      // entry threw "null is not an object" — a 502 carrying an internal
      // TypeError on a reply whose other frames were sound — while a string was
      // walked character by character and answered a choice the upstream never
      // sent (a one-character string has no index, and `index` reads that as
      // the first slot). One stream answers one reply to a client that streams
      // and one that does not.
      for (const part of Array.isArray(data.choices) ? data.choices : []) {
        if (!isSnapshotObject(part)) continue;
        const position = index(part.index);
        if (!choices.has(position)) {
          choices.set(position, {
            index: position,
            message: { role: "assistant", content: null },
            finish_reason: null,
          });
          tools.set(position, new Map());
        }
        const choice = choices.get(position);
        const message = choice.message;
        const delta = part.delta ?? {};
        if (delta.role) message.role = delta.role;
        for (const key of ["content", "reasoning_content", "reasoning", "refusal"]) {
          if (typeof delta[key] === "string") message[key] = (message[key] ?? "") + delta[key];
        }
        if (delta.function_call) {
          message.function_call ??= { name: "", arguments: "" };
          appendFunction(message.function_call, delta.function_call);
        }
        // The calls this choice has opened: what a fragment with no index of
        // its own is placed against, by the id it carries.
        const calls = tools.get(position);
        // The same reading for the fragments of a delta: a `tool_calls` that is
        // not a list holds no fragment, and one that is not an object is not a
        // fragment to place — read as one it opened a call with nothing in it
        // that no upstream frame ever described.
        for (const fragment of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          if (!isSnapshotObject(fragment)) continue;
          const toolIndex = place(fragment, calls);
          if (!calls.has(toolIndex))
            calls.set(toolIndex, { type: "function", function: { name: "", arguments: "" } });
          const call = calls.get(toolIndex);
          for (const key of ["id", "type"]) {
            // `"id": null` arrives on the continuation frames of a call this
            // route named on the first one (see ensureCallIDs in
            // tool-response.mjs): a fragment may leave the id as it stands,
            // but a null or empty one does not take it away.
            if (fragment[key] === undefined) continue;
            if (key === "id" && (fragment[key] === null || fragment[key] === "")) continue;
            call[key] = fragment[key];
          }
          if (fragment.function) appendFunction(call.function, fragment.function);
        }
        // Both null and undefined are "this chunk carried no finish reason";
        // a loose comparison is the only way to say that in one test, and the
        // project's rules do not allow it.
        if (part.finish_reason !== null && part.finish_reason !== undefined)
          choice.finish_reason = part.finish_reason;
        // A logprobs that is not an object states none: `Object.entries` over a
        // string answers its characters by index, and over a list its positions,
        // which is a report nobody wrote. Read by shape, as `usage` is above.
        if (isSnapshotObject(part.logprobs)) {
          choice.logprobs ??= {};
          // Written as a defined own property, and read back as one. A
          // "__proto__" key arrives as an own property of the parsed object,
          // and `choice.logprobs[key] = value` would take the inherited
          // accessor instead: an object value silently re-parented the
          // accumulated object and the key never reached the reply, while an
          // array value read Object.prototype back and spread it, throwing
          // "not iterable" — a 502 on an otherwise valid stream. The delta
          // written by tool-response.mjs follows the same rule.
          for (const [key, value] of Object.entries(part.logprobs)) {
            const held = Object.hasOwn(choice.logprobs, key) ? choice.logprobs[key] : undefined;
            Object.defineProperty(choice.logprobs, key, {
              value: Array.isArray(value)
                ? [...(Array.isArray(held) ? held : []), ...value]
                : value,
              writable: true,
              enumerable: true,
              configurable: true,
            });
          }
        }
      }
    },
    finish() {
      for (const [position, choice] of choices) {
        if (tools.get(position).size) choice.message.tool_calls = sorted(tools.get(position));
      }
      body.choices = sorted(choices);
      return body;
    },
  };
}

function responsesAccumulator() {
  let body = { object: "response", output: [] };
  let final;
  // The items a reply holds, in the order the stream opened them, keyed by the
  // order itself. The key is not the item's output_index: an index the
  // upstream states and an index this file has to infer are two different
  // things, and while they shared one key space a frame that stated
  // `output_index: 0` landed on the item an earlier frame had inferred into
  // slot 0 — `keep` read the second item as a newer view of the first and the
  // reply answered 200 with one item of the two, wearing the first one's id.
  // One key space per fact: `output` follows the arrival order, `indexMap`
  // holds only the indices the upstream itself stated, and a frame that states
  // an index no item holds opens a new item rather than displacing one.
  const output = new Map(); // arrival order -> { value, id, index }
  let next = 0;
  const indexMap = new Map(); // stated output_index -> arrival order
  // The id a streamed item was named by, once a frame names it: an item opened
  // by a frame that carries no id of its own is named by the frames after it.
  const idMap = new Map(); // item id -> arrival order
  // The fields a streamed item fills in: a message its content, a call its
  // arguments, a reasoning item its summary.
  const fields = ["content", "arguments", "summary", "text", "refusal"];
  // The newest item this stream opened without an id, by kind: a reply whose
  // frames name nothing at all is one the upstream never indexed, and every
  // frame after its item — the ones that say `added` and the ones that only
  // fill a field in — belongs to that item. Remembering where it is keeps a
  // frame with no id from opening a second item of its own kind (`item()`
  // defaults to "message", so a text delta of such a reply would), while a
  // frame of another kind is still not allowed to continue the wrong item —
  // measured: a response's text landing on its function call. An item that
  // adopts an id later still has the frames after the id that name nothing at
  // all, so the slot stays here after it is named.
  const openNone = new Map();
  // What a streamed item is named by is read the one way this file reads a name
  // (`identity`, above, which is this rule written once for both accumulators):
  // the same words as `identity()` in tool-response.mjs, because one upstream
  // value must not be a name to one file and no name to the other, or two items
  // of one reply share an item (measured: two calls with `"id": 0` and their own
  // output_indexes — 0 and 1 — resolved to the first one's item, and the second
  // call's arguments were written over the first's).
  const at = (id) => idMap.get(id);
  // Whether a record is still nameless: it was opened by a frame that said
  // nothing about what it is, which is the one shape an id-less frame or a
  // stated index may still claim as its own.
  const nameless = (record) => record.id === undefined && record.index === undefined;
  // A record's item and the item's identity are one fact told twice: the
  // frames that follow a name an item took must answer by it, and the finished
  // item must carry it. Written once, so the two cannot drift.
  function named(slot, id) {
    const record = output.get(slot);
    record.id = id;
    if (record.value !== undefined) record.value.id = id;
    // Which item a frame that names the word alone reaches, when the reply has
    // spent the word on two items: the one that took it last — the item the
    // stream is working on, which is the reading this file already gives a
    // frame that names nothing at all (openNone, above). The item it pointed
    // at before keeps the id it answered with; only the routing moves. Measured
    // on two calls sharing one id, each with its own output_index and one of
    // them naming the id alone in its arguments frames: the older item held the
    // word and every argument of the newer landed on it, so the reply came back
    // with the newer call's arguments on both items.
    idMap.set(id, slot);
  }
  // The record a frame belongs to. What it states comes first: the
  // output_index it carries, then the item id it names — an item is the one
  // its own frames say it is. What it leaves to this file comes second: a
  // frame naming nothing continues the item the stream opened namelessly,
  // which is what a reply that never indexed its items means. Anything else
  // is a frame over an item this stream never opened, which is still not
  // something to guess at.
  function locate(data, id, opening = false, kind) {
    const name = identity(id);
    if (data.output_index !== undefined) {
      const held = indexMap.get(index(data.output_index));
      if (held !== undefined) return held;
    } else if (name !== undefined) {
      const held = at(name);
      if (held !== undefined) return held;
      const candidates = [...output].filter(
        ([, record]) => record.id === undefined && record.value?.type === kind,
      );
      const open = openNone.get(kind);
      if (open !== undefined && output.get(open).id === undefined) {
        // The item the stream opened namelessly is the one an id-less reply
        // names from the frames after it, so the id is adopted and one call
        // stays one item (measured on this route: a call's output_item.added
        // arrives with no id at all). An item that already has an id of its
        // own is not it, and one named item is not a candidate at all.
        named(open, name);
        return open;
      }
      if (!opening) {
        // Exactly one nameless item of this kind is the item the frame names,
        // so the id is adopted; two of them, or none, is a guess.
        if (candidates.length === 1) {
          const [held] = candidates[0];
          named(held, name);
          return held;
        }
        throw new Error("Upstream frame names an unknown item without an output index");
      }
    } else if (!opening) {
      const open = openNone.get(kind);
      if (open !== undefined) return open;
      const candidates = [...output].filter(
        ([, record]) => nameless(record) && record.value?.type === kind,
      );
      if (candidates.length === 1) return candidates[0][0];
      throw new Error("Upstream frame names an unknown item without an output index");
    }
    // A stated index this stream has not seen opens the item it names; the
    // item a stream opens namelessly takes its place in the arrival order,
    // which no stated index can collide with.
    const slot = next++;
    const record = { value: undefined, id: undefined, index: undefined };
    output.set(slot, record);
    if (data.output_index !== undefined) {
      record.index = index(data.output_index);
      indexMap.set(record.index, slot);
    }
    if (name !== undefined) {
      // An `added` frame opens an item, and the id it carries is that item's
      // own even when the reply has spent the word on an item already. A
      // stated index says this frame belongs to another item, and a stated
      // index is a fact about the reply; an id another item happens to hold is
      // not a reason to refuse the frame. Refusing it lost the whole reply —
      // two calls, one name, and a client that gets neither — where the
      // upstream's own contradiction costs the reply only its second name.
      named(slot, name);
    }
    if (nameless(record) && name === undefined) openNone.set(kind, slot);
    return slot;
  }
  // A snapshot replaces the item in its slot only when it is a whole view of
  // it; a partial one leaves what the deltas delivered standing. A snapshot
  // that carries no id does not take away the one the stream named the item by
  // (locate, above): the item's own snapshot arrives without it in the shape
  // that names an item from the frames after it, and taking the snapshot as it
  // stands lost the id again. One that carries an id still wins, as it did.
  // The index the frame states is a fact about where its item sits (locate,
  // above), so it is recorded with the item it placed: a snapshot that carries
  // an output_index states the same place an `added` frame does, and a stream
  // whose opening snapshot arrived first is otherwise read as holding a second
  // item stating the same index — the reply answered 200 with two entries
  // carrying one id.
  function keep(slot, value, at) {
    const record = output.get(slot);
    if (!carries(value, record.value, fields)) return;
    // The id is inherited by the same item's partial view, never by another
    // item. The slot is the item's own — locate resolves a stated index or id
    // to the item that stated it, and opens a new item for one no item holds —
    // so the snapshot in it names the same item, and a snapshot that brings an
    // id of its own is that item named at last.
    const stated = identity(value.id);
    if (stated === undefined && record.id !== undefined) value.id = record.id;
    record.value = value;
    if (at !== undefined) {
      record.index = at;
      indexMap.set(at, slot);
      // A snapshot that states a place is a fact about it, so the record is no
      // longer an item the upstream left unnamed — the one a later frame that
      // states nothing may still claim as its own (nameless, above).
      if (openNone.get(value.type) === slot) openNone.delete(value.type);
    }
    if (stated !== undefined) named(slot, stated);
    if (record.index !== undefined) indexMap.set(record.index, slot);
  }
  function item(data, type = "message") {
    // The name is read the one way this file reads one (identity, above), so a
    // frame carrying `0` or `false` opens the same item a frame carrying no id
    // at all does, rather than one that is half-named.
    const slot = locate(data, identity(data.item_id), false, type);
    const record = output.get(slot);
    if (record.value === undefined) {
      const value = { type };
      // locate has already recorded the name on the record when the frame
      // carried one, so the item takes the name it was opened with.
      if (record.id !== undefined) value.id = record.id;
      if (type === "message") Object.assign(value, { role: "assistant", content: [] });
      if (type === "function_call") value.arguments = "";
      if (type === "reasoning") value.summary = [];
      record.value = value;
    }
    return record.value;
  }
  // The parts of one item, held by the place the upstream gave each of them.
  // A Map and not an array: the place is the upstream's own number and may be
  // far ahead of the ones before it, and an array written at that number holds
  // a hole for every place between — one frame of a hundred bytes answered a
  // reply of 327 821 bytes, every hole written as a null, and the limit that
  // bounds the bytes read says nothing about a reply that is a thousand times
  // the stream that described it (measured: 304 bytes of SSE, 327 821 bytes of
  // reply). The Map holds what was written and the reply is written dense:
  // the parts in the order the upstream placed them, and no null among them.
  //
  // A collection that arrived as an array — a snapshot's own content — is
  // taken hold of in the same shape, and the parts that are not parts are
  // left out of it, as they are everywhere else in this file.
  function parts(value, field) {
    let collection = value[field];
    if (collection instanceof Map) return collection;
    const map = new Map();
    if (Array.isArray(collection))
      for (const [at, part] of collection.entries()) {
        if (isSnapshotObject(part)) map.set(at, part);
      }
    value[field] = map;
    return map;
  }
  // The reply is written dense: the parts of an item are the ones the stream
  // placed, in the order it placed them, and a place nothing was written to
  // is not a null among them.
  function dense(value) {
    for (const field of ["content", "summary"]) {
      const collection = value[field];
      if (collection instanceof Map) value[field] = sorted(collection);
    }
    return value;
  }
  return {
    apply(data, type) {
      if (type === "response.created" || type === "response.in_progress") {
        // A snapshot that is not a reply object — a null, a string, a list —
        // stands in for nothing: spread as it stood, a string's characters
        // became the reply's own keys. The same reading every snapshot in this
        // file gets (isSnapshotObject, above).
        if (isSnapshotObject(data.response)) {
          // A snapshot's output is a list of items, and an entry that is not an
          // item is not one to take hold of: `keep` weighed it as nothing and
          // the reply answered 200 with it among the items, and the id lookup
          // threw on the first one that was null — a 502 carrying an internal
          // TypeError on a reply whose other frames were sound. The same
          // reading the Messages accumulator gives a block that is not a block
          // (isSnapshotObject, above), and the one this file gives the items
          // themselves: one that is not an item is skipped, and is not a reason
          // to fail the stream. An output that is not a list at all holds no
          // entry to read and is no view of the reply's items, so `finish`
          // answers the accumulated ones (below).
          const stated = Array.isArray(data.response.output);
          const items = stated ? data.response.output.filter(isSnapshotObject) : [];
          // The snapshot is spread whole, and its own `usage` comes with it:
          // read by shape, so a report that is not one leaves the body holding
          // the report it already had (keepUsage, above).
          const reported = body.usage;
          body = { ...body, ...data.response };
          keepUsage(body, reported);
          if (stated) body.output = items;
          // A snapshot that carries an item where the reply already has one
          // adds only what it actually carries: the accumulated items stand
          // against an output list it does not carry, or carries empty.
          for (const [at, value] of items.entries()) {
            // The entry's place in the list is where the stream placed it: the
            // output_index a frame of the same reply states for its own item,
            // or — for a snapshot that states none, which is what an opening
            // snapshot does — the place the list itself gives it. Other frames
            // of the reply name that place, and a stream whose opening snapshot
            // arrived first was otherwise read as holding a second item stating
            // the same index: the reply answered 200 with two entries carrying
            // one id (fc1 twice), one call told twice. An index the entry states
            // itself is a fact and wins over the position, as the stated index
            // wins over an inferred one wherever they meet.
            const where = value.output_index === undefined ? at : index(value.output_index);
            keep(
              locate({ output_index: where }, identity(value.id), true, value.type),
              value,
              where,
            );
          }
        }
      } else if (type === "response.output_item.added" || type === "response.output_item.done") {
        // An item frame whose `item` is not an item — a null, a string, a list
        // — names nothing to keep, and storing it answered the reply with it
        // among the items. The same rule the part frames below get.
        if (isSnapshotObject(data.item))
          keep(
            locate(
              data,
              identity(data.item.id),
              type === "response.output_item.added",
              data.item?.type,
            ),
            data.item,
            // The frame's own index is already recorded on the item it placed
            // (locate, above), so only the frame that states one has anything
            // to add here — an `added` frame that arrives with no index at all
            // names no place of its own.
            data.output_index === undefined ? undefined : index(data.output_index),
          );
      } else if (type === "response.content_part.added" || type === "response.content_part.done") {
        const value = item(data);
        const content = parts(value, "content");
        // A re-emitted opening part carries an empty text where the deltas
        // have already filled the slot — the partial-snapshot hazard the item
        // guard above and content_block_start exist for, so the same test.
        // `refusal` is weighed too: a part whose only content is a refusal
        // weighs nothing on text alone and would be taken for an empty one.
        // A part that is not a part at all — a null, a string, a list — is the
        // same hazard in its plainest form: stored as it stood it answered 200
        // with a null among the content, and the next delta that read a field
        // of it threw ("Attempted to assign to readonly property"). Nothing to
        // place places nothing, and the item's own frames stand.
        const at = index(data.content_index);
        if (isSnapshotObject(data.part) && carries(data.part, content.get(at), ["text", "refusal"]))
          content.set(at, data.part);
      } else if (
        type === "response.output_text.delta" ||
        type === "response.output_text.done" ||
        type === "response.refusal.delta" ||
        type === "response.refusal.done"
      ) {
        const value = item(data);
        const content = parts(value, "content");
        const refusal = type.startsWith("response.refusal.");
        const field = refusal ? "refusal" : "text";
        const at = index(data.content_index);
        let part = content.get(at);
        if (part === undefined) {
          part = refusal
            ? { type: "refusal", refusal: "" }
            : { type: "output_text", text: "", annotations: [] };
          content.set(at, part);
        }
        const isDelta = type.endsWith(".delta");
        applyText(part, field, isDelta ? data.delta : data[field], isDelta);
      } else if (
        type === "response.function_call_arguments.delta" ||
        type === "response.function_call_arguments.done"
      ) {
        const value = item(data, "function_call");
        const isDelta = type.endsWith(".delta");
        applyText(value, "arguments", isDelta ? data.delta : data.arguments, isDelta);
      } else if (
        type === "response.reasoning_summary_part.added" ||
        type === "response.reasoning_summary_part.done"
      ) {
        const value = item(data, "reasoning");
        const summary = parts(value, "summary");
        // The same re-emitted-opening-frame hazard as content_part above, and
        // the same refusal of a part that is not a part.
        const at = index(data.summary_index);
        if (isSnapshotObject(data.part) && carries(data.part, summary.get(at), ["text"]))
          summary.set(at, data.part);
      } else if (/^response\.reasoning_(summary_)?text\.(delta|done)$/.test(type)) {
        const value = item(data, "reasoning");
        const summary = type.includes("summary");
        const collection = parts(value, summary ? "summary" : "content");
        const at = index(summary ? data.summary_index : data.content_index);
        let part = collection.get(at);
        if (part === undefined) {
          part = { type: summary ? "summary_text" : "reasoning_text", text: "" };
          collection.set(at, part);
        }
        // A summary's whole text arrives in `summary` and a reasoning text's
        // in `text`. Reading `text` for a summary lost a done event that had
        // no delta before it (measured: the summary came back empty).
        const isDelta = type.endsWith(".delta");
        applyText(part, "text", isDelta ? data.delta : summary ? data.summary : data.text, isDelta);
      } else if (type === "response.reasoning_content.delta") {
        body.reasoning_content = (body.reasoning_content ?? "") + (data.delta ?? "");
      } else if (type === "response.completed" || type === "response.incomplete") {
        // A terminal whose `response` is not a reply object — a null, a string,
        // a list — is not a terminal reply at all, and stands in for nothing:
        // the same reading every snapshot in this file gets (isSnapshotObject,
        // above). Read as one, a list became the whole body of the reply — the
        // accumulated items were gone and the client read a list where a
        // response belongs.
        if (isSnapshotObject(data.response)) {
          // The output a terminal carries is a list of items like any other
          // snapshot's, and an entry that is not an item is not one to answer
          // with: it was returned verbatim, so the reply ended with a null or a
          // string where an item belongs. A terminal that carries nothing but
          // such entries carries no output of its own — the items the stream
          // accumulated stand in for the collection it lost (finish, below).
          if (Array.isArray(data.response.output))
            data.response.output = data.response.output.filter(isSnapshotObject);
          final = data.response;
        }
        body.status = type === "response.completed" ? "completed" : "incomplete";
        for (const key of ["incomplete_details", "finish_reason"]) {
          if (data[key] !== undefined) body[key] = data[key];
        }
      }
      // Read by shape, as the chat accumulator's usage is (above): a report that
      // is not one states none, and a spread of it would answer its characters
      // or positions as keys of a field the client reads.
      if (isSnapshotObject(data.usage)) body.usage = { ...body.usage, ...data.usage };
    },
    finish() {
      // The reply holds the items that reached a value — a frame described one
      // and a snapshot may not have arrived yet. Their order is the order the
      // upstream placed them in: the output_index it stated for an item is
      // where that item sits in the reply, and an item it stated none for takes
      // the first place no stated index claims, in the order the stream opened
      // it. That is the ordering this file's slots used to give by construction
      // — an indexed item sat at its index, an unplaced one at the next free
      // number — and the client that reads no stream has only the array's order
      // to read the reply by: answering the items in arrival order instead
      // answered them 2 then 1 for a reply that said 1 then 2. A stated index
      // is a fact and an inferred place is a guess, so where the two meet the
      // stated index keeps its place and the unplaced item takes the next one.
      const items = () => {
        const stated = new Set();
        for (const record of output.values())
          if (record.index !== undefined) stated.add(record.index);
        const placed = [];
        let free = 0;
        for (const record of output.values()) {
          if (record.value === undefined) continue;
          if (record.index !== undefined) {
            placed.push([record.index, record.value]);
            continue;
          }
          while (stated.has(free)) free++;
          placed.push([free++, record.value]);
        }
        return placed.sort(([a], [b]) => a - b).map(([, value]) => dense(value));
      };
      if (!final) {
        body.output = items();
        return body;
      }
      const kept = items();
      // A terminal object that carries no output of its own — absent, or
      // empty while the stream accumulated some — is not a whole view of the
      // reply: returning it verbatim discards every delta already delivered,
      // and the client reads a 200 as a model that said nothing. The
      // accumulation stands in for the collection it lost; everything else
      // about the terminal is what the upstream said last, and comes back
      // exactly as it arrived.
      //
      // A terminal that carries a list of its own is read against the items
      // the stream delivered before that list wins. It is a whole view of the
      // reply only where it holds as many of those items as the stream
      // delivered: a list that names fewer of them is a partial view of the
      // reply, and it stands in for the collection it lost — a gateway that
      // reports the last item only answered 200 with one item where the
      // stream carried two, and the earlier one was gone with no word.
      //
      // The terminal is the last snapshot of a reply whose items were filled
      // in by deltas, and it gets the same weight comparison every other
      // snapshot gets: a list equal to the accumulation in count and ids but
      // carrying shorter content is a partial view of it, not a newer one.
      // Read by count and ids alone, a gateway re-emitting the final response
      // with `content: [{type:"output_text", text:""}]` passed the test and
      // `return { ...body, ...terminal }` answered 200 with the streamed text
      // silently dropped — the one place in this file where a snapshot could
      // overwrite a fully accumulated item without being weighed against it.
      //
      // An id is not the only correspondence: a gateway may repeat the list
      // without ids, or the stream may have opened items it never named. The
      // place in the list is what is left then, and it is the same place the
      // item was accumulated at. Both readings are weighed, so a terminal that
      // names nothing still cannot replace a filled item with an empty one.
      const keptByID = new Map();
      for (const item of kept) {
        const id = identity(item.id);
        if (id !== undefined) keptByID.set(id, item);
      }
      // A terminal whose output is not a list carries no usable output: a
      // scalar or an object is not a collection of items to answer with, and
      // taking it as one replaced everything the stream delivered.
      const whole = Array.isArray(final.output)
        ? final.output.length > 0 &&
          final.output.length >= kept.length &&
          names(final.output, kept) &&
          // A terminal that carries MORE items than the stream was seen to
          // accumulate is a superset of the reply, not a shorter view of it:
          // the missing items are the reason it exists, and it wins. The items
          // it names again are still weighed against the stream's copy — a
          // gateway that adds an item and re-emits an earlier one truncated
          // would otherwise replace the accumulated item with the shorter
          // view, and the text the deltas delivered would be gone — while an
          // item it names for the first time has nothing to be weighed
          // against. A terminal of the same length is the shape a re-emitting
          // gateway uses, and each item is weighed against the one in the same
          // place before it may replace it.
          (final.output.length > kept.length
            ? final.output.every((item) => {
                const held = keptByID.get(identity(item.id));
                return held === undefined || carries(item, held, fields);
              })
            : final.output.every((item, at) => {
                const id = identity(item.id);
                const held = id === undefined ? kept[at] : (keptByID.get(id) ?? kept[at]);
                return held === undefined || carries(item, held, fields);
              }))
        : false;
      // The terminal is spread whole onto the answer, so the report it carries
      // is read by shape like every other (keepUsage, above): one that is not a
      // report states none, and the report the stream accumulated stands.
      const terminal = { ...final };
      keepUsage(terminal, body.usage);
      // The terminal is not the whole reply either. What apply merged onto
      // the body from the events' top level — usage, status,
      // incomplete_details, finish_reason, and the object this reply is — is
      // the upstream's too, and answering with the terminal alone dropped it:
      // a terminal carrying its whole response beside a top-level usage, or
      // one that omits object, answered without them. The body is the base,
      // the terminal overrides what it carries, and the items it lost come
      // back from the accumulation.
      // A terminal that is not a whole view of the reply contributes only what
      // it carries beside `output`: the items the stream delivered come back
      // from the accumulation. A non-list `output` is not a view of the items
      // at all, so even a reply that accumulated none answers with the empty
      // list it would have had rather than the scalar.
      if (whole) return { ...body, ...terminal };
      return { ...body, ...terminal, output: kept };
    },
  };
}

// The block field each Anthropic text delta fills in. A Map rather than an
// object literal, and one of them for the whole module rather than one per
// delta: read off an object, a `delta.type` of "__proto__", "toString" or
// "constructor" reached the member the prototype chain holds there and the
// delta wrote that key onto its block — a key the delta never named, holding a
// function that JSON.stringify then dropped. A Map holds no chain: those three
// names are the misses they are.
const ANTHROPIC_TEXT_FIELDS = new Map([
  ["text_delta", "text"],
  ["thinking_delta", "thinking"],
  ["signature_delta", "signature"],
]);

function anthropicAccumulator() {
  let body = {
    type: "message",
    role: "assistant",
    content: [],
    stop_reason: null,
    stop_sequence: null,
  };
  const blocks = new Map();
  const argumentsJSON = new Map();
  // The fields a Messages block fills in: its text, thinking, signature, or
  // the input a tool call opened with.
  const fields = ["text", "thinking", "signature", "partial_json", "input"];
  return {
    apply(data, type) {
      if (type === "message_start") {
        // The message is spread whole, and its own `usage` comes with it: read
        // by shape, so a report that is not one leaves the body holding the
        // report it already had (keepUsage, above).
        //
        // A message that is not an object stands in for nothing — the same
        // reading the Responses accumulator gives its own snapshot
        // (isSnapshotObject, above): spread as it stood, a string's characters
        // became the reply's own keys, and the reply answered 200 carrying keys
        // the upstream never named and no id at all.
        const reported = body.usage;
        if (isSnapshotObject(data.message)) {
          body = { ...body, ...data.message };
          keepUsage(body, reported);
        }
        // `content` is the one key of a message_start that `apply` fills in
        // itself, and a value that is not a list of blocks — a string, a
        // number, an object — is not a view of the reply to take it from: the
        // spread above would set it on the body and answer with it, ahead of
        // the blocks this stream accumulates. A null or a missing one is the
        // shape every frame of this accumulator leaves alone already.
        const stated = Array.isArray(data.message?.content) ? data.message.content : [];
        body.content = stated;
        // A message_start that repeats beside the deltas it opened, or one
        // whose block has not been filled in yet, is a partial view of the
        // reply: a block that carries nothing where the accumulated one has
        // content leaves it standing.
        for (const [position, block] of stated.entries())
          if (isSnapshotObject(block) && carries(block, blocks.get(position), fields))
            blocks.set(position, block);
      } else if (type === "content_block_start") {
        // The same test message_start's blocks get, for the same reason: a
        // gateway re-emitting a block's opening frame carries a block that
        // was never filled in (a text one opens with text: ""), and taking
        // it would discard the text, thinking or signature the deltas
        // already delivered. A start with nothing accumulated applies, as
        // does one that carries content of its own.
        //
        // A frame that carries no block at all, or a null or a flat value
        // where one belongs, is the same partial view: `carries` weighs it as
        // nothing, so it was stored as it stood and the reply answered 200
        // with a null among its content, or threw on the first delta that
        // read a field of it. Nothing to take hold of is not a reason to fail
        // a stream whose other frames are sound — it opens nothing, and the
        // deltas that follow it are refused exactly like a delta with no
        // block above them, which is the answer this file gives that shape.
        const position = index(data.index);
        if (isSnapshotObject(data.content_block) && carries(data.content_block, blocks.get(position), fields))
          blocks.set(position, data.content_block);
      } else if (type === "content_block_delta") {
        const position = index(data.index);
        const block = blocks.get(position);
        if (!block) throw new Error("Content delta without a content block");
        const delta = data.delta ?? {};
        const field = ANTHROPIC_TEXT_FIELDS.get(delta.type);
        if (field) applyText(block, field, delta[field], true);
        if (delta.type === "input_json_delta") {
          argumentsJSON.set(
            position,
            (argumentsJSON.get(position) ?? "") + (delta.partial_json ?? ""),
          );
        }
      } else if (type === "message_delta") {
        // Only the fields a message_delta is defined to carry are taken from
        // it. Object.assign copied with [[Set]] semantics: a "__proto__" key
        // in the upstream's delta re-parented the message being accumulated,
        // and any other key silently overwrote its id, role, type or content.
        for (const field of ["stop_reason", "stop_sequence"]) {
          if (data.delta?.[field] !== undefined) body[field] = data.delta[field];
        }
        // Read by shape, as the chat accumulator's usage is (above).
        if (isSnapshotObject(data.usage)) body.usage = { ...body.usage, ...data.usage };
      }
    },
    finish() {
      for (const [position, value] of argumentsJSON) {
        // An upstream may send an empty delta set for a call that takes no
        // arguments: there are no bytes to parse, and the block's own input
        // stands. JSON.parse("") would fail a valid call.
        if (!value.trim()) continue;
        const block = blocks.get(position);
        if (!block) throw new Error("Tool input for no content block in upstream stream");
        try {
          block.input = JSON.parse(value);
        } catch {
          throw new Error("Invalid tool input JSON in upstream stream");
        }
      }
      body.content = sorted(blocks);
      return body;
    },
  };
}

export async function collapseResponse(response, protocol) {
  if (!response.ok) return response;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "text/event-stream") return response;
  const factories = {
    chat: chatAccumulator,
    responses: responsesAccumulator,
    anthropic: anthropicAccumulator,
  };
  if (!Object.hasOwn(factories, protocol)) throw new TypeError(`Unsupported protocol: ${protocol}`);
  const accumulator = factories[protocol]();
  let completed = false;
  let failure;
  let eventName = "";
  let dataLines = [];
  let lineParts = [];
  let skipLF = false;

  function dispatch() {
    const name = eventName;
    const text = dataLines.join("\n");
    eventName = "";
    dataLines = [];
    if (failure) return;
    if (name === "error") {
      let value = text;
      try {
        value = JSON.parse(text);
      } catch {
        /* Error events may contain plain text. */
      }
      failure = errorMessage(value);
      return;
    }
    if (!text.trim()) return;
    if (text.trim() === "[DONE]") {
      // [DONE] is what ends a Chat stream, and it is a valid end-of-stream
      // sentinel for a Responses or Messages one that has already reported
      // its own terminal event (response.completed, response.incomplete,
      // message_stop) — a gateway in front of the upstream may append it.
      // Before that event it is an ending the protocol never reported, so
      // what was streamed is not a whole reply: the guard refuses the same
      // bytes with the same words rather than reading them as a success.
      if (protocol === "chat") completed = true;
      else if (!completed) failure = "Unexpected upstream completion marker";
      return;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      failure = "Invalid JSON in upstream SSE event";
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      failure = "Invalid JSON object in upstream SSE event";
      return;
    }
    const type = data.type ?? name;
    if (
      data.error ||
      type === "error" ||
      type === "response.failed" ||
      data.response?.status === "failed"
    ) {
      failure = errorMessage(data.error ?? data.response?.error ?? data);
      return;
    }
    if (completed) return;
    try {
      accumulator.apply(data, type);
    } catch (error) {
      failure = errorMessage(error, "Invalid upstream SSE event");
      return;
    }
    if (
      (protocol === "responses" &&
        (type === "response.completed" || type === "response.incomplete")) ||
      (protocol === "anthropic" && type === "message_stop")
    )
      completed = true;
  }

  function line(value) {
    if (value === "") return dispatch();
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "data") dataLines.push(content);
    if (field === "event") eventName = content;
  }

  function feed(text) {
    let start = 0;
    if (skipLF && text.length) {
      if (text[0] === "\n") start = 1;
      skipLF = false;
    }
    const endings = /[\r\n]/g;
    endings.lastIndex = start;
    let match;
    while ((match = endings.exec(text))) {
      lineParts.push(text.slice(start, match.index));
      line(lineParts.join(""));
      lineParts = [];
      start = match.index + 1;
      if (match[0] === "\r") {
        if (text[start] === "\n") start++;
        else if (start === text.length) skipLF = true;
      }
      endings.lastIndex = start;
    }
    if (start < text.length) lineParts.push(text.slice(start));
  }

  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) {
          failure = `Upstream SSE exceeds the ${MAX_BYTES / (1024 * 1024)} MiB limit`;
          await reader.cancel();
          break;
        }
        feed(decoder.decode(value, { stream: true }));
        if (failure) {
          await reader.cancel();
          break;
        }
      }
      feed(decoder.decode());
      // The event-stream format discards the pending data at the end of the
      // stream, and this file does not. The framing dispatches an event on an
      // empty line, so a stream whose last event is not followed by one —
      // `data: [DONE]\n`, or a last line with no newline at all — left that
      // event undispatched: the completion marker among it was never read,
      // the reply was answered with a 502 that threw away the text the stream
      // had already delivered (measured on the same bytes: two newlines
      // answered 200 with the reply, one newline answered 502 with nothing).
      //
      // The marker is the upstream's own end of the reply, and a reply that
      // carries it is a whole one whatever the framing did after it. So the
      // pending event is dispatched at the end of the stream.
      //
      // What this does not make is half an event acceptable: the pending bytes
      // are dispatched as they stand, and bytes that are not a whole event
      // fail as they always have. A stream cut short in the middle of one
      // still answers 502, and a stream cut short before its marker still
      // answers 502 with the completion it never reported — the distinction
      // this file has always drawn between a reply that ended and one that
      // was cut short (provider.mjs and tool-response.mjs read the same two
      // cases apart).
      if (!failure) {
        if (lineParts.length) {
          line(lineParts.join(""));
          lineParts = [];
        }
        if (dataLines.length) dispatch();
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (!failure && !completed) failure = "Upstream SSE stream ended without a completion marker";
  let body;
  if (!failure) {
    try {
      body = accumulator.finish();
    } catch (error) {
      failure = errorMessage(error);
    }
  }
  return jsonResponse(response, protocol, body, failure);
}
