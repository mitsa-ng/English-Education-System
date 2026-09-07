"""Pydantic 回應模型 — 與 docs/analysis-service.md 契約 1:1（snake_case）。"""

from typing import List, Optional

from pydantic import BaseModel, Field

ENGINE_VERSION = "1.0.0"

VALID_ERROR_TYPES = {"spelling", "grammar", "semantic"}


class AnalyzeError(BaseModel):
    type: str = Field(description="spelling / grammar / semantic")
    original: str
    suggestion: str
    explanation: Optional[str] = None
    offset: int = Field(default=-1, description="相對輸入文字的起始位置；無法唯一定位時 -1")
    length: int = 0


class AnalyzeSummary(BaseModel):
    spellingCount: int = 0
    grammarCount: int = 0
    semanticCount: int = 0
    wordCount: int = 0


class AnalyzeResponse(BaseModel):
    engineVersion: str = ENGINE_VERSION
    language: str
    errors: List[AnalyzeError]
    summary: AnalyzeSummary


class OcrMeta(BaseModel):
    pageCount: int
    pageType: str = Field(description="digital / scanned")
    spellCorrected: bool


class AnalyzeFileResponse(AnalyzeResponse):
    extractedText: str
    ocrMeta: OcrMeta
    annotatedPdfBase64: Optional[str] = None


class HealthResponse(BaseModel):
    status: str = "ok"
    ollama: str = Field(description="reachable / unreachable")
    model: str
    engineVersion: str = ENGINE_VERSION
