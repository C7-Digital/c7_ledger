import { EventEmitter } from "eventemitter3";
import {
  ArchiveEvent,
  CantonError,
  CreateEvent,
  Interface,
  InterfaceMapping,
  InterfaceMultiStream,
  InterfaceStream,
  MultiStream,
  Stream,
  StreamState,
  TemplateMapping,
} from "./types";
import { PackageIdString } from "./valueTypes";
import { logger } from "./logger";
import { PackageIdEmitterMap, } from "./PackageIdEmitterMap";

/**
 * Adapts a Stream instance to the MultiStream interface
 * Provides template-specific event handlers with proper typing
 */
export class MultiStreamAdapter<TM extends TemplateMapping> implements MultiStream<TM> {
  protected stream: Stream<object, unknown>;
  protected packageIdEmitters = new PackageIdEmitterMap();
  private errorEmitter: EventEmitter = new EventEmitter(); // Dedicated error emitter
  private stateEmitter: EventEmitter = new EventEmitter(); // Dedicated state emitter

  /**
   * Create a new MultiStream adapter
   * @param stream The underlying Stream instance
   */
  constructor(stream: Stream<object, unknown>) {
    this.stream = stream;

    // Set up global listeners that route events to template-specific emitters
    this.stream.on("create", this.handleCreateEvent.bind(this));
    this.stream.on("archive", this.handleArchiveEvent.bind(this));
    this.stream.on("error", this.handleError.bind(this));
    this.stream.on("state", this.handleStateEvent.bind(this));
  }

  /**
   * Get or create an EventEmitter for a specific package ID
   */
  protected getEmitterForPackageId(packageId: PackageIdString): EventEmitter {
    if (!this.packageIdEmitters.has(packageId)) {
      this.packageIdEmitters.set(packageId, new EventEmitter());
    }
    return this.packageIdEmitters.get(packageId)!;
  }

  /**
   * Handle create events from the underlying stream
   * and route them to the appropriate package ID emitter
   */
  private handleCreateEvent(event: CreateEvent<object, unknown>): void {
    const packageId = event.templateId;
    if (this.packageIdEmitters.has(packageId)) {
      this.packageIdEmitters.get(packageId)!.emit("create", event);
    } else {
      logger.warn(`Received create event for unknown template ${packageId}`);
    }
  }

  /**
   * Handle archive events from the underlying stream
   * and route them to the appropriate package ID emitter
   */
  private handleArchiveEvent(event: ArchiveEvent<object>): void {
    const packageId = event.templateId;
    if (this.packageIdEmitters.has(packageId)) {
      this.packageIdEmitters.get(packageId)!.emit("archive", event);
    } else {
      logger.warn(`Received archive event for unknown template ${packageId}`);
    }
  }

  /**
   * Handle error events from the underlying stream
   * and emit them to the dedicated error emitter
   */
  private handleError(error: CantonError): void {
    // Emit to the dedicated error emitter instead of all template emitters
    this.errorEmitter.emit("error", error);
  }

  private handleStateEvent(state: StreamState): void {
    this.stateEmitter.emit("state", state);
  }

  // MultiStream interface implementation

  onCreate<TID extends keyof TM>(
    templateId: TID,
    listener: (event: CreateEvent<TM[TID]["contractType"] & object, TM[TID]["keyType"]>) => void
  ): void {
    const emitter = this.getEmitterForPackageId(templateId as PackageIdString);
    emitter.on("create", (event: CreateEvent<object, unknown>) => {
      // Type assertion: we know the event has the correct type based on templateId
      listener(event as CreateEvent<TM[TID]["contractType"], TM[TID]["keyType"]>);
    });
  }

  onArchive<TID extends keyof TM>(
    templateId: TID,
    listener: (event: ArchiveEvent<TM[TID]["contractType"]>) => void
  ): void {
    const emitter = this.getEmitterForPackageId(templateId as PackageIdString);
    emitter.on("archive", (event: ArchiveEvent<object>) => {
      // Type assertion: we know the event has the correct type based on templateId
      listener(event as ArchiveEvent<TM[TID]["contractType"]>);
    });
  }

  onError(listener: (error: CantonError) => void): void {
    this.errorEmitter.on("error", listener);
  }

  onState(listener: (state: StreamState) => void): void {
    this.stream.on("state", listener);
  }

  offCreate<TID extends keyof TM>(
    templateId: TID,
    listener: (event: CreateEvent<TM[TID]["contractType"], TM[TID]["keyType"]>) => void
  ): void {
    if (this.packageIdEmitters.has(templateId as PackageIdString)) {
      this.packageIdEmitters.get(templateId as PackageIdString)!.off("create", listener);
    }
  }

  offArchive<TID extends keyof TM>(
    templateId: TID,
    listener: (event: ArchiveEvent<TM[TID]["contractType"]>) => void
  ): void {
    if (this.packageIdEmitters.has(templateId as PackageIdString)) {
      this.packageIdEmitters.get(templateId as PackageIdString)!.off("archive", listener);
    }
  }

  offError(listener: (error: CantonError) => void): void {
    this.errorEmitter.off("error", listener);
  }

  offState(listener: (state: StreamState) => void): void {
    this.stream.off("state", listener);
  }

  start(): void {
    this.stream.start();
  }

  state(): StreamState {
    return this.stream.state();
  }

  close(): void {
    this.stream.close();

    for (const emitter of this.packageIdEmitters.values()) {
      emitter.removeAllListeners();
    }
    this.packageIdEmitters.clear();

    // Clean up the error emitter too
    this.errorEmitter.removeAllListeners();
    this.stateEmitter.removeAllListeners();
  }

  updateToken(newToken: string): void {
    this.stream.updateToken(newToken);
  }
}

/**
 * Extends MultiStreamAdapter to add interface-specific event handling
 * Provides both template-specific and interface-specific event handlers with proper typing
 */
export class InterfaceMultiStreamImpl<IM extends InterfaceMapping> extends MultiStreamAdapter<{[K in keyof IM]: {contractType: object; keyType: unknown}}> implements InterfaceMultiStream<IM> {
  private interfaceStream: InterfaceStream<object>;

  /**
   * Create a new InterfaceMultiStream adapter
   * @param stream The underlying InterfaceStream instance
   */
  constructor(stream: InterfaceStream<object>) {
    // Pass the stream to the parent MultiStreamAdapter
    super(stream);
    this.interfaceStream = stream;

    // Set up interface-specific event listener
    this.interfaceStream.on("interfaceView", this.handleInterfaceViewEvent.bind(this));
  }

  /**
   * Handle interfaceView events from the underlying stream
   */
  private handleInterfaceViewEvent(event: Interface<object>): void {
    const interfaceId = event.interfaceId;
    if (this.packageIdEmitters.has(interfaceId)) {
      this.packageIdEmitters.get(interfaceId)!.emit("interfaceView", event);
    } else {
      logger.warn(`Received interfaceView event for unknown interface ${interfaceId}`);
    }
  }

  // InterfaceMultiStreamMethods implementation

  onInterfaceView<IID extends keyof IM>(
    interfaceId: IID,
    listener: (event: Interface<IM[IID]["contractType"]>) => void
  ): void {
    const emitter = this.getEmitterForPackageId(interfaceId as PackageIdString);
    emitter.on("interfaceView", (event: Interface<object>) => {
      listener(event as Interface<IM[IID]["contractType"]>);
    });
  }

  offInterfaceView<IID extends keyof IM>(
    interfaceId: IID,
    listener: (event: Interface<IM[IID]["contractType"]>) => void
  ): void {
    if (this.packageIdEmitters.has(interfaceId as PackageIdString)) {
      this.packageIdEmitters.get(interfaceId as PackageIdString)!.off("interfaceView", listener);
    }
  }
}
