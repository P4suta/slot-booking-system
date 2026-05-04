import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    benchmark: {
      include: ["test/**/*.bench.ts"],
      reporters: ["default"],
    },
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/index.ts",
        "src/**/*.d.ts",
        // Type-only files — declarations / discriminated-union types only.
        "src/domain/booking/Booking.ts",
        "src/domain/booking/Command.ts",
        "src/domain/events/BookingEvent.ts",
        "src/domain/entities/Closure.ts",
        "src/domain/entities/Resource.ts",
      ],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
})
