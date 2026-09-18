import { SessionStateError } from '../core/errors';
import { log } from '../core/logger';
import type { SessionConnectTimings } from '../core/state';
import {
  decodeInbound,
  EnvelopeReassembler,
  type RealtimeClientMessage,
  type RealtimeInboundMessage,
} from './envelope';
import { describeFetchFailure } from './fetch_failure';
import {
  parseRetryAfter,
  parseSessionStartErrorDetail,
  sessionStartErrorFrom,
  SessionStartError,
} from './session_start_error';
import type {
  RealtimeCloseInfo,
  RealtimeConnectOptions,
  RealtimeTransport,
  RpcInvocation,
  Unsubscribe,
} from './types';
import type { SessionStartTimings } from '../protocol';

type WebSocketStart = {
  session_id: string;
  ws_url: string;
  ws_subprotocol: string;
  timings?: SessionStartTimings;
};

type AudioFormat = {
  type: 'ws-audio-format';
  input_sample_rate_hz: number;
  output_sample_rate_hz: number;
  num_channels: 1;
};

type RpcRequest = {
  type: 'rpc-request';
  request_id: string;
  method: string;
  payload: string;
};

type RpcCancel = { type: 'rpc-cancel'; request_id: string };

const INPUT_BUFFER_SIZE = 2048;
const AUDIO_PREAMBLE_TIMEOUT_MS = 30_000;
const RPC_ERROR_MAX_CHARS = 512;

const CLEAN_CLOSE_CODES = new Set([1000, 1001, 1005]);

export class WebSocketTransport implements RealtimeTransport {
  private socket: WebSocket | null = null;
  private connectController: AbortController | null = null;
  private lifetimeController: AbortController | null = null;
  private connected = false;
  private closing = false;
  private inputRate = 0;
  private outputRate = 0;
  private microphoneStream: MediaStream | null = null;
  private callerStream: MediaStream | null = null;
  private inputStream: MediaStream | null = null;
  private inputContext: AudioContext | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputProcessor: ScriptProcessorNode | null = null;
  private inputSilencer: GainNode | null = null;
  private readonly inputResampler = new Pcm16Resampler();
  private outputContext: AudioContext | null = null;
  private outputDestination: MediaStreamAudioDestinationNode | null = null;
  private outputStream: MediaStream | null = null;
  private outputElement: HTMLAudioElement | null = null;
  private hostAudioElement: HTMLAudioElement | null = null;
  private onOutputBlocked: ((blocked: boolean) => void) | null = null;
  private outputBlocked = false;
  private nextPlaybackAt = 0;
  private muted = false;
  private inputGeneration = 0;
  private microphoneRequest: {
    promise: Promise<MediaStream>;
    signal?: AbortSignal;
  } | null = null;
  private readonly playing = new Set<AudioBufferSourceNode>();
  private readonly reassembler = new EnvelopeReassembler();
  private readonly rpcMethods = new Map<
    string,
    (invocation: RpcInvocation) => Promise<string>
  >();
  private readonly activeRpc = new Map<string, AbortController>();
  private readonly messageListeners = new Set<(message: RealtimeInboundMessage) => void>();
  private readonly closeListeners = new Set<(info?: RealtimeCloseInfo) => void>();
  private readonly outputStreamListeners = new Set<() => void>();

  async connect(options: RealtimeConnectOptions): Promise<void> {
    if (this.socket !== null || this.connectController !== null) return;
    const controller = new AbortController();
    this.connectController = controller;
    this.lifetimeController = controller;
    this.onOutputBlocked = options.onOutputBlocked ?? null;
    this.outputBlocked = false;
    this.closing = false;
    const initialInputGeneration = options.publishMicrophone === false
      ? null
      : ++this.inputGeneration;
    const startedAt = performance.now();
    try {
      const started = await this.startSession(options, controller.signal);
      controller.signal.throwIfAborted();
      const startDoneAt = performance.now();
      try {
        options.onSessionStarted?.(started.session_id);
      } catch (error) {
        log.error('[websocket-transport] onSessionStarted callback threw', error);
      }
      controller.signal.throwIfAborted();
      await this.openSocket(started, controller.signal);
      controller.signal.throwIfAborted();
      const socketDoneAt = performance.now();
      if (initialInputGeneration !== null) {
        await this.acquireMicrophone(controller.signal, initialInputGeneration);
      }
      controller.signal.throwIfAborted();
      const readyAt = performance.now();
      const timings: SessionConnectTimings = {
        wsMs: startDoneAt - startedAt,
        roomMs: 0,
        micMs: options.publishMicrophone === false ? 0 : readyAt - socketDoneAt,
        totalConnectMs: readyAt - startedAt,
        readyMs: null,
        serverTimings: started.timings ?? null,
      };
      options.onConnectTimings?.(timings, startedAt);
      log.debug('[websocket-transport] connected', {
        startMs: startDoneAt - startedAt,
        socketMs: socketDoneAt - startDoneAt,
      });
    } catch (error) {
      await this.disconnect({ sendEndFrame: false });
      throw error;
    } finally {
      if (this.connectController === controller) this.connectController = null;
    }
  }

  async disconnect(options?: { sendEndFrame?: boolean }): Promise<void> {
    this.connectController?.abort();
    this.connectController = null;
    this.lifetimeController?.abort();
    this.lifetimeController = null;
    for (const controller of this.activeRpc.values()) controller.abort();
    this.activeRpc.clear();
    this.inputGeneration += 1;
    this.closing = true;
    if (options?.sendEndFrame !== false && this.connected) {
      try {
        await this.send({ type: 'end' });
      } catch (error) {
        log.warn('[websocket-transport] end frame failed', error);
      }
    }
    this.connected = false;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    await this.stopInput();
    for (const track of this.microphoneStream?.getTracks() ?? []) track.stop();
    this.microphoneStream = null;
    this.callerStream = null;
    this.clearPlayback();
    await this.outputContext?.close();
    this.outputContext = null;
    this.outputDestination = null;
    this.outputStream = null;
    this.onOutputBlocked = null;
    this.outputBlocked = false;
    this.nextPlaybackAt = 0;
    if (this.outputElement !== null) {
      this.outputElement.pause();
      this.outputElement.srcObject = null;
      if (this.outputElement !== this.hostAudioElement) this.outputElement.remove();
    }
    this.outputElement = null;
    this.reassembler.clear();
  }

  async send(message: RealtimeClientMessage): Promise<void> {
    const socket = this.requireSocket();
    socket.send(JSON.stringify(message));
  }

  async setMicMuted(muted: boolean): Promise<void> {
    const lifetimeSignal = this.lifetimeController?.signal;
    const generation = ++this.inputGeneration;
    this.muted = muted;
    for (const track of this.microphoneStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
    try {
      if (muted) {
        await this.stopInput();
      } else {
        const signal = this.requireLifetimeSignal();
        const stream = this.callerStream ?? (await this.ensureMicrophone(signal));
        if (!this.isInputGeneration(generation)) {
          this.discardStaleMicrophone(stream);
          return;
        }
        if (!await this.startInput(stream, signal, generation)) return;
        if (!this.isInputGeneration(generation)) return;
        if (this.callerStream !== null) {
          await this.send({ type: 'bind-input' });
        }
      }
      if (!this.isInputGeneration(generation)) return;
      await this.send({ type: 'mute', muted });
    } catch (error) {
      if (!this.isInputGeneration(generation)) {
        if (lifetimeSignal?.aborted) throw error;
        return;
      }
      throw error;
    }
  }

  async startAudioStream(stream: MediaStream): Promise<void> {
    if (this.callerStream !== null) {
      throw new SessionStateError({
        code: 'audio_publish_already_active',
        message: 'An audio stream is already running — call stopAudioStream before starting another.',
      });
    }
    if (stream.getAudioTracks().length === 0) {
      throw new Error('Audio stream must contain at least one audio track.');
    }
    const signal = this.requireLifetimeSignal();
    const generation = ++this.inputGeneration;
    this.callerStream = stream;
    try {
      await this.stopInput();
      this.requireCallerStreamGeneration(stream, generation);
      if (!await this.startInput(stream, signal, generation)) return;
      this.requireCallerStreamGeneration(stream, generation);
      await this.send({ type: 'bind-input' });
      this.requireCallerStreamGeneration(stream, generation);
      await this.send({ type: 'mute', muted: false });
      this.requireCallerStreamGeneration(stream, generation);
    } catch (error) {
      if (!this.isCallerStreamGeneration(stream, generation)) return;
      await this.stopInput();
      if (!this.isCallerStreamGeneration(stream, generation)) return;
      try {
        if (!await this.restoreMicrophone(signal, generation)) return;
      } catch (restoreError) {
        log.error('[websocket-transport] restoring the microphone failed', restoreError);
      }
      if (!this.isCallerStreamGeneration(stream, generation)) return;
      this.callerStream = null;
      throw error;
    }
  }

  async stopAudioStream(): Promise<void> {
    if (this.callerStream === null) return;
    const signal = this.requireLifetimeSignal();
    const generation = ++this.inputGeneration;
    this.callerStream = null;
    try {
      await this.stopInput();
      if (!this.isInputGeneration(generation)) return;
      if (!await this.restoreMicrophone(signal, generation)) return;
      if (!this.isInputGeneration(generation)) return;
      await this.send({ type: 'mute', muted: this.muted });
    } catch (error) {
      if (!this.isInputGeneration(generation)) return;
      throw error;
    }
  }

  getInputStream(): MediaStream | null {
    return this.inputStream;
  }

  getOutputAudioElement(): HTMLAudioElement | null {
    return this.outputElement;
  }

  getOutputStream(): MediaStream | null {
    return this.outputStream;
  }

  onOutputStreamChanged(callback: () => void): Unsubscribe {
    this.outputStreamListeners.add(callback);
    return () => this.outputStreamListeners.delete(callback) as unknown as void;
  }

  attachAudioElement(element: HTMLAudioElement | null): void {
    if (this.hostAudioElement === element) return;
    const previous = this.outputElement;
    const previousWasOwned = previous !== null && previous !== this.hostAudioElement;
    this.hostAudioElement = element;
    const replacement =
      element ?? (this.outputStream !== null ? this.createAudioElement() : null);
    this.outputElement = replacement;
    if (replacement !== null && this.outputStream !== null) {
      replacement.srcObject = this.outputStream;
      replacement.autoplay = true;
      this.tryPlayOutput(replacement);
    }
    if (previous !== null && previous !== replacement) {
      previous.pause();
      previous.srcObject = null;
      if (previousWasOwned) previous.remove();
    }
  }

  async resumeAudioPlayback(): Promise<void> {
    if (this.outputBlocked) this.clearPlayback();
    await this.outputContext?.resume();
    if (this.outputElement !== null) await this.playOutput(this.outputElement);
  }

  onMessage(callback: (message: RealtimeInboundMessage) => void): Unsubscribe {
    this.messageListeners.add(callback);
    return () => this.messageListeners.delete(callback) as unknown as void;
  }

  onClose(callback: (info?: RealtimeCloseInfo) => void): Unsubscribe {
    this.closeListeners.add(callback);
    return () => this.closeListeners.delete(callback) as unknown as void;
  }

  onReconnecting(_callback: () => void): Unsubscribe {
    return () => undefined;
  }

  onReconnected(_callback: () => void): Unsubscribe {
    return () => undefined;
  }

  registerRpcMethod(
    name: string,
    handler: (invocation: RpcInvocation) => Promise<string>,
  ): Unsubscribe {
    if (this.rpcMethods.has(name)) throw new Error(`RPC handler already registered: ${name}`);
    this.rpcMethods.set(name, handler);
    return () => this.rpcMethods.delete(name) as unknown as void;
  }

  private async startSession(
    options: RealtimeConnectOptions,
    signal: AbortSignal,
  ): Promise<WebSocketStart> {
    const headers = {
      ...(options.getAuthHeaders ? await options.getAuthHeaders() : {}),
      'Content-Type': 'application/json',
    };
    let response: Response;
    try {
      response = await fetch(options.sessionStartUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(options.config),
        signal,
      });
    } catch (error) {
      throw new SessionStartError({
        code: 'transport',
        message: describeFetchFailure(options.sessionStartUrl, error),
        cause: error,
      });
    }
    if (!response.ok) {
      const detail = await parseSessionStartErrorDetail(response);
      throw sessionStartErrorFrom(
        response.status,
        response.statusText,
        detail,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new SessionStartError({ code: 'invalid_response', message: 'WebSocket session-start response was not JSON.' });
    }
    if (!isWebSocketStart(body)) {
      throw new SessionStartError({ code: 'invalid_response', message: 'WebSocket session-start response was malformed.' });
    }
    return body;
  }

  private openSocket(started: WebSocketStart, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(started.ws_url, started.ws_subprotocol);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      const settle = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(preambleTimeout);
        signal.removeEventListener('abort', abort);
        complete();
      };
      const abort = (): void => {
        socket.close();
        settle(() => reject(signal.reason));
      };
      signal.addEventListener('abort', abort, { once: true });
      const preambleTimeout = setTimeout(() => {
        socket.close();
        settle(() => reject(
          new SessionStartError({ code: 'transport', message: 'WebSocket audio preamble timed out.' }),
        ));
      }, AUDIO_PREAMBLE_TIMEOUT_MS);
      socket.addEventListener('message', (event) => {
        if (!this.connected) {
          try {
            const format = parseAudioFormat(event.data);
            this.inputRate = format.input_sample_rate_hz;
            this.outputRate = format.output_sample_rate_hz;
            this.connected = true;
            settle(resolve);
          } catch (error) {
            socket.close();
            settle(() => reject(error));
          }
          return;
        }
        this.handleSocketMessage(event.data);
      });
      socket.addEventListener('close', (event) => {
        const wasConnected = this.connected;
        this.connected = false;
        if (!settled) {
          settle(() => reject(
            new SessionStartError({ code: 'transport', message: `WebSocket session was refused (${event.code}): ${event.reason || 'closed'}` }),
          ));
          return;
        }
        if (!wasConnected) return;
        if (!this.closing) {
          void this.handleUnexpectedClose({
            code: String(event.code),
            reason: event.reason || 'socket closed',
            // 1000/1001 are a deliberate close; 1005 is a close frame that
            // carried no status, which the server sends for the same thing.
            serverEnded: CLEAN_CLOSE_CODES.has(event.code),
          });
        }
      });
      socket.addEventListener('error', () => {
        if (!settled) {
          settle(() => reject(
            new SessionStartError({ code: 'transport', message: 'WebSocket session could not connect.' }),
          ));
        }
      });
      if (signal.aborted) abort();
    });
  }

  private handleSocketMessage(data: unknown): void {
    if (typeof data === 'string') {
      let frame: unknown;
      try {
        frame = JSON.parse(data);
      } catch {
        this.emitDecoded(new TextEncoder().encode(data));
        return;
      }
      if (isRpcRequest(frame)) {
        void this.invokeRpc(frame);
        return;
      }
      if (isRpcCancel(frame)) {
        this.activeRpc.get(frame.request_id)?.abort();
        return;
      }
      if (isAudioFormat(frame)) return;
      this.emitDecoded(new TextEncoder().encode(data));
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.playAudio(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      this.playAudio(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
  }

  private emitDecoded(data: Uint8Array): void {
    const decoded = decodeInbound(data, this.reassembler);
    if (decoded.status !== 'message') return;
    for (const callback of this.messageListeners) callback(decoded.message);
  }

  private async invokeRpc(request: RpcRequest): Promise<void> {
    const handler = this.rpcMethods.get(request.method);
    if (handler === undefined) {
      this.sendRpc({
        type: 'rpc-response',
        request_id: request.request_id,
        error: `no handler for ${JSON.stringify(request.method)}`,
      });
      return;
    }
    const controller = new AbortController();
    this.activeRpc.set(request.request_id, controller);
    try {
      const payload = await handler({
        payload: request.payload,
        callerIdentity: 'agent',
        callerIsAgent: true,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        this.sendRpc({ type: 'rpc-response', request_id: request.request_id, payload });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.sendRpc({
          type: 'rpc-response',
          request_id: request.request_id,
          error: boundRpcError(error instanceof Error ? error.message : String(error)),
        });
      }
    } finally {
      if (this.activeRpc.get(request.request_id) === controller) {
        this.activeRpc.delete(request.request_id);
      }
    }
  }

  private sendRpc(frame: Record<string, unknown>): void {
    try {
      this.requireSocket().send(JSON.stringify(frame));
    } catch (error) {
      log.warn('[websocket-transport] RPC reply could not be sent', error);
    }
  }

  private async acquireMicrophone(signal: AbortSignal, generation: number): Promise<void> {
    const stream = await this.ensureMicrophone(signal);
    if (!this.isInputGeneration(generation)) {
      this.discardStaleMicrophone(stream);
      return;
    }
    await this.startInput(stream, signal, generation);
  }

  private async ensureMicrophone(signal?: AbortSignal): Promise<MediaStream> {
    if (this.microphoneStream !== null) return this.microphoneStream;
    if (typeof navigator === 'undefined' || navigator.mediaDevices === undefined) {
      throw new Error('The websocket microphone requires a browser media device API.');
    }
    let request = this.microphoneRequest;
    if (request === null || request.signal !== signal) {
      request = {
        promise: navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: false,
            autoGainControl: false,
          },
        }),
        signal,
      };
      this.microphoneRequest = request;
    }
    let stream: MediaStream;
    try {
      stream = await request.promise;
    } finally {
      if (this.microphoneRequest === request) this.microphoneRequest = null;
    }
    if (signal?.aborted) {
      for (const track of stream.getTracks()) track.stop();
      signal.throwIfAborted();
    }
    for (const track of stream.getAudioTracks()) track.enabled = !this.muted;
    this.microphoneStream = stream;
    return stream;
  }

  private async handleUnexpectedClose(info: RealtimeCloseInfo): Promise<void> {
    try {
      await this.disconnect({ sendEndFrame: false });
    } catch (error) {
      log.error('[websocket-transport] unexpected-close cleanup failed', error);
    }
    for (const callback of this.closeListeners) callback(info);
  }

  private async restoreMicrophone(signal: AbortSignal, generation: number): Promise<boolean> {
    if (this.muted) return true;
    let microphone = this.microphoneStream;
    if (microphone === null && this.microphoneRequest?.signal === signal) {
      microphone = await this.ensureMicrophone(signal);
      if (!this.isInputGeneration(generation)) return false;
    }
    if (microphone === null) return true;
    return this.startInput(microphone, signal, generation);
  }

  private async startInput(
    stream: MediaStream,
    signal?: AbortSignal,
    generation?: number,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    await this.stopInput();
    signal?.throwIfAborted();
    if (generation !== undefined && !this.isInputGeneration(generation)) return false;
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(INPUT_BUFFER_SIZE, 1, 1);
    const silencer = context.createGain();
    silencer.gain.value = 0;
    processor.onaudioprocess = (event) => {
      const socket = this.socket;
      if (!this.connected || socket === null || socket.readyState !== WebSocket.OPEN) return;
      const pcm = this.inputResampler.process(
        event.inputBuffer.getChannelData(0),
        event.inputBuffer.sampleRate,
        this.inputRate,
      );
      if (pcm.byteLength > 0) socket.send(pcm);
    };
    source.connect(processor);
    processor.connect(silencer);
    silencer.connect(context.destination);
    this.inputContext = context;
    this.inputSource = source;
    this.inputProcessor = processor;
    this.inputSilencer = silencer;
    this.inputStream = stream;
    this.inputResampler.reset();
    try {
      await context.resume();
      signal?.throwIfAborted();
    } catch (error) {
      if (this.inputContext === context) await this.stopInput();
      throw error;
    }
    return true;
  }

  private async stopInput(): Promise<void> {
    this.inputProcessor?.disconnect();
    this.inputSource?.disconnect();
    this.inputSilencer?.disconnect();
    this.inputProcessor = null;
    this.inputSource = null;
    this.inputSilencer = null;
    const context = this.inputContext;
    this.inputContext = null;
    this.inputStream = null;
    this.inputResampler.reset();
    await context?.close();
  }

  private playAudio(bytes: Uint8Array): void {
    if (bytes.byteLength < 2 || this.outputRate <= 0) return;
    this.ensureOutput();
    if (this.outputBlocked) return;
    const context = this.outputContext;
    const destination = this.outputDestination;
    if (context === null || destination === null) return;
    const samples = pcm16ToFloat(bytes);
    const buffer = context.createBuffer(1, samples.length, this.outputRate);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    const startAt = Math.max(context.currentTime, this.nextPlaybackAt);
    this.nextPlaybackAt = startAt + buffer.duration;
    this.playing.add(source);
    source.onended = () => this.playing.delete(source);
    source.start(startAt);
  }

  private ensureOutput(): void {
    if (this.outputContext !== null) return;
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    this.outputContext = context;
    this.outputDestination = destination;
    this.outputStream = destination.stream;
    const element = this.hostAudioElement ?? this.createAudioElement();
    this.outputElement = element;
    if (element !== null) {
      element.srcObject = destination.stream;
      element.autoplay = true;
      this.tryPlayOutput(element);
    }
    for (const callback of this.outputStreamListeners) callback();
  }

  private createAudioElement(): HTMLAudioElement | null {
    if (typeof document === 'undefined') return null;
    const element = document.createElement('audio');
    element.style.display = 'none';
    document.body.appendChild(element);
    return element;
  }

  private requireSocket(): WebSocket {
    if (this.socket === null || !this.connected || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Realtime websocket transport is not connected.');
    }
    return this.socket;
  }

  private requireLifetimeSignal(): AbortSignal {
    const signal = this.lifetimeController?.signal;
    if (signal === undefined || signal.aborted) {
      throw new Error('Realtime websocket transport is not connected.');
    }
    return signal;
  }

  private isCallerStreamGeneration(stream: MediaStream, generation: number): boolean {
    return this.callerStream === stream && this.isInputGeneration(generation);
  }

  private requireCallerStreamGeneration(stream: MediaStream, generation: number): void {
    if (!this.isCallerStreamGeneration(stream, generation)) {
      throw new Error('Audio stream start was stopped before setup completed.');
    }
  }

  private tryPlayOutput(element: HTMLAudioElement): void {
    void this.playOutput(element).catch((error: unknown) => {
      log.warn('[websocket-transport] audio autoplay blocked', error);
    });
  }

  private async playOutput(element: HTMLAudioElement): Promise<void> {
    try {
      await element.play();
    } catch (error) {
      if (this.outputElement === element) {
        this.outputBlocked = true;
        this.clearPlayback();
        this.onOutputBlocked?.(true);
      }
      throw error;
    }
    if (this.outputElement === element) {
      this.outputBlocked = false;
      this.onOutputBlocked?.(false);
    }
  }

  private isInputGeneration(generation: number): boolean {
    return this.inputGeneration === generation;
  }

  private discardStaleMicrophone(stream: MediaStream): void {
    if (
      this.muted &&
      this.callerStream === null &&
      this.microphoneStream === stream &&
      this.inputStream !== stream
    ) {
      for (const track of stream.getTracks()) track.stop();
      this.microphoneStream = null;
    }
  }

  private clearPlayback(): void {
    for (const source of this.playing) {
      try {
        source.stop();
      } catch {
        // Already ended.
      }
    }
    this.playing.clear();
    this.nextPlaybackAt = 0;
  }
}

export class Pcm16Resampler {
  private sourceOffset = 0;
  private nextOutputPosition = 0;
  private sourceRate = 0;
  private targetRate = 0;
  private previousSample = 0;
  private hasPreviousSample = false;

  reset(): void {
    this.sourceOffset = 0;
    this.nextOutputPosition = 0;
    this.sourceRate = 0;
    this.targetRate = 0;
    this.previousSample = 0;
    this.hasPreviousSample = false;
  }

  process(input: Float32Array, sourceRate: number, targetRate: number): Int16Array {
    if (input.length === 0 || sourceRate <= 0 || targetRate <= 0) {
      return new Int16Array();
    }
    if (sourceRate !== this.sourceRate || targetRate !== this.targetRate) {
      this.reset();
      this.sourceRate = sourceRate;
      this.targetRate = targetRate;
    }
    const start = this.sourceOffset;
    const end = start + input.length;
    const step = sourceRate / targetRate;
    const output: number[] = [];
    while (this.nextOutputPosition < end) {
      const position = this.nextOutputPosition - start;
      const left = Math.floor(position);
      const fraction = position - left;
      if (fraction > 0 && left + 1 >= input.length) break;
      const leftSample = left === -1 && this.hasPreviousSample
        ? this.previousSample
        : input[Math.max(0, left)];
      const rightSample = input[Math.max(0, left + 1)] ?? leftSample;
      const sample = leftSample + (rightSample - leftSample) * fraction;
      output.push(Math.round(Math.max(-1, Math.min(1, sample)) * 32767));
      this.nextOutputPosition += step;
    }
    this.sourceOffset = end;
    this.previousSample = input[input.length - 1];
    this.hasPreviousSample = true;
    return Int16Array.from(output);
  }
}

function isWebSocketStart(value: unknown): value is WebSocketStart {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.session_id === 'string' &&
    typeof row.ws_url === 'string' &&
    typeof row.ws_subprotocol === 'string' &&
    row.ws_subprotocol.length > 0
  );
}

function parseAudioFormat(value: unknown): AudioFormat {
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch (error) {
    throw new SessionStartError({ code: 'transport', message: 'WebSocket audio preamble was not JSON.' });
  }
  if (!isAudioFormat(parsed)) {
    throw new SessionStartError({ code: 'transport', message: 'WebSocket audio preamble was malformed.' });
  }
  return parsed;
}

function isAudioFormat(value: unknown): value is AudioFormat {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    row.type === 'ws-audio-format' &&
    typeof row.input_sample_rate_hz === 'number' &&
    row.input_sample_rate_hz > 0 &&
    typeof row.output_sample_rate_hz === 'number' &&
    row.output_sample_rate_hz > 0 &&
    row.num_channels === 1
  );
}

function isRpcRequest(value: unknown): value is RpcRequest {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    row.type === 'rpc-request' &&
    typeof row.request_id === 'string' &&
    typeof row.method === 'string' &&
    typeof row.payload === 'string'
  );
}

function isRpcCancel(value: unknown): value is RpcCancel {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return row.type === 'rpc-cancel' && typeof row.request_id === 'string';
}

export function floatToPcm16(
  input: Float32Array,
  sourceRate: number,
  targetRate: number,
): Int16Array {
  return new Pcm16Resampler().process(input, sourceRate, targetRate);
}

function boundRpcError(error: string): string {
  return Array.from(error).slice(0, RPC_ERROR_MAX_CHARS).join('');
}

export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const output = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < output.length; index += 1) {
    output[index] = view.getInt16(index * 2, true) / 32768;
  }
  return output;
}
