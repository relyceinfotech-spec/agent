import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const configModuleUrl = new URL("../src/config.ts", import.meta.url).href;

function loadConfig(overrides: Record<string, string>) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import ${JSON.stringify(configModuleUrl)};`,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...overrides },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

describe("semantic memory runtime configuration", () => {
  it("rejects embedding dimensions that do not match the Supabase vector column", () => {
    const result = loadConfig({ EMBEDDING_DIMENSIONS: "768" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("1536-dimensional research.max_user_memories vector column");
  });

  it("rejects a memory text cap larger than the database constraint", () => {
    const result = loadConfig({ MEMORY_MAX_TEXT_CHARS: "2001" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MEMORY_MAX_TEXT_CHARS");
  });
});
