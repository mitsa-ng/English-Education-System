/**
 * 加權總表純計算（無 DB、無副作用，可獨立單元測試）。
 * 規則：類別內多筆取平均 → 平均 × 權重%（weightedScore）→ 總分 = Σ weightedScore。
 */

export interface GradebookCategory {
  id: string;
  name: string;
  weight: number; // 0–100（百分比）
}

export interface GradebookEntryInput {
  categoryId: string;
  studentId: string;
  score: number;
}

export interface GradebookStudent {
  studentId: string;
  name: string;
  studentNumber: string | null;
}

export interface CategoryScore {
  categoryId: string;
  name: string;
  weight: number;
  entryCount: number;
  average: number | null;
  weightedScore: number | null;
}

export interface GradebookRow {
  studentId: string;
  studentNumber: string | null;
  name: string;
  categories: CategoryScore[];
  weightedTotal: number;
}

export interface Gradebook {
  classId: string;
  calculatedAt: string;
  rows: GradebookRow[];
}

export function calculateGradebook(
  classId: string,
  categories: GradebookCategory[],
  entries: GradebookEntryInput[],
  students: GradebookStudent[],
): Gradebook {
  const byCategory = new Map<string, GradebookEntryInput[]>();
  for (const entry of entries) {
    const list = byCategory.get(entry.categoryId) ?? [];
    list.push(entry);
    byCategory.set(entry.categoryId, list);
  }

  const rows = students.map((student) => {
    const categoryScores: CategoryScore[] = categories.map((category) => {
      const own = (byCategory.get(category.id) ?? []).filter((e) => e.studentId === student.studentId);
      if (own.length === 0) {
        return {
          categoryId: category.id,
          name: category.name,
          weight: category.weight,
          entryCount: 0,
          average: null,
          weightedScore: null,
        };
      }
      const average = own.reduce((sum, e) => sum + e.score, 0) / own.length;
      return {
        categoryId: category.id,
        name: category.name,
        weight: category.weight,
        entryCount: own.length,
        average: round2(average),
        weightedScore: round2((average * category.weight) / 100),
      };
    });
    const weightedTotal = round2(
      categoryScores.reduce((sum, c) => sum + (c.weightedScore ?? 0), 0),
    );
    return {
      studentId: student.studentId,
      studentNumber: student.studentNumber,
      name: student.name,
      categories: categoryScores,
      weightedTotal,
    };
  });

  return { classId, calculatedAt: new Date().toISOString(), rows };
}

/** CSV（UTF-8 with BOM，Excel 直開）。 */
export function gradebookToCsv(gradebook: Gradebook): string {
  const header = ['座號', '姓名', ...gradebook.rows[0]?.categories.map((c) => `${c.name}(${c.weight}%)`) ?? [], '加權總分'];
  const lines = [header.join(',')];
  for (const row of gradebook.rows) {
    const cells = [
      row.studentNumber ?? '',
      row.name,
      ...row.categories.map((c) => (c.average === null ? '' : String(c.average))),
      String(row.weightedTotal),
    ];
    lines.push(cells.map(csvEscape).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
