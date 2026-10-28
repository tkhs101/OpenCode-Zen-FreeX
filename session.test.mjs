import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationKey,
  currentIdentity,
  forgetIdentity,
  identityTTL,
  mintIdentity,
  opencodeID,
  realSessionID,
  rotateIdentity,
  sessionID,
} from "./provider.mjs";

// This file pins the affinity ladder — how a conversation is named, and how one
// name keeps one session across its turns. The package engages that ladder only
// when OPENCODE_ZEN_FREE_SESSION_AFFINITY=1 is set: by default every request
// leaves as its own fresh session (pinned in the rotation tests at the end of
// this file). The knob is read per call, so setting it here turns every call
// below affinity-on without touching them one by one.
process.env.OPENCODE_ZEN_FREE_SESSION_AFFINITY = "1";

// The layout provider.mjs encodes, from OpenCode's identifier.ts: a
// 3-character prefix and "_", 12 hex of Date.now() * 0x1000 + counter, then
// 14 random base62 characters. The tail of that layout is written once, in
// LAYOUT; ID_SHAPE is the layout with the prefix left as a class as wide as the
// prefix this module mints, and SHAPE is the same layout with that prefix
// spelled out, so the field widths and the class after them cannot drift
// between the two readings.
const PREFIX = "ses";
const PREFIX_CHARS = PREFIX.length + 1;
const FIELD_HEX = 12;
const TAIL_CHARS = 14;
const LAYOUT = `_[0-9a-f]{${FIELD_HEX}}[0-9A-Za-z]{${TAIL_CHARS}}$`;
const ID_SHAPE = new RegExp(`^[a-z]{${PREFIX.length}}${LAYOUT}`);
const SHAPE = new RegExp(`^${PREFIX}${LAYOUT}`);
const FIELD_MASK = 0xffffffffffffn; // the 48 bits that hex field carries
const COUNTER_MOD = 0x1000n; // its low 12 bits are the counter
// opencodeID wraps its counter at this one, so every id it mints carries a
// counter from 1 through 15. realSessionID accepts a wider range — the live
// endpoint was found to accept 1 through 63 on 2026-10-25 — but the ids this
// module makes itself stay inside the narrower range.
const MINT_LIMIT = 16;
const ACCEPT_LIMIT = 64;
const WRAP = 2 ** 36; // the 36 bits of Date.now() the field keeps

// Decode an id the way OpenCode's identifier.ts lays it out. One of another
// shape is an assertion here, rather than a raw SyntaxError out of BigInt.
function decode(id, descending) {
  assert.match(id, ID_SHAPE);
  let value = BigInt(`0x${id.slice(PREFIX_CHARS, PREFIX_CHARS + FIELD_HEX)}`);
  if (descending) value = ~value & FIELD_MASK;
  return { time: Number(value / COUNTER_MOD), counter: Number(value % COUNTER_MOD) };
}

test("a made-up session id is OpenCode's: descending, the time it was made, a small counter", () => {
  const before = Date.now();
  const id = sessionID(new Headers({ "x-session-id": "conversation-a" }), {});
  const after = Date.now();
  assert.match(id, SHAPE);
  assert.ok(realSessionID(id), id);
  const { time, counter } = decode(id, true);
  // The time field wraps every 2^36 ms, so what a range check can hold is
  // the elapsed offset, not two already-wrapped values.
  const elapsed = ((time - before) % WRAP + WRAP) % WRAP;
  assert.ok(elapsed <= after - before, `${time} not in ${before}..${after}`);
  // Whatever the counter was, it has to be one realSessionID reads as a
  // counter rather than as part of the time: the id is the shape Zen checks.
  assert.ok(counter > 0 && counter < MINT_LIMIT, `counter ${counter}`);
});

test("one conversation keeps one session, another gets its own", () => {
  const a1 = sessionID(new Headers({ "x-session-id": "conversation-b" }), {});
  const a2 = sessionID(new Headers({ "x-session-id": "conversation-b" }), {});
  const b = sessionID(new Headers({ "x-session-id": "conversation-c" }), {});
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  // A conversation with no header of its own is keyed by its first user
  // message, so the same question keeps one session...
  const body = { messages: [{ role: "user", content: "first question" }] };
  assert.equal(sessionID(new Headers(), body), sessionID(new Headers(), body));
  // ...and a different one gets its own, rather than every headerless request
  // sharing whichever conversation arrived first.
  const other = { messages: [{ role: "user", content: "second question" }] };
  assert.notEqual(sessionID(new Headers(), body), sessionID(new Headers(), other));
  // A signal the host does send is read wherever it is: a conversation id in
  // the body's metadata is a signal, not prose to be hashed.
  const signaled = sessionID(new Headers(), { metadata: { session_id: "conversation-d" } });
  assert.equal(signaled, sessionID(new Headers({ "conversation-id": "conversation-d" }), {}));
});

test("with the window off, a request with no signal and no user message gets an id of its own", () => {
  // Nothing to key a conversation by, so with the window off the id cannot be
  // kept for a next turn and is minted fresh — and it must still be the shape
  // Zen checks rather than a bare made-up value. Two of them differ, which is
  // the half a name like "one id, not a new one a turn" got wrong: a single
  // constant here would fold every such request into whichever conversation
  // happened to arrive first. The window is the one thing allowed to share an
  // id between two such requests, and it is off here (see the window cases).
  const held = process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
  process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = "0";
  try {
    const first = sessionID(new Headers(), {});
    const second = sessionID(new Headers(), {});
    assert.ok(realSessionID(first), first);
    assert.ok(realSessionID(second), second);
    assert.notEqual(first, second, "nothing names this conversation, so nothing may be shared");
  } finally {
    if (held === undefined) delete process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
    else process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = held;
  }
});

test("OpenCode's own session id is passed through, a hash cut to its shape is not", () => {
  const real = "ses_ecc5d8f28ffe9Cy14V8Em7lI2u";
  assert.equal(sessionID(new Headers({ "x-opencode-session": real }), {}), real);
  // 0.1.4 sent this for "x-session-id: session_123"; Zen answers it 403.
  const hashed = "ses_e9283da055b15JwOAra76bwUx4";
  assert.equal(realSessionID(hashed), false);
  const sent = sessionID(new Headers({ "x-opencode-session": hashed }), {});
  assert.notEqual(sent, hashed);
  assert.ok(realSessionID(sent), sent);
});

test("ids made in one millisecond count up, as OpenCode's do", () => {
  const now = 1_790_000_000_000;
  const first = opencodeID("msg", false, now);
  const second = opencodeID("msg", false, now);
  // Asserting the increment rather than the absolute numbers keeps this free of
  // the module's own counter state, which another test in this process shares.
  assert.equal(decode(second, false).counter, decode(first, false).counter + 1);
  assert.equal(decode(second, false).time, decode(first, false).time);
});

test("a burst that fills the counter field still makes OpenCode's ids", () => {
  const now = 1_790_000_000_001;
  const ids = Array.from({ length: 40 }, () => opencodeID("ses", true, now));
  const counters = ids.map((id) => decode(id, true).counter);
  // Forty ids is past the fifteen the counter's own range holds, so the burst
  // wraps it, and what this holds is that every id of the wrap stays inside that
  // range. MINT_LIMIT is the range opencodeID keeps; realSessionID accepts the
  // wider 1-63 the endpoint was measured to take, and would not catch a wrap
  // that broke at 16. COUNTER_MOD is the width of the whole hex field instead,
  // and a counter read back below it is true by construction — a burst that
  // broke the wrap would carry into the time the id claims and still pass that
  // boundary, which is why this one is asserted here.
  for (const [at, counter] of counters.entries()) {
    assert.ok(counter > 0 && counter < MINT_LIMIT, `id ${at} has counter ${counter}`);
    assert.ok(realSessionID(ids[at]), `id ${at} is not one OpenCode could have made`);
  }
  // Counting still happens: consecutive ids inside one millisecond differ.
  assert.notEqual(counters[0], counters[1]);
});

// The live endpoint was measured on 2026-10-25: a correctly-shaped `ses_` id
// whose counter (the low 12 bits, inverted) is 1 through 63 answers, and one
// with 0 or 64 is refused with the same 403 FreeTierError as a hash. The gate
// therefore reads the counter, not only the shape.
//
// The time field is deliberately left as zeros here: it is a truncation of
// Date.now() and every genuine id decodes to 1970 unless the reader
// reconstructs a cycle, so a plausibility check on it would reject OpenCode's
// own sessions. What this package mints carries the current time (opencodeID),
// which is the half that matters on this side.
test("the session counter is accepted through 63 and rejected at 64", () => {
  const shaped = (counter) =>
    `ses_000000000${(0xfff - counter).toString(16).padStart(3, "0")}${"A".repeat(TAIL_CHARS)}`;
  for (const counter of [1, 15, 16, 63]) {
    const id = shaped(counter);
    assert.ok(realSessionID(id), `counter ${counter} is one the endpoint accepts: ${id}`);
  }
  for (const counter of [0, 64, 65, 0xfff]) {
    const id = shaped(counter);
    assert.equal(realSessionID(id), false, `counter ${counter} is not: ${id}`);
  }
  assert.equal(realSessionID(shaped(1).replace("ses_", "msg_")), false, "the prefix still has to be ses_");
  assert.equal(realSessionID(shaped(1).slice(0, -1)), false, "the tail still has to be fourteen characters");
  assert.ok(realSessionID(shaped(1)), "the acceptance check is not rejecting the shape itself");
});

// A signal the host sends outranks an empty opening. `""` is falsy, so a
// conversation whose first user message is empty used to be read as one with no
// opening at all and was minted an id of its own — per call, not per
// conversation — even though the host had named it. What the host said is the
// one thing here that identifies a conversation, and an empty message is not a
// reason to discard it.
//
// The two headed cases below are what says so: the same name answers one id,
// two names answer two, and both are OpenCode-shaped rather than the name
// passed through (a name that is not one of OpenCode's own is hashed, the way
// any other signal is).
test("a host signal still names a conversation whose first user message is empty", () => {
  const empty = { messages: [{ role: "user", content: "" }] };
  const first = sessionID(new Headers({ "x-opencode-session": "conversation-g" }), empty);
  const second = sessionID(new Headers({ "x-opencode-session": "conversation-g" }), empty);
  assert.equal(first, second, "one name, one conversation");
  assert.ok(realSessionID(first), first);
  const other = sessionID(new Headers({ "x-opencode-session": "conversation-h" }), empty);
  assert.notEqual(first, other, "two names, two conversations");
  assert.notEqual(first, "conversation-g", "a name that is not OpenCode's is hashed, not passed on");
  // The body's metadata is the same kind of signal and outranks it the same way.
  const byMetadata = sessionID(new Headers(), { ...empty, metadata: { session_id: "conversation-g" } });
  assert.equal(byMetadata, first, "where the name came from does not change what it names");
});

// The same contract with a first user message that has words in it: a host
// signal is the conversation's own name for itself, so it is the key on its own
// and nothing else is folded in beside it. A host that carries a signal may
// open a later turn with a shortened history, and keyed by the opening too, the
// same conversation would answer a new id the moment its first message moved.
//
// The empty opening above cannot hold this line on its own: a regression that
// folded the opening into the signal — hashing the name and the first message
// together — answers one id for an empty opening and two for a spoken one, and
// every assertion above still passes.
test("a host signal names a conversation whatever its first user message says", () => {
  const named = new Headers({ "x-opencode-session": "conversation-i" });
  const opened = { messages: [{ role: "user", content: "hi" }] };
  const shortened = { messages: [{ role: "user", content: "hi again" }] };
  // The signal alone is the key: the same name answers one id whatever the
  // opening says, so a turn that opens differently keeps the conversation.
  assert.equal(
    sessionID(named, opened),
    sessionID(named, shortened),
    "one name, one conversation: the opening is not folded in beside the signal",
  );
  // ...and two names answer two ids, whatever the opening says.
  assert.notEqual(
    sessionID(named, opened),
    sessionID(new Headers({ "x-opencode-session": "conversation-j" }), opened),
    "two names, two conversations: one opening does not make them one",
  );
  // The id is still OpenCode's own shape, and not the name passed on.
  const id = sessionID(named, opened);
  assert.ok(realSessionID(id), id);
  assert.notEqual(id, "conversation-i", "a name that is not OpenCode's is hashed, not passed on");
});

// The id is the one OpenCode itself would mint, and that is what Zen reads.
// OpenCode's own identifier.ts (packages/schema/src/identifier.ts) takes six
// bytes out of `Date.now() * 0x1000 + counter` — the low 48 of it and no more
// — writes them as hex, and adds 14 random base62 characters; a session's
// value is the one inverted, so that a newer id sorts first.
//
// The 48 bits are OpenCode's own field and not a truncation of a wider one, so
// what the field holds of the time is the time modulo 2^36 ms — 795.4 days —
// and OpenCode's ids start over at the same period. The mask is not a defect
// to be repaired here: an id that carried more of the time than OpenCode's
// does is not one Zen reads as OpenCode's.
function opencodeTime(timestamp, counter, descending) {
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = descending ? ~current : current;
  return Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
}

test("the id is the one OpenCode itself would mint, bit for bit", () => {
  // A millisecond no other case in this file uses, so the counter this module
  // keeps for it is the first one it hands out: 1.
  const now = 1_790_000_777_000;
  const id = opencodeID("ses", true, now);
  assert.equal(id.slice(4, 16), opencodeTime(now, 1, true));
  assert.equal(id.length, 4 + FIELD_HEX + TAIL_CHARS);
  // The time the field carries is the time modulo 2^36 ms, inverted for a
  // session — and that is what OpenCode's own ids carry, so the two cannot
  // drift into being different kinds of id.
  const value = BigInt(`0x${id.slice(4, 16)}`);
  assert.equal(value >> 12n, (1n << 36n) - 1n - (BigInt(now) % (1n << 36n)));
});

// An empty opening with NO signal is the one shape that cannot be keyed: two
// conversations that opened empty are indistinguishable from one, so any key
// derived here would either be shared by unrelated conversations — one Zen
// session, with its affinity and its quota — or differ again on the next turn.
// Not sharing is the half worth keeping, and it is what this does: the id is
// minted per call. This is a known limit and not an accident, so it is pinned:
// a change that started sharing these would be a regression here.
test("an empty opening with no signal is never shared between conversations", () => {
  const empty = { messages: [{ role: "user", content: "" }] };
  const first = sessionID(new Headers(), empty);
  const second = sessionID(new Headers(), empty);
  assert.ok(realSessionID(first), first);
  assert.ok(realSessionID(second), second);
  assert.notEqual(first, second, "nothing named this conversation, so nothing may be shared");
  // An opening with words is still a key, so this is the shape that gave
  // something up rather than the contract itself — the key is the first *user*
  // message wherever it sits in the history.
  const spoken = { messages: [{ role: "user", content: "hi" }, { role: "user", content: "" }] };
  assert.equal(sessionID(new Headers(), spoken), sessionID(new Headers(), spoken));
});

// The reachable limit of keying a conversation by its opening: two hosts that
// send no session signal at all and open with the very same words are one key,
// and one Zen session. There is nothing in the request that distinguishes them
// — that is what the signal is for — so this is pinned rather than papered
// over, and it is the reason the signal above is read first: a host that does
// name its conversations gets separate sessions for them.
test("conversations with the same opening and no signal are one key", () => {
  const opening = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(
    sessionID(new Headers(), opening),
    sessionID(new Headers(), opening),
    "nothing distinguishes these two, so they key the same — the contract this plugin has",
  );
});

test("a session id is never minted from a signal that is not a string", () => {
  // A body is the host's to fill in, so `metadata.session_id` is not guaranteed
  // to be text; a number there is not a session the tier could have seen. The
  // guard is not about throwing — the hash is a template literal, so it would
  // coerce the number rather than fail — it is about not keying by it: with the
  // guard gone, both calls below would answer one session, hashed from "42".
  const first = sessionID(new Headers(), { metadata: { session_id: 42 } });
  const second = sessionID(new Headers(), { metadata: { session_id: 42 } });
  assert.ok(realSessionID(first), first);
  // and it is not the text "42" either: the number is ignored rather than
  // coerced, so what the string keys must not be what the number answered.
  const text = sessionID(new Headers(), { metadata: { session_id: "42" } });
  assert.notEqual(first, text, "42 is not \"42\"");
  assert.notEqual(first, second, "a number is not a session to key a conversation by");
});

// An empty string is a string, and the guard that reads the metadata admits
// one: taken as the conversation's name, it became the key every such request
// shared — `sha256("ses\0")` — so every host that sent an empty name landed on
// one Zen session, with its affinity and its quota. Measured on 2026-10-20:
// two conversations opening differently answered the same id
// (ses_ea7d502a1ffe9szowdKaA6Qa5p), which is the one thing the module's own
// comments say must not happen.
//
// The case above proves the type guard was considered and stops one case short
// of the empty string — which is where this hid.
test("a name with nothing in it is no name, and no such request is shared", () => {
  const blank = sessionID(new Headers(), { metadata: { session_id: "" } });
  const blankAgain = sessionID(new Headers(), { metadata: { session_id: "" } });
  assert.ok(realSessionID(blank), blank);
  // Nothing named those two conversations, so nothing may be shared between
  // them: an id of its own each, not the one key every empty name shares.
  assert.notEqual(blank, blankAgain, "an empty name is no name: it may not be shared");
  // And two conversations that each carry an empty name are two
  // conversations, however differently they open.
  const one = sessionID(new Headers(), {
    metadata: { session_id: "" },
    messages: [{ role: "user", content: "one" }],
  });
  const other = sessionID(new Headers(), {
    metadata: { session_id: "" },
    messages: [{ role: "user", content: "two" }],
  });
  assert.notEqual(one, other, "an empty name may not fold two conversations into one");
  // An empty name changes nothing about how the request is keyed: it is keyed
  // the way any unnamed request is, by its opening.
  const opening = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(
    sessionID(new Headers(), { ...opening, metadata: { session_id: "" } }),
    sessionID(new Headers(), opening),
    "an empty name names nothing, so it changes nothing about the key",
  );
});

// The other half of a body being the host's to fill in: a body that is not a
// body at all. `sessionID` read `body.metadata` and `message.role` with no null
// check, so `sessionID(headers)` with no body, `{ metadata: null }`, and a
// history holding a null entry each threw a TypeError — a request that never
// reached upstream, answered as an internal error. The shapes that are not a
// body are the host's to send too, and none of them may throw; the ones that
// carry a usable opening still key it, past the entries that are not messages.
test("a body that is not a body does not throw, and its opening is still read", () => {
  const headers = new Headers();
  for (const [what, body] of [
    ["no body at all", undefined],
    ["a null body", null],
    ["a null metadata", { metadata: null }],
    ["a null message in the history", { messages: [null] }],
    ["a null entry in input", { input: [null] }],
  ])
    assert.doesNotThrow(() => sessionID(headers, body), what);
  // A null entry beside the opening is skipped rather than standing for it: the
  // first user message is still what names the conversation, exactly as if the
  // null had not been sent.
  const opening = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(
    sessionID(headers, { messages: [null, { role: "user", content: "hi" }] }),
    sessionID(headers, opening),
    "a null entry before the opening hid the opening from the key",
  );
  // Nothing named this one, so it gets an id of its own rather than throwing —
  // and an OpenCode-shaped one, because the tier checks the shape.
  const unnamed = sessionID(headers, undefined);
  assert.ok(realSessionID(unnamed), unnamed);
});

// A signal and an opening are different kinds of name, and they used to share
// one hashed key space (`ses\0`). A host that sends the header value `"hi"` —
// the quote characters are part of the value — and a host whose first user
// message is the string `hi` hashed the same bytes, because JSON.stringify
// writes the opening as `"hi"` too: two unrelated conversations landed on one
// Zen session, with its affinity and its quota. The domains have their own
// prefixes now, so no value of one can spell a value of the other.
test("a signal that spells a JSON opening is not that opening's conversation", () => {
  const opening = { messages: [{ role: "user", content: "hi" }] };
  const bySignal = sessionID(new Headers({ "x-opencode-session": '"hi"' }), opening);
  const byOpening = sessionID(new Headers(), opening);
  assert.ok(realSessionID(bySignal), bySignal);
  assert.notEqual(
    bySignal,
    byOpening,
    "a header value equal to the quoted opening named the opening's conversation",
  );
  // Each still keys itself: the same signal is one conversation, and the same
  // opening is one conversation — the separation is between the two domains,
  // not a break of either.
  assert.equal(
    sessionID(new Headers({ "x-opencode-session": '"hi"' }), opening),
    bySignal,
    "the signal stopped naming its own conversation",
  );
  assert.equal(sessionID(new Headers(), opening), byOpening, "the opening stopped naming its own");
});

// The aliases a host may name its conversation by, in the order provider.mjs
// reads them. The header spellings are the ones Claude Code, Codex and the
// OpenCode-shaped clients send; each is a name of the same kind, so each is
// read with the same rule: the first non-empty one wins, and two requests that
// carry it answer one session however differently they open.
test("every session header and body alias names the conversation it carries", () => {
  const first = { messages: [{ role: "user", content: "first opening" }] };
  const second = { messages: [{ role: "user", content: "a shortened history" }] };
  const plain = sessionID(new Headers(), first);
  const headersOf = (name) => [
    (value) => sessionID(new Headers({ [name]: value }), first),
    (value) => sessionID(new Headers({ [name]: value }), second),
  ];
  const sources = [
    ...[
      "x-opencode-session",
      "x-opencode-session-id",
      "x-session-affinity",
      "x-session-id",
      "session_id",
      "conversation-id",
      "conversation_id",
    ].map((name) => ({ label: `header ${name}`, of: headersOf(name) })),
    {
      label: "body conversation_id",
      of: [
        (value) => sessionID(new Headers(), { conversation_id: value, ...first }),
        (value) => sessionID(new Headers(), { conversation_id: value, ...second }),
      ],
    },
    {
      label: "metadata.session_id",
      of: [
        (value) => sessionID(new Headers(), { metadata: { session_id: value }, ...first }),
        (value) => sessionID(new Headers(), { metadata: { session_id: value }, ...second }),
      ],
    },
  ];
  for (const { label, of: [oneOf, againOf] } of sources) {
    const value = `conversation-${label.replace(/\W+/g, "-")}`;
    const one = oneOf(value);
    assert.ok(realSessionID(one), `${label}: ${one}`);
    assert.equal(one, againOf(value), `${label}: one name, two openings, two sessions`);
    assert.notEqual(one, plain, `${label}: the alias was not read, the opening was`);
    assert.notEqual(
      oneOf(`${value}-other`),
      one,
      `${label}: two names answered one session`,
    );
  }
});

// Claude Code puts the per-conversation name in the tail of metadata.user_id —
// `user_<hash>_account_<uuid>_session_<uuid>` — and the rest of that string is
// per user, not per conversation. A JSON user id carries the name as
// `session_id`. Both forms are read; a user id with neither is no name, and the
// request falls back to its opening rather than being keyed by a hash of a
// per-user value that would then fold every conversation of that user together.
test("Claude Code's metadata.user_id names a conversation in both of its forms", () => {
  const first = { messages: [{ role: "user", content: "hi" }] };
  const second = { messages: [{ role: "user", content: "hi, again" }] };
  const session = "123e4567-e89b-12d3-a456-426614174001";
  const ids = (userID) => [
    sessionID(new Headers(), { ...first, metadata: { user_id: userID } }),
    sessionID(new Headers(), { ...second, metadata: { user_id: userID } }),
  ];
  const underscored = `user_abcdef_account_123e4567-e89b-12d3-a456-426614174000_session_${session}`;
  const [one, again] = ids(underscored);
  assert.ok(realSessionID(one), one);
  assert.equal(one, again, "one user id, two openings, two sessions");
  assert.notEqual(
    one,
    ids(underscored.replace(session, "123e4567-e89b-12d3-a456-426614174002"))[0],
    "two user ids answered one session",
  );
  // The JSON string form, and the same value as an object: one name either way.
  const asJSON = JSON.stringify({ session_id: `json-${session}` });
  const byJSON = ids(asJSON)[0];
  assert.equal(byJSON, ids(asJSON)[1], "the JSON user id was not read as a name");
  assert.equal(
    byJSON,
    sessionID(new Headers(), { ...first, metadata: { user_id: { session_id: `json-${session}` } } }),
    "the JSON object and its string are one name",
  );
  // A user id that carries neither form is no name: the opening still keys it,
  // exactly as if the field had not been sent.
  assert.equal(
    ids("user_abcdef_account_123e4567-e89b-12d3-a456-426614174000")[0],
    sessionID(new Headers(), first),
    "a per-user value with no session part named the conversation",
  );
});

// The opening is the system prompt and the first user turn, not the user turn
// alone. Agent clients open with a boilerplate environment turn, so the user
// turn alone collides across unrelated conversations while the system prompts
// do not; and for one host, a changed system prompt is a changed conversation
// even where the user turn is identical.
test("a system prompt separates conversations that open with the same words", () => {
  const withSystem = (system, opening = "hi") => ({
    messages: [{ role: "system", content: system }, { role: "user", content: opening }],
  });
  const one = sessionID(new Headers(), withSystem("You are one."));
  const same = sessionID(new Headers(), withSystem("You are one."));
  const other = sessionID(new Headers(), withSystem("You are another."));
  assert.ok(realSessionID(one), one);
  assert.equal(one, same, "the same system prompt answered two sessions");
  assert.notEqual(one, other, "two system prompts answered one session");
  // A developer message is the same fact in the other role.
  const developer = {
    messages: [{ role: "developer", content: "You are one." }, { role: "user", content: "hi" }],
  };
  assert.equal(
    sessionID(new Headers(), developer),
    one,
    "a developer message and a system message were different conversations",
  );
  // A system message after the first user turn is not part of the opening: the
  // prelude is what the conversation started under, and later instructions do
  // not re-key it.
  const after = {
    messages: [{ role: "user", content: "hi" }, { role: "system", content: "later" }],
  };
  assert.equal(
    sessionID(new Headers(), after),
    sessionID(new Headers(), { messages: [{ role: "user", content: "hi" }] }),
    "a system message after the opening changed the key",
  );
  // The two protocol-specific shapes of the same fact.
  const byInstructions = (instructions) => ({
    instructions,
    input: [{ role: "user", content: "hi" }],
  });
  assert.notEqual(
    sessionID(new Headers(), byInstructions("You are one.")),
    sessionID(new Headers(), byInstructions("You are another.")),
    "Responses instructions did not key the conversation",
  );
  const byTopLevelSystem = (system) => ({ system, messages: [{ role: "user", content: "hi" }] });
  assert.notEqual(
    sessionID(new Headers(), byTopLevelSystem("You are one.")),
    sessionID(new Headers(), byTopLevelSystem("You are another.")),
    "Anthropic's top-level system did not key the conversation",
  );
});

// A Responses continuation carries `previous_response_id` instead of the
// history, and the turn after it must answer the session the reply it continues
// was made in. It is the id of last resort: read only where no header or body
// signal named the conversation and no opening can key it. An empty id is no
// id, like every other empty name.
test("previous_response_id keeps a continuation on the session it continues", () => {
  const response = { previous_response_id: "resp_01JABC" };
  const one = sessionID(new Headers(), response);
  assert.ok(realSessionID(one), one);
  assert.equal(sessionID(new Headers(), { previous_response_id: "resp_01JABC" }), one, "one reply, two sessions");
  assert.notEqual(
    sessionID(new Headers(), { previous_response_id: "resp_01JDEF" }),
    one,
    "two replies answered one session",
  );
  // It does not outrank an opening: a body that carries its first user turn is
  // keyed by that, whether or not a previous reply is named.
  const opening = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(
    sessionID(new Headers(), { ...opening, previous_response_id: "resp_01JABC" }),
    sessionID(new Headers(), opening),
    "previous_response_id replaced the opening as the key",
  );
  // Nor a host signal: the host's own name is the conversation's name.
  const named = sessionID(new Headers({ "x-opencode-session": "conversation-p" }), response);
  assert.equal(
    sessionID(new Headers({ "x-opencode-session": "conversation-p" }), {
      ...response,
      previous_response_id: "resp_01JDEF",
    }),
    named,
    "previous_response_id outranked the host's own name",
  );
  // An empty id names nothing: the body with no opening still gets an id of
  // its own per call, as the unnamed case always has.
  const blank = () => sessionID(new Headers(), { previous_response_id: "" });
  assert.notEqual(blank(), blank(), "an empty previous_response_id was read as a name");
});

// Empty values are no names wherever a new alias sits, exactly as an empty
// metadata.session_id is none: the request falls back to the opening it would
// have used had the field not been sent at all.
test("an empty alias changes nothing about how a request is keyed", () => {
  const opening = { messages: [{ role: "user", content: "hi" }] };
  const plain = sessionID(new Headers(), opening);
  for (const [label, body] of [
    ["conversation_id", { ...opening, conversation_id: "" }],
    ["metadata.user_id", { ...opening, metadata: { user_id: "" } }],
  ])
    assert.equal(sessionID(new Headers(), body), plain, `${label}: an empty name changed the key`);
  assert.equal(
    sessionID(new Headers({ session_id: "", "conversation-id": "" }), opening),
    plain,
    "an empty header named a conversation",
  );
  // And an id OpenCode itself minted is still passed through whole — the rule
  // every signal source keeps, not just the old five headers.
  const official = opencodeID("ses", true);
  assert.equal(
    sessionID(new Headers({ "x-opencode-session": official }), opening),
    official,
    "an official id in a header was hashed",
  );
  assert.equal(
    sessionID(new Headers(), { ...opening, conversation_id: official }),
    official,
    "an official id in the body was hashed",
  );
});

test("with the window off, every request is a fresh session, whatever names the conversation", () => {
  const held = process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
  process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = "0";
  try {
    const before = Date.now();
    const headers = new Headers({ "x-session-id": "conversation-one" });
    const body = { messages: [{ role: "user", content: "hi" }] };
    const first = sessionID(headers, body, { rotate: true });
    const second = sessionID(headers, body, { rotate: true });
    assert.notEqual(first, second, "two requests are two sessions");
    const after = Date.now();
    for (const id of [first, second]) {
      assert.match(id, SHAPE);
      const { time } = decode(id, true);
      // The time field wraps every 2^36 ms, so the range check holds the
      // elapsed offset, exactly as the minted-id test above does.
      const elapsed = ((time - before) % WRAP + WRAP) % WRAP;
      assert.ok(elapsed <= after - before, `${id} carries the time it was made`);
    }
    // A name the host sends — even an id OpenCode itself minted — does not hold
    // the request to that session: rotation reads no signal, by design, so a
    // conversation the tier has already judged cannot be landed back on it.
    const official = opencodeID("ses", true);
    assert.notEqual(
      sessionID(new Headers({ "x-opencode-session": official }), body, { rotate: true }),
      official,
      "an official id does not survive rotation",
    );
  } finally {
    if (held === undefined) delete process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
    else process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = held;
  }
});

test("OPENCODE_ZEN_FREE_SESSION_AFFINITY=1 is what puts the ladder in charge", () => {
  const saved = process.env.OPENCODE_ZEN_FREE_SESSION_AFFINITY;
  const savedTTL = process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
  try {
    delete process.env.OPENCODE_ZEN_FREE_SESSION_AFFINITY;
    const headers = new Headers({ "x-session-id": "conversation-one" });
    const body = { messages: [{ role: "user", content: "hi" }] };
    // With the knob unset the window decides: two requests inside it are one
    // session, and a window of zero is what makes them two again. Neither reads
    // the name the host sent, which is the half this case has always pinned.
    forgetIdentity();
    assert.equal(
      sessionID(headers, body),
      sessionID(headers, body),
      "with the knob unset, the window's session is kept",
    );
    process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = "0";
    assert.notEqual(
      sessionID(headers, body),
      sessionID(headers, body),
      "a window of zero mints per request again",
    );
    if (savedTTL === undefined) delete process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
    else process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = savedTTL;
    process.env.OPENCODE_ZEN_FREE_SESSION_AFFINITY = "1";
    assert.equal(
      sessionID(headers, body),
      sessionID(headers, body),
      "with the knob set, the conversation keeps one session again",
    );
    assert.ok(
      realSessionID(sessionID(headers, body)),
      "the kept id is still one OpenCode could have minted",
    );
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_ZEN_FREE_SESSION_AFFINITY;
    else process.env.OPENCODE_ZEN_FREE_SESSION_AFFINITY = saved;
    if (savedTTL === undefined) delete process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
    else process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = savedTTL;
  }
});

// The retry's replacement ledger is minted as one pair, not as two calls of two
// clocks: the tier reads a session id and a project id as one conversation in
// one project, so what replaces a spent pair is itself a pair — minted from one
// reading of the clock, and replaced together the next time.
test("a replacement ledger is minted as one pair", async () => {
  const { mintIdentity } = await import("./provider.mjs");
  const pair = mintIdentity();
  assert.ok(realSessionID(pair.session), "the session half is one OpenCode could have minted");
  assert.match(pair.project, /^[0-9a-f]{40}$/, "the project half is the git-hash shape the CLI sends");
  // The two halves agree about when their request happened: both carry the
  // clock the call was made at, which for the session id is the field the tier
  // reads and for the project id is nothing at all — the pair is one action.
  const now = Date.now();
  const stamped = mintIdentity(now);
  const decoded = decode(stamped.session, true);
  assert.equal(
    decoded.time,
    // The field keeps 36 bits of the clock (2^36 ms of it, one wrap); the pair
    // was minted from the reading this test handed in.
    now % WRAP,
    "the session half carries the clock the pair was minted from, not one it re-read",
  );
  assert.ok(decoded.counter > 0 && decoded.counter < MINT_LIMIT, `counter ${decoded.counter}`);
  // Two pairs are two pairs: no half is shared, whatever the timing.
  const other = mintIdentity(now);
  assert.notEqual(stamped.session, other.session);
  assert.notEqual(stamped.project, other.project);
});

// The window: one pair is used for as long as it is younger than the setting,
// and replaced when it is not. This is the shape a client has — a conversation
// that lasts a minute, then another — and the reason it exists is that identity
// hops in rapid bursts are blanket-refused where the same requests spaced about
// half a second apart pass (see PACING_ENV in provider.mjs). The clock is handed
// in rather than waited on, so the boundary is tested and not slept through.
test("one pair is used for the window and replaced when it ends", () => {
  const held = process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
  process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = "60000";
  try {
    forgetIdentity();
    const minted = currentIdentity(undefined, 1_000_000);
    assert.ok(realSessionID(minted.session), minted.session);
    assert.match(minted.project, /^[0-9a-f]{40}$/);
    // The last millisecond of the window still belongs to it.
    const last = currentIdentity(undefined, 1_000_000 + 59_999);
    assert.equal(last.session, minted.session, "the session holds to the end of its window");
    assert.equal(last.project, minted.project, "and so does the project id");
    // The next millisecond is a new pair, both halves at once.
    const next = currentIdentity(undefined, 1_000_000 + 60_000);
    assert.notEqual(next.session, minted.session, "a window that ended mints a new session");
    assert.notEqual(next.project, minted.project, "and a new project id");
    assert.equal(currentIdentity(undefined, 1_000_000 + 60_000).session, next.session, "the new pair is the one kept");
  } finally {
    if (held === undefined) delete process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
    else process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = held;
  }
});

// A window of zero is the per-request minting this package shipped with, and the
// value to set when measuring one ledger — a rotating id cannot answer a
// question about one id.
test("a window of zero mints a pair per call", () => {
  const held = process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
  process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = "0";
  try {
    forgetIdentity();
    const first = currentIdentity(undefined, 1_000_000);
    const second = currentIdentity(undefined, 1_000_000);
    assert.notEqual(first.session, second.session, "two calls, two sessions");
    assert.notEqual(first.project, second.project, "two calls, two project ids");
  } finally {
    if (held === undefined) delete process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
    else process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = held;
  }
});

// A clock that went backwards is an expired window, not a pair with time left: an
// id stamped in the future is one the tier reads as a lie, and the shape check it
// applies to a session id is the same one that made hash-derived timestamps in
// 1970 look like an exhausted quota.
test("a clock that went backwards ends the window", () => {
  const held = process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
  process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = "60000";
  try {
    forgetIdentity();
    const minted = currentIdentity(undefined, 1_000_000);
    const backwards = currentIdentity(undefined, 1_000_000 - 1);
    assert.notEqual(backwards.session, minted.session);
    assert.notEqual(backwards.project, minted.project);
  } finally {
    if (held === undefined) delete process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
    else process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = held;
  }
});

// A 429 replaces the pair whatever the window says, and the replacement becomes
// the window's: the ledger that just answered is worth more than the one it
// replaced, and going back to a spent pair on the next request would be asking
// the bucket that refused it.
test("a retry's pair becomes the one the window keeps", () => {
  const held = process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
  process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = "60000";
  try {
    forgetIdentity();
    const first = currentIdentity(undefined, 1_000_000);
    const retried = rotateIdentity(undefined, 1_000_000 + 1_000);
    assert.notEqual(retried.session, first.session, "the retry mints a new session");
    assert.notEqual(retried.project, first.project, "and a new project id");
    assert.equal(
      currentIdentity(undefined, 1_000_000 + 2_000).session,
      retried.session,
      "the pair that answered is the one the next request uses",
    );
  } finally {
    if (held === undefined) delete process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
    else process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = held;
  }
});

// The setting is read like every other one on this path: a whole number of
// milliseconds, a documented off switch at zero, and the default for anything
// that is not one.
test("the window setting is bounded, with zero as its off switch", () => {
  assert.equal(identityTTL(undefined), 60_000, "unset is a minute");
  assert.equal(identityTTL(""), 60_000, "empty is unset");
  assert.equal(identityTTL("0"), 0, "zero is the off switch, not a typo");
  assert.equal(identityTTL("1500"), 1500, "a short window is a window");
  assert.equal(identityTTL("86400000"), 86_400_000, "a day is the ceiling");
  assert.equal(identityTTL("86400001"), 60_000, "beyond it is not a window");
  assert.equal(identityTTL("-1"), 60_000, "negative is not a window");
  assert.equal(identityTTL("1.5"), 60_000, "a fraction is not a window");
  assert.equal(identityTTL("soon"), 60_000, "a word is not a window");
});

// One pair per conversation, not one pair per process. A host that runs two
// conversations at once would otherwise send both under one id, and the tier
// files what it thinks of traffic against the session: two conversations would
// share one memory, one window and one refusal.
test("each conversation holds a window of its own", () => {
  const held = process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
  process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = "60000";
  try {
    forgetIdentity();
    const one = conversationKey(new Headers({ "x-opencode-session": "conversation-one" }), {});
    const two = conversationKey(new Headers({ "x-opencode-session": "conversation-two" }), {});
    assert.notEqual(one, two, "two names are two keys");
    const a = currentIdentity(one, 1_000_000);
    const b = currentIdentity(two, 1_000_000);
    assert.notEqual(a.session, b.session, "and two pairs");
    assert.notEqual(a.project, b.project);
    // Each keeps its own across turns, and the other's activity does not move it.
    assert.equal(currentIdentity(one, 1_000_000 + 30_000).session, a.session);
    assert.equal(currentIdentity(two, 1_000_000 + 30_000).session, b.session);
    // A refusal is one conversation's business: rotating one leaves the other.
    const rotated = rotateIdentity(one, 1_000_000 + 40_000);
    assert.notEqual(rotated.session, a.session);
    assert.equal(
      currentIdentity(two, 1_000_000 + 40_000).session,
      b.session,
      "another conversation's pair is not this refusal's business",
    );
  } finally {
    if (held === undefined) delete process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
    else process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = held;
  }
});

// A request that names nothing has no key, so it shares the unnamed slot — the
// single pair this package used before the window existed. That is the limit of
// what can be told apart: two requests nothing names are two requests nothing
// can tell apart, and a pair per request would be the hop burst this window
// exists to avoid.
test("requests that name nothing share one slot", () => {
  const held = process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
  process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = "60000";
  try {
    forgetIdentity();
    assert.equal(conversationKey(new Headers(), {}), undefined, "no header, no name");
    const first = currentIdentity(undefined, 1_000_000);
    const second = currentIdentity(undefined, 1_000_000 + 1_000);
    assert.equal(second.session, first.session);
    assert.equal(second.project, first.project);
  } finally {
    if (held === undefined) delete process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS;
    else process.env.OPENCODE_ZEN_FREE_IDENTITY_TTL_MS = held;
  }
});

// The key is a name the host gave, never something read out of the content. An
// opening moves the moment a host shortens its history, and a Responses
// continuation id is new on every turn by construction; keyed by either, a
// conversation would answer a new pair every turn — the hop burst the window
// exists to avoid, arrived at by accident.
test("the opening and the continuation id are not names", () => {
  const opening = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(conversationKey(new Headers(), opening), undefined, "an opening is not a name");
  assert.equal(
    conversationKey(new Headers(), { previous_response_id: "resp_123" }),
    undefined,
    "a continuation id is not a name",
  );
  // The names the host does give are read, and read in the ladder's order.
  const named = new Headers({ "x-session-id": "conversation-x" });
  assert.equal(
    conversationKey(named, { ...opening, conversation_id: "conversation-y" }),
    conversationKey(named, opening),
    "the header wins over the body, as it does in the ladder",
  );
  assert.equal(
    conversationKey(new Headers(), { ...opening, metadata: { session_id: "conversation-z" } }),
    conversationKey(new Headers({ "session_id": "conversation-z" }), {}),
    "the same name is the same key wherever it was spelled",
  );
});
