// Exercise the shipped IIFE in a real, sandboxed browser without Node globals.
// The host is synthetic; this is not a claim of live ChatGPT rendering.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { z } from "zod";
import { registerWorkflowTools } from "../../server/dist/mcp/workflow-tools.js";

// Consume the server's actual published contracts. Zod parsing alone would
// insert defaults and hide arguments missing at the host validation boundary.
const taskInputs = {};
registerWorkflowTools((name, _description, schema) => {
  if (["list_tasks", "get_task"].includes(name))
    taskInputs[name] = z.toJSONSchema(schema, { target: "draft-7" });
}, {});

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
  for (const mode of ["global", "contextual", "pending", "rejected"]) {
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
                hostContext: { theme: "light", displayMode: "fullscreen" },
              },
            });
          } else if (
            message.method === "ui/notifications/initialized" &&
            mode === "contextual"
          ) {
            send({
              method: "ui/notifications/tool-result",
              params: {
                content: [],
                structuredContent: {
                  projectId: "demo-project",
                  taskId: "demo-task",
                  revision: 1,
                },
              },
            });
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
            const task = {
              id: "demo-task",
              subject: "Synthetic task",
              taskStatus: "open",
              reviewStatus: "proposed",
              revision: 1,
            };
            const results = {
              list_projects: {
                projects: [{ id: "demo-project", name: "Demo project" }],
                nextOffset: null,
              },
              list_tasks: { items: [task], nextOffset: null },
              get_task: {
                task,
                latestCheckpoint: null,
                blockers: { active: [] },
                runs: [],
                records: [],
                pagination: { nextOffset: null },
              },
            };
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
          .filter({ hasText: "Connecting" })
          .waitFor();
        assert.deepEqual(
          await page.evaluate(() => window.calls.map((c) => c.name)),
          ["ui/initialize"],
        );
      } else if (mode === "rejected") {
        await app.getByRole("alert").waitFor();
        assert.match(await app.getByRole("alert").innerText(), /connect/i);
      } else {
        await app.getByRole("heading", { name: "Task dossier" }).waitFor();
        await app
          .getByRole("option", { name: "Demo project", exact: true })
          .waitFor({ state: "attached" });
        if (mode === "global") {
          assert.equal(
            await app.getByLabel("Project", { exact: true }).inputValue(),
            "",
          );
          await app
            .getByLabel("Project", { exact: true })
            .selectOption("demo-project");
          await app
            .getByRole("option", { name: "Synthetic task · proposed" })
            .waitFor({ state: "attached" });
          await app
            .getByLabel("Task", { exact: true })
            .selectOption("demo-task");
        }
        await app
          .getByRole("heading", { name: "Executions", exact: true })
          .waitFor();
        assert.equal(
          await app.getByLabel("Project", { exact: true }).inputValue(),
          "demo-project",
        );
        assert.equal(
          await app.getByLabel("Task", { exact: true }).inputValue(),
          "demo-task",
        );
        const calls = await page.evaluate(() => window.calls);
        assert.ok(
          calls.some(
            (c) =>
              c.name === "get_task" &&
              c.args.projectId === "demo-project" &&
              c.args.taskId === "demo-task",
          ),
        );
        assert.ok(
          calls.every((c) =>
            [
              "ui/initialize",
              "list_projects",
              "list_tasks",
              "get_task",
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
