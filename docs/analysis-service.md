# 作文分析服務契約 — Project-EAT Sidecar（M0 定稿）

> 本文定義 NestJS backend 與 Python 分析 sidecar（`analyzer/`）之間的介面契約。實作於 M4；契約變更需同時更新本文、`docs/openapi.yaml`（Analysis 標籤）與 `infrastructure/analyzer-client`。

## 1. 定位與邊界

```
modules/analysis（NestJS）              analyzer sidecar（FastAPI）
┌─────────────────────────┐            ┌──────────────────────────────┐
│ 決策層：                 │            │ 執行層（同步運算，無狀態）：    │
│  - 是否允許觸發分析       │   HTTP     │  - OCR（RapidOCR / PyMuPDF）  │
│  - AnalysisStatus 流轉   │ ────────▶ │  - LLM 批改（Ollama）         │
│  - 重試策略 / 並發上限    │            │  - 標註 PDF 產生              │
│  - 結果落庫（Prisma）     │            │  - 不落庫、不管佇列            │
└─────────────────────────┘            └──────────────────────────────┘
```

- sidecar **不對外曝露**：只在 docker internal network 監聽（預設 `http://analyzer:8000`），所有 `/internal/*` 端點要求 header `X-Internal-Token: <ANALYZER_INTERNAL_TOKEN>`。
- sidecar **無狀態**：不存任何業務資料；失敗重試、狀態機、歷史紀錄全在 backend（`separate decision from actions`）。
- 檔案不經 backend 中轉：backend 先從 MinIO 取得物件串流，直接以 multipart 轉送 sidecar；回傳的標註 PDF 由 backend 寫回 MinIO 並記 `annotatedPdfKey`。

## 2. 端點定義

### 2.1 `GET /internal/health`

```json
{ "status": "ok", "ollama": "reachable", "model": "phi3", "engineVersion": "1.0.0" }
```

`ollama` 回 `reachable` / `unreachable`。backend 啟動時與每次分析前探測；unreachable 時不觸發任務，直接 FAILED（`ANALYSIS_ENGINE_UNAVAILABLE`）。

### 2.2 `POST /internal/analyze` — 純文字批改（同步）

**Request** `application/json`

```json
{
  "text": "My freind like to eating apples...",
  "language": "en",
  "model": "phi3"
}
```

| 欄位 | 型別 | 必填 | 說明 |
|------|------|------|------|
| text | string | ✅ | 作文本文（≤ 20,000 字；超長由 backend 先拒絕） |
| language | string | ❌ | ISO code，預設 `en`；支援 `en / zh-Hant / zh-Hans / ja / ko / es / fr / de` |
| model | string | ❌ | Ollama 模型覆寫；預設用 sidecar 環境變數 `OLLAMA_MODEL` |

**Response 200** `application/json`

```json
{
  "engineVersion": "1.0.0",
  "language": "en",
  "errors": [
    {
      "type": "spelling",
      "original": "freind",
      "suggestion": "friend",
      "explanation": null,
      "offset": 3,
      "length": 6
    },
    {
      "type": "grammar",
      "original": "like to eating",
      "suggestion": "likes to eat",
      "explanation": null,
      "offset": 9,
      "length": 14
    }
  ],
  "summary": {
    "spellingCount": 1,
    "grammarCount": 1,
    "semanticCount": 0,
    "wordCount": 7
  }
}
```

| 欄位 | 說明 |
|------|------|
| errors[].type | `spelling` / `grammar` / `semantic`（沿用 Project-EAT 三分類） |
| errors[].original | 原文錯誤片段 |
| errors[].suggestion | 建議修正 |
| errors[].explanation | 給學生的中文說明；**v1 為 null**（LLM prompt 尚未要求），M4+ 可由 prompt 擴充產出 |
| errors[].offset / length | 相對 `text` 的字元位置（sidecar 以字串定位計算；找不到唯一位置時 offset = -1） |
| summary.wordCount | 依語言切分（中文按字元、英文按空白） |

**對應 Project-EAT 程式**：`NLPEngine.analyse_text(text)`（`nlp_engine.py`）。輸出 dict 原生即 `{original, type, suggestion}`；offset/length 與 summary 由 sidecar 包裝層新增計算。

### 2.3 `POST /internal/analyze-file` — 檔案批改（OCR + 標註 PDF，同步長運算）

**Request** `multipart/form-data`

| 欄位 | 型別 | 必填 | 說明 |
|------|------|------|------|
| file | binary | ✅ | PDF / PNG / JPG（≤ 20 MB） |
| language | string | ❌ | 同上 |
| spellCorrect | boolean | ❌ | OCR 拼字校正；**預設 `false`**——學生作文要保留真實拼字錯誤，校正會抹掉（Project-EAT README 明示此 trade-off），僅教師清掃講義等場景開 `true` |
| annotate | boolean | ❌ | 是否產生標註 PDF，預設 `true` |

**Response 200** `application/json`

```json
{
  "engineVersion": "1.0.0",
  "language": "en",
  "extractedText": "My freind like to eating apples...",
  "errors": [ /* 同 2.2 errors，offset 相對 extractedText */ ],
  "summary": { /* 同 2.2 */ },
  "ocrMeta": {
    "pageCount": 1,
    "pageType": "scanned",
    "spellCorrected": false
  },
  "annotatedPdfBase64": "JVBERi0xLjQK..."
}
```

`annotatedPdfBase64`：annotate=false 時為 `null`。PDF 約數 MB，base64 膨脹 33% 對單篇作文可接受；若未來批次場景變慢，改走 sidecar 直接寫 MinIO（已在開放議題記錄）。

**對應 Project-EAT 程式**：`OCREngine.process_pdf`（`ocr_engine.py`，數位 PDF 走 PyMuPDF、掃描/手寫走 RapidOCR）→ `NLPEngine.analyse(ocr_words)`（`nlp_engine.py`）→ `Annotator`（`annotator.py`，色彩標註 + 側欄）。

### 2.4 錯誤回應（sidecar → backend）

格式與主 API 一致：`{ "error": { "code": "", "message": "", "details": {} } }`

| HTTP | code | 情境 | backend 對應處置 |
|------|------|------|-----------------|
| 400 | `ANALYZER_INVALID_LANGUAGE` | language 不在支援清單 | 任務 FAILED（`ANALYSIS_INVALID_LANGUAGE`），不重試 |
| 400 | `ANALYZER_FILE_TOO_LARGE` | 檔案超限 | FAILED（`ANALYSIS_FILE_TOO_LARGE`），不重試 |
| 415 | `ANALYZER_UNSUPPORTED_MEDIA_TYPE` | 副檔名/格式不支援 | FAILED（同碼），不重試 |
| 422 | `ANALYZER_OCR_NO_TEXT` | OCR 抽不出任何文字（空白頁/解析度過低） | FAILED（`ANALYSIS_OCR_FAILED`），不重試，訊息提示掃描品質 |
| 503 | `ANALYZER_OLLAMA_UNAVAILABLE` | Ollama 連不上 | 重試 1 次（間隔 10s）→ 仍失敗則 FAILED（`ANALYSIS_ENGINE_UNAVAILABLE`） |
| 504 | `ANALYZER_TIMEOUT` | 超過 backend 客戶端 timeout（文字 120s / 檔案 300s） | 同上重試策略 |
| 500 | `ANALYZER_INTERNAL_ERROR` | sidecar 例外 | 重試 1 次 → FAILED（`ANALYSIS_FAILED`），sidecar log 附 stack |

重試策略是 backend 決策層職責（`modules/analysis`），上表為定稿值，實作時以 config 可調。

## 3. Sidecar 實作規格（M4）

```
analyzer/
├── app/
│   ├── main.py              # FastAPI app：三個 /internal 端點、X-Internal-Token 驗證、engineVersion 常數
│   ├── engine_ocr.py        # ← Project-EAT ocr_engine.py 原碼搬入（OCREngine）
│   ├── engine_nlp.py        # ← Project-EAT nlp_engine.py 原碼搬入（NLPEngine）
│   ├── engine_annotator.py  # ← Project-EAT annotator.py 原碼搬入（Annotator）
│   ├── language_prompts.py  # ← Project-EAT language_prompts.py 原碼搬入（LANGUAGES / _OCR_LANGS / _SYSTEM_PROMPTS）
│   └── contracts.py         # Pydantic response models（與本文 1:1）
├── requirements.txt         # fastapi, uvicorn, pymupdf, rapidocr, pillow, numpy, requests, pyspellchecker
├── tests/                   # 契約測試：固定輸入 → 固定 errors JSON 快照
└── Dockerfile
```

搬入原則：

- **原碼優先**：四個引擎檔案從 Project-EAT 逐字搬入（保留演算法與 rubric），只改 import 路徑與移除 CLI/GUI 依賴；`gui.py`、`main.py`（CLI）、`camera/`、`live_camera/`、`pretest_posttest.py` **不搬**。
- **Pydantic 契約**：response model 以 `contracts.py` 為單一真相，欄位名與本文完全一致（snake_case——Python 端維持原生風格，**backend 的 analyzer-client 負責轉成 API 的 camelCase**，轉換只發生在邊界一處）。
- **uvicorn 單 worker**：Ollama 推論本身序列化，多 worker 只會增加記憶體；並發控制由 backend 上限（同時進行中分析 ≤ 3）負責。

## 4. NestJS 整合（M4，介面預留於 M1）

```typescript
// infrastructure/analyzer-client（唯一知道 sidecar 存在的地方）
export interface AnalysisEngine {
  healthCheck(): Promise<EngineHealth>;
  analyzeText(input: TextAnalysisInput): Promise<AnalysisOutput>;
  analyzeFile(input: FileAnalysisInput): Promise<FileAnalysisOutput>;
}
```

- `modules/analysis` 只依賴 `AnalysisEngine` interface（DI 注入），測試用 in-memory fake。
- 分析流程：`POST /v1/submissions/{id}/analyze` → 建立 AnalysisResult(PENDING) → 立即回 202 → 內部 worker 取任務（PROCESSING）→ 呼叫 sidecar → COMPLETED/FAILED 落庫。worker v1 用 NestJS 內建 queue（in-process），不引入 Redis——單實體單教師的量體不需要。
- Ollama 佈置由部署者決定：compose 內建 `ollama` 服務或 `OLLAMA_URL` 指向外部。

## 5. 開放議題

| 議題 | 說明 | 時點 |
|------|------|------|
| explanation 產出 | prompt 擴充要求 LLM 附中文解說，phi3 等小模型品質待驗證 | M4 實驗 |
| 大檔批次 | 標註 PDF 改由 sidecar 直寫 MinIO（需給 scoped credential） | 有批次需求時 |
| 語言別 rubric 差異 | zh-Hant 等 CJK 語言的 offset 計算需按字元（無空格），engine 已有 NO_SPACE_LANGUAGES 處理 | M4 契約測試覆蓋 |
