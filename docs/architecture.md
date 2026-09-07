# 系統架構（M0 設計文件）

> 狀態：已定稿（M0）。修改本文件需在 PR 中說明原因，並同步更新 `docs/openapi.yaml` 與 `backend/prisma/schema.prisma`。

## 1. 設計目標

- **教師主權部署**：每位教師自架一套完整實例（後端 + 資料庫 + 分析引擎），資料不經過任何中央伺服器。
- **學生跨站使用**：學生端 App 可同時連結多個教師站點，各自持有獨立帳號與 token。
- **作文批改為一級功能**：整合 Project-EAT（Python）為 sidecar 服務，保留 OCR、手寫掃描、標註 PDF 全部能力。
- **一鍵自架**：`docker compose up -d` + `.env` 即完成部署，目標使用者是不具 DevOps 背景的教師。

## 2. 整體架構

```
                        ┌─────────────────────────────────────────────┐
                        │              教師自架實例（docker compose）    │
                        │                                             │
瀏覽器/PWA ── HTTPS ──▶ │  caddy (自動 TLS, 反向代理)                  │
                        │    ├── /              → frontend 靜態檔      │
                        │    ├── /v1/api/*     → backend (NestJS)      │
                        │    └── /v1/files/*   → minio (presigned)     │
                        │                                             │
                        │  backend (NestJS)                           │
                        │    ├── REST API /v1/*                       │
                        │    ├── JWT auth (access + refresh)          │
                        │    ├── analysis 拍排程 ── HTTP ──┐           │
                        │    └── Prisma ──────▶ postgres  │           │
                        │                                  ▼           │
                        │  analyzer (FastAPI sidecar, Project-EAT)     │
                        │    ├── OCR (RapidOCR / PyMuPDF)              │
                        │    ├── LLM 批改（呼叫 Ollama）                 │
                        │    └── 標註 PDF 產生                          │
                        │                                              │
                        │  postgres ── 業務資料（唯一真相來源）           │
                        │  minio ──── 檔案（附件、作文、標註 PDF）        │
                        └─────────────────────────────────────────────┘

學生端 App（同一套 static frontend，多站模式）
  ├── 伺服器 A (教師甲) ── 各自持有 JWT
  ├── 伺服器 B (教師乙)
  └── 伺服器 C (教師丙)
```

要點：

- **analyzer sidecar 不對外曝露**：僅接受來自 backend 的內部 HTTP 呼叫（docker network 內隔離，不掛在 caddy 後面）。
- **Ollama 由教師自行決定部署方式**：可與 analyzer 同容器、獨立容器（compose 內 `ollama` 服務）或外部機器（`OLLAMA_URL` 環境變數指向）。analyzer 對 Ollama 不可用時回傳明確錯誤碼，backend 將分析任務標記為 FAILED。
- **檔案存取走 presigned URL**：上傳/下載直接對 minio 簽發短期 URL，大型檔案不經過 backend 轉發。

## 3. 技術棧（定稿）

| 類別 | 選擇 | 決策理由 |
|------|------|----------|
| 後端框架 | NestJS (Node.js + TypeScript) | 模組化、DI、OpenAPI 自動生成、生態成熟 |
| 前端 | Vite + React（SPA，兩個獨立 app：教師端、學生端） | 純靜態檔案，Caddy 直接服務，自架部署最輕 |
| 資料庫 | PostgreSQL 16 | 業務資料唯一真相來源 |
| ORM | Prisma | 型別安全、migration 工具鏈完整 |
| 檔案儲存 | MinIO（S3 相容） | 自架、可換成任何 S3 endpoint |
| 分析引擎 | FastAPI sidecar（移植 Project-EAT） | 保留 Python OCR/PDF 生態系，見 `analysis-service.md` |
| LLM 推理 | Ollama（HTTP API） | 教師可自選模型大小與硬體 |
| 反向代理 | Caddy | 自動 HTTPS（Let's Encrypt），零設定 |
| 認證 | JWT access token（15 分鐘）+ refresh token（30 天，可撤銷，DB 記錄 hash） | 無狀態驗證 + 可控撤銷 |

## 4. 跨站連結機制（學生端多伺服器）

### 4.1 Discovery

每個實例提供公開端點（不需認證）：

```
GET /v1/discovery
→ 200 {
  "serverName": "王老師的英文課",
  "teacherName": "王小明",
  "school": "某某高中",
  "apiVersion": "v1",
  "softwareVersion": "1.0.0",
  "description": "...",
  "features": ["essay-analysis", "grade-export"]
  }
```

學生新增伺服器時，App 呼叫此端點：2 秒 timeout，回應通過 schema 驗證即視為可用，顯示 `serverName` 供確認。

### 4.2 多站資料模型（學生端 App 本地）

```
servers: [{ serverId(url), displayName, apiVersion, addedAt }]
credentials: { [url]: { accessToken, refreshToken, userId, expiresAt } }
```

- 每個伺服器的 token 分開儲存，切換伺服器即切換 base URL + token 組合。
- App 端**不快取業務資料**（作業、成績一律即時拉取），避免多站資料一致性問題。
- 路徑統一為 `/v1/*`。原規劃書 4.2 節的 `/api/v1/discovery` 與第 7 節 API 表不一致，**定稿採 `/v1/*`**，caddy 將 `/v1/api/*` 轉發 backend 時剝除前綴（見部署節）。

### 4.3 中央目錄（未實作，預留）

未來可提供公開目錄服務讓學生搜尋教師站點。目錄只存 discovery 資訊的快取，不參與認證。M1–M8 不實作。

## 5. 部署拓撲（docker-compose 服務）

| 服務 | image | 對外 | 說明 |
|------|-------|------|------|
| `caddy` | caddy:2 | 80/443 | 自動 TLS；路由靜態檔、`/v1/api/*`、minio presigned 路徑 |
| `backend` | 自建 (NestJS) | 僅內部 | REST API；健康檢查 `/v1/health` |
| `analyzer` | 自建 (FastAPI) | 僅內部 | Project-EAT 引擎；健康檢查 `/internal/health` |
| `postgres` | postgres:16 | 僅內部 | 掛 volume `pgdata` |
| `minio` | minio/minio-server | 僅內部（presigned 經 caddy） | 掛 volume `miniodata` |
| `ollama`（選配） | ollama/ollama | 僅內部 | 不想內建可設 `OLLAMA_URL` 指向外部 |

- `frontend-teacher` 與 `frontend-student` 建置產物為靜態檔，直接放進 caddy 容器（`/teacher`、`/student` 兩個路徑，或由 `.env` 選擇單一合併 app）。**定稿：單一合併 app，登入後依角色顯示教師或學生介面**——降低自架者設定負擔，多站學生模式本來就需要同一份前端。
- `.env` 必要變數：`DOMAIN`、`POSTGRES_PASSWORD`、`JWT_SECRET`、`MINIO_ROOT_*`、`OLLAMA_URL`（預設 `http://ollama:11434`）、`ANALYZER_URL`（預設 `http://analyzer:8000`）。

## 6. 認證與權限

### 6.1 帳號模型

- **教師**：Email 註冊（email + password）。單一實例預期一位教師（部署者），但 schema 支援多位（未來補習班情境）。LINE 登入為 M5+ 選配。
- **學生**：兩種建立路徑——(a) 教師建立（給予帳號 + 預設密碼或邀請碼）；(b) 學生以班級邀請碼自助註冊。學生帳號僅存在於該教師實例。
- **助教**：教師指派既有使用者 `role = ASSISTANT`，可代批改，權限邊界見 `data-model.md`。

### 6.2 Token 流程

```
login → access token (JWT, 15min, 內含 userId/role) + refresh token (30d, DB 存 sha256 hash)
API 呼叫 → Authorization: Bearer <access>
access 過期 → POST /v1/auth/refresh（帶 refresh）→ 新 access（可輪替 refresh）
logout → 撤銷該 refresh token（DB 標記 revokedAt）
```

- Refresh token 採 rotation：每次 refresh 發新的、作廢舊的，偵測重用即撤銷整條 token family。
- 學生端 App 每個伺服器獨立保存一組 token。

### 6.3 RBAC（角色 × 資源）

| 資源 | TEACHER | ASSISTANT | STUDENT |
|------|---------|-----------|---------|
| classes CRUD | ✅（僅自己實例） | 讀取 | 讀取（已加入的） |
| students | ✅ | 讀取 + 批改相關編輯 | 僅自身 |
| assignments | ✅ | 讀取 | 讀取 + 提交 |
| submissions | 全班級 | 負責班級可批改 | 僅自己的 |
| grades | ✅ | 讀取 + 輸入 | 僅自己的 |
| analysis | 觸發 + 讀取 | 觸發 + 讀取 | 觸發（自己的）+ 讀取 |

## 7. 錯誤處理與日誌

- 統一錯誤格式：`{ "error": { "code": "ASSIGNMENT_NOT_FOUND", "message": "找不到指定的作業", "details": { "assignmentId": "..." } } }`。完整錯誤碼清單隨 openapi.yaml 各端點定義。
- 日誌：pino（structured JSON），每請求帶 `requestId`、`userId`、`route`、`statusCode`、`durationMs`；錯誤另帶 `errorCode` 與資源 ID。**不記錄**：密碼、token、作文全文（只記長度與 hash 摘要）。
- analyzer sidecar 日誌獨立輸出（stdout → docker logs），backend 呼叫失敗時記 `analysisServiceUnreachable`，含 timeout 與 HTTP status。

## 8. 安全注意事項

1. **傳輸**：所有對外流量經 caddy 強制 HTTPS（HTTP 自動 redirect）。開發模式（localhost）例外。
2. **CORS**：定稿為**同源部署**（前端與 API 同 domain），學生端多站模式直接用各伺服器的原始 domain 呼叫，`Access-Control-Allow-Origin` 設為自身 origin（caddy 同源其實不觸發 CORS preflight）。若未來拆開部署，`.env` 可設 `CORS_ORIGINS`。
3. **Token 儲存（學生端 App）**：Web App 存 localStorage 有 XSS 風險，定稿採 **httpOnly cookie 儲存 refresh token + 記憶體持有 access token**（每站一組 cookie，以 base URL 隔離）。PWA/未來原生 App 可升級為 Keychain/SecureStorage。
4. **analyzer 隔離**：sidecar 僅在 docker internal network 監聽，不發佈埠號；`/internal/*` 端點另以共享 secret header（`X-Internal-Token`）第二層防護。
5. **上傳限制**：單檔 20 MB，白名單副檔名（pdf/png/jpg/jpeg/txt/docx），由 backend 驗證後才簽 presigned URL。
6. **邀請碼**：班級邀請碼格式 `XXXX-XXXX`（避開易混淆字元），預設 7 天效期、可停用、有使用次數上限（可設無限）。
7. **密碼**：bcrypt（cost 12），最小長度 8。教師註冊不限 email 網域（自架情境），但同一 email 在單一實例唯一。

## 9. 專案結構（M1 起沿用）

```
英語教學工具/
├── backend/                 # NestJS
│   ├── src/
│   │   ├── modules/         # auth / users / classes / students / assignments /
│   │   │                    # submissions / analysis / grades / announcements / notifications
│   │   ├── common/          # errors / guards / interceptors / types (branded types, enums)
│   │   ├── config/
│   │   └── infrastructure/  # database / storage / email / analyzer-client（外部服務邊界）
│   ├── prisma/schema.prisma # ✅ M0 已定稿
│   └── Dockerfile
├── analyzer/                # FastAPI sidecar（移植 Project-EAT 核心）
│   ├── app/
│   │   ├── main.py          # /internal/analyze, /internal/analyze-file, /internal/health
│   │   ├── ocr_engine.py    # ← Project-EAT ocr_engine.py
│   │   ├── nlp_engine.py    # ← Project-EAT nlp_engine.py
│   │   ├── language_prompts.py  # ← Project-EAT language_prompts.py
│   │   └── annotator.py     # ← Project-EAT annotator.py
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/                # Vite + React（單一 app，雙角色）
│   └── src/
│       ├── teacher/
│       ├── student/
│       └── shared/          # 多站伺服器管理、API client
├── docs/                    # ✅ M0 產出
├── docker-compose.yml
└── .env.example
```

模組邊界規則（對應開發規範 keep external behind boundary）：

- `modules/*` 只依賴 `infrastructure/*` 提供的 interface（如 `AnalysisEngine`、`FileStorage`、`MailerPort`），不直接 import HTTP client。
- `infrastructure/analyzer-client` 是 sidecar 唯一呼叫者，側車契約變更只改這一層。

## 10. 開放議題（M0 記錄，後續里程碑處理）

| 議題 | 處理時點 |
|------|----------|
| LINE 登入 | M5+（通知模組一起評估） |
| Web Push 通知（VAPID） | M5 |
| 成績 PDF 排版 | M5（先出 CSV） |
| 聚合儀表板（跨站待辦） | M8 後 |
| 多教師單實例（補習班） | schema 已預留 teacherId，UI 不做 |
| 中央目錄服務 | 不排程 |
