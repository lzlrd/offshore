/**
 * Client for an OpenAI-compatible endpoint. Supports both wire protocols that
 * Codex understands: Chat Completions ("chat") and the Responses API
 * ("responses"). Uses the global `fetch` (Node 18+) so there is no HTTP dep.
 *
 * Requests are streamed (SSE). The timeout is an *idle* timeout — it resets on
 * every chunk — so a slow but steadily-progressing generation never trips it;
 * only a genuine stall (or a slow cold start before the first token) does.
 */

import type { OffshoreConfig, ProviderConfig } from "./config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class OffshoreError extends Error {
  constructor(message: string, readonly retryable = false, readonly cause?: unknown) {
    super(message);
    this.name = "OffshoreError";
  }
}

interface ModelsResponse {
  data?: Array<{ id?: string }>;
}

/** A parsed SSE `data:` frame; its shape depends on the wire API. */
interface SseEvent {
  type?: string;
  delta?: unknown;
  choices?: Array<{ delta?: { content?: unknown } }>;
  error?: { message?: string };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OffshoreClient {
  private readonly provider: ProviderConfig;

  constructor(private readonly config: OffshoreConfig, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.provider = config.provider;
  }

  /** Send a conversation and return the assistant's text, using the provider's wire API. */
  async chat(messages: ChatMessage[]): Promise<string> {
    return this.provider.wireApi === "responses"
      ? this.chatViaResponses(messages)
      : this.chatViaCompletions(messages);
  }

  private chatViaCompletions(messages: ChatMessage[]): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: true,
    };
    if (this.config.temperature !== null) body.temperature = this.config.temperature;
    if (this.config.maxTokens !== null) body.max_tokens = this.config.maxTokens;

    return this.withRetries(() => this.streamOnce("/chat/completions", body, pickCompletionDelta));
  }

  private chatViaResponses(messages: ChatMessage[]): Promise<string> {
    const instructions = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const input = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role,
        content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }],
      }));

    const body: Record<string, unknown> = {
      model: this.config.model,
      input,
      stream: true,
    };
    if (this.config.temperature !== null) body.temperature = this.config.temperature;
    if (instructions) body.instructions = instructions;
    if (this.config.maxTokens !== null) body.max_output_tokens = this.config.maxTokens;

    return this.withRetries(() => this.streamOnce("/responses", body, pickResponsesDelta));
  }

  /** List model ids the runtime currently exposes. */
  async listModels(): Promise<string[]> {
    const data = await this.withRetries(() => this.requestOnce<ModelsResponse>("/models", { method: "GET" }));
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
  }

  private buildUrl(path: string): string {
    const url = new URL(`${this.provider.baseUrl}${path}`);
    for (const [k, v] of Object.entries(this.provider.queryParams)) url.searchParams.set(k, v);
    return url.toString();
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
      ...this.provider.httpHeaders,
    };
    for (const [header, envVar] of Object.entries(this.provider.envHttpHeaders)) {
      const value = this.env[envVar];
      if (value !== undefined) headers[header] = value;
    }
    return headers;
  }

  /** Run a request, retrying with backoff only on transient (retryable) failures. */
  private async withRetries<T>(run: () => Promise<T>): Promise<T> {
    const retries = this.provider.requestMaxRetries;
    let attempt = 0;
    for (; ;) {
      try {
        return await run();
      } catch (err) {
        const retryable = err instanceof OffshoreError && err.retryable;
        if (!retryable || attempt >= retries) throw err;
        attempt += 1;
        await delay(Math.min(250 * 2 ** attempt, 4000));
      }
    }
  }

  /**
   * POST a streaming request and accumulate the assistant's text. A failure
   * *before* the body is read (network, 429, 5xx) is retryable; once bytes are
   * flowing nothing is retried, so a partial generation is never duplicated.
   */
  private async streamOnce(
    path: string,
    body: unknown,
    pickDelta: (event: SseEvent) => string | undefined,
  ): Promise<string> {
    const url = this.buildUrl(path);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    };
    const disarm = () => {
      if (timer) clearTimeout(timer);
    };

    arm();
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        body: JSON.stringify(body),
        headers: this.buildHeaders(),
        signal: controller.signal,
      });
    } catch (err) {
      disarm();
      if (err instanceof Error && err.name === "AbortError") throw this.timeoutError(url, err);
      throw this.unreachableError(err);
    }

    if (!response.ok) {
      disarm();
      const detail = await response.text().catch(() => "");
      const retryable = response.status === 429 || response.status >= 500;
      throw new OffshoreError(
        `${url} responded ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
        retryable,
      );
    }
    if (!response.body) {
      disarm();
      throw new OffshoreError(`${url} returned no response body to stream.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const acc = new SseAccumulator(pickDelta);
    try {
      for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm(); // progress — reset the idle clock
        if (acc.push(decoder.decode(value, { stream: true }))) break; // saw [DONE]
      }
      acc.push(decoder.decode() + "\n"); // flush any trailing, non-newline-terminated frame
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw this.timeoutError(url, err);
      throw err; // inline error frame (non-retryable) or a read failure
    } finally {
      disarm();
      reader.cancel().catch(() => {});
    }

    if (acc.text.trim() === "") throw new OffshoreError("Model returned an empty response.");
    return acc.text;
  }

  private async requestOnce<T>(path: string, init: RequestInit): Promise<T> {
    const url = this.buildUrl(path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal, headers: this.buildHeaders() });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw this.timeoutError(url, err);
      throw this.unreachableError(err);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const retryable = response.status === 429 || response.status >= 500;
      throw new OffshoreError(
        `${url} responded ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
        retryable,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new OffshoreError(`Could not parse JSON from ${url}.`, false, err);
    }
  }

  private timeoutError(url: string, cause: unknown): OffshoreError {
    return new OffshoreError(
      `Request to ${url} timed out after ${this.config.timeoutMs}ms with no activity. ` +
      `Is the local model running? First load can be slow — raise OFFSHORE_TIMEOUT_MS.`,
      false,
      cause,
    );
  }

  private unreachableError(cause: unknown): OffshoreError {
    // Network-level failure (connection refused, DNS, reset): worth retrying.
    return new OffshoreError(
      `Could not reach the ${this.provider.name} endpoint at ${this.provider.baseUrl}. ` +
      `Check that the runtime is up and the provider's base_url is correct.`,
      true,
      cause,
    );
  }
}

/** Chat Completions stream: text arrives as choices[0].delta.content. */
export function pickCompletionDelta(event: SseEvent): string | undefined {
  const d = event.choices?.[0]?.delta?.content;
  return typeof d === "string" ? d : undefined;
}

/** Responses API stream: text arrives as `response.output_text.delta` frames. */
export function pickResponsesDelta(event: SseEvent): string | undefined {
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") return event.delta;
  return undefined;
}

/**
 * Parses an SSE text stream incrementally, buffering the partial trailing line
 * between pushes so a frame split across chunk boundaries is reassembled. It is a
 * class (not a pure function) precisely because it carries that cross-chunk state;
 * the live reader and the tests both drive it through `push`.
 */
export class SseAccumulator {
  private buffer = "";
  text = "";

  constructor(private readonly pickDelta: (event: SseEvent) => string | undefined) {}

  /** Feed a decoded chunk; returns true once the terminal `[DONE]` is seen. Throws on an inline error frame. */
  push(chunk: string): boolean {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue; // skip event:/id:/comments/blank lines
      const payload = line.slice(5).trim();
      if (payload === "") continue;
      if (payload === "[DONE]") return true;
      let event: SseEvent;
      try {
        event = JSON.parse(payload) as SseEvent;
      } catch {
        continue; // ignore an unparseable frame rather than abort the whole stream
      }
      if (event.error?.message) throw new OffshoreError(`Model returned an error: ${event.error.message}`);
      const d = this.pickDelta(event);
      if (typeof d === "string") this.text += d;
    }
    return false;
  }
}
