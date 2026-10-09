import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportPrivateMaps } from "./private-source-maps.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "private-map-test-"));
try {
  const pub = path.join(root, "public"),
    priv = path.join(root, "private");
  for (const name of ["assets/app.js", "mcp/widget.js"]) {
    const file = path.join(pub, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'throw Error("synthetic");');
    fs.writeFileSync(
      file + ".map",
      JSON.stringify({
        sources: ["example.ts"],
        sourcesContent: ['throw Error("synthetic");'],
        mappings: "AAAA",
      }),
    );
  }
  assert.throws(
    () => exportPrivateMaps(pub, path.join(pub, "maps"), "test"),
    /outside/,
  );
  const manifest = exportPrivateMaps(pub, priv, "test");
  assert.equal(Object.keys(manifest.files).length, 2);
  assert.equal(fs.existsSync(path.join(pub, "mcp/widget.js.map")), false);
  assert.equal(
    fs.readFileSync(path.join(pub, "assets/app.js"), "utf8"),
    fs.readFileSync(path.join(priv, "assets/app.js"), "utf8"),
  );
  assert.throws(() => exportPrivateMaps(pub, priv, "test"), /ENOENT/);
  console.log("PASS private frontend/widget maps and public boundary");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
