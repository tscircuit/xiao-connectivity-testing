import assert from "node:assert/strict";
import test from "node:test";
import { parseDataRecord } from "../app/serial-parser.ts";

test("accepts a complete four-DUT DATA record", () => {
  const parsed = parseDataRecord("DATA,1234,0,65535,42");
  assert.equal(parsed.kind, "valid");
  if (parsed.kind === "valid") {
    assert.deepEqual(parsed.values, [1234, 0, 65535, 42]);
    assert.equal(parsed.record, "DATA,1234,0,65535,42");
  }
});

test("rejects a record with a truncated trailing field", () => {
  // Number("") is 0, so a truncated record must not become a phantom
  // zero reading. Serial noise drops bytes like this in practice.
  const parsed = parseDataRecord("DATA,1234,0,65535,");
  assert.equal(parsed.kind, "invalid");
});

test("rejects a record with an empty middle field", () => {
  const parsed = parseDataRecord("DATA,1234,,65535,42");
  assert.equal(parsed.kind, "invalid");
});

test("rejects a record with too few fields", () => {
  assert.equal(parseDataRecord("DATA,1,2,3").kind, "invalid");
});

test("rejects a record with too many fields", () => {
  assert.equal(parseDataRecord("DATA,1,2,3,4,5").kind, "invalid");
});

test("rejects a record with non-numeric fields", () => {
  assert.equal(parseDataRecord("DATA,1,x,3,4").kind, "invalid");
  assert.equal(parseDataRecord("DATA,1,2.5,3,4").kind, "invalid");
});

test("returns none for lines without a DATA record", () => {
  assert.equal(parseDataRecord("MPY: soft reboot").kind, "none");
  assert.equal(parseDataRecord("").kind, "none");
});

test("finds DATA records after REPL echo noise", () => {
  const parsed = parseDataRecord(">>>DATA,1,2,3,4");
  assert.equal(parsed.kind, "valid");
});
