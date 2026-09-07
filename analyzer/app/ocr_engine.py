"""
ocr_engine.py — Base Module (v3 — RapidOCR)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Auto-detects page type and picks the best extraction strategy:

  ┌──────────────────┬─────────────────────────────────────────────────────┐
  │ Page type        │ Strategy                                            │
  ├──────────────────┼─────────────────────────────────────────────────────┤
  │ Digital PDF      │ PyMuPDF get_text("words") — instant, pixel-perfect  │
  │ Scanned / image  │ RapidOCR  (ONNX Runtime, CPU)                       │
  │ Handwritten      │ RapidOCR  (same path — handles printed handwriting) │
  └──────────────────┴─────────────────────────────────────────────────────┘

Decision rule: if PyMuPDF finds ≥ DIGITAL_THRESHOLD words on a page the page
is treated as digital.  Otherwise the page is rendered to a NumPy image and
fed to RapidOCR.

Output format (identical regardless of source):
    {
      0: [{"text": "word", "box": [[x1,y1],[x2,y1],[x2,y2],[x1,y2]]}, ...],
      1: [...],
    }
All coordinates are in PDF point-space (origin = top-left, 1 pt = 1/72 inch).
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

import fitz  # PyMuPDF ≥ 1.23
import logging
import numpy as np
from PIL import Image

from .language_prompts import (
    DEFAULT_LANGUAGE,
    get_ocr_langs,
    normalize as normalize_language,
)

logger = logging.getLogger(__name__)


def load_rapidocr_engine(use_gpu: bool = True, langs: list = None):
    """Create a RapidOCR engine (ONNX Runtime, CPU by default).

    use_gpu: accepted for API compatibility; RapidOCR favours CPU for
    single-image speed.  GPU config is automatic via ONNX Runtime.
    langs: language list (default ['en']).  Ignored by v3.x which auto-loads
    PP-OCRv6 models covering ch+en by default.
    """
    from rapidocr import RapidOCR

    engine = RapidOCR()
    logger.info(f"RapidOCR loaded  → ONNX Runtime  langs={langs or ['en']}")
    return engine


# ── lazy spell-check loader ─────────────────────────────────────────────────────
_SPELL_CHECKER = None

def _get_spell_checker():
    """Lazy singleton for SpellChecker (pyspellchecker)."""
    global _SPELL_CHECKER
    if _SPELL_CHECKER is None:
        try:
            from spellchecker import SpellChecker
            _SPELL_CHECKER = SpellChecker()
            logger.info("SpellChecker loaded")
        except ImportError:
            logger.warning("pyspellchecker not installed — spell-check disabled")
            _SPELL_CHECKER = False
    return _SPELL_CHECKER


def _spell_correct_word(word: str) -> str:
    """
    If *word* is a known English word → return as-is.
    Otherwise return the closest correction if edit-distance ≤ 2,
    or an empty string (meaning the token is garbage / unreadable OCR).
    When spell-checker is unavailable, returns the word unchanged.
    """
    spell = _get_spell_checker()
    if spell is False:
        return word
    if word in spell:
        return word
    candidates = spell.candidates(word)
    if not candidates:
        return ""
    corrected = spell.correction(word)
    if corrected and corrected != word and len(corrected) >= 2:
        return corrected
    return ""

# ── tunables ──────────────────────────────────────────────────────────────────
DIGITAL_THRESHOLD = 15      # native word count ≥ this → treat page as digital
DIGITAL_DPI       = 150     # render resolution for digital pages
SCAN_DPI          = 300     # render resolution for scanned / handwritten pages
USE_GPU           = True    # attempt GPU; falls back gracefully to CPU
CONFIDENCE_THRESHOLD = 0.4


class OCREngine:
    """
    Hybrid text extractor.

    RapidOCR is imported lazily — digital-only PDFs never pay the
    ONNX Runtime startup cost.

    Usage:
        engine    = OCREngine()
        ocr_words = engine.process_pdf("essay.pdf")
        # ocr_words[0] → [{text, box}, ...]  for page 0
    """

    def __init__(self, use_gpu: bool = USE_GPU, spell_correct: bool = True,
                 language: str = DEFAULT_LANGUAGE):
        self.use_gpu   = use_gpu
        self.language  = normalize_language(language)
        self.ocr_langs = get_ocr_langs(self.language)
        # Dictionary spell-correction uses an English dictionary, so only apply
        # it for English essays — running it on other languages would "correct"
        # valid foreign words into English garbage.
        self.spell_correct = spell_correct and self.language == "en"
        if spell_correct and not self.spell_correct:
            logger.info(
                f"  OCR spell-correction disabled for language={self.language} "
                "(English-only dictionary)"
            )
        self._engine = None   # RapidOCR engine, loaded on first scanned/HW page
        logger.info(
            f"OCREngine ready  lang={self.language}  ocr_langs={self.ocr_langs}  "
            "(auto-detect: digital=PyMuPDF | scan/HW=RapidOCR)"
        )

    # ── lazy RapidOCR loader ──────────────────────────────────────────────────

    def _get_reader(self):
        """Load RapidOCR once (ONNX Runtime, CPU)."""
        if self._engine is None:
            self._engine = load_rapidocr_engine(self.use_gpu, self.ocr_langs)
        return self._engine

    # ── digital extraction (PyMuPDF) ──────────────────────────────────────────

    @staticmethod
    def _extract_digital(page: fitz.Page) -> list:
        """
        PyMuPDF word-level extraction.

        page.get_text("words") yields tuples:
            (x0, y0, x1, y1, "word", block_no, line_no, word_no)
        We convert the axis-aligned rect to a 4-corner polygon so the
        output schema matches RapidOCR's [[x1,y1],[x2,y1],[x2,y2],[x1,y2]].
        """
        words = []
        for entry in page.get_text("words"):
            x0, y0, x1, y1 = entry[0], entry[1], entry[2], entry[3]
            text = entry[4].strip()
            if not text:
                continue
            box = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
            words.append({"text": text, "box": box})
        return words

    # ── scanned / handwritten extraction (RapidOCR) ──────────────────────────

    def _extract_easyocr(self, page: fitz.Page, dpi: int = SCAN_DPI) -> list:
        """
        Render page → RapidOCR → scale boxes to PDF point-space.
        """
        zoom   = dpi / 72
        mat    = fitz.Matrix(zoom, zoom)
        pix    = page.get_pixmap(matrix=mat, alpha=False)
        img    = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        arr    = np.array(img)  # RGB numpy array

        h_img, w_img = arr.shape[:2]
        scale_x      = page.rect.width  / w_img
        scale_y      = page.rect.height / h_img

        engine = self._get_reader()
        result = engine(arr)  # RapidOCR → RapidOCROutput(boxes, txts, scores)

        words = []
        if result.boxes is not None and len(result.boxes) > 0:
            for raw_box, text, conf in zip(result.boxes, result.txts, result.scores):
                text = text.strip()
                if not text or conf < CONFIDENCE_THRESHOLD:
                    continue
                box = [[pt[0] * scale_x, pt[1] * scale_y] for pt in raw_box]
                words.append({"text": text, "box": box})

        # spell-check post-processing — filter / correct OCR garbage.
        # Optional: correcting here also erases genuine spelling errors the
        # LLM is supposed to flag, so callers can disable it (spell_correct=False).
        if not self.spell_correct:
            logger.debug(
                f"  RapidOCR: {len(words)} words (spell-correction disabled, "
                f"conf ≥ {CONFIDENCE_THRESHOLD})"
            )
            return words

        cleaned = []
        for w in words:
            corrected = _spell_correct_word(w["text"])
            if corrected:
                w["text"] = corrected
            cleaned.append(w)

        logger.debug(
            f"  RapidOCR: {len(cleaned)} words after spell-check "
            f"(was {len(words)}, conf ≥ {CONFIDENCE_THRESHOLD})"
        )
        return cleaned

    # ── per-page dispatch ─────────────────────────────────────────────────────

    def process_page(self, page: fitz.Page) -> list:
        """
        Auto-detect page type and extract words.

        Steps:
          1. Run PyMuPDF native extraction.
          2. If ≥ DIGITAL_THRESHOLD words found → digital mode (return now).
          3. Otherwise → RapidOCR (scanned or handwritten).

        Heuristic: pages with DIGITAL_THRESHOLD ≤ count < 2× threshold whose
        native words are mostly short / numeric (page numbers, headers) are
        re-routed to RapidOCR even if the raw count passes the threshold.
        """
        native = self._extract_digital(page)

        if len(native) >= DIGITAL_THRESHOLD:
            # guard against handwritten pages with embedded page furniture
            if len(native) < DIGITAL_THRESHOLD * 2:
                short = sum(1 for w in native if len(w["text"]) <= 3 or w["text"].isdigit())
                ratio = short / max(len(native), 1)
                if ratio > 0.6:
                    logger.info(
                        f"  Page {page.number + 1}: LOW-QUALITY DIGITAL "
                        f"({len(native)} words, {ratio:.0%} short/numeric → "
                        f"falling back to RapidOCR @ {SCAN_DPI} DPI)"
                    )
                    return self._extract_easyocr(page, dpi=SCAN_DPI)

            logger.info(
                f"  Page {page.number + 1}: DIGITAL  "
                f"({len(native)} words via PyMuPDF)"
            )
            return native

        logger.info(
            f"  Page {page.number + 1}: SCAN/HANDWRITTEN  "
            f"(only {len(native)} native words → RapidOCR @ {SCAN_DPI} DPI)"
        )
        return self._extract_easyocr(page, dpi=SCAN_DPI)

    # ── public API ────────────────────────────────────────────────────────────

    def process_pdf(self, pdf_path: str) -> dict:
        """
        Process all pages of a PDF.

        Returns:
            { page_index: [{"text": str, "box": [[x1,y1],...]}, ...] }
        """
        doc    = fitz.open(pdf_path)
        try:
            output = {}

            for page_num in range(len(doc)):
                logger.info(f"Processing page {page_num + 1}/{len(doc)} …")
                output[page_num] = self.process_page(doc[page_num])

            total = sum(len(v) for v in output.values())
            logger.info(f"OCR complete: {total} words across {len(output)} page(s)")
            return output
        finally:
            doc.close()


# ── CLI smoke-test ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import sys, json
    logging.basicConfig(level=logging.INFO,
                        format="%(levelname)-7s %(name)s  %(message)s")

    if len(sys.argv) < 2:
        print("Usage: python ocr_engine.py <essay.pdf> [--json]")
        sys.exit(1)

    engine  = OCREngine()
    results = engine.process_pdf(sys.argv[1])

    for pg, words in results.items():
        print(f"\n=== Page {pg}  ({len(words)} words) ===")
        for w in words[:15]:
            print(f"  {w['text']!r:30s}  box_tl={w['box'][0]}")

    if "--json" in sys.argv:
        out = sys.argv[1].replace(".pdf", "_ocr.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"\nSaved → {out}")
