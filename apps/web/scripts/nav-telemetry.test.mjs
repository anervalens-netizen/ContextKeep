import assert from "node:assert/strict";
import { test } from "node:test";
import { envelopeMatcher } from "./nav-telemetry.mjs";
const match = envelopeMatcher("https://synthetic-key@example.invalid/prefix/42");
const request = (url, method = "POST", resource = "fetch") => ({ url: () => url, method: () => method, resourceType: () => resource });
test("only the configured Sentry envelope is fulfilled locally", () => {
  const exact = "https://example.invalid/prefix/api/42/envelope/?sentry_key=synthetic-key&sentry_version=7";
  assert.equal(match(request(exact)), true);
  assert.equal(match(request(exact, "GET")), false);
  assert.equal(match(request(exact, "POST", "script")), false);
  assert.equal(match(request(exact.replace("example.invalid", "other.invalid"))), false);
  assert.equal(match(request(exact.replace("/42/", "/43/"))), false);
  assert.equal(match(request(exact.replace("synthetic-key", "other"))), false);
  assert.equal(envelopeMatcher(undefined)(request(exact)), false);
});
