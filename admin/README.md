# @c7-digital/admin

TypeScript client for the Canton **participant admin** gRPC API.

This package wraps a small, read-only subset of the Canton admin API:

| Service | RPC | Purpose |
|---|---|---|
| `ParticipantStatusService` | `ParticipantStatus` | Health + version |
| `TrafficControlService` | `TrafficControlState` | Real-time traffic budget state |
| `PackageService` | `ListPackages` | DAR/package inventory and metadata |

Synchronizer ID for `TrafficControlState` is supplied by the caller — typically
read from `canton.conf`, the node operator, or AmuletRules via Scan.

The admin API runs on a separate port from the JSON Ledger API
(typically `5002`) and uses
**gRPC** rather than HTTP/JSON. Production deployments require TLS and
admin-token auth; both are supported via the `tls` and `token` config
fields.

## Usage

```ts
import { AdminClient } from "@c7-digital/admin";

const admin = new AdminClient({ endpoint: "localhost:5002" });

const status = await admin.getParticipantStatus();
const traffic = await admin.getTrafficControlState(synchronizerId);
console.log(`Base traffic remaining: ${traffic.trafficState?.baseTrafficRemainder} bytes`);

await admin.close();
```

## Production deployment

```ts
import { readFileSync } from "node:fs";

const admin = new AdminClient({
  endpoint: "participant.example.com:5002",
  tls: {
    ca: readFileSync("/etc/canton/ca.crt"),
    cert: readFileSync("/etc/canton/client.crt"),
    key: readFileSync("/etc/canton/client.key"),
  },
  token: process.env.CANTON_ADMIN_TOKEN,
});
```

## Vendored protos

This package vendors a small subset of Canton's admin protos under `proto/`.
See `proto/VENDORED.md` for the upstream commit pin and refresh procedure.
