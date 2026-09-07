"""
main.py — FastAPI sidecar：Project-EAT 引擎的 HTTP 契約層。

所有 /internal/* 端點要求 X-Internal-Token（env ANALYZER_INTERNAL_TOKEN）；
env 未設定時為開發模式（放行並記警告）。
錯誤回應格式與主 API 一致：{ "error": { "code", "message", "details" } }。
"""

from __future__ import annotations

import logging
import os

from fastapi import Depends, FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse

from . import pipeline
from .contracts import AnalyzeFileResponse, AnalyzeResponse, HealthResponse
from .language_prompts import LANGUAGES

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("analyzer")

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_TEXT_CHARS = 20000

app = FastAPI(title="Essay Analyzer (Project-EAT sidecar)", version="1.0.0")

INTERNAL_TOKEN = os.environ.get("ANALYZER_INTERNAL_TOKEN", "")


class AnalyzerError(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}


@app.exception_handler(AnalyzerError)
async def analyzer_error_handler(_request: Request, exc: AnalyzerError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status,
        content={"error": {"code": exc.code, "message": exc.message, "details": exc.details}},
    )


def require_token(request: Request) -> None:
    if not INTERNAL_TOKEN:
        logger.warning("ANALYZER_INTERNAL_TOKEN 未設定：開發模式，跳過內部 token 驗證")
        return
    if request.headers.get("X-Internal-Token", "") != INTERNAL_TOKEN:
        raise AnalyzerError(401, "ANALYZER_UNAUTHORIZED", "內部 token 無效")


def ensure_language(language: str) -> None:
    if language not in LANGUAGES:
        raise AnalyzerError(
            400, "ANALYZER_INVALID_LANGUAGE", f"不支援的語言：{language}", {"supported": list(LANGUAGES.keys())}
        )


def ensure_ollama() -> None:
    if not pipeline.check_ollama():
        raise AnalyzerError(503, "ANALYZER_OLLAMA_UNAVAILABLE", "Ollama 服務不可達", {"ollamaUrl": pipeline.OLLAMA_URL})


@app.get("/internal/health", dependencies=[Depends(require_token)])
def health() -> HealthResponse:
    return HealthResponse(ollama="reachable" if pipeline.check_ollama() else "unreachable", model=pipeline.DEFAULT_MODEL)


@app.post("/internal/analyze", response_model=AnalyzeResponse, dependencies=[Depends(require_token)])
def analyze(payload: dict) -> AnalyzeResponse:
    text = (payload or {}).get("text", "")
    language = (payload or {}).get("language") or "en"
    model = (payload or {}).get("model")

    if not isinstance(text, str) or not text.strip():
        raise AnalyzerError(400, "ANALYZER_INVALID_REQUEST", "text 不可為空")
    if len(text) > MAX_TEXT_CHARS:
        raise AnalyzerError(400, "ANALYZER_TEXT_TOO_LONG", f"text 超過 {MAX_TEXT_CHARS} 字")
    ensure_language(language)
    ensure_ollama()

    try:
        return pipeline.analyze_text(text, language, model)
    except pipeline.OllamaUnavailable as exc:
        raise AnalyzerError(503, "ANALYZER_OLLAMA_UNAVAILABLE", f"Ollama 呼叫失敗：{exc}") from exc
    except AnalyzerError:
        raise
    except Exception as exc:  # noqa: BLE001 — 引擎任何例外統一 500，不外洩細節
        logger.exception("analyze failed")
        raise AnalyzerError(500, "ANALYZER_INTERNAL_ERROR", "分析引擎內部錯誤") from exc


@app.post("/internal/analyze-file", response_model=AnalyzeFileResponse, dependencies=[Depends(require_token)])
async def analyze_file_endpoint(
    file: UploadFile = File(...),
    language: str = Form("en"),
    spellCorrect: bool = Form(False),
    annotate: bool = Form(True),
) -> AnalyzeFileResponse:
    data = await file.read()
    filename = file.filename or ""

    if len(data) > MAX_UPLOAD_BYTES:
        raise AnalyzerError(400, "ANALYZER_FILE_TOO_LARGE", "檔案超過 20MB")
    ensure_language(language)
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in ("pdf", "png", "jpg", "jpeg"):
        raise AnalyzerError(415, "ANALYZER_UNSUPPORTED_MEDIA_TYPE", f"不支援的檔案類型：.{ext or '(無副檔名)'}")
    ensure_ollama()

    try:
        return pipeline.analyze_file(data, filename, language, spell_correct=spellCorrect, annotate=annotate)
    except pipeline._NoTextError as exc:
        raise AnalyzerError(422, "ANALYZER_OCR_NO_TEXT", "OCR 無法抽出文字，請確認掃描品質（建議 ≥200 DPI）") from exc
    except ValueError as exc:
        raise AnalyzerError(415, "ANALYZER_UNSUPPORTED_MEDIA_TYPE", str(exc)) from exc
    except pipeline.OllamaUnavailable as exc:
        raise AnalyzerError(503, "ANALYZER_OLLAMA_UNAVAILABLE", f"Ollama 呼叫失敗：{exc}") from exc
    except AnalyzerError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("analyze-file failed")
        raise AnalyzerError(500, "ANALYZER_INTERNAL_ERROR", "分析引擎內部錯誤") from exc
