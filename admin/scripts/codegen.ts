#!/usr/bin/env tsx
// Generate TypeScript stubs from vendored canton admin protos.
//
// Uses `grpc_tools_node_protoc` (bundled `protoc` binary from grpc-tools)
// invoking `protoc-gen-ts_proto` to emit @grpc/grpc-js-compatible service stubs.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PROTO_DIR = resolve(ROOT, "proto");
const OUT_DIR = resolve(ROOT, "src/generated");

const PROTOS = [
  "com/digitalasset/canton/admin/health/v30/status_service.proto",
  "com/digitalasset/canton/admin/sequencer/v30/sequencer_connection.proto",
  "com/digitalasset/canton/admin/time/v30/time_tracker_config.proto",
  "com/digitalasset/canton/admin/participant/v30/traffic_control_service.proto",
  "com/digitalasset/canton/admin/participant/v30/participant_status_service.proto",
  "com/digitalasset/canton/admin/participant/v30/synchronizer_connectivity_service.proto",
  "com/digitalasset/canton/admin/participant/v30/package_service.proto",
];

if (existsSync(OUT_DIR)) {
  rmSync(OUT_DIR, { recursive: true, force: true });
}
mkdirSync(OUT_DIR, { recursive: true });

const protocBin = resolve(ROOT, "node_modules/.bin/grpc_tools_node_protoc");
const tsProtoPlugin = resolve(ROOT, "node_modules/.bin/protoc-gen-ts_proto");

if (!existsSync(protocBin)) {
  console.error(`grpc_tools_node_protoc not found at ${protocBin}`);
  console.error("Run `pnpm install` first.");
  process.exit(1);
}
if (!existsSync(tsProtoPlugin)) {
  console.error(`protoc-gen-ts_proto not found at ${tsProtoPlugin}`);
  console.error("Run `pnpm install` first.");
  process.exit(1);
}

const tsProtoOpts = [
  "outputServices=grpc-js",
  "esModuleInterop=true",
  "useExactTypes=false",
  "useOptionals=messages",
  "stringEnums=true",
  "snakeToCamel=true",
  "outputClientImpl=grpc-js",
  "importSuffix=.js",
].join(",");

const args = [
  `--plugin=protoc-gen-ts_proto=${tsProtoPlugin}`,
  `--ts_proto_out=${OUT_DIR}`,
  `--ts_proto_opt=${tsProtoOpts}`,
  `--proto_path=${PROTO_DIR}`,
  ...PROTOS,
];

console.log(`Generating TypeScript stubs from ${PROTOS.length} protos...`);
try {
  execSync(`${protocBin} ${args.join(" ")}`, { stdio: "inherit" });
  console.log(`✅ Stubs written to ${OUT_DIR}`);
} catch (err) {
  console.error("Codegen failed.");
  process.exit(1);
}
