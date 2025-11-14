import { EventEmitter } from "eventemitter3";
import {
  ArchiveEvent,
  CantonError,
  CreateEvent,
  MultiStream,
  Stream,
  StreamState,
  TemplateMapping,
} from "./types";
import { PackageIdString } from "./valueTypes";
import { logger } from "./logger";
import { TemplateEmitterMap } from "./TemplateEmitterMap";

/**
 * Adapts a Stream instance to the MultiStream interface
 * Provides template-specific event handlers with proper typing
 */
export class MultiStreamAdapter<TM extends TemplateMapping> implements MultiStream<TM> {
  private stream: Stream<object, unknown>;
  private templateEmitters = new TemplateEmitterMap();
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
   * Get or create an EventEmitter for a specific template
   */
  private getEmitterForTemplate(templateId: PackageIdString): EventEmitter {
    if (!this.templateEmitters.has(templateId)) {
      this.templateEmitters.set(templateId, new EventEmitter());
    }
    return this.templateEmitters.get(templateId)!;
  }

  /**
   * Handle create events from the underlying stream
   * and route them to the appropriate template emitter
   */
  private handleCreateEvent(event: CreateEvent<object, unknown>): void {
    const templateId = event.templateId;
    if (this.templateEmitters.has(templateId)) {
      this.templateEmitters.get(templateId)!.emit("create", event);
    } else {
      logger.warn(`Received create event for unknown template ${templateId}`);
    }
  }

  /**
   * Handle archive events from the underlying stream
   * and route them to the appropriate template emitter
   */
  private handleArchiveEvent(event: ArchiveEvent<object>): void {
    const templateId = event.templateId;
    if (this.templateEmitters.has(templateId)) {
      this.templateEmitters.get(templateId)!.emit("archive", event);
    } else {
      logger.warn(`Received archive event for unknown template ${templateId}`);
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
    const emitter = this.getEmitterForTemplate(templateId as PackageIdString);
    emitter.on("create", (event: CreateEvent<object, unknown>) => {
      // Type assertion: we know the event has the correct type based on templateId
      listener(event as CreateEvent<TM[TID]["contractType"], TM[TID]["keyType"]>);
    });
  }

  onArchive<TID extends keyof TM>(
    templateId: TID,
    listener: (event: ArchiveEvent<TM[TID]["contractType"]>) => void
  ): void {
    const emitter = this.getEmitterForTemplate(templateId as PackageIdString);
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
    if (this.templateEmitters.has(templateId as PackageIdString)) {
      this.templateEmitters.get(templateId as PackageIdString)!.off("create", listener);
    }
  }

  offArchive<TID extends keyof TM>(
    templateId: TID,
    listener: (event: ArchiveEvent<TM[TID]["contractType"]>) => void
  ): void {
    if (this.templateEmitters.has(templateId as PackageIdString)) {
      this.templateEmitters.get(templateId as PackageIdString)!.off("archive", listener);
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

    for (const emitter of this.templateEmitters.values()) {
      emitter.removeAllListeners();
    }
    this.templateEmitters.clear();

    // Clean up the error emitter too
    this.errorEmitter.removeAllListeners();
    this.stateEmitter.removeAllListeners();
  }
}
