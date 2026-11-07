import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CANVAS_CLAIM_NOTE, createCanvasClaimGuard, detectCanvasEditClaim } from "../src/figma-agent/chat-claim-guard";

async function run(frames: string[]): Promise<string> {
  const enc = new TextEncoder();
  const src = new ReadableStream<Uint8Array>({ start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); } });
  return await new Response(src.pipeThrough(createCanvasClaimGuard())).text();
}
const delta = (content: string) => "data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + "\n\n";

describe("canvas claim guard", () => {
  it("flags invented edit claims", () => {
    assert.equal(detectCanvasEditClaim("Filled 4 value(s) in 4 text layers:\n- 12 Mar → 15 Apr"), true);
    assert.equal(detectCanvasEditClaim("Done! I've updated the button colour to blue."), true);
    assert.equal(detectCanvasEditClaim("The shadow has been applied to the selected frame."), true);
  });
  it("leaves suggestions and negations alone", () => {
    assert.equal(detectCanvasEditClaim("I can't change the canvas from chat. You could update the button colour."), false);
    assert.equal(detectCanvasEditClaim("Try renaming the layers to match the screen."), false);
    assert.equal(detectCanvasEditClaim("A good empty state has a heading and one action."), false);
  });
  it("appends the note before [DONE]", async () => {
    const out = await run([delta("Filled 4 values"), delta(" in 4 text layers."), "data: [DONE]\n\n"]);
    const note = out.indexOf(JSON.stringify(CANVAS_CLAIM_NOTE).slice(1, 20));
    assert.ok(note > 0);
    assert.ok(out.indexOf("[DONE]") > note);
  });
  it("passes clean answers through unchanged", async () => {
    const frames = [delta("Use 16px padding."), "data: [DONE]\n\n"];
    const out = await run(frames);
    assert.ok(!out.includes("can't edit the canvas"));
    assert.ok(out.includes("[DONE]"));
  });
});
