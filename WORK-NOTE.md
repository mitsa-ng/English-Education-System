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

## 備忘

- Project-EAT 位置：`/Users/mac/Documents/Project-EAT`；引擎公開介面：`NLPEngine.analyse_text/analyse`、`OCREngine.process_pdf`、`Annotator`；錯誤 dict 原生格式 `{original, type, suggestion}`。
- Prisma CLI 需釘 prisma@6（npx 預設抓到 8.0.0-rc，無 validate/format 指令）。
