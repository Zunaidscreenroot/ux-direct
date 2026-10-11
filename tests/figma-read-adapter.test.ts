import test from "node:test";
import assert from "node:assert/strict";
import { FigmaReadAdapter, summarizeFigmaNode } from "../src/figma/read-adapter";

test("Figma adapter denies an empty allowlist before network access", async () => {
  let calls = 0;
  const adapter = new FigmaReadAdapter({
    accessToken: "test-token",
    allowedFileIdsRaw: "",
    workspaceLabel: "zunaid_workspace",
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ document: {} }), { status: 200 });
    },
  });
  await assert.rejects(adapter.readFile("file-a"), /allowlist_empty/);
  assert.equal(calls, 0);
});

test("Figma adapter reads only the explicitly allowed file with GET", async () => {
  let calls = 0;
  const adapter = new FigmaReadAdapter({
    accessToken: "test-token",
    allowedFileIdsRaw: "file-a",
    workspaceLabel: "zunaid_workspace",
    apiBaseUrl: "https://figma.test/v1",
    fetchImpl: async (input, init) => {
      calls += 1;
      assert.equal(String(input), "https://figma.test/v1/files/file-a?depth=4");
      assert.equal(init?.method, "GET");
      assert.equal((init?.headers as Record<string, string>)["X-Figma-Token"], "test-token");
      return new Response(JSON.stringify({ document: { id: "0:1", name: "Root" }, components: {} }), { status: 200 });
    },
  });
  const result = await adapter.readFile("file-a");
  assert.equal(calls, 1);
  assert.equal(result.readOnly, true);
  await assert.rejects(adapter.readFile("file-b"), /file_not_allowlisted/);
  assert.equal(calls, 1);
});

test("Figma adapter fails closed when token is missing", async () => {
  let calls = 0;
  const adapter = new FigmaReadAdapter({
    accessToken: "",
    allowedFileIdsRaw: "file-a",
    workspaceLabel: "zunaid_workspace",
    fetchImpl: async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
  });
  await assert.rejects(adapter.readFile("file-a"), /token is not configured/);
  assert.equal(calls, 0);
});

test("node summary preserves source IDs and visible layout metadata", () => {
  assert.deepEqual(summarizeFigmaNode({
    id: "10:2", name: "Heading", type: "TEXT", characters: "Hello",
    absoluteBoundingBox: { x: 10, y: 20, width: 100, height: 24 },
    children: [],
  }), {
    id: "10:2", name: "Heading", type: "TEXT", text: "Hello",
    bounds: { x: 10, y: 20, width: 100, height: 24 }, childCount: 0,
  });
});
