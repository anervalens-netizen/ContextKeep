// Exercise the shipped IIFE in a real, sandboxed browser without Node globals.
// The host is synthetic; this is not a claim of live ChatGPT rendering.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { z } from "zod";
import { registerWorkflowTools } from "../../server/dist/mcp/workflow-tools.js";
import { registerDossierTools } from "../../server/dist/mcp/dossier-tools.js";

// Consume the server's actual published contracts. Zod parsing alone would
// insert defaults and hide arguments missing at the host validation boundary.
const taskInputs = {};
registerWorkflowTools((name, _description, schema) => {
  if (["list_tasks", "get_task"].includes(name))
    taskInputs[name] = z.toJSONSchema(schema, { target: "draft-7" });
}, {});
registerDossierTools(
  (name, _description, schema) => {
    taskInputs[name] = z.toJSONSchema(schema, { target: "draft-7" });
  },
  {},
  () => ({ actor: "test" }),
);

const dist = process.env.CK_MCP_DIST
  ? new URL("file://" + process.env.CK_MCP_DIST.replace(/\/$/, "") + "/")
  : new URL("../dist/mcp/", import.meta.url);
const js = await readFile(new URL("widget.js", dist), "utf8");
const css = await readFile(new URL("widget.css", dist), "utf8");
const html =
  "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'\"><style>" +
  css +
  '</style></head><body><div id="root"></div><script>' +
  js.replace(/<\/script/gi, "<\\/script") +
  "</script></body></html>";
const options = { headless: true, timeout: 15000 };
let browser;
if (process.env.CK_NAV_EXECUTABLE_PATH) {
  browser = await chromium.launch({
    ...options,
    executablePath: process.env.CK_NAV_EXECUTABLE_PATH,
  });
} else {
  browser = await chromium
    .launch({ ...options, channel: "chrome" })
    .catch(() => chromium.launch(options));
}
const cases = [];
try {
  for (const mode of ["global", "contextual", "hydrated", "stale", "fullscreen", "fullscreen-refused", "english", "pending", "rejected"]) {
    const page = await browser.newPage();
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.evaluate(
      ({ html, mode, taskInputs }) => {
        const frame = document.createElement("iframe");
        frame.id = "app";
        frame.setAttribute("sandbox", "allow-scripts");
        frame.style.cssText = "width:100%;height:900px;border:0";
        window.calls = [];
        const preferences={landingView:"recent",taskVisibility:"actual_tasks",contextBudget:"balanced",refreshInterval:"manual",language:mode==="english"?"en":"ro"};
            const task = {
              id: "demo-task",
              subject: "Synthetic task",
              taskStatus: "open",
              effectiveState: "in_progress",
              stateSource: "reported_progress",
              reviewStatus: "proposed",
              revision: 1,
            };
            const dossier = {
              projectId: "demo-project",
              taskId: "demo-task",
              title: "Synthetic task",
              objective: "Verify the synthetic result",
              taskRevision: 1,
              state: "in_progress",
              stateSource: "reported_progress",
              summary: "Synthetic verification is ready",
              nextAction: "Inspect the existing synthetic artifact",
              ownerAction: null,
              progress: null,
              lastReported: {
                recordId: "report-a",
                recordedAt: "2026-01-01T00:00:00.000Z",
                reviewStatus: "proposed",
                evidenceBasis: "agent_report",
              },
              execution: null,
              blockers: { activeCount: 0 },
              continuation: {
                policy: null,
                activeSubscriptions: 0,
                ready: false,
              },
              warnings: [],
              stateToken: "synthetic-state-1",
            };
            const project = {
              id: "demo-project",
              name: "Demo project",
              lifecycle: "active",
            };
            const results = {
              "settings.read":{values:preferences},
              get_project_dossier: {
                project,
                goals: [],
                tasks: [],
                pagination: { total: 1, nextOffset: null },
                historicalUnscopedCheckpoints: 0,
                links: { items: [] },
              },
              get_portfolio: {
                items: [
                  { ...project, taskCount: 1, tasks: [], moreTasks: false },
                ],
                total: 1,
                nextOffset: null,
              },
              resume_task: {
                dossier,
                resumeText:
                  "Resume synthetic task: inspect the existing artifact; do not restart its job.",
                startsExecution: false,
              },
              get_operational_timeline: {
                items: [],
                total: 0,
                nextOffset: null,
              },
              list_projects: {
                projects: [{ id: "demo-project", name: "Demo project" }],
                nextOffset: null,
              },
              list_tasks: { items: [task], nextOffset: null },
              get_task: {
                task,
                dossier,
                latestCheckpoint: null,
                blockers: { active: [] },
                runs: [],
                records: [],
                pagination: { nextOffset: null },
              },
            };

        window.addEventListener("message", (event) => {
          if (
            event.source !== frame.contentWindow ||
            event.data?.jsonrpc !== "2.0"
          )
            return;
          const message = event.data;
          const send = (value) =>
            frame.contentWindow.postMessage({ jsonrpc: "2.0", ...value }, "*");
          if (message.method === "ui/initialize") {
            window.calls.push({ name: "ui/initialize" });
            if (mode === "pending") return;
            if (mode === "rejected") {
              send({
                id: message.id,
                error: {
                  code: -32603,
                  message: "Synthetic initialization failure",
                },
              });
              return;
            }
            send({
              id: message.id,
              result: {
                protocolVersion: message.params.protocolVersion,
                hostInfo: { name: "Synthetic UI host", version: "1.0.0" },
                hostCapabilities: { serverTools: {} },
                hostContext: { theme: "light", displayMode: mode.startsWith("fullscreen") ? "inline" : "fullscreen", ...(mode.startsWith("fullscreen") ? {availableDisplayModes:["inline","fullscreen"]}: {}) },
              },
            });
          } else if (
            message.method === "ui/notifications/initialized" &&
            ["contextual", "global", "hydrated", "stale", "fullscreen", "fullscreen-refused", "english"].includes(mode)
          ) {
            send({
              method: "ui/notifications/tool-result",
              params: {
                content: [],
                structuredContent: mode !== "global" ? {
                  projectId: "demo-project",
                  taskId: "demo-task",
                  revision: 1,
                  ...(["hydrated", "stale"].includes(mode) ? {bootstrap:{version:1,preferences,observedAt:new Date(Date.now()-(mode==="stale"?60000:0)).toISOString(),reads:[
                    {tool:"list_projects",arguments:{offset:0,limit:50},value:results.list_projects},
                    {tool:"list_tasks",arguments:{projectId:"demo-project",offset:0,limit:50,selection:"actual_tasks",view:"recent"},value:results.list_tasks},
                    {tool:"get_task",arguments:{projectId:"demo-project",taskId:"demo-task",offset:0,limit:20},value:results.get_task},
                    {tool:"get_operational_timeline",arguments:{projectId:"demo-project",taskId:"demo-task",offset:0,limit:20,scope:"all"},value:results.get_operational_timeline},
                  ]}}:{}),
                } : {},
              },
            });
          } else if (message.method === "ui/request-display-mode") {
            window.calls.push({name:message.method,args:message.params});
            if(mode==="fullscreen-refused") send({id:message.id,error:{code:-32603,message:"Synthetic host refusal"}});
            else send({id:message.id,result:{mode:"fullscreen"}});
            send({method:"ui/notifications/host-context-changed",params:{displayMode:"inline",availableDisplayModes:["inline","fullscreen"]}});
          } else if (message.method === "tools/call") {
            const { name, arguments: args } = message.params;
            window.calls.push({ name, args });
            const missing = (taskInputs[name]?.required ?? []).filter(
              (key) => !Object.hasOwn(args, key),
            );
            if (missing.length) {
              send({
                id: message.id,
                error: {
                  code: -32602,
                  message:
                    "Missing required tool arguments: " + missing.join(", "),
                },
              });
              return;
            }
            if (!(name in results)) {
              send({
                id: message.id,
                error: { code: -32601, message: "Unexpected tool" },
              });
            } else {
              send({
                id: message.id,
                result: { content: [], structuredContent: results[name] },
              });
            }
          }
        });
        document.body.appendChild(frame);
        frame.srcdoc = html;
      },
      { html, mode, taskInputs },
    );
    const app = page.frameLocator("#app");
    try {
      if (mode === "pending") {
        await app
          .getByRole("status")
          .filter({ hasText: "Se conectează" })
          .waitFor();
        assert.deepEqual(
          await page.evaluate(() => window.calls.map((c) => c.name)),
          ["ui/initialize"],
        );
      } else if (mode === "rejected") {
        await app.getByRole("alert").waitFor();
        assert.match(await app.getByRole("alert").innerText(), /conecta/i);
      } else {
        await app.getByRole("heading", { name: mode==="english"?"Task dossier":"Dosarul taskului" }).waitFor();
        await app
          .getByRole("option", { name: "Demo project", exact: true })
          .waitFor({ state: "attached" });
        if (mode === "global") {
          assert.equal(
            await app.getByLabel(mode==="english"?"Project":"Proiect", { exact: true }).inputValue(),
            "",
          );
          await app
            .getByLabel(mode==="english"?"Project":"Proiect", { exact: true })
            .selectOption("demo-project");
          await app
            .getByRole("option", { name: "Synthetic task · in_progress · proposed", exact: true })
            .waitFor({ state: "attached" });
          await app
            .getByLabel("Task", { exact: true })
            .selectOption("demo-task");
        }
        await app
          .getByRole("heading", { name: mode==="english"?"Executions":"Execuții", exact: true })
          .waitFor();
        assert.equal(
          await app.getByLabel(mode==="english"?"Project":"Proiect", { exact: true }).inputValue(),
          "demo-project",
        );
        assert.equal(
          await app.getByLabel("Task", { exact: true }).inputValue(),
          "demo-task",
        );
        await app
          .getByRole("heading", { name: mode==="english"?"What matters now":"Ce contează acum", exact: true })
          .waitFor();
        await app
          .getByRole("button", { name: mode==="english"?"Resume work":"Reia lucrarea", exact: true })
          .click();
        await app.getByLabel(mode==="english"?"Resume context":"Context de reluare", { exact: true }).waitFor();
        assert.match(
          await app.getByLabel(mode==="english"?"Resume context":"Context de reluare").inputValue(),
          /do not restart/,
        );
        const frameElement = page.frames().find((f) => f.parentFrame());
        assert.equal(
          await frameElement.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          true,
        );
        const calls = await page.evaluate(() => window.calls);
        assert.equal(
          calls.some(c => c.name === "get_task" && c.args.projectId === "demo-project" && c.args.taskId === "demo-task"),
          mode !== "hydrated",
        );
        if(mode === "hydrated") assert.deepEqual(calls.map(c=>c.name),["ui/initialize","resume_task"]);
        else assert.equal(calls.filter(c=>c.name==="settings.read").length,1,"one preferences read before data fallback");
        assert.equal(calls.filter(c=>c.name==="ui/request-display-mode").length,mode.startsWith("fullscreen")?1:0);
        assert.ok(
          calls.every((c) =>
            [
              "ui/initialize",
              "ui/request-display-mode",
              "settings.read",
              "list_projects",
              "list_tasks",
              "get_task",
              "get_project_dossier",
              "get_portfolio",
              "resume_task",
              "get_operational_timeline",
            ].includes(c.name),
          ),
        );
      }
      assert.deepEqual(errors, [], "Browser exceptions in shipped widget");
      const frame = page.frames().find((f) => f.parentFrame());
      assert.equal(
        await frame.evaluate(() => typeof globalThis.process),
        "undefined",
      );
      cases.push({ mode, status: "PASS" });
    } catch (error) {
      throw new Error(
        mode +
          ": " +
          error.message +
          "; browser errors=" +
          JSON.stringify(errors),
        { cause: error },
      );
    } finally {
      await page.close();
    }
  }
  console.log(
    JSON.stringify({ status: "PASS", bundle: fileURLToPath(dist), cases }),
  );
} finally {
  await browser.close();
}
