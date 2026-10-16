import type { Plugin } from "vite";
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Build-only evidence; the web server denies .vite and the browser never fetches this graph. */
export function loadingEvidencePlugin(): Plugin {
  let sourceRoot = "";
  const normalized = (value: string) => value.replaceAll("\\", "/");
  function moduleId(value: string) {
    const id = normalized(value);
    const dependency = id.lastIndexOf("/node_modules/");
    if (dependency >= 0) return id.slice(dependency + 1);
    return id.startsWith(sourceRoot + "/") ? id.slice(sourceRoot.length + 1) : id;
  }
  return {
    name: "gather-production-loading-graph",
    apply: "build",
    configResolved(config) { sourceRoot = normalized(config.root); },
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(item => item.type === "chunk").map(item => ({
        file: item.fileName,
        imports: item.imports,
        dynamicImports: item.dynamicImports,
        isEntry: item.isEntry,
        isDynamicEntry: item.isDynamicEntry,
        facadeModule: item.facadeModuleId ? moduleId(item.facadeModuleId) : null,
        modules: Object.keys(item.modules).map(moduleId).sort(),
      }));
      const modules = [...this.getModuleIds()].map(id => {
        const info = this.getModuleInfo(id);
        return { id: moduleId(id), imports: (info?.importedIds ?? []).map(moduleId).sort(),
          dynamicImports: (info?.dynamicallyImportedIds ?? []).map(moduleId).sort() };
      });
      const assets = Object.values(bundle).filter(item => /\.(?:js|css)$/.test(item.fileName)).map(item => {
        const bytes = item.type === "chunk" ? Buffer.from(item.code) : Buffer.from(item.source);
        return { file: item.fileName, type: item.fileName.endsWith(".js") ? "js" : "css",
          rawBytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length,
          sha256: createHash("sha256").update(bytes).digest("hex") };
      });
      this.emitFile({ type: "asset", fileName: ".vite/loading-graph.json", source: JSON.stringify({
        schemaVersion: 1, chunks: chunks.sort((a, b) => a.file.localeCompare(b.file)),
        modules: modules.sort((a, b) => a.id.localeCompare(b.id)), assets,
      }) });
    },
    writeBundle: {
      order: "post",
      handler(options, bundle) {
        // Vite's later HTML/preload and CSS hooks may finalize emitted bytes after generateBundle.
        // Read the real files so normal Docker metadata describes exactly what nginx serves.
        const directory = options.dir!;
        const metadata = path.join(directory, ".vite/loading-graph.json");
        const graph = JSON.parse(readFileSync(metadata, "utf8"));
        graph.assets = Object.values(bundle).filter(item => /\.(?:js|css)$/.test(item.fileName)).map(item => {
          const bytes = readFileSync(path.join(directory, item.fileName));
          return { file: item.fileName, type: item.fileName.endsWith(".js") ? "js" : "css",
            rawBytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length,
            sha256: createHash("sha256").update(bytes).digest("hex") };
        });
        writeFileSync(metadata, JSON.stringify(graph));
      },
    },
  };
}
