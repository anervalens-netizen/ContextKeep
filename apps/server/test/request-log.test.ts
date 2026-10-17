import { expect, it } from "vitest";
import { requestLogFields } from "../src/lib/request-log.js";
it("categorizes clients without recording query credentials or arbitrary header content", () => {
  const result = requestLogFields({ id: "synthetic", method: "GET", url: "/api/projects?token=private-fixture",
    headers: { "user-agent": "python-requests/synthetic-private", authorization: "Bearer secret-fixture", cookie: "session=private-cookie" } });
  expect(result).toEqual({ id: "synthetic", method: "GET", url: "/api/projects", clientKind: "python", hasAuthorization: true, hasCookie: true });
  expect(JSON.stringify(result)).not.toMatch(/secret-fixture|private-fixture|synthetic-private|private-cookie/);
  expect(requestLogFields({ headers: { "user-agent": "private-arbitrary-agent" } }).clientKind).toBe("unknown");
});
