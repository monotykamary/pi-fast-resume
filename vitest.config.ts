import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    exclude: ["node_modules", "dist", ".idea", ".git", ".cache"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "**/*.d.ts", "**/*.test.ts", "**/*.bench.ts"],
    },
  },
  // `vitest bench` discovers bench files via its default glob
  // (**/*.{bench,benchmark}.*); `vitest run` only uses test.include above, so
  // __tests__/perf.bench.ts is benchmark-only and never runs as a test.
});
