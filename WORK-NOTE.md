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
