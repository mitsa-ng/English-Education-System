# 資料模型設計說明（M0）

> 對應 `backend/prisma/schema.prisma`（M0 定稿，已通過 `prisma validate`）。本文說明設計決策與狀態機；欄位級定義以 schema 檔案與 `docs/openapi.yaml` 為準。

## 1. 實體關係總覽

```
User ──1:N── RefreshToken
 │
 ├──1:1── Student ──1:N── ClassEnrollment ──N:1── Class ──1:N── Assignment
 │           │                                     │              │
 │           │                                     │              ├──1:N── Submission ──1:N── AnalysisResult
 │           ├──1:N── GradeEntry ──N:1── GradeCategory ──N:1─────┘              │
 │           └──1:N── Submission                                     Attachment
 │
 ├──1:N── Announcement（班級公告）
 └──1:N── Notification（個人通知）
```

## 2. 對原規劃書的設計修正

### 2.1 Student 不再直掛 classId（重要修正）

原規劃書 `Student: id, classId, userId, ...` 的問題：

- 同一學生同時加入兩班 → 必須複製兩筆 Student（兩個 id、兩份 notes），資料重工且提交紀錄斷裂。
- 學生換班 / 修課結束無法表達歷史。

**定稿**：`Student` 隸屬教師實例（`teacherId` + `userId` 1:1），班級關係由 `ClassEnrollment`（`@@unique([classId, studentId])`）承擔，移出班級 = enrollment 標記 `REMOVED`。

API 维持原規劃路徑不變：`GET /v1/classes/{classId}/students` 回傳的是該班 ACTIVE enrollments 展開的 student 資料。

### 2.2 Submission「未提交」不落庫

`SubmissionStatus.PENDING` 只出現在 API 回應（教師查看全班提交狀況時，名單中未提交者合成 `PENDING`），DB 中不存在 PENDING 列——避免「空殼提交」與真实提交競態。落庫列由 `SUBMITTED` 起始。

### 2.3 每生每作業單一提交列

`@@unique([assignmentId, studentId])`：重複提交 = 更新同一列（content/attachments 覆蓋、`submittedAt` 重置）。簡化「最新版」語意；若未來需要提交歷史版本，再擴充 `SubmissionRevision`。

### 2.4 GradeCategory / GradeEntry 兩層式成績

- `GradeCategory`：加權類別（如 平時 30%），同班級類別權重總和應為 100（應用層驗證）。
- `GradeEntry`：類別內的分項分數，同類別可多筆（多次小考），加權計算 = 類別內平均 × 權重。
- 作業成績（`Submission.grade`）與成績簿（GradeEntry）**分開存放**：作業批改歸 submission 生命週期，教師可選擇性把作業分數「抄入」成績簿（M5 提供 copy endpoint）。

### 2.5 Attachment 共用單表

`Attachment` 以兩個 nullable FK（`assignmentId` / `submissionId`）服務兩種擁有者，應用層強制恰好一者非 null。Prisma 無法表達互斥 FK，此約束寫入 `attachments` service 的建立驗證與測試。

### 2.6 等第轉換不落庫

加權總分 → 等第（A/B/C...）的切分門檻屬呈現層設定（各校自訂），存 Class 上的 JSON 設定或前端設定即可，M5 決定；DB 只存原始分數。

## 3. 狀態機

### 3.1 Assignment

```
DRAFT ──publish──▶ PUBLISHED ──close──▶ CLOSED
                        │                    │
                        └── 回 DRAFT 不支援；CLOSED 可重新開啟為 PUBLISHED
```

- 只有 `PUBLISHED` 對學生可見、可提交。
- `CLOSED` 可由教師重新開啟（`PATCH /v1/assignments/{id}` 設 `status: PUBLISHED`）。
- 刪除 = soft delete（`archivedAt`），任何狀態皆可封存。

### 3.2 Submission

```
（未落庫 PENDING）
   │ 學生首次提交
   ▼
SUBMITTED ──教師評分──▶ GRADED ──發還（設 returnedAt）──▶ RETURNED
   ▲                                                        │
   └──────────── 學生重新提交（僅 GRADED 前 / 作業未 CLOSE）───┘
```

- `RETURNED` 後不可再提交（此作業定案）。
- 重新提交：SUBMITTED 狀態下覆蓋更新。

### 3.3 AnalysisResult

```
PENDING ──backend 呼叫 sidecar──▶ PROCESSING ──成功──▶ COMPLETED
   │                                  │
   │                                  └─失敗─▶ FAILED（記 errorCode）
   └─ sidecar 不可達/排程失敗 ──▶ FAILED
```

- 同一 submission 可有多筆 AnalysisResult（重新分析 = 建新列，保留歷史）。
- 狀態流轉完全由 backend 的 analysis 模組管理（`separate decision from actions`：是否觸發、重試策略在 service 決策層，sidecar 呼叫在 infrastructure 層）。

### 3.4 Class / Enrollment

- `Class`: ACTIVE ↔ ARCHIVED（封存軟刪除；封存班級的 assignments 全部對學生隱藏）。
- `Enrollment`: ACTIVE → REMOVED（單向；重新加入建新列會撞 unique，故 REMOVED 列直接改回 ACTIVE）。

## 4. TypeScript 型別對應（M1 實作方針）

- 所有 id 以 branded type 強化：`type UserId = string & { readonly __brand: 'UserId' }`（`common/types/branded-types.ts`）。
- enum 對應 Prisma 產生的型別，API 層 DTO 直接复用，不重複定義（單一真相）。
- `resultJson` 的結構由 `infrastructure/analyzer-client` 定義 `AnalysisError` interface（契約見 `docs/analysis-service.md`），不散落到 modules。

## 5. 資料保留與刪除政策

| 資料 | 刪除方式 |
|------|----------|
| Class | 軟刪除（ARCHIVED），不物理刪除 |
| Assignment | 軟刪除（archivedAt） |
| Student 移出班級 | Enrollment → REMOVED |
| Student 檔案刪除 | 教師可物理刪（串聯刪 submissions/grades；需二次確認）——M2 決定是否改軟刪 |
| 使用者帳號 | 教師/學生可停用（M1+ 加 `disabledAt` 欄位時的 migration） |
| 檔案物件 | 隨擁有者刪除時由 storage service 非同步清理 MinIO |

## 6. 分析計算層（進步趨勢，不落庫）

進步趨勢與前後測統計**不新增任何資料表**，由既有資料即時彙算（API 見 openapi.yaml Analytics 標籤）：

- `GET /v1/students/{studentId}/progress`：`AnalysisResult`（COMPLETED）的錯誤類別計數時間序列 + `Submission.grade` 的評分趨勢；`errorRateChange` = 每百字錯誤數（最近一次 − 首次）。
- `GET /v1/classes/{classId}/analytics/pre-post`：教師指定前測／後測兩個作業，對兩者皆有 `Submission.grade` 的學生做配對——描述統計、paired t-test、Cohen's d（方法移植自 Project-EAT `pretest_posttest.py`，其以假資料驗證過公式）。
- 統計實作放 `modules/analytics` 的純函式（`separate decision from actions`：t 檢定與效應量計算可獨立單元測試）。

## 7. 索引設計重點

- `Class(teacherId, status)`：教師首頁班級列表（過濾 ARCHIVED）。
- `Assignment(classId, status, dueAt)`：學生作業列表按截止排序。
- `Submission(studentId, status)` / `Submission @@unique(assignmentId, studentId)`：教師批改佇列與學生「我的提交」。
- `AnalysisResult(submissionId, createdAt)`：取最新分析結果。
- `Notification(userId, readAt)`：未讀通知計數。
