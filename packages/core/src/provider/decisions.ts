import type { Usage } from "../protocol/index.js";

export interface DecisionQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface DecisionAnswer {
  choice: string;
  confidence: number;
  reason?: string;
}

export interface DecisionConnection {
  source: "gemini" | "jev";
  baseURL: string;
  model: string;
  key: () => Promise<string | undefined>;
  sessionHeader?: string | undefined;
  sessionId?: string | undefined;
}

export type DecisionFailure =
  | { kind: "auth" | "unsupported" | "rate_limit" | "http"; status: number }
  | { kind: "missing_key" | "blocked" | "invalid_answers" | "timeout" | "request_failed" };

export type DecisionResponse = (
  { ok: true; answers: Record<string, DecisionAnswer> } | { ok: false; failure: DecisionFailure }
) & { usage?: Usage | undefined };

const SAFETY_ERROR_CODES = new Set([
  "safety",
  "prohibited_content",
  "blocklist",
  "image_safety",
  "content_blocked",
]);

export function parseDecisionAnswerTable(
  raw: unknown,
  questions: Record<string, DecisionQuestion>,
): Record<string, DecisionAnswer> | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const answers: Record<string, DecisionAnswer> = Object.create(null) as Record<
    string,
    DecisionAnswer
  >;
  for (const [key, question] of Object.entries(questions)) {
    const entry: unknown = Array.isArray(raw)
      ? raw[Number(key) - 1]
      : Object.hasOwn(raw, key)
        ? (raw as Record<string, unknown>)[key]
        : undefined;
    if (entry === null || typeof entry !== "object") return undefined;
    const { choice, confidence, reason } = entry as Record<string, unknown>;
    if (
      typeof choice !== "string" ||
      !Object.hasOwn(question.criteria, choice) ||
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      return undefined;
    }
    answers[key] = { choice, confidence, ...(typeof reason === "string" ? { reason } : {}) };
  }
  return answers;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function jevState(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

async function isBlockedResponse(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } } | null;
    const code = body?.error?.code;
    return typeof code === "string" && SAFETY_ERROR_CODES.has(code);
  } catch {
    return false;
  }
}

/** Sends one shared input with an arbitrary table of choice questions. */
export async function requestDecisions(
  connection: DecisionConnection,
  input: string,
  questions: Record<string, DecisionQuestion>,
  signal: AbortSignal,
): Promise<DecisionResponse> {
  const timeout = AbortSignal.timeout(20_000);
  const requestSignal = AbortSignal.any([signal, timeout]);
  const gemini = connection.source === "gemini";
  try {
    const key = await connection.key();
    requestSignal.throwIfAborted();
    if (!key) return { ok: false, failure: { kind: "missing_key" } };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (gemini) {
      headers["x-goog-api-key"] = key;
    } else {
      headers.Authorization = `Bearer ${key}`;
      if (connection.sessionHeader && connection.sessionId) {
        headers[connection.sessionHeader] = connection.sessionId;
      }
    }
    const response = await fetch(
      `${connection.baseURL.replace(/\/+$/, "")}/${gemini ? "decisions" : "systemone"}`,
      {
        method: "POST",
        headers,
        signal: requestSignal,
        body: JSON.stringify({
          model: connection.model,
          ...(gemini ? { input } : { state: jevState(input) }),
          questions,
        }),
      },
    );
    if (!response.ok) {
      const blocked = gemini && response.status === 400 && (await isBlockedResponse(response));
      requestSignal.throwIfAborted();
      if (blocked) return { ok: false, failure: { kind: "blocked" } };
      const { status } = response;
      const kind =
        status === 401 || status === 403
          ? "auth"
          : status === 400 || status === 404
            ? "unsupported"
            : status === 429
              ? "rate_limit"
              : "http";
      return { ok: false, failure: { kind, status } };
    }
    const body: unknown = await response.json();
    requestSignal.throwIfAborted();
    if (typeof body !== "object" || body === null) {
      return { ok: false, failure: { kind: "request_failed" } };
    }
    const data = body as {
      answers?: unknown;
      usage?: { total_input_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown };
      prompt_feedback?: { block_reason?: unknown };
    };
    const inputTokens = gemini ? data.usage?.total_input_tokens : data.usage?.input_tokens;
    const outputTokens = gemini ? 0 : data.usage?.output_tokens;
    const usage =
      isTokenCount(inputTokens) && isTokenCount(outputTokens)
        ? { inputTokens, outputTokens }
        : undefined;
    const blockReason = data.prompt_feedback?.block_reason;
    if (gemini && typeof blockReason === "string" && blockReason.length > 0) {
      return { ok: false, failure: { kind: "blocked" }, usage };
    }
    const answers = parseDecisionAnswerTable(data.answers, questions);
    return answers
      ? { ok: true, answers, usage }
      : { ok: false, failure: { kind: "invalid_answers" }, usage };
  } catch {
    signal.throwIfAborted();
    return { ok: false, failure: { kind: timeout.aborted ? "timeout" : "request_failed" } };
  }
}
