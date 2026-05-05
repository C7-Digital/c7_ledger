# Vendored Canton Admin API Protos

This directory contains a copy of selected Canton participant admin API protos
used by `@c7-digital/admin`.

## Source

Upstream: https://github.com/digital-asset/canton
Pinned commit: `df0ed749f` (2026-04-22)
Source path: `community/admin-api/src/main/protobuf/com/digitalasset/canton/admin/`

## Files

Direct services we wrap:
- `participant/v30/traffic_control_service.proto`
- `participant/v30/participant_status_service.proto`
- `participant/v30/package_service.proto`

Transitively required by the above:
- `health/v30/status_service.proto`
- `time/v30/time_tracker_config.proto`

## Modifications

None — files are copied verbatim from upstream.

## Refresh

To update to a newer Canton version:

1. Bump the canton submodule pointer (`git -C canton checkout <new-commit>`)
2. Re-copy each proto file listed above from the canton submodule into this
   directory, preserving paths
3. Update the `Pinned commit` line above
4. Re-run `pnpm -F @c7-digital/admin codegen` to regenerate TypeScript stubs
