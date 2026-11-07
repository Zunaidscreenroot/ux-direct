/* eslint-disable @typescript-eslint/no-explicit-any -- sandboxed plugin UI code is untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const ui = readFileSync(join(process.cwd(), "figma-plugin/ui.html"), "utf8");

function stopBlock() {
  const match = /\/\/ uxd-stop-task:start([\s\S]*?)\/\/ uxd-stop-task:end/.exec(ui);
  assert.ok(match, "stop markers exist");
  const calls: any[] = [];
  const window: any = { fetch: async (url: string, options: any) => { calls.push({ url, options }); return { ok: true }; } };
  const sandbox: any = { window, AbortController, Promise, Error, Object, String };
  runInNewContext("let isSending = false;" + match[1] +
    "\nthis.api = { requestStop, throwIfStopped, isStopError, start: function () { isSending = true; stopRequested = false; activeAbort = new AbortController(); }, abort: function () { return activeAbort; } };", sandbox);
  return { api: sandbox.api, window, calls };
}

test("stop aborts in-flight requests and blocks further canvas changes, but not undo or cleanup", async () => {
  const { api, window, calls } = stopBlock();
  api.start();
  await window.fetch("https://x/api", { method: "POST" });
  const signal = calls[0].options.signal;
  assert.equal(signal.aborted, false, "a running task's fetch carries the task signal");
  api.requestStop();
  assert.equal(signal.aborted, true, "stop aborts the in-flight request");
  await assert.rejects(window.fetch("https://x/api", {}), /Stopped by you/);
  assert.throws(() => api.throwIfStopped("write-canvas"), /Stopped by you/);
  assert.throws(() => api.throwIfStopped("apply-hygiene-fixes"), /Stopped by you/);
  assert.doesNotThrow(() => api.throwIfStopped("delete-created"), "cleanup of partial output still runs");
  assert.doesNotThrow(() => api.throwIfStopped("trigger-undo"));
  assert.equal(api.isStopError(new Error("The operation was aborted.")), true);
});

test("the stop button is wired into the composer and the submit lifecycle", () => {
  assert.match(ui, /<button id="stop" class="send stop" type="button"[^>]*hidden>/);
  assert.match(ui, /\$\("stop"\)\.addEventListener\("click", function \(event\) \{ event\.preventDefault\(\); requestStop\(\); \}\);/);
  assert.match(ui, /if \(isStopError\(error\)\) \{/);
  assert.match(ui, /\$\("stop"\)\.hidden = true;\n\s+\$\("send"\)\.hidden = false;/, "finally restores the send button");
});
