import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const hash = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const walk = (root) =>
  fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? walk(path.join(root, e.name))
        : [path.join(root, e.name)],
    );
export function exportPrivateMaps(publicRoot, privateRoot, release) {
  publicRoot = path.resolve(publicRoot);
  privateRoot = path.resolve(privateRoot);
  if (
    privateRoot === publicRoot ||
    privateRoot.startsWith(publicRoot + path.sep)
  )
    throw Error("Maps must be outside the served root");
  const scripts = walk(publicRoot).filter(
    (f) =>
      f.endsWith(".js") &&
      (f.includes(path.sep + "assets" + path.sep) ||
        f.endsWith(path.sep + "mcp" + path.sep + "widget.js")),
  );
  if (!scripts.length) throw Error("No release scripts");
  // Rolldown emits this compiler-only helper without a source map. Its exact
  // generated text is the source of an identity map, never claimed as app TS.
  const generated = [];
  for (const file of scripts) {
    if (
      !fs.existsSync(file + ".map") &&
      /^rolldown-runtime-[A-Za-z0-9_-]+\.js$/.test(path.basename(file))
    ) {
      const text = fs.readFileSync(file, "utf8");
      fs.writeFileSync(
        file + ".map",
        JSON.stringify({
          version: 3,
          file: path.basename(file),
          sources: ["generated/" + path.basename(file)],
          sourcesContent: [text],
          names: [],
          mappings: text
            .split("\n")
            .map((_, i) => (i ? "AACA" : "AAAA"))
            .join(";"),
        }),
      );
      generated.push(path.relative(publicRoot, file));
    }
  }
  // Validate the entire build before moving any maps.
  for (const file of scripts) {
    const map = JSON.parse(fs.readFileSync(file + ".map", "utf8"));
    if (!map.sources?.length || !map.sourcesContent?.length)
      throw Error("Missing source contents");
    if (fs.readFileSync(file, "utf8").includes("sourceMappingURL="))
      throw Error("Maps must be hidden");
  }
  fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  const files = {};
  for (const file of scripts) {
    const relative = path.relative(publicRoot, file);
    const target = path.join(privateRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(file, target);
    fs.renameSync(file + ".map", target + ".map");
    files[relative] = { js: hash(file), map: hash(target + ".map") };
  }
  if (walk(publicRoot).some((f) => f.endsWith(".map")))
    throw Error("Public source maps remain");
  const manifest = { release, files, generatedSources: generated };
  fs.writeFileSync(
    path.join(privateRoot, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(publicRoot, "release.json"),
    JSON.stringify({ release }),
  );
  return manifest;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  exportPrivateMaps(
    process.argv[2] ?? "apps/web/dist",
    process.argv[3] ?? "artifacts/private-source-maps",
    process.env.VITE_RELEASE ?? "development",
  );
}
