"""契約測試 — 引擎以 stub 取代（不需 Ollama/RapidOCR 模型下載），CI 可跑。"""

from __future__ import annotations

import base64

import fitz
import pytest
from fastapi.testclient import TestClient

from app import pipeline
from app.main import app


class StubNlp:
    """回傳固定錯誤集，模擬 NLPEngine.analyse_text / analyse。"""

    def analyse_text(self, text: str):
        return [
            {"original": "freind", "type": "spelling", "suggestion": "friend"},
            {"original": "like to eating", "type": "grammar", "suggestion": "likes to eat"},
            {"original": "the", "type": "grammar", "suggestion": "a"},  # 出現多次 → offset -1
            {"original": "", "type": "spelling", "suggestion": "x"},  # 空 original → 捨棄
            {"original": "zzz", "type": "weird", "suggestion": "y"},  # 非法 type → grammar
        ]

    def analyse(self, ocr_words):
        return self.analyse_text("")


@pytest.fixture(autouse=True)
def _stub_engine(monkeypatch):
    monkeypatch.setattr(pipeline, "build_nlp_engine", lambda *a, **k: StubNlp())
    monkeypatch.setattr(pipeline, "check_ollama", lambda: True)


@pytest.fixture(autouse=True)
def _auth(monkeypatch):
    monkeypatch.setattr("app.main.INTERNAL_TOKEN", "test-token")
    app.dependency_overrides.clear()


def client_with_token():
    return TestClient(app, headers={"X-Internal-Token": "test-token"})


def test_health_shape():
    res = client_with_token().get("/internal/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["ollama"] in ("reachable", "unreachable")
    assert body["engineVersion"] == "1.0.0"


def test_analyze_contract_en():
    text = "My freind like to eating the apple and the pear."
    res = client_with_token().post("/internal/analyze", json={"text": text, "language": "en"})
    assert res.status_code == 200
    body: dict = res.json()

    assert body["engineVersion"] == "1.0.0"
    assert body["language"] == "en"
    errors = body["errors"]
    assert len(errors) == 4  # 空 original 被捨棄

    spelling = errors[0]
    assert spelling["type"] == "spelling"
    assert spelling["original"] == "freind"
    assert spelling["suggestion"] == "friend"
    assert spelling["offset"] == text.find("freind")
    assert spelling["length"] == len("freind")
    assert spelling["explanation"] is None

    # 「the」出現多次 → offset = -1
    dup = next(e for e in errors if e["original"] == "the")
    assert dup["offset"] == -1

    # 非法 type → 修正為 grammar
    weird = next(e for e in errors if e["original"] == "zzz")
    assert weird["type"] == "grammar"

    summary = body["summary"]
    assert summary["spellingCount"] == 1
    assert summary["grammarCount"] == 3
    assert summary["semanticCount"] == 0
    assert summary["wordCount"] == len(text.split())


def test_analyze_word_count_zh_hant():
    """CJK 無空格語言按字元計數。"""
    res = client_with_token().post("/internal/analyze", json={"text": "我喜歡蘋果", "language": "zh-Hant"})
    assert res.status_code == 200
    assert res.json()["summary"]["wordCount"] == 5


def test_invalid_language_400():
    res = client_with_token().post("/internal/analyze", json={"text": "hi", "language": "xx"})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "ANALYZER_INVALID_LANGUAGE"


def test_empty_text_400():
    res = client_with_token().post("/internal/analyze", json={"text": "  ", "language": "en"})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "ANALYZER_INVALID_REQUEST"


def test_missing_token_401():
    """_auth fixture 已把 INTERNAL_TOKEN 設為 test-token：無 header → 401 統一格式。"""
    res = TestClient(app).get("/internal/health")
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "ANALYZER_UNAUTHORIZED"


def _blank_pdf() -> bytes:
    doc = fitz.open()
    doc.new_page()
    data = doc.tobytes()
    doc.close()
    return data


def test_analyze_file_no_text_422(monkeypatch):
    """空白數位 PDF：PyMuPDF 抽 0 字 → 422 ANALYZER_OCR_NO_TEXT。"""

    class ZeroOcr:
        def process_pdf(self, path):
            return {0: []}

    monkeypatch.setattr(pipeline, "build_ocr_engine", lambda *a, **k: ZeroOcr())
    res = client_with_token().post(
        "/internal/analyze-file",
        files={"file": ("blank.pdf", _blank_pdf(), "application/pdf")},
        data={"language": "en"},
    )
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "ANALYZER_OCR_NO_TEXT"


def test_analyze_file_unsupported_ext_415():
    res = client_with_token().post(
        "/internal/analyze-file",
        files={"file": ("virus.exe", b"MZ...", "application/x-msdownload")},
        data={"language": "en"},
    )
    assert res.status_code == 415
    assert res.json()["error"]["code"] == "ANALYZER_UNSUPPORTED_MEDIA_TYPE"


def test_annotated_pdf_is_base64(monkeypatch):
    """數位 PDF + stub：檢查 annotatedPdfBase64 可解碼為 PDF。"""

    class DictOcr:
        def process_pdf(self, path):
            # 一個詞，附 PDF 座標框（Annotator 需要）
            return {0: [{"text": "freind", "box": [[50, 50], [90, 50], [90, 70], [50, 70]]}]}

    monkeypatch.setattr(pipeline, "build_ocr_engine", lambda *a, **k: DictOcr())

    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((50, 60), "freind")
    pdf_bytes = doc.tobytes()
    doc.close()

    res = client_with_token().post(
        "/internal/analyze-file",
        files={"file": ("essay.pdf", pdf_bytes, "application/pdf")},
        data={"language": "en"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["extractedText"].strip() == "freind"
    assert body["ocrMeta"]["pageCount"] == 1
    assert body["ocrMeta"]["pageType"] == "digital"
    assert body["summary"]["wordCount"] == 1

    decoded = base64.b64decode(body["annotatedPdfBase64"])
    assert decoded[:5] == b"%PDF-"


def test_pipeline_shape_errors_pure():
    """純函式：shape_errors 的定位邏輯（契約 offset 語意）。"""
    text = "abc def abc"
    errs = pipeline.shape_errors([{"original": "abc", "type": "spelling", "suggestion": "xyz"}], text)
    assert errs[0].offset == -1  # 兩處出現 → 不唯一

    errs2 = pipeline.shape_errors([{"original": "def", "type": "spelling", "suggestion": "xyz"}], text)
    assert errs2[0].offset == 4
    assert errs2[0].length == 3
