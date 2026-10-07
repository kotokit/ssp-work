// Scoring for the detector: turn per-seller verdicts into precision/recall
// against ground truth, and sweep a threshold to see the false-positive /
// false-negative trade-off. Pure and offline — it just re-runs analyze().
//
// Ground truth is per seller: 'positive' = should be caught (flag or block),
// 'negative' = should stay clean. For the synthetic fixtures that mapping comes
// from the cohort labels; for replayed production events it comes from your
// analysts' past actions.

import { analyze, DIMENSIONS } from './detector.mjs';

const round = (x) => Number(x.toFixed(3));

/**
 * Map group key -> 'positive' | 'negative' from event `truth` labels, for a
 * given dimension's key function (default: publisher). A key is positive if any
 * of its events is a positive truth.
 */
export function groundTruthByKey(events, positiveTruths, keyFn = DIMENSIONS.publisher) {
  const m = new Map();
  for (const ev of events) {
    const k = keyFn(ev);
    const cls = positiveTruths.has(ev.truth) ? 'positive' : 'negative';
    if (!m.has(k) || cls === 'positive') m.set(k, cls);
  }
  return m;
}

/** Confusion matrix + precision/recall/F1 over groups. A non-clean verdict is a positive prediction. */
export function confusion(report, truthByKey) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const g of report.groups) {
    const predicted = g.verdict !== 'clean';
    const actual = truthByKey.get(g.key) === 'positive';
    if (predicted && actual) tp += 1;
    else if (predicted && !actual) fp += 1;
    else if (!predicted && !actual) tn += 1;
    else fn += 1;
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, tn, fn, precision: round(precision), recall: round(recall), f1: round(f1) };
}

/**
 * Re-run the detector across a range of values for one threshold and report
 * how the catch/false-positive counts move. This is how you pick a threshold
 * before turning a rule on — and why a too-loose night rule touches the
 * honest baseline.
 */
export function sweep(events, ctx, { key, values, dimension = 'publisher' }, truthByKey) {
  return values.map((v) => {
    const r = analyze(events, { ...ctx, thresholds: { ...(ctx.thresholds ?? {}), [key]: v } }, { dimension });
    const c = confusion(r, truthByKey);
    return {
      [key]: v,
      caught: r.summary.blocked.length + r.summary.flagged.length,
      falsePos: c.fp,
      falseNeg: c.fn,
      precision: c.precision,
      recall: c.recall,
    };
  });
}
