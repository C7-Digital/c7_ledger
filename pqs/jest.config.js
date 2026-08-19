export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.ts", "**/?(*.)+(spec|test).ts"],
  extensionsToTreatAsEsm: [".ts"],
  // Source imports carry the `.js` extension ESM requires; strip it so jest
  // resolves the `.ts` file.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: true,
      },
    ],
  },
  modulePathIgnorePatterns: ["<rootDir>/lib/"],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.test.ts"],
};
