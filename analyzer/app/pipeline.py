"""
pipeline.py — 引擎包裝層（決策與純計算，便於 stub 測試）。

職責：
  • 把 NLPEngine / OCREngine / Annotator 的原生輸出包成契約格式（offsets、summary）
  • 文字/檔案兩條分析路徑
  • Ollama 健康檢查
引擎本身（nlp_engine 等）逐字搬自 Project-EAT，不在此改動。
"""

from __future__ import annotations

import base64
import os
import tempfile
from typing import Any, Dict, List, Optional

import requests

from .contracts import (
    ENGINE_VERSION,
    AnalyzeError,
    AnalyzeFileResponse,
    AnalyzeResponse,
    AnalyzeSummary,
    OcrMeta,
)
from .language_prompts import LANGUAGES, NO_SPACE_LANGUAGES

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
DEFAULT_MODEL = os.environ.get("OLLAMA_MODEL", "phi3")
USE_GPU = os.environ.get("ANALYZER_USE_GPU", "false").lower() == "true"


class OllamaUnavailable(Exception):
    pass


def build_nlp_engine(language: str, model: Optional[str] = None):
    """延遲建立真引擎（測試以 monkeypatch 取代本函式）。"""
    from .nlp_engine import NLPEngine

    return NLPEngine(
        model=model or DEFAULT_MODEL,
        ollama_url=os.environ.get("OLLAMA_GENERATE_URL", f"{OLLAMA_URL}/api/generate"),
        language=language,
    )


def build_ocr_engine(language: str, spell_correct: bool):
    from .ocr_engine import OCREngine

    return OCREngine(use_gpu=USE_GPU, spell_correct=spell_correct, language=language)


def check_language(language: str) -> None:
    if language not in LANGUAGES:
        raise ValueError(f"unsupported language: {language}")


def check_ollama() -> bool:
    try:
        requests.get(f"{OLLAMA_URL}/api/tags", timeout=3)
        return True
    except requests.RequestException:
        return False


def word_count(text: str, language: str) -> int:
    if language in NO_SPACE_LANGUAGES:
        return len(text)
    return len(text.split())


def _locate(original: str, text: str) -> int:
    """回傳 original 在 text 的唯一起始位置；找不到或多處出現 → -1（契約：offset 不確定時 -1）。"""
    first = text.find(original)
    if first == -1:
        return -1
    if text.find(original, first + 1) != -1:
        return -1
    return first


def shape_errors(raw_errors: List[Dict[str, str]], text: str) -> List[AnalyzeError]:
    shaped: List[AnalyzeError] = []
    for raw in raw_errors:
        error_type = str(raw.get("type", "grammar")).strip().lower()
        if error_type not in ("spelling", "grammar", "semantic"):
            error_type = "grammar"
        original = str(raw.get("original", ""))
        if not original:
            continue
        shaped.append(
            AnalyzeError(
                type=error_type,
                original=original,
                suggestion=str(raw.get("suggestion", "")),
                explanation=raw.get("explanation"),
                offset=_locate(original, text),
                length=len(original),
            )
        )
    return shaped


def summarize(errors: List[AnalyzeError], text: str, language: str) -> AnalyzeSummary:
    return AnalyzeSummary(
        spellingCount=sum(1 for e in errors if e.type == "spelling"),
        grammarCount=sum(1 for e in errors if e.type == "grammar"),
        semanticCount=sum(1 for e in errors if e.type == "semantic"),
        wordCount=word_count(text, language),
    )


def analyze_text(
    text: str,
    language: str,
    model: Optional[str] = None,
    engine: Optional[Any] = None,
) -> AnalyzeResponse:
    check_language(language)
    nlp = engine if engine is not None else build_nlp_engine(language, model)
    try:
        raw = nlp.analyse_text(text)
    except requests.RequestException as exc:  # Ollama 連不上
        raise OllamaUnavailable(str(exc)) from exc
    errors = shape_errors(raw, text)
    return AnalyzeResponse(
        engineVersion=ENGINE_VERSION,
        language=language,
        errors=errors,
        summary=summarize(errors, text, language),
    )


class _NoTextError(Exception):
    """OCR 抽不出任何文字（空白頁/解析度過低）→ API 層轉 422。"""


def _image_bytes_to_pdf(data: bytes) -> bytes:
    """PNG/JPG → 單頁 PDF（OCR 管線以 PDF 為單位）。"""
    import fitz

    filetype = "png" if data[:4] == b"\x89PNG" else "jpg"
    with fitz.open(stream=data, filetype=filetype) as img:
        return img.convert_to_pdf()


def _page_type(data: bytes) -> str:
    """粗測：任一頁 PyMuPDF 抽得到字 → digital，否則 scanned。"""
    import fitz

    with fitz.open(stream=data, filetype="pdf") as doc:
        for page in doc:
            if page.get_text().strip():
                return "digital"
    return "scanned"


def analyze_file(
    data: bytes,
    filename: str,
    language: str,
    spell_correct: bool,
    annotate: bool,
    engine: Optional[Any] = None,
) -> AnalyzeFileResponse:
    check_language(language)
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext == "png" or ext == "jpg" or ext == "jpeg":
        data = _image_bytes_to_pdf(data)
    elif ext != "pdf":
        raise ValueError(f"unsupported extension: {ext}")

    ocr = build_ocr_engine(language, spell_correct)
    nlp = engine if engine is not None else build_nlp_engine(language)

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        ocr_words: Dict[int, List] = ocr.process_pdf(tmp_path)
        total = sum(len(v) for v in ocr_words.values())
        if total == 0:
            raise _NoTextError()

        from .nlp_engine import NLPEngine

        extracted_text = NLPEngine._words_to_text(ocr_words, language)
        try:
            raw = nlp.analyse(ocr_words)
        except requests.RequestException as exc:
            raise OllamaUnavailable(str(exc)) from exc
        errors = shape_errors(raw, extracted_text)

        annotated_b64: Optional[str] = None
        if annotate:
            from .annotator import Annotator

            out_path = tmp_path.replace(".pdf", "_annotated.pdf")
            Annotator(language=language).annotate_pdf(tmp_path, ocr_words, raw, out_path)
            with open(out_path, "rb") as fh:
                annotated_b64 = base64.b64encode(fh.read()).decode("ascii")

        return AnalyzeFileResponse(
            engineVersion=ENGINE_VERSION,
            language=language,
            errors=errors,
            summary=summarize(errors, extracted_text, language),
            extractedText=extracted_text,
            ocrMeta=OcrMeta(
                pageCount=len(ocr_words),
                pageType=_page_type(data),
                spellCorrected=spell_correct,
            ),
            annotatedPdfBase64=annotated_b64,
        )
    finally:
        for path in (tmp_path, tmp_path.replace(".pdf", "_annotated.pdf")):
            if os.path.exists(path):
                os.unlink(path)
