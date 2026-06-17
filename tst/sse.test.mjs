import test from "node:test";
import assert from "node:assert/strict";
import {
  SseAccumulator,
  pickCompletionDelta,
  pickResponsesDelta,
  OffshoreError,
} from "../dist/client.js";

test("reassembles completion deltas split across chunk boundaries", () => {
  const acc = new SseAccumulator(pickCompletionDelta);
  // One frame is split mid-token; another is split mid-JSON.
  acc.push('data: {"choices":[{"delta":{"content":"Hel');
  acc.push('lo"}}]}\n\ndata: {"choices":[{"delta":{"con');
  const done = acc.push('tent":" world"}}]}\n\ndata: [DONE]\n\n');
  assert.equal(acc.text, "Hello world");
  assert.equal(done, true);
});

test("ignores keep-alive comments and non-data lines", () => {
  const acc = new SseAccumulator(pickCompletionDelta);
  acc.push(': keep-alive\n\nevent: ping\n\ndata: {"choices":[{"delta":{"content":"x"}}]}\n\n');
  assert.equal(acc.text, "x");
});

test("throws OffshoreError on an inline error frame", () => {
  const acc = new SseAccumulator(pickCompletionDelta);
  assert.throws(() => acc.push('data: {"error":{"message":"boom"}}\n\n'), OffshoreError);
});

test("extracts Responses API output_text deltas and ignores other event types", () => {
  const acc = new SseAccumulator(pickResponsesDelta);
  acc.push('data: {"type":"response.output_text.delta","delta":"a"}\n');
  acc.push('data: {"type":"response.created"}\n');
  acc.push('data: {"type":"response.output_text.delta","delta":"b"}\n');
  acc.push("data: [DONE]\n");
  assert.equal(acc.text, "ab");
});
