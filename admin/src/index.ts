export { AdminClient, type AdminClientConfig, type AdminTlsConfig } from "./client.js";

// Re-export the wire types so consumers don't have to reach into ./generated/
export type {
  TrafficControlStateRequest,
  TrafficControlStateResponse,
  TrafficState,
} from "./generated/com/digitalasset/canton/admin/participant/v30/traffic_control_service.js";

export type {
  ParticipantStatusRequest,
  ParticipantStatusResponse,
} from "./generated/com/digitalasset/canton/admin/participant/v30/participant_status_service.js";

export type {
  ListConnectedSynchronizersRequest,
  ListConnectedSynchronizersResponse,
  ListConnectedSynchronizersResponse_Result,
  GetSynchronizerIdRequest,
  GetSynchronizerIdResponse,
} from "./generated/com/digitalasset/canton/admin/participant/v30/synchronizer_connectivity_service.js";

export type {
  ListPackagesRequest,
  ListPackagesResponse,
  PackageDescription,
} from "./generated/com/digitalasset/canton/admin/participant/v30/package_service.js";
