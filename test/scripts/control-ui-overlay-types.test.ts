import path from "node:path";
import { expect, it } from "vitest";
import { createNativeTypeScriptProject } from "../../scripts/lib/native-typescript.mts";

it("types overlay admission without loading the modal renderer", () => {
  const owner = createNativeTypeScriptProject({
    cwd: process.cwd(),
    configFileName: "overlay-registry-typing.json",
    files: {
      "overlay-registry-typing.json": JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          lib: ["es2023", "dom", "dom.iterable"],
          module: "esnext",
          moduleResolution: "bundler",
          allowImportingTsExtensions: true,
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          types: [],
        },
        files: ["ui/src/components/overlay-registry.ts"],
        include: [],
      }),
    },
  });
  try {
    expect(owner.project.program.getSemanticDiagnostics()).toEqual([]);
    expect(owner.project.program.getSourceFileNames()).not.toContain(
      path.resolve("ui/src/components/modal-dialog.ts").split(path.sep).join("/"),
    );
  } finally {
    owner.close();
  }
});
