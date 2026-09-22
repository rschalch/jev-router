import test from "node:test";
import assert from "node:assert/strict";
import { LruMap } from "../src/lru.mjs";

test("holds no more than its limit, evicting the oldest", () => {
  const map = new LruMap(2);
  map.set("a", 1).set("b", 2).set("c", 3);
  assert.deepEqual([...map.keys()], ["b", "c"]);
});

test("reading an entry protects it from eviction", () => {
  const map = new LruMap(2);
  map.set("main", 1).set("sub-1", 2);
  assert.equal(map.get("main"), 1);
  map.set("sub-2", 3);
  assert.deepEqual([...map.keys()], ["main", "sub-2"]);
});

test("replacing an entry neither evicts another nor grows the map", () => {
  const map = new LruMap(2);
  map.set("a", 1).set("b", 2).set("a", 3);
  assert.deepEqual([...map.entries()], [["b", 2], ["a", 3]]);
});

test("a miss returns undefined and changes nothing", () => {
  const map = new LruMap(2);
  map.set("a", 1);
  assert.equal(map.get("missing"), undefined);
  assert.deepEqual([...map.keys()], ["a"]);
});
