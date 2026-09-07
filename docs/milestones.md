# 開發里程碑與驗收條件（M0 定稿）

> 每個里程碑以「可驗收的產出」定義完成；勾選狀態於實作時更新。M4 已依 sidecar 決策（見 `docs/analysis-service.md`）修正，M6/M7 已依「單一 Vite + React app、雙角色」決策修正。

## M0 — 需求與架構設計 ✅（本次完成）

- [x] `docs/architecture.md`：整體架構、部署拓撲、安全決策
- [x] `docs/openapi.yaml`：全端點規格（通過 redocly lint，零錯誤零警告）
- [x] `backend/prisma/schema.prisma`：完整 schema（通過 `prisma validate`）
- [x] `docs/data-model.md`：模型決策與狀態機
- [x] `docs/analysis-service.md`：sidecar 契約
- [x] `docs/milestones.md`：本文
- [x] repo 初始化（git、README、LICENSE）

## M1 — 後端基礎建設 ✅（2026-09-08 完成）

範圍：NestJS 專案、Prisma 接線、auth、統一錯誤處理、日誌、Docker 化、`/v1/discovery`、`/v1/health`、CI/CD 與資安掃描（提前到位）。

- [x] `docker compose up -d` 一指令啟動 backend + postgres（minio/caddy/analyzer 可後續里程碑加入），`GET /v1/health` 回 200（實測通過，port 可由 `BACKEND_PORT` 覆寫）
- [x] `GET /v1/discovery` 回 200 且符合 `DiscoveryInfo` schema（實測通過）
- [x] 教師註冊 → 登入 → refresh → logout 全流程可用（e2e 12/12 綠）
- [x] refresh token rotation + 重用偵測（撤銷 family）有測試（e2e「舊 token 重用 → family 撤銷」案例）
- [x] 統一錯誤格式 `{ error: { code, message, details } }`：全域 exception filter + `ErrorCode` enum，任何未攔截例外也走同格式（500 / COMMON_INTERNAL_ERROR；單元測試 3 案例）
- [x] pino 結構化日誌帶 requestId；Authorization/cookie/body 全程 redact（`.env` 測試載入前完成驗證）
- [x] 全 API 走 `/v1` 前綴 + Swagger UI（`/docs`，bearer auth 已掛）
- [x] migration 流程：`prisma migrate dev` 產生初始 migration（20260907191822_init），CI 以 postgres service 容器重放
- [x]（提前）CI：GitHub Actions — backend job（lint/validate/unit/e2e/build）、docs job（redocly lint）、npm audit（--omit=dev，high 以上擋下）、CodeQL、gitleaks、dependabot

## M2 — 班級與學生管理 ✅（2026-09-08 完成）

- [x] Classes CRUD（含封存軟刪除、邀請碼生成/停用/效期）符合 openapi.yaml Classes 標籤
- [x] 學生批次建立回傳預設密碼；學生邀請碼自助註冊與加入班級可用
- [x] RBAC：學生看不到未加入班級；助教唯讀（@Roles 宣告式 RolesGuard + e2e 覆蓋三角色 × 主要資源）
- [x] 分頁 envelope（page/limit/total/totalPages）在所有 list 端點一致（common/types/pagination 共用）
- [x] e2e：建班 → 批次加學生 → 學生登入看到班級（classes-students.e2e-spec.ts，13 案例；全套 25/25 綠）

## M3 — 作業與提交（不含分析）✅（2026-09-08 完成）

- [x] Assignment 建立/發佈/關閉/重開狀態機（非法轉換回 409 ASSIGNMENT_INVALID_TRANSITION；DRAFT→CLOSED 拒絕、CLOSED→PUBLISHED 重開）
- [x] 學生提交/重新提交（upsert）＋截止後拒絕（409 SUBMISSION_NOT_ACCEPTABLE；GRADED/RETURNED 後亦鎖定）
- [x] `/v1/uploads` presigned 上傳 + 副檔名/大小驗證（白名單 pdf/png/jpg/jpeg/txt/docx、≤20MB）；minio 服務加入 compose（FileStorage 邊界 + S3 實作，presign 本地計算、離線可測）
- [x] 教師全班提交狀況列表（未提交合成 PENDING、submissionId null、status 篩選、分頁 envelope）
- [x] 評分與發還（PATCH grade → GRADED；returnToStudent → RETURNED 後鎖定 409 SUBMISSION_ALREADY_RETURNED）
- 附帶：附件改掛流程（學生上傳時暫掛 assignmentId，提交時改掛 submissionId 並清 assignmentId）

## M4 — 作文分析（Project-EAT sidecar）✅（2026-09-08 完成）

- [x] `analyzer/` FastAPI 服務：`/internal/health`、`/internal/analyze`、`/internal/analyze-file`，四個引擎檔案自 Project-EAT 原碼逐字搬入（僅改為相對 import）
- [x] 契約測試 10 案例全綠（stub 引擎，CI 可跑）：errors 結構/offset 定位語意/CJK 字數/401 token/415 副檔名/422 OCR 無文字/標註 PDF 為合法 base64 PDF（真 Annotator）
- [x] X-Internal-Token 驗證（env 未設為開發模式並警告）；analyzer 不發佈對外埠（compose 無 ports、healthcheck 走內部 token）
- [x] NestJS `AnalysisEngine` interface + AnalyzerHttpClient（timeout 文字 120s/檔案 300s、503/504/500 重試一次、snake→camel 邊界轉換）
- [x] `POST /v1/submissions/{id}/analyze` 回 202；in-process worker 完成 COMPLETED/FAILED 落庫；並發上限 3；進行中再觸發 409
- [x] 標註 PDF 寫回 MinIO（putObject）＋ Attachment 列，`GET analysis` 回 `annotatedPdfAttachmentId` 可走 presigned 下載
- [x] e2e（fake engine）8 案例：輪詢 COMPLETED、errors 符合 AnalysisErrorItem、歷史列表、409 進行中、FAILED 引擎不可用後可重觸發、latestFile 路徑含 PDF 附件下載、跨學生 403
- [x] 真引擎煙霧測試：本地 Ollama（qwen3.8:27b-mlx）分析錯誤作文句，正確抓出全部 6 個拼字/文法錯誤且 offset 定位正確（重複字正確回 -1）
- [x] compose 加入 analyzer + ollama 服務；CI 加入 analyzer pytest job

## M5 — 成績、公告與通知

- [ ] GradeCategory CRUD（權重總和 ≤ 100 驗證）+ GradeEntry 批次登打
- [ ] 加權總表計算（類別平均 × 權重）與 CSV 匯出（UTF-8 BOM，Excel 直開）
- [ ] Announcement 發佈 → 全班 Notification 產生；未讀查詢/已讀標記
- [ ] 截止提醒：每日排程掃描 48 小時內到期作業 → ASSIGNMENT_DUE_SOON 通知（in-process scheduler）
- [ ] Email 發送（基礎設施邊界 `MailerPort`，預設 no-op logger 實作，可接 SMTP）
- [ ] 進步趨勢 API：`GET /v1/students/{id}/progress`（錯誤類別時間序列 + 分數趨勢）與 `GET /v1/classes/{id}/analytics/pre-post`（paired t-test、Cohen's d）；統計純函式單元測試（含 pretest_posttest.py 對照組）

## M6 — 前端教師端 MVP

- [ ] Vite + React app（`frontend/`）：登入/註冊、班級、學生、作業、批改、成績、公告七個主畫面
- [ ] 作文批改工作區：左原文右分析錯誤清單、教師編輯回饋、觸發重新分析
- [ ] API client 型別由 `docs/openapi.yaml` 生成（openapi-typescript）
- [ ] caddy 服務加入 compose：同源部署前端 + API，`docker compose up` 全棧可用
- [ ] 瀏覽器端驗證：access token 記憶體持有、refresh 走 httpOnly cookie

## M7 — 前端學生端 MVP（多伺服器）

- [ ] 伺服器管理頁：新增（discovery 驗證、顯示站名）、編輯、刪除、快速切換
- [ ] 每站憑證隔離（cookie 以站域名自然隔離；切換站點重新載入該站資料）
- [ ] 學生作業流程：查看作業 → 提交（文字/檔案）→ 查看批改與分析結果
- [ ] 通知列表與已讀
- [ ] PWA：manifest + service worker（離線殼），可安裝到桌面

## M8 — 測試、文件與發佈 v1.0

- [ ] 後端測試覆蓋：模組 e2e 全綠；關鍵服務單元測試（分析狀態機、加權計算、RBAC）
- [ ] `docker compose up -d` 於乾淨機器（無 node/python 環境）一鍵全棧部署演練記錄
- [ ] `.env.example` 完整、README 快速開始、管理員手冊（備份/還原、升級）
- [ ] GitHub Sponsors / Open Collective 設定，README 捐款區塊
- [ ] 發佈 v1.0.0 tag 與映像（ghcr）

## 里程碑外的預留項

- LINE 登入、Web Push、成績 PDF、跨站聚合儀表板、中央目錄——見 `architecture.md` §10。
