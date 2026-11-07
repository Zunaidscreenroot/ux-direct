/* eslint-disable @typescript-eslint/no-explicit-any -- extracted plugin function is untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");
const match = /\/\/ uxd-free-spot:start([\s\S]*?)\/\/ uxd-free-spot:end/.exec(ui);
assert.ok(match, "free-spot markers exist");
const sandbox: Record<string, any> = {};
runInNewContext(match[1] + "\nthis.fn = pickFreeCanvasSpot;", sandbox);
const pick: (boxes: any[], x: number, y: number, w: number, h: number) => { x: number; y: number } = sandbox.fn;

const overlaps = (a: any, b: any) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test("free spot never lands on a tall existing frame low on the page (finding 67)", () => {
  // Column of frames down to y≈10.5k, and the row is full to the right: the old search clamped y to 9500.
  const boxes: any[] = [{ x: 460, y: 9286, width: 360, height: 1225 }];
  for (let i = 0; i < 70; i++) boxes.push({ x: 960 + i * 460, y: 9286, width: 360, height: 1225 });
  const spot = pick(boxes, 460, 9286, 360, 1400);
  const box = { x: spot.x, y: spot.y, width: 360, height: 1400 };
  for (const b of boxes) assert.equal(overlaps(box, b), false, JSON.stringify({ spot, b }));
  assert.ok(spot.y >= 9286 + 1225, "dropped below the occupied row");
});

test("free spot moves right past a frame whose full height covers the start point", () => {
  const boxes = [{ x: 460, y: 6000, width: 360, height: 4000 }];
  const spot = pick(boxes, 460, 9500, 360, 800);
  assert.equal(spot.y, 9500);
  assert.ok(spot.x >= 460 + 360 + 100);
});
