export default {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.ts", "**/?(*.)+(spec|test).ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest"],
  },
  modulePathIgnorePatterns: ["<rootDir>/lib/"],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.test.ts", "!src/generated/**"],
};
