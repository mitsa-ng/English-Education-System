# 英語教師教室管理與學習輔助系統

為華語地區（台灣、香港、中國等地）英文教師打造的**開源、可自架**教室管理系統：班級、學生、作業、成績、公告一站式管理，並內建 AI 作文批改（整合 [Project-EAT](../Project-EAT)）。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## 特色

- 🏫 **教室管理**：班級、學生檔案（含特殊需求註記）、作業派發與批改、加權成績簿、班級公告。
- ✍️ **AI 作文批改**：學生提交作文後自動偵測拼字、文法、語意錯誤（Project-EAT 引擎，本地 LLM），教師可編輯回饋後發還；支援手寫掃描 OCR 與標註 PDF。
- 🕸️ **教師主權、 federated 架構**：每位教師自架一套實例，資料完全自持；學生端 App 可同時連結多位教師的站點。
- 🐳 **一鍵自架**：`docker compose up -d` + `.env` 即完成部署（自動 HTTPS）。

## 使用者角色

| 角色 | 能做什麼 |
|------|----------|
| 教師 | 建班級、管理學生、派作業、批改（含 AI 分析）、登打成績、發公告 |
| 學生 | 以邀請碼加入班級、查看作業、提交作文、查看回饋與成績 |
| 助教 | 協助批改與登分（唯讀班級管理資料） |

## 開發狀態

**M0（設計定稿）與 M1（後端骨架）已完成**：auth（JWT + refresh rotation）、`/v1/discovery`、`/v1/health`、Swagger（`/docs`）、Docker 一鍵起棧、CI/CD 與資安掃描皆已到位。完整路線圖見 [docs/milestones.md](docs/milestones.md)。

## 開發快速開始

```bash
# 一鍵起棧（postgres + backend）
cp backend/.env.example .env   # 填 JWT_SECRET（openssl rand -base64 48）
docker compose up -d
curl http://localhost:3000/v1/health

# 本機開發（backend/）
cd backend
npm ci
npx prisma migrate dev                  # 需要本機 postgres（docker compose -f docker-compose.test.yml up -d）
npm run test:e2e                        # e2e（自動起測試 DB 容器）
npm run lint && npm test
```

CI（GitHub Actions）：backend 測試矩陣、OpenAPI lint、npm audit、CodeQL、gitleaks、dependabot 全開。

## 文件索引

| 文件 | 內容 |
|------|------|
| [docs/architecture.md](docs/architecture.md) | 系統架構、部署拓撲、安全決策 |
| [docs/openapi.yaml](docs/openapi.yaml) | REST API 規格（OpenAPI 3.0，可在 Swagger UI 開啟） |
| [docs/data-model.md](docs/data-model.md) | 資料模型設計與狀態機 |
| [docs/analysis-service.md](docs/analysis-service.md) | 作文分析 sidecar（Project-EAT）介面契約 |
| [docs/milestones.md](docs/milestones.md) | 開發里程碑與驗收條件 |
| [backend/prisma/schema.prisma](backend/prisma/schema.prisma) | 資料庫 schema（Prisma） |

## 技術棧

NestJS（TypeScript）· Vite + React · PostgreSQL + Prisma · MinIO · FastAPI sidecar（Python）· Ollama · Docker Compose + Caddy

## 授權與支持

本專案以 [MIT License](LICENSE) 開源。開發完成後將開放 GitHub Sponsors / Open Collective 捐款通道——捐款用於伺服器成本、開發時間與社群經營。

## 致謝

作文批改核心引擎來自競賽專題 [Project-EAT](https://github.com/mitsa-ng/Project-EAT)（AI English Essay Annotation Tool）。
