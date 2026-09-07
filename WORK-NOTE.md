# M0 工作筆記（隨做隨更）

## 目標

產出 M0 里程碑全部文件：架構文件、OpenAPI 規格、Prisma schema、sidecar 契約、里程碑計畫。不寫應用程式碼。

## 已確認決策

- 本次只做 M0（設計文件 + schema），不寫 NestJS/前端程式碼
- Project-EAT 以 **Python sidecar（FastAPI 容器）** 整合，NestJS 透過 HTTP 呼叫
- 前端定調 **Vite + React**（SPA，靜態檔案由 Caddy 服務）
- API 路徑統一 `/v1/*`（修正原規劃書 4.2 節 `/api/v1/discovery` 的不一致）
- Student 改隸屬教師（teacherId）+ ClassEnrollment 連接班級（修正原規劃 Student 直掛 classId 的重工問題）

## 驗收條件（完成打勾）

- [x] openapi.yaml 通過 lint（redocly：零錯誤零警告）
- [x] schema.prisma 通過 `prisma validate`（prisma@6.19.3）
- [x] 每個 API 端點在 openapi.yaml 都有錯誤回應與狀態碼
- [x] sidecar 契約明確指出 Project-EAT 各 .py 檔的對應去向（analysis-service.md §3）
- [x] milestones.md 每階段有可勾選的驗收條件
- [x] git initial commit 完成（0dd757e）

## 進度

- 2026-09-08 M5 完成：grades（類別 CRUD 權重預算＋P2002 重名轉 409、批次登打、calculateGradebook 純函式、CSV BOM）、announcements＋notifications（ANNOUNCEMENT_NEW/GRADE_PUBLISHED/SUBMISSION_RETURNED 鈎子、due-soon 排程 24h 去重）、MailerPort noop、analytics（progress + pre-post；stats.ts 純函式含 incomplete beta 算 p 值，8 測試對 scipy 對照誤差 <1e-8）。e2e 58/58（+10）。踩雷：POST 記得 @HttpCode(200)（join、calculate）；配對樣本要在測試裡補齊（乙生前測）；jest -t 過濾跑時 beforeAll 會跑但其他測試的資料不會建。

- 2026-09-08 M4 完成：analyzer/（四引擎逐字搬入僅改相對 import；pipeline 包裝層 offset 定位「唯一出現才給值，否則 -1」；FastAPI 統一錯誤格式＋token；契約測試 10/10 stub 可跑 CI）；真引擎煙霧測試 qwen3.8:27b-mlx 全中（6/6 錯誤）。NestJS：AnalyzerHttpClient（timeout 120/300s＋重試一次）、analysis 模組（202＋in-process worker 並發 3＋FAILED 落庫＋標註 PDF putObject 回存＋Attachment 補建）、FileStorage 加 get/putObject。e2e 48/48（M4 +8，DI 覆寫 fake engine/storage）。compose 加 analyzer+ollama；CI 加 pytest job。踩雷：本機 port 8000 被佔→8010；引擎絕對 import→相對；測試附件上傳者與提交者要一致。

- 2026-09-08 M3 完成：assignments（狀態機 ALLOWED_TRANSITIONS 表）、submissions（upsert 提交、PENDING 合成列表、評分/發還鎖定）、files（presigned PUT/GET，FileStorage 邊界 + S3FileStorage，presign 本地計算所以測試不需 MinIO）、compose 加 minio。e2e 40/40（M3 +15）。踩雷：down -v 後要重跑 migrate deploy（測試 DB 空的）；中文姓名碼位排序與直覺不同（斷言改無序比對）。

- 2026-09-08 M2 完成：classes 模組（CRUD/封存/邀請碼 XXXX-XXXX 生命週期/join＋REMOVED 復活）、students 模組（批次建立回傳明文初始密碼一次/列表/更新/移出冪等）、common（PageQuery+envelope、@Roles RolesGuard 串在 JWT guard 後）。e2e 25/25（新增 classes-students 13 案例：三角色 RBAC、分頁形狀、邀請碼停用重啟）。踩雷：Nest POST 預設 201，join 規格要 200 → @HttpCode(HttpStatus.OK)。

- 2026-09-08 git init、目錄結構建立（docs/、backend/prisma/）
- 2026-09-08 architecture.md、schema.prisma（validate 通過，修 3 處關聯宣告）、data-model.md
- 2026-09-08 openapi.yaml（redocly lint 通過；修 YAML flow-mapping、3.0.3 nullable、tag 描述、公開端點補 429）
- 2026-09-08 analysis-service.md、milestones.md、README.md、LICENSE
- 2026-09-08 remote 改名同步（English-Education-System）；規格補強：Analytics 標籤 + /progress + /analytics/pre-post（零 schema 變更）
- 2026-09-08 M1 完成：NestJS 骨架、auth（refresh rotation + family 撤銷）、discovery/health、統一錯誤格式、pino redact 日誌、Docker 全棧、e2e 12/12、單元 3/3、CI（backend/docs/audit/CodeQL/gitleaks/dependabot）
  - 踩雷備忘：JwtModule.register({}) 不會自動讀 JWT_SECRET → registerAsync；e2e 需 setupFiles 先設 env（ConfigModule 在 import 時驗證）；setGlobalPrefix 抽成 configureApp 供測試共用；docker compose 專案目錄名是中文 → compose 加 name:；port 3000 常被佔 → BACKEND_PORT 可覆寫；npm audit --omit=dev 對 transitive 過濾不可靠 → overrides deepmerge-ts@^8（Prisma CLI 鏈，實測 CLI 正常）
  - CI 修了兩輪：(1) gitleaks 把 ci.yml 寫死的測試 JWT_SECRET 判為 leak → 改 openssl rand 動態生成；(2) e2e spec 的 beforeAll 蓋掉 CI 的 DATABASE_URL（5432）成本機 5433 → 移除覆蓋，env 統一由 test/setup-e2e.ts 預設
  - **2026-09-08 CI 全綠確認**：main 分支 CI / Gitleaks / CodeQL 三 workflow success（commit 0f8d5a8）

## 備忘

- Project-EAT 位置：`/Users/mac/Documents/Project-EAT`；引擎公開介面：`NLPEngine.analyse_text/analyse`、`OCREngine.process_pdf`、`Annotator`；錯誤 dict 原生格式 `{original, type, suggestion}`。
- Prisma CLI 需釘 prisma@6（npx 預設抓到 8.0.0-rc，無 validate/format 指令）。
- 本機 port 3000 被 AutoClip dev server 佔用中，驗收用 BACKEND_PORT=3100。
