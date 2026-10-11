import test from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_FIGMA_FILE_KEY, isAllowedFigmaFileKey, authorizeFigmaFile, assertFigmaFileAccess, parseAllowedFileIds } from "../src/security/figma-access";

test("empty allowlist denies all access", () => {
  assert.deepEqual(authorizeFigmaFile("file-a", "zunaid_workspace", { allowedFileIds: [] }), {
    allowed: false, reason: "allowlist_empty",
  });
});

test("parses allowlist with trimming and de-duplication", () => {
  assert.deepEqual(parseAllowedFileIds(" abc, file-2,abc ,, file-2 "), ["abc", "file-2"]);
});

test("allows only an explicitly listed file in the approved workspace", () => {
  assert.equal(authorizeFigmaFile("file-a", "zunaid_workspace", { allowedFileIds: ["file-a"] }).allowed, true);
  assert.deepEqual(authorizeFigmaFile("file-b", "zunaid_workspace", { allowedFileIds: ["file-a"] }), {
    allowed: false, reason: "file_not_allowlisted",
  });
});

test("denies a listed file if workspace label mismatches", () => {
  assert.deepEqual(authorizeFigmaFile("file-a", "company-other", { allowedFileIds: ["file-a"] }), {
    allowed: false, reason: "workspace_mismatch",
  });
});

test("assertion throws for denied access", () => {
  assert.throws(() => assertFigmaFileAccess("file-a", "zunaid_workspace", { allowedFileIds: [] }), /Figma access denied/);
});


test("only the exact Zunaid_Workspace file key is accepted by the API allowlist", () => {
  assert.equal(isAllowedFigmaFileKey(ALLOWED_FIGMA_FILE_KEY), true);
  assert.equal(isAllowedFigmaFileKey("another-client-file-key"), false);
  assert.equal(isAllowedFigmaFileKey(undefined), false);
});
