import { describe, expect, it } from '@jest/globals';
import {
  descriptive,
  interpretCohensD,
  pairedTTest,
  regularizedIncompleteBeta,
} from './stats';

/**
 * 對照組：Project-EAT pretest_posttest.py 同種子（np.random.seed(42), N=30），
 * 數值由 scipy.stats 產生（記錄於 WORK-NOTE / M5 開發過程）。
 */
const PRE = [64, 56, 66, 76, 55, 55, 77, 67, 52, 65, 52, 52, 61, 35, 37, 51, 46, 62, 47, 41, 76, 55, 59, 41, 51, 59, 44, 63, 51, 54];
const POST = [74, 86, 81, 83, 77, 60, 94, 67, 57, 81, 73, 69, 75, 48, 40, 60, 57, 85, 65, 42, 93, 67, 68, 61, 75, 82, 52, 75, 68, 77];

// scipy 對照值
const SCIPY = {
  preMean: 55.666666666666664,
  preSd: 10.889201653182761,
  postMean: 69.73333333333333,
  postSd: 13.77136793178672,
  diffMean: 14.066666666666666,
  diffSd: 7.478398009039717,
  t: 10.302514833960636,
  p: 3.342081179648501e-11,
  cohenD: 1.8809732578639438,
};

describe('descriptive（對照 scipy：ddof=1）', () => {
  it('pre/post/diff 的描述統計與 scipy 一致', () => {
    const pre = descriptive(PRE);
    expect(pre.mean).toBeCloseTo(SCIPY.preMean, 10);
    expect(pre.standardDeviation).toBeCloseTo(SCIPY.preSd, 10);
    expect(pre.min).toBe(35);
    expect(pre.max).toBe(77);

    const post = descriptive(POST);
    expect(post.mean).toBeCloseTo(SCIPY.postMean, 10);
    expect(post.standardDeviation).toBeCloseTo(SCIPY.postSd, 10);

    const diff = descriptive(POST.map((v, i) => v - PRE[i]));
    expect(diff.mean).toBeCloseTo(SCIPY.diffMean, 10);
    expect(diff.standardDeviation).toBeCloseTo(SCIPY.diffSd, 10);
    expect(diff.min).toBe(0);
    expect(diff.max).toBe(30);
  });

  it('單一值：sd=0', () => {
    const stat = descriptive([7]);
    expect(stat).toEqual({ mean: 7, standardDeviation: 0, min: 7, max: 7 });
  });
});

describe('pairedTTest（對照 scipy.stats.ttest_rel）', () => {
  it('N=30 種子資料：t/p/cohenD 與 scipy 一致', () => {
    const result = pairedTTest(PRE, POST);
    expect(result.tStatistic).toBeCloseTo(SCIPY.t, 8);
    expect(result.pValue).toBeCloseTo(SCIPY.p, 15);
    expect(result.cohenD).toBeCloseTo(SCIPY.cohenD, 10);
    expect(result.degreesOfFreedom).toBe(29);
    expect(result.significant).toBe(true);
  });

  it('完全相同的兩組：sd=0 邊界 → p=1、不顯著', () => {
    const result = pairedTTest(PRE, PRE);
    expect(result.pValue).toBe(1);
    expect(result.significant).toBe(false);
    expect(result.cohenD).toBe(0);
    expect(result.tStatistic).toBe(0);
  });

  it('低自由度小樣本：df=4 顯著', () => {
    const r2 = pairedTTest([1, 2, 3, 4, 6], [2, 4, 6, 8, 12]);
    expect(r2.degreesOfFreedom).toBe(4);
    expect(r2.significant).toBe(true);
  });

  it('incomplete beta 基本值', () => {
    expect(regularizedIncompleteBeta(1, 1, 0.3)).toBeCloseTo(0.3, 10);
    expect(regularizedIncompleteBeta(2, 3, 0)).toBe(0);
    expect(regularizedIncompleteBeta(2, 3, 1)).toBe(1);
  });
});

describe('interpretCohensD', () => {
  it('d=1.88 顯著 → 效應量極大', () => {
    expect(interpretCohensD(1.88, true)).toContain('效應量極大');
  });
  it('不顯著 → 標示未達顯著', () => {
    expect(interpretCohensD(0.9, false)).toContain('未達顯著');
  });
});
