import { describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers.js";

describe("CK-A04 authenticated data provenance", () => {
  it("marks private GET responses as live-network and non-cacheable", async () => {
    const t = await makeTestApp();
    try {
      const requestId = "a04-live-request-12345678";
      const response = await t.app.inject({
        method: "GET",
        url: "/api/projects",
        headers: {
          cookie: t.cookie,
          "x-contextkeep-request-id": requestId,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-contextkeep-data-source"]).toBe("network-v1");
      expect(response.headers["x-contextkeep-response-id"]).toBe(requestId);
      const fetchedAt = response.headers["x-contextkeep-fetched-at"];
      expect(typeof fetchedAt).toBe("string");
      expect(Number.isFinite(Date.parse(String(fetchedAt)))).toBe(true);
      expect(String(response.headers["cache-control"])).toContain("no-store");
    } finally {
      await t.cleanup();
    }
  });
});
