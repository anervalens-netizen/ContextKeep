import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { projects, records } from "../src/db/schema.js";
import { buildSearchProfile, search } from "../src/services/search.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const old = "2024-01-01T00:00:00.000Z";
const recent = "2026-05-19T00:00:00.000Z";
const apps: TestApp[] = [];
afterEach(async () => {
  for (const t of apps.splice(0)) await t.cleanup();
});

async function fixture() {
  const t = await makeTestApp({ adapters: "manual" });
  apps.push(t);
  const projectId = randomUUID();
  t.app.ck.deps.db.insert(projects).values({
    id: projectId, name: "Synthetic release continuity", createdAt: old, updatedAt: old,
  }).run();
  const add = (overrides: Partial<typeof records.$inferInsert> = {}) => {
    const id = randomUUID();
    t.app.ck.deps.db.insert(records).values({
      id, projectId, type: "fact", subject: "Beacon release", predicate: "status",
      text: "Beacon current release revision deployment verification steps",
      reviewStatus: "accepted", evidenceBasis: "document", recordDedupHash: id,
      recordedAt: old, sourceEventAt: recent, createdAt: old, updatedAt: old,
      ...overrides,
    }).run();
    return id;
  };
  return { t, projectId, add };
}

describe("ME-17 Romanian latest-query continuity", () => {
  it.each([
    ["Ultima revizie Beacon", "latest revision Beacon"],
    ["ULTIMUL release Beacon", "latest release Beacon"],
    ["Ultimele verificări Beacon", "latest verification Beacon"],
    ["Ultimii pași Beacon", "latest steps Beacon"],
  ])("prefers dated evidence over a stronger unsafe match for %s", async (q, english) => {
    const { t, projectId, add } = await fixture();
    const valid = add();
    const decoy = { subject: q, text: `${q}. ${english}. Beacon current status.` };
    const future = add({ ...decoy, subject: `${q} future`, sourceEventAt: "2099-01-01T00:00:00.000Z" });
    const undated = add({ ...decoy, subject: `${q} undated`, sourceEventAt: null, recordedAt: recent });
    const expired = add({ ...decoy, subject: `${q} expired`, sourceEventAt: old, effectiveTo: "2025-01-01T00:00:00.000Z" });
    const overdue = add({ ...decoy, subject: `${q} overdue`, volatile: 1, reviewDueAt: "2025-01-01T00:00:00.000Z" });

    for (const query of [english, q]) {
      const result = search(t.app.ck.deps, { q: query, projectId, mode: "canonical", limit: 10 });
      expect(result.records[0]?.id, query).toBe(valid);
      expect(result.records[0]?.temporal?.currentAdjustment).toBe(12);
      expect(result.records.find((r) => r.id === future)?.temporal?.eligibility).toBe("future");
      expect(result.records.find((r) => r.id === undated)?.temporal?.eligibility).toBe("unknown");
      expect(result.records.find((r) => r.id === expired)?.temporal?.eligibility).toBe("expired");
      expect(result.records.find((r) => r.id === overdue)?.temporal?.currentAdjustment).toBe(-24);
    }
  });

  it.each([
    "what is currently running on 8080",
    "current service on 3000",
    "current service from 8080",
    "current service in 3082",
    "current service before 8080",
    "current service after 3000",
    "current service on 3082",
    "serviciu curent la 3082",
    "current service on 2024",
    "serviciu curent la 2024",
    "ce rulează la 3082",
    "ultima revizie Beacon la 3082",
  ])("keeps current port queries ahead of superseded decoys for %s", async (q) => {
    const { t, projectId, add } = await fixture();
    const port = q.match(/\d{4}/)![0];
    const valid = add({ text: `Beacon current service running on ${port}` });
    const superseded = add({
      subject: q, text: `${q}. Beacon current service runtime status.`,
      reviewStatus: "superseded", sourceEventAt: old,
    });
    const result = search(t.app.ck.deps, { q, projectId, includeHistorical: true, limit: 10 });
    expect(result.records[0]?.id).toBe(valid);
    expect(result.ranking.intent).toBe("current");
    expect(result.records.find((r) => r.id === superseded)?.reviewStatus).toBe("superseded");
    expect(buildSearchProfile(q)).toMatchObject({ currentIntent: true, historicalIntent: false });
  });

  it("keeps project, authority and explicit history boundaries", async () => {
    const { t, projectId, add } = await fixture();
    const accepted = add();
    const proposed = add({ reviewStatus: "proposed", evidenceBasis: "agent_report" });
    const superseded = add({ reviewStatus: "superseded", sourceEventAt: old });
    const foreignProject = randomUUID();
    t.app.ck.deps.db.insert(projects).values({
      id: foreignProject, name: "Other synthetic project", createdAt: old, updatedAt: old,
    }).run();
    add({ projectId: foreignProject, text: "Ultima revizie Beacon latest current release revision" });
    const result = search(t.app.ck.deps, {
      q: "ultima revizie Beacon", projectId, scope: "all", mode: "canonical", limit: 10,
    });
    expect(result.records.map((r) => r.id)).toEqual([accepted]);
    expect(result.workingRecords.map((r) => r.id)).toEqual([proposed]);
    expect(result.workingRecords[0]?.reviewStatus).toBe("proposed");
    expect(result.workingRecords[0]?.evidenceBasis).toBe("agent_report");
    expect([...result.records, ...result.workingRecords].every((r) => r.projectId === projectId)).toBe(true);
    const history = search(t.app.ck.deps, {
      q: "ultima revizie Beacon", projectId, includeHistorical: true, limit: 10,
    });
    expect(history.records[0]?.id).toBe(accepted);
    expect(history.records.find((r) => r.id === superseded)?.reviewStatus).toBe("superseded");
  });

  it.each([
    "ultimul release Beacon înainte de 2024-02-01",
    "ultimul release Beacon inainte de 2024-02-01",
    "care era ultima revizie Beacon la 1 ianuarie 2024",
    "ultima revizie Beacon din 2024",
    "ultima revizie Beacon la 2024-01-02",
    "latest Beacon release as of 2024-01-02",
    "ultima revizie Beacon din ianuarie 2024",
    "ultima revizie Beacon la 2 ianuarie 2024",
    "latest Beacon release on January 2, 2024",
    "latest Beacon release in 2024",
    "latest Beacon release as of 2024",
    "ultima revizie Beacon la data de 2024",
    "latest Beacon release in the year 1880",
    "ultima revizie Beacon din anul 1880",
    "ultima revizie Beacon la data de 1880",
    "latest Beacon release as of 1880",
    "latest Beacon release on 2024-01-02",
    "ultima revizie Beacon la data de 2024-01-02",
    "latest Beacon release in 2026-05-19T00:00:00.000Z",
    "latest Beacon release on 2026-05-19T00:00:00.000Z",
    "ultima revizie Beacon la 2026-05-19T03:00:00.000+03:00",
    "latest Beacon release in 2026-05-19T00:00:00-04:00",
  ])("preserves historical intent and provenance for %s", async (q) => {
    const { t, projectId, add } = await fixture();
    add();
    const superseded = add({ reviewStatus: "superseded", sourceEventAt: old });
    const result = search(t.app.ck.deps, { q, projectId, includeHistorical: true, limit: 10 });
    expect(buildSearchProfile(q).historicalIntent).toBe(true);
    expect(result.records[0]?.id).toBe(superseded);
    expect(result.records[0]?.reviewStatus).toBe("superseded");
    expect(result.records[0]?.temporal?.currentAdjustment).toBe(0);
    expect(search(t.app.ck.deps, { q, projectId }).records.some((r) => r.id === superseded)).toBe(false);
  });

  it("requires explicit year context outside the conservative inference range", () => {
    for (const year of [1899, 2100]) {
      expect(buildSearchProfile(`current release in ${year}`)).toMatchObject({
        currentIntent: true, historicalIntent: false,
      });
      expect(buildSearchProfile(`latest release in the year ${year}`)).toMatchObject({
        currentIntent: false, historicalIntent: true,
      });
    }
    for (const year of [1900, 2099]) {
      expect(buildSearchProfile(`latest release in ${year}`)).toMatchObject({
        currentIntent: false, historicalIntent: true,
      });
    }
  });

  it("preserves explicitly mixed intent and does not treat version numbers as calendar clauses", () => {
    expect(buildSearchProfile("care era ultima revizie Beacon din 2024 și ce este acum")).toMatchObject({
      currentIntent: true, historicalIntent: true,
    });
    expect(buildSearchProfile("what was running in 2024 and what is currently running on 8080")).toMatchObject({
      currentIntent: true, historicalIntent: true,
    });
    for (const q of [
      "ultima revizie Beacon 2024.1", "latest Beacon release from 2024.1",
      "current service on 2024.1", "serviciu curent la 2024.1",
    ]) {
      expect(buildSearchProfile(q)).toMatchObject({ currentIntent: true, historicalIntent: false });
    }
  });
});
