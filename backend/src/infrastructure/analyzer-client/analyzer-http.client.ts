import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  AnalysisEngineUnavailableError,
  type AnalysisEngine,
  type AnalysisOutput,
  type EngineHealth,
  type FileAnalysisInput,
  type FileAnalysisOutput,
  type TextAnalysisInput,
} from './analysis-engine.interface';

/** 契約逾時（docs/analysis-service.md §2.4）：文字 120s、檔案 300s。 */
const TEXT_TIMEOUT_MS = 120_000;
const FILE_TIMEOUT_MS = 300_000;
const RETRY_DELAY_MS = 10_000;
const RETRYABLE_STATUS = new Set([500, 503, 504]);

interface SidecarErrorBody {
  error?: { code?: string; message?: string };
}

export class AnalyzerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AnalyzerHttpError';
  }
}

/**
 * sidecar 唯一呼叫者：timeout、503/504/500 重試一次（間隔 10s）、
 * 4xx 不重試（直接視為任務失敗）。
 */
@Injectable()
export class AnalyzerHttpClient implements AnalysisEngine {
  private readonly logger = new Logger(AnalyzerHttpClient.name);
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('ANALYZER_URL') ?? 'http://localhost:8010';
    this.token = config.get<string>('ANALYZER_INTERNAL_TOKEN') ?? '';
  }

  async healthCheck(): Promise<EngineHealth> {
    const body = await this.request<{ ollama: EngineHealth['ollama']; model: string }>(
      `/internal/health`,
      TEXT_TIMEOUT_MS,
    );
    return { ollama: body.ollama, model: body.model };
  }

  async analyzeText(input: TextAnalysisInput): Promise<AnalysisOutput> {
    return this.withRetry(async () => {
      const body = await this.request<Record<string, unknown>>(`/internal/analyze`, TEXT_TIMEOUT_MS, {
        method: 'POST',
        json: { text: input.text, language: input.language },
      });
      return this.mapAnalysisOutput(body);
    });
  }

  async analyzeFile(input: FileAnalysisInput): Promise<FileAnalysisOutput> {
    return this.withRetry(async () => {
      const form = new FormData();
      form.append(
        'file',
        new Blob([input.data as BlobPart], { type: input.mimeType }),
        input.filename,
      );
      form.append('language', input.language);
      const body = await this.request<Record<string, unknown>>(
        `/internal/analyze-file`,
        FILE_TIMEOUT_MS,
        { method: 'POST', body: form },
      );
      return {
        ...this.mapAnalysisOutput(body),
        extractedText: String(body.extractedText ?? ''),
        annotatedPdfBase64:
          typeof body.annotatedPdfBase64 === 'string' ? body.annotatedPdfBase64 : null,
      };
    });
  }

  // ── 內部 ────────────────────────────────────────────────────────────────

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AnalyzerHttpError && RETRYABLE_STATUS.has(error.status)) {
        this.logger.warn(`sidecar ${error.status}（${error.code}），10 秒後重試一次`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        return operation();
      }
      throw error;
    }
  }

  private async request<T>(
    path: string,
    timeoutMs: number,
    init?: { method?: string; json?: unknown; body?: FormData },
  ): Promise<T> {
    const requestId = randomUUID();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      if (init?.json !== undefined) {
        response = await fetch(`${this.baseUrl}${path}`, {
          method: init.method ?? 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Token': this.token,
            'X-Request-Id': requestId,
          },
          body: JSON.stringify(init.json),
          signal: controller.signal,
        });
      } else {
        response = await fetch(`${this.baseUrl}${path}`, {
          method: init?.method ?? 'GET',
          headers: { 'X-Internal-Token': this.token, 'X-Request-Id': requestId },
          body: init?.body,
          signal: controller.signal,
        });
      }

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => ({}))) as SidecarErrorBody;
        throw new AnalyzerHttpError(
          response.status,
          errorBody.error?.code ?? 'ANALYSIS_FAILED',
          errorBody.error?.message ?? `sidecar ${response.status}`,
        );
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof AnalyzerHttpError) {
        if (error.status >= 500) {
          throw new AnalysisEngineUnavailableError(error.message);
        }
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AnalysisEngineUnavailableError(`sidecar timeout（>${timeoutMs / 1000}s）`);
      }
      throw new AnalysisEngineUnavailableError(
        `sidecar 無法連線：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** snake_case（sidecar）→ camelCase（主 API），只在這一處轉換。 */
  private mapAnalysisOutput(body: Record<string, unknown>): AnalysisOutput {
    const errors = Array.isArray(body.errors) ? body.errors : [];
    const summary = (body.summary ?? {}) as Record<string, number>;
    return {
      engineVersion: String(body.engineVersion ?? 'unknown'),
      language: String(body.language ?? 'en'),
      errors: errors.map((raw) => {
        const e = raw as Record<string, unknown>;
        return {
          type: (String(e.type ?? 'grammar') as AnalysisOutput['errors'][number]['type']) ?? 'grammar',
          original: String(e.original ?? ''),
          suggestion: String(e.suggestion ?? ''),
          explanation: e.explanation === null || e.explanation === undefined ? null : String(e.explanation),
          offset: typeof e.offset === 'number' ? e.offset : -1,
          length: typeof e.length === 'number' ? e.length : 0,
        };
      }),
      summary: {
        spellingCount: Number(summary.spellingCount ?? 0),
        grammarCount: Number(summary.grammarCount ?? 0),
        semanticCount: Number(summary.semanticCount ?? 0),
        wordCount: Number(summary.wordCount ?? 0),
      },
    };
  }
}
