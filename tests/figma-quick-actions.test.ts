/* eslint-disable @typescript-eslint/no-explicit-any -- sandboxed plugin code is untyped. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const code = readFileSync(join(process.cwd(), "figma-plugin/code.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(process.cwd(), "figma-plugin/manifest.json"), "utf8"));

function boot(fileKey: string) {
  const handlers: Record<string, (event: any) => any> = {};
  let input: ((event: any) => void) | null = null;
  const posted: any[] = [];
  const shown: number[] = [];
  const figma: any = {
    fileKey, currentPage: { id: "0:1", type: "PAGE", name: "Page", children: [], selection: [], findOne: () => null }, root: { children: [] }, mixed: Symbol("m"),
    ui: { postMessage: (m: any) => posted.push(m), onmessage: null }, showUI() { shown.push(1); }, closePlugin() {}, commitUndo() {},
    on(name: string, fn: (event: any) => any) { handlers[name] = fn; },
    parameters: { on(name: string, fn: (event: any) => void) { if (name === "input") input = fn; } },
    clientStorage: { store: {} as Record<string, unknown>, async getAsync(k: string) { return this.store[k]; }, async setAsync(k: string, v: unknown) { this.store[k] = v; } },
  };
  runInNewContext(code, { figma, __html__: "", console, atob, btoa, Promise, Map, Set, Symbol, Uint8Array, setTimeout, clearTimeout });
  return { figma, handlers, posted, shown, input: () => input };
}

test("manifest exposes a freeform Cmd+/ task parameter and still opens normally", () => {
  assert.equal(manifest.parameterOnly, false);
  assert.deepEqual(manifest.parameters.map((p: any) => [p.key, p.allowFreeform]), [["prompt", true]]);
});

test("quick action: suggestions filter, the typed task reaches the panel once it is ready", async () => {
  const key = /UXD_ALLOWED_FILE_KEY = "([^"]+)"/.exec(code)![1];
  const { figma, handlers, posted, shown, input } = boot(key);
  assert.equal(shown.length, 0, "no showUI at load: Figma may be in query mode (Cmd+/ parameter box)");
  let suggestions: string[] = [];
  input()!({ key: "prompt", query: "hyg", result: { setSuggestions: (list: string[]) => { suggestions = list; } } });
  assert.deepEqual(JSON.parse(JSON.stringify(suggestions)), ["fix hygiene", "check hygiene"]);

  await handlers.run({ command: "", parameters: { prompt: "  fix hygiene  " } });
  assert.equal(shown.length, 1, "the panel opens once the task is entered");
  assert.equal(posted.filter((m) => m.type === "uxd-quick-action").length, 0, "waits for the panel to load");
  await figma.ui.onmessage({ type: "get-selection" });
  assert.deepEqual(JSON.parse(JSON.stringify(posted.filter((m) => m.type === "uxd-quick-action").map((m) => [m.prompt, m.autoRun]))), [["fix hygiene", true]]);
  await figma.ui.onmessage({ type: "get-selection" });
  assert.equal(posted.filter((m) => m.type === "uxd-quick-action").length, 1, "delivered once");
  await handlers.run({ command: "", parameters: undefined });
  assert.equal(posted.filter((m) => m.type === "uxd-quick-action").length, 1, "a normal launch sends nothing");
});

test("quick action is ignored outside the allowed file", () => {
  const { handlers, posted } = boot("someOtherFile");
  handlers.run({ command: "", parameters: { prompt: "fix hygiene" } });
  assert.equal(posted.filter((m) => m.type === "uxd-quick-action").length, 0);
});

test("a replayed quick action (same task as last time) is prefilled, not run; a new task runs", async () => {
  const key = /UXD_ALLOWED_FILE_KEY = "([^"]+)"/.exec(code)![1];
  const { figma, handlers, posted } = boot(key);
  await handlers.run({ command: "", parameters: { prompt: "fix hygiene" } });
  await figma.ui.onmessage({ type: "get-selection" });
  await handlers.run({ command: "", parameters: { prompt: "Fix hygiene" } });
  await handlers.run({ command: "", parameters: { prompt: "add icons to these buttons" } });
  const sent = posted.filter((m) => m.type === "uxd-quick-action").map((m) => [m.prompt, m.autoRun]);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [["fix hygiene", true], ["Fix hygiene", false], ["add icons to these buttons", true]]);
});
