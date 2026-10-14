import test from "node:test";
import assert from "node:assert/strict";
import { scopedNetlifyStoreName } from "../src/connections/netlify-store-scope";

test("production keeps the stable shared store name", () => {
  assert.equal(scopedNetlifyStoreName("ux-direct-plugin-bridge", { CONTEXT: "production" } as NodeJS.ProcessEnv), "ux-direct-plugin-bridge");
});
test("Deploy Preview isolates state by review ID", () => {
  assert.equal(scopedNetlifyStoreName("ux-direct-plugin-bridge", { CONTEXT: "deploy-preview", REVIEW_ID: "31" } as NodeJS.ProcessEnv), "ux-direct-plugin-bridge-preview-31");
  assert.notEqual(
    scopedNetlifyStoreName("ux-direct-plugin-bridge", { CONTEXT: "deploy-preview", REVIEW_ID: "31" } as NodeJS.ProcessEnv),
    scopedNetlifyStoreName("ux-direct-plugin-bridge", { CONTEXT: "deploy-preview", REVIEW_ID: "32" } as NodeJS.ProcessEnv),
  );
});
test("branch deploy and development stores do not reuse production keys", () => {
  assert.equal(scopedNetlifyStoreName("ux-direct-connection-status", { CONTEXT: "branch-deploy", BRANCH: "feature/ux-preview" } as NodeJS.ProcessEnv), "ux-direct-connection-status-branch-feature-ux-preview");
  assert.equal(scopedNetlifyStoreName("ux-direct-connection-status", { CONTEXT: "dev" } as NodeJS.ProcessEnv), "ux-direct-connection-status-dev");
});
test("scoped store names fit Netlify's 64-byte store name limit", () => {
  const name = scopedNetlifyStoreName("x".repeat(63), { CONTEXT: "deploy-preview", REVIEW_ID: "123456789012345" } as NodeJS.ProcessEnv);
  assert.ok(Buffer.byteLength(name, "utf8") <= 64);
});
