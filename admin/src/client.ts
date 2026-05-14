import {
  ChannelCredentials,
  Metadata,
  type ClientUnaryCall,
  type ServiceError,
} from "@grpc/grpc-js";

import {
  TrafficControlServiceClient,
  type TrafficControlStateRequest,
  type TrafficControlStateResponse,
} from "./generated/com/digitalasset/canton/admin/participant/v30/traffic_control_service.js";

import {
  ParticipantStatusServiceClient,
  type ParticipantStatusRequest,
  type ParticipantStatusResponse,
} from "./generated/com/digitalasset/canton/admin/participant/v30/participant_status_service.js";

import {
  PackageServiceClient,
  type ListPackagesRequest,
  type ListPackagesResponse,
} from "./generated/com/digitalasset/canton/admin/participant/v30/package_service.js";

/**
 * TLS configuration for the admin gRPC connection.
 *
 * - `"insecure"` — plaintext H2C, suitable for Docker-network-scoped admin
 *   ports during development. Refused by production deployments that require
 *   TLS.
 * - `{ ... }` — channel credentials with optional CA bundle, client cert, and
 *   client key. The CA bundle is required when connecting to a participant
 *   whose certificate is not in the system trust store.
 */
export type AdminTlsConfig =
  | "insecure"
  | {
      ca?: Buffer;
      cert?: Buffer;
      key?: Buffer;
    };

export interface AdminClientConfig {
  /**
   * gRPC endpoint of the participant admin API, e.g. `localhost:5002`.
   * No scheme — gRPC channel target uses host:port.
   */
  endpoint: string;
  /**
   * TLS configuration. Defaults to `"insecure"` to match local Docker
   * deployments. Production deployments should pass channel credentials.
   */
  tls?: AdminTlsConfig;
  /**
   * Optional bearer token for admin-token-auth deployments. Sent in the
   * `authorization` metadata header on every RPC.
   */
  token?: string;
  /**
   * Per-RPC deadline in milliseconds. Defaults to 5000.
   */
  defaultDeadlineMs?: number;
}

/**
 * Strongly-typed client for the Canton participant admin gRPC API.
 *
 * Wraps the canton-vendored protos with promise-based methods. All RPCs are
 * read-only in this version; mutations (synchronizer connect/disconnect,
 * DAR upload/vet, etc.) are intentionally not exposed.
 *
 * Usage:
 *
 * ```ts
 * const admin = new AdminClient({ endpoint: "localhost:5002" });
 * const status = await admin.getParticipantStatus();
 * const traffic = await admin.getTrafficControlState(synchronizerId);
 * await admin.close();
 * ```
 */
export class AdminClient {
  private readonly traffic: TrafficControlServiceClient;
  private readonly status: ParticipantStatusServiceClient;
  private readonly packages: PackageServiceClient;
  private readonly defaultDeadlineMs: number;
  private readonly token?: string;

  constructor(config: AdminClientConfig) {
    const credentials = AdminClient.buildCredentials(config.tls ?? "insecure");
    this.token = config.token;
    this.defaultDeadlineMs = config.defaultDeadlineMs ?? 5000;

    this.traffic = new TrafficControlServiceClient(config.endpoint, credentials);
    this.status = new ParticipantStatusServiceClient(config.endpoint, credentials);
    this.packages = new PackageServiceClient(config.endpoint, credentials);
  }

  private static buildCredentials(tls: AdminTlsConfig): ChannelCredentials {
    if (tls === "insecure") {
      return ChannelCredentials.createInsecure();
    }
    return ChannelCredentials.createSsl(tls.ca, tls.key, tls.cert);
  }

  private buildMetadata(): Metadata {
    const md = new Metadata();
    if (this.token) {
      md.set("authorization", `Bearer ${this.token}`);
    }
    return md;
  }

  private deadline(): Date {
    return new Date(Date.now() + this.defaultDeadlineMs);
  }

  /**
   * Get the participant's status (uptime, version, active warnings).
   */
  async getParticipantStatus(): Promise<ParticipantStatusResponse> {
    const request: ParticipantStatusRequest = {};
    return this.unaryCall((cb) =>
      this.status.participantStatus(request, this.buildMetadata(), { deadline: this.deadline() }, cb),
    );
  }

  /**
   * Get the participant's current traffic budget state on the given
   * synchronizer. Returns base-rate remainder, extra-traffic purchased and
   * consumed totals, and the timestamp the snapshot is valid for.
   *
   * This is the authoritative real-time signal the orchestrator polls to
   * keep its BudgetTracker reconciled against ground truth.
   */
  async getTrafficControlState(synchronizerId: string): Promise<TrafficControlStateResponse> {
    const request: TrafficControlStateRequest = { synchronizerId };
    return this.unaryCall((cb) =>
      this.traffic.trafficControlState(request, this.buildMetadata(), { deadline: this.deadline() }, cb),
    );
  }

  /**
   * List DAR packages currently vetted on this participant.
   * @param opts.limit Maximum number of packages to return; 0 means unlimited.
   * @param opts.filterName Substring filter on the package name; empty means no filter.
   */
  async listPackages(opts?: { limit?: number; filterName?: string }): Promise<ListPackagesResponse> {
    const request: ListPackagesRequest = {
      limit: opts?.limit ?? 0,
      filterName: opts?.filterName ?? "",
    };
    return this.unaryCall((cb) =>
      this.packages.listPackages(request, this.buildMetadata(), { deadline: this.deadline() }, cb),
    );
  }

  /**
   * Close all gRPC channels held by this client. After close, methods will
   * fail. Safe to call multiple times.
   */
  async close(): Promise<void> {
    this.traffic.close();
    this.status.close();
    this.packages.close();
  }

  /**
   * Promise-wrap a callback-style unary gRPC call.
   * Type parameter inferred from the callback signature.
   */
  private unaryCall<T>(
    invoker: (cb: (err: ServiceError | null, response: T) => void) => ClientUnaryCall,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      invoker((err, response) => {
        if (err) {
          reject(err);
        } else {
          resolve(response);
        }
      });
    });
  }
}
