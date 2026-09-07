/**
 * 統計純函式（decision 層，無副作用）——方法對齊 Project-EAT pretest_posttest.py
 * （scipy.stats.ttest_rel / ddof=1），單元測試以同種子資料的 scipy 輸出為對照組。
 */

export interface DescriptiveStat {
  mean: number;
  standardDeviation: number; // 樣本標準差（ddof=1）
  min: number;
  max: number;
}

export function descriptive(values: number[]): DescriptiveStat {
  if (values.length === 0) {
    throw new Error('descriptive() 需要至少一個值');
  }
  const n = values.length;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  if (n === 1) {
    return { mean, standardDeviation: 0, min: values[0], max: values[0] };
  }
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
  return {
    mean,
    standardDeviation: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

export interface PairedTTest {
  tStatistic: number;
  degreesOfFreedom: number;
  pValue: number; // 雙尾
  cohenD: number;
  significant: boolean; // α = 0.05
}

/** 配對樣本 t 檢定（雙尾）＋ Cohen's d。 */
export function pairedTTest(pre: number[], post: number[]): PairedTTest {
  if (pre.length !== post.length) {
    throw new Error('pre/post 長度不一致');
  }
  const n = pre.length;
  if (n < 2) {
    throw new Error('配對 t 檢定至少需要 2 組');
  }
  const diff = post.map((v, i) => v - pre[i]);
  const diffStat = descriptive(diff);
  const standardError = diffStat.standardDeviation / Math.sqrt(n);
  const degreesOfFreedom = n - 1;

  // 邊界防護：diff 全零（sd=0）→ t 未定義；語意上「完全無差異」→ p=1
  if (diffStat.standardDeviation === 0) {
    const identical = diffStat.mean === 0;
    return {
      tStatistic: identical ? 0 : Number.POSITIVE_INFINITY,
      degreesOfFreedom,
      pValue: identical ? 1 : 0,
      cohenD: identical ? 0 : Number.POSITIVE_INFINITY,
      significant: !identical,
    };
  }

  const tStatistic = diffStat.mean / standardError;
  const pValue = twoTailedPValue(degreesOfFreedom, tStatistic);
  return {
    tStatistic,
    degreesOfFreedom,
    pValue,
    cohenD: diffStat.mean / diffStat.standardDeviation,
    significant: pValue < 0.05,
  };
}

/** 雙尾 t 分配 p 值：p = I_{x}(df/2, 1/2)，x = df/(df+t²)（標準恆等式）。 */
function twoTailedPValue(df: number, t: number): number {
  const x = df / (df + t * t);
  return regularizedIncompleteBeta(df / 2, 0.5, x);
}

// ── regularized incomplete beta（Numerical Recipes：Lanczos log-gamma ＋ 連分式）──

const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(z: number): number {
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const x = z - 1;
  let a = LANCZOS_COEFFICIENTS[0];
  const t = x + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_COEFFICIENTS.length; i += 1) {
    a += LANCZOS_COEFFICIENTS[i] / (x + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betacf(a: number, b: number, x: number): number {
  const MAX_ITERATIONS = 200;
  const EPSILON = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return h;
}

export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBeta = logGamma(a + b) - logGamma(a) - logGamma(b);
  const front = Math.exp(lnBeta + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betacf(a, b, x)) / a;
  }
  return 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** 效應量解讀（中文），供 API interpretation 欄位。 */
export function interpretCohensD(cohenD: number, significant: boolean): string {
  const abs = Math.abs(cohenD);
  const magnitude =
    abs >= 1.2 ? '效應量極大' : abs >= 0.8 ? '效應量大' : abs >= 0.5 ? '效應量中' : abs >= 0.2 ? '效應量小' : '效應量可忽略';
  if (!significant) {
    return `未達顯著（p ≥ 0.05），${magnitude}`;
  }
  const level = '顯著';
  return `${level}，${magnitude}`;
}
