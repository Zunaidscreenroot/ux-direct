import assert from "node:assert/strict";
import test from "node:test";
import { netlifyDeploymentScope } from "../src/netlify/deployment-scope";

test("uses a stable production scope only for production", () => {
  assert.equal(netlifyDeploymentScope({ CONTEXT: "production" }), "production");
  assert.equal(netlifyDeploymentScope({ CONTEXT: "branch-deploy", BRANCH: "main" }), "branch-main");
});

test("isolates preview state by branch", () => {
  assert.equal(netlifyDeploymentScope({ CONTEXT: "deploy-preview", BRANCH: "feat/plugin-preview" }), "branch-feat-plugin-preview");
});
