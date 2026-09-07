"""
nlp_engine.py — Analysis Module (v2)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sends the full essay text to Phi-3 (via Ollama JSON mode) for proofreading.

Key improvements over v1:
  • Stricter system prompt with explicit examples — extracts all errors, not 1
  • Chunked processing for long essays (avoids Phi-3 context overflow)
  • 3-tier fault-tolerant JSON parser handles wrapped / embedded / line-by-line
  • Deduplication of repeated errors across chunks
  • analyse_text() convenience method for plain strings

Output format:
    [
      {"original": "intresting",   "type": "spelling", "suggestion": "interesting"},
      {"original": "eats",         "type": "grammar",  "suggestion": "eat"},
      {"original": "smells like a trash", "type": "semantic", "suggestion": "smells like trash"},
      ...
    ]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

import json
import logging
import os
import re
import time
import requests
from typing import Union

from .language_prompts import (
    DEFAULT_LANGUAGE,
    get_system_prompt,
    is_no_space,
    normalize as normalize_language,
)

logger = logging.getLogger(__name__)

# ── Ollama / Phi-3 config ─────────────────────────────────────────────────────
OLLAMA_URL   = os.getenv("OLLAMA_URL", "http://localhost:11434/api/generate")
MODEL_NAME   = os.getenv("OLLAMA_MODEL", "phi3")
LANGUAGE     = os.getenv("EAT_LANGUAGE", DEFAULT_LANGUAGE)   # default grading language
TEMPERATURE  = 0.0
MAX_TOKENS   = 4096
CHUNK_WORDS  = 200     # split space-delimited essays longer than this many words
CHUNK_CHARS  = 350     # split non-space scripts (zh/ja) longer than this many chars

# ── Prompts ───────────────────────────────────────────────────────────────────
# NOTE: "format":"json" is intentionally NOT used — it causes Phi-3 to collapse
# all errors into one object.  Plain-text mode with a strict few-shot prompt
# produces correct per-error objects for small models.
#
# The per-language grading rubrics ("評判標準") live in language_prompts.py.
# SYSTEM_PROMPT is kept as the English default for backward compatibility;
# NLPEngine(language=...) selects the right rubric at construction time.

SYSTEM_PROMPT = get_system_prompt(DEFAULT_LANGUAGE)

class NLPEngine:
    """
    Wraps Ollama Phi-3 for essay proofreading.

    Usage:
        engine = NLPEngine()
        errors = engine.analyse(ocr_words)      # pass OCREngine output dict
        errors = engine.analyse_text("She go…") # or a plain string
    """

    def __init__(self, model: str = MODEL_NAME, ollama_url: str = OLLAMA_URL,
                 language: str = LANGUAGE):
        self.model         = model
        self.ollama_url    = ollama_url
        self.language      = normalize_language(language)
        self.system_prompt = get_system_prompt(self.language)
        logger.info(
            f"NLPEngine ready  model={self.model}  lang={self.language}  "
            f"url={self.ollama_url}"
        )

    # ── text preparation ──────────────────────────────────────────────────────

    @staticmethod
    def _words_to_text(ocr_words: Union[list, dict],
                       language: str = DEFAULT_LANGUAGE) -> str:
        """Flatten OCREngine output → plain text string.

        Non-space scripts (Chinese, Japanese) are joined WITHOUT spaces so the
        reconstructed essay stays faithful and the model's character-level
        'original' spans still match the essay text.
        """
        if isinstance(ocr_words, dict):
            flat = []
            for pg in sorted(ocr_words.keys()):
                flat.extend(ocr_words[pg])
            ocr_words = flat
        sep = "" if is_no_space(language) else " "
        return sep.join(w["text"] for w in ocr_words if w.get("text", "").strip())

    @staticmethod
    def _chunk_text(text: str, language: str = DEFAULT_LANGUAGE) -> list:
        """
        Split text into overlapping sentence-boundary chunks so the model can
        analyse each piece without losing context across sentence borders.

        • Space-delimited languages are budgeted by word count (CHUNK_WORDS).
        • Non-space scripts (zh/ja) are budgeted by character count
          (CHUNK_CHARS) and split on CJK sentence punctuation (。！？) too.
        """
        no_space  = is_no_space(language)
        max_units = CHUNK_CHARS if no_space else CHUNK_WORDS
        sep       = "" if no_space else " "
        size      = (lambda s: len(s)) if no_space else (lambda s: len(s.split()))

        # Split after western ". ! ?" (followed by space) or CJK "。！？".
        sentences = re.split(r'(?<=[.!?])\s+|(?<=[。！？])\s*', text.strip())
        sentences = [s for s in sentences if s and s.strip()]

        chunks, current, current_units = [], [], 0
        for sent in sentences:
            u = size(sent)
            if current_units + u > max_units and current:
                chunks.append(sep.join(current))
                # keep last sentence as overlap context
                current       = [current[-1], sent]
                current_units = sum(size(x) for x in current)
            else:
                current.append(sent)
                current_units += u

        if current:
            chunks.append(sep.join(current))

        return chunks or [text]

    # ── Ollama call ───────────────────────────────────────────────────────────

    def _call_ollama(self, text: str, chunk_index: int = 0, total_chunks: int = 0) -> str:
        """POST to Ollama /api/generate, return raw response string.

        Retries once on transient failures (5xx / dropped connection).
        """
        word_count = len(text.split())
        logger.info(
            f"  Calling Ollama chunk {chunk_index}/{total_chunks} "
            f"({word_count} words, model={self.model}) …"
        )
        payload = {
            "model":   self.model,
            "prompt":  text,
            "system":  self.system_prompt,
            "stream":  False,
            "options": {
                "temperature": TEMPERATURE,
                "num_predict": MAX_TOKENS,
            },
        }

        last_exc = None
        for attempt in (1, 2):
            t0 = time.time()
            try:
                resp = requests.post(self.ollama_url, json=payload, timeout=600)
            except requests.exceptions.ConnectionError as exc:
                if attempt == 1:
                    logger.warning("  Ollama connection dropped — retrying in 2s …")
                    last_exc = exc
                    time.sleep(2)
                    continue
                raise RuntimeError(
                    "Cannot reach Ollama.  Start it first:  ollama serve\n"
                    f"Then pull the model:                   ollama pull {self.model}"
                )
            except requests.exceptions.ReadTimeout:
                elapsed = time.time() - t0
                logger.error(
                    f"  Ollama read timeout after {elapsed:.0f}s "
                    f"(chunk {chunk_index}/{total_chunks}, {word_count} words).\n"
                    f"  Try: restart Ollama with 'ollama serve' or use a smaller model."
                )
                raise

            if resp.status_code == 404:
                raise RuntimeError(
                    f"Ollama model {self.model!r} not found.  "
                    f"Pull it first:  ollama pull {self.model}"
                )
            if resp.status_code >= 500 and attempt == 1:
                logger.warning(
                    f"  Ollama server error {resp.status_code} — retrying in 2s …"
                )
                time.sleep(2)
                continue
            resp.raise_for_status()

            elapsed = time.time() - t0
            try:
                data = resp.json()
            except ValueError:
                logger.error(
                    f"  Ollama returned non-JSON response "
                    f"({len(resp.text)} chars) — skipping chunk."
                )
                return ""
            raw = data.get("response", "")
            logger.info(f"  Ollama responded in {elapsed:.1f}s  ({len(raw)} chars)")
            return raw

        raise RuntimeError(f"Ollama request failed after retry: {last_exc}")

    # ── fault-tolerant JSON parser ────────────────────────────────────────────

    @staticmethod
    def _parse(raw: str) -> list:
        """
        Extract a JSON array from the model response.
        Handles: pure array, dict wrapper, JSON embedded in prose, line-by-line.
        """
        raw = raw.strip()
        if not raw:
            return []

        # Tier 1: direct parse
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return parsed
            if isinstance(parsed, dict):
                for key in ("errors", "results", "corrections", "issues", "data"):
                    if isinstance(parsed.get(key), list):
                        return parsed[key]
                if "original" in parsed:
                    return [parsed]
                # flatten all list values
                out = []
                for v in parsed.values():
                    if isinstance(v, list):
                        out.extend(v)
                return out
        except json.JSONDecodeError:
            pass

        # Tier 2: extract outermost [...] block
        m = re.search(r'\[.+\]', raw, re.DOTALL)
        if m:
            try:
                return json.loads(m.group())
            except json.JSONDecodeError:
                pass

        # Tier 3: line-by-line objects
        items = []
        for line in raw.splitlines():
            line = line.strip().rstrip(",")
            if line.startswith("{") and line.endswith("}"):
                try:
                    obj = json.loads(line)
                    if isinstance(obj, dict) and "original" in obj:
                        items.append(obj)
                except json.JSONDecodeError:
                    continue
        if items:
            return items

        # Tier 4: Phi-3 collapsed all errors into one object with list-as-string values
        # e.g. {"original": "[\'intresting\',\'peoples\']", "suggestion": "[\'interesting\',\'people\']"}
        try:
            collapsed = json.loads(raw)
            if isinstance(collapsed, dict):
                def _to_list(val):
                    if isinstance(val, list):
                        return [str(v).strip() for v in val]
                    inner = re.findall(r"[\'\"](.*?)[\'\"]", str(val))
                    return inner
                originals   = _to_list(collapsed.get("original",   []))
                types_      = _to_list(collapsed.get("type",       []))
                suggestions = _to_list(collapsed.get("suggestion", []))
                if originals:
                    result = []
                    for idx, orig in enumerate(originals):
                        result.append({
                            "original":   orig,
                            "type":       types_[idx]       if idx < len(types_)       else "grammar",
                            "suggestion": suggestions[idx]  if idx < len(suggestions)  else "",
                        })
                    logger.debug(f"  Tier 4 recovered {len(result)} error(s) from collapsed object")
                    return result
        except Exception as exc:
            logger.debug(f"  Tier 4 collapsed-object recovery failed: {exc}")

        logger.warning("Could not parse model response — skipping chunk.")
        logger.debug(f"  Raw: {raw[:400]}")
        return []


    @staticmethod
    def _validate(errors: list, language: str = DEFAULT_LANGUAGE) -> list:
        """
        Normalise and deduplicate error entries.

        Phi-3 may return items in several shapes:
          dict  {"original": "x", "type": "spelling", "suggestion": "y"}  <- ideal
          list  ["x", "spelling", "y"]   (3 elements)
          list  ["x", "y"]               (2 elements, type inferred)
          list  [{...}, {...}]            (nested dicts  - flatten first)
        All shapes are coerced to the canonical dict form.
        """
        valid_types = {"spelling", "grammar", "semantic"}
        seen, out   = set(), []

        # Expand top-level nested lists into a flat sequence
        flat_errors = []
        for item in errors:
            if isinstance(item, list):
                if item and isinstance(item[0], dict):
                    flat_errors.extend(item)   # list-of-dicts -> flatten
                else:
                    flat_errors.append(item)   # list-of-strings -> keep
            else:
                flat_errors.append(item)

        for item in flat_errors:
            # coerce list -> dict
            if isinstance(item, list):
                strings = [str(el).strip() for el in item if el is not None]
                if len(strings) >= 3:
                    item = {"original": strings[0], "type": strings[1], "suggestion": strings[2]}
                elif len(strings) == 2:
                    item = {"original": strings[0], "type": "grammar", "suggestion": strings[1]}
                else:
                    continue

            if not isinstance(item, dict):
                continue

            original   = str(item.get("original",   "") or "").strip()
            error_type = str(item.get("type",        "") or "").strip().lower()
            suggestion = str(item.get("suggestion",  "") or "").strip()

            if not original:
                continue
            # Reject sentences masquerading as errors (model hallucination).
            # Space-delimited: a real error token is at most 6 words long.
            # Non-space scripts (zh/ja): .split() sees the whole phrase as one
            # token, so cap by character count instead.
            too_long = (len(original) > 12 if is_no_space(language)
                        else len(original.split()) > 6)
            if too_long:
                logger.debug(f"  Skipping over-long error: {original!r}")
                continue
            if error_type not in valid_types:
                error_type = "grammar"
            if original in seen:
                continue
            seen.add(original)

            out.append({
                "original":   original,
                "type":       error_type,
                "suggestion": suggestion,
            })
        return out

    @staticmethod
    def _filter_useless(errors: list) -> list:
        """Remove errors where suggestion is identical to original (no-op)."""
        kept = []
        for e in errors:
            orig = e.get("original", "").strip()
            sugg = e.get("suggestion", "").strip()
            if orig.lower() == sugg.lower():
                logger.debug(f"  Filtered no-op: {orig!r} -> {sugg!r}")
                continue
            kept.append(e)
        if len(kept) < len(errors):
            logger.info(f"  Filtered {len(errors) - len(kept)} no-op(s)")
        return kept

    @staticmethod
    def _filter_hallucinations(errors: list, text: str,
                               language: str = DEFAULT_LANGUAGE) -> list:
        """
        Remove errors whose 'original' text does NOT appear verbatim (case-insensitive)
        in the essay text.  Phi-3 often emits errors from its few-shot prompt examples
        that don't exist in the actual essay — this filter catches those.

        For non-space scripts (zh/ja), spaces are ignored on both sides so a
        character span still matches even if OCR token-joining introduced gaps.
        """
        if not errors:
            return []
        no_space = is_no_space(language)

        def _norm(s: str) -> str:
            s = s.lower()
            return re.sub(r"\s+", "", s) if no_space else s

        text_cmp = _norm(text)
        kept = []
        for e in errors:
            orig = e.get("original", "").strip()
            if not orig:
                continue
            if _norm(orig) in text_cmp:
                kept.append(e)
            else:
                logger.debug(f"  Filtered hallucination: {orig!r} not in essay text")
        if len(kept) < len(errors):
            logger.info(f"  Filtered {len(errors) - len(kept)} hallucination(s)")
        return kept

    # ── public API ────────────────────────────────────────────────────────────

    def analyse_text(self, text: str) -> list:
        """
        Proofread a plain text string.
        Long essays are chunked; results are merged and deduplicated.
        """
        text = text.strip()
        if not text:
            return []

        chunks  = self._chunk_text(text, self.language)
        all_err = []

        for i, chunk in enumerate(chunks):
            logger.info(
                f"  Analysing chunk {i+1}/{len(chunks)}  "
                f"({len(chunk.split())} words) …"
            )
            raw    = self._call_ollama(chunk, chunk_index=i + 1, total_chunks=len(chunks))
            errors = self._parse(raw)
            all_err.extend(errors)
            logger.info(f"  Chunk {i+1}/{len(chunks)}: {len(errors)} error(s)")

        final = self._validate(all_err, self.language)
        final = self._filter_hallucinations(final, text, self.language)
        final = self._filter_useless(final)
        logger.info(f"Analysis complete: {len(final)} error(s)")
        return final

    def analyse(self, ocr_words: Union[list, dict]) -> list:
        """
        Proofread from OCREngine output.

        Dict input (page → words) is analysed page by page and each error is
        tagged with its page number, so the annotator only marks the page the
        error was actually found on — the same words used correctly on
        another page stay untouched.
        """
        if isinstance(ocr_words, list):
            return self.analyse_text(self._words_to_text(ocr_words, self.language))

        pages = {pg: self._words_to_text(ocr_words[pg], self.language).strip()
                 for pg in sorted(ocr_words.keys())}
        if not any(pages.values()):
            logger.warning("Empty OCR text — nothing to analyse.")
            return []

        all_errors = []
        for pg, page_text in pages.items():
            if not page_text:
                continue
            logger.info(
                f"Analysing page {pg + 1}  ({len(page_text.split())} words) …"
            )
            errors = self.analyse_text(page_text)
            for e in errors:
                e["page"] = pg
            all_errors.extend(errors)
        return all_errors


# ── CLI smoke-test ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO,
                        format="%(levelname)-7s %(name)s  %(message)s")

    engine = NLPEngine()

    # Built-in test (matches the essay visible in the screenshot)
    test_essay = (
        "Living ."
    )

    print("─── Essay ────────────────────────────────────────")
    print(test_essay[:200], "…")
    print("\n─── Errors ───────────────────────────────────────")

    errors = engine.analyse_text(test_essay)
    for e in errors:
        print(f"  [{e['type']:8s}]  {e['original']!r:30s} → {e['suggestion']!r}")

    if len(sys.argv) > 1:
        import json as _json
        with open(sys.argv[1], encoding="utf-8") as f:
            ocr = {int(k): v for k, v in _json.load(f).items()}
        errors = engine.analyse(ocr)
        out = sys.argv[1].replace("_ocr.json", "_errors.json")
        with open(out, "w", encoding="utf-8") as f:
            _json.dump(errors, f, ensure_ascii=False, indent=2)
        print(f"\nSaved → {out}")