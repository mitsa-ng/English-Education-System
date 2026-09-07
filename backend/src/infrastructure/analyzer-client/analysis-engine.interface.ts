/**
 * 作文分析引擎邊界（docs/analysis-service.md 契約）。
 * modules/analysis 只依賴此介面；測試以 in-memory fake 取代。
 * snake_case → camelCase 的轉換只發生在 AnalyzerHttpClient 這一處。
 */

export interface AnalysisErrorItem {
  type: 'spelling' | 'grammar' | 'semantic';
  original: string;
  suggestion: string;
  explanation: string | null;
  offset: number;
  length: number;
}

export interface AnalysisSummary {
  spellingCount: number;
  grammarCount: number;
  semanticCount: number;
  wordCount: number;
}

export interface AnalysisOutput {
  engineVersion: string;
  language: string;
  errors: AnalysisErrorItem[];
  summary: AnalysisSummary;
}

export interface FileAnalysisOutput extends AnalysisOutput {
  extractedText: string;
  annotatedPdfBase64: string | null;
}

export interface TextAnalysisInput {
  text: string;
  language: string;
}

export interface FileAnalysisInput {
  data: Uint8Array;
  filename: string;
  mimeType: string;
  language: string;
}

export interface EngineHealth {
  ollama: 'reachable' | 'unreachable';
  model: string;
}

export const ANALYSIS_ENGINE = Symbol('ANALYSIS_ENGINE');

/** modules/analysis 依賴的引擎介面（DI token：ANALYSIS_ENGINE）。 */
export interface AnalysisEngine {
  healthCheck(): Promise<EngineHealth>;
  analyzeText(input: TextAnalysisInput): Promise<AnalysisOutput>;
  analyzeFile(input: FileAnalysisInput): Promise<FileAnalysisOutput>;
}

export class AnalysisEngineUnavailableError extends Error {}
