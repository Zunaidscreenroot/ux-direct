import { test } from "node:test";
import assert from "node:assert/strict";
import { auditImageSchema } from "../src/figma-agent/audit-input";

test("UX audit accepts a full-resolution phone screen capture (360x926 at ~1400px)", () => {
  // A 1400px-side JPEG from captureRenderedNodePreview is typically 150–600 KB of base64.
  const capture = "data:image/jpeg;base64," + "A".repeat(600_000);
  assert.equal(auditImageSchema.safeParse(capture).success, true);
  assert.equal(auditImageSchema.safeParse("data:image/jpeg;base64," + "A".repeat(2_000_000)).success, false, "still bounded");
});
