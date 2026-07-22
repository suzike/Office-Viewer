export const DEFAULT_THRESHOLDS = Object.freeze({
  coldStartMs: 8_000,
  firstDocumentOpenMs: 8_000,
  tabSwitchP95Ms: 2_500,
  aiFirstTokenMs: 2_000,
  mainProcessPeakMb: 350,
  rendererProcessesPeakMb: 700,
  totalProcessTreePeakMb: 1_200,
})

export const DEFAULT_COMPARISON_POLICY = Object.freeze({
  maximumRegressionPercent: 20,
  timingNoiseFloorMs: 150,
  memoryNoiseFloorMb: 32,
})

export function evaluateThresholds(values, thresholds = DEFAULT_THRESHOLDS) {
  const checks = Object.entries(thresholds).map(([metric, budget]) => ({
    metric,
    value: values[metric],
    budget,
    unit: metric.endsWith('Mb') ? 'MiB' : 'ms',
    passed: Number.isFinite(values[metric]) && values[metric] <= budget,
  }))
  return {
    allPassed: checks.every((check) => check.passed),
    checks,
  }
}

export function compareWithBaseline(values, baselineValues, policy = DEFAULT_COMPARISON_POLICY) {
  const comparisons = Object.keys(DEFAULT_THRESHOLDS).map((metric) => {
    const current = values[metric]
    const baseline = baselineValues[metric]
    const noiseFloor = metric.endsWith('Mb') ? policy.memoryNoiseFloorMb : policy.timingNoiseFloorMs
    if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline <= 0) {
      return { metric, status: 'unavailable', current, baseline }
    }
    const difference = current - baseline
    const regressionPercent = difference / baseline * 100
    const regressed = difference > noiseFloor && regressionPercent > policy.maximumRegressionPercent
    return {
      metric,
      status: regressed ? 'regression' : 'accepted',
      current,
      baseline,
      difference: round(difference, 2),
      regressionPercent: round(regressionPercent, 2),
      noiseFloor,
    }
  })
  return {
    passed: comparisons.every((comparison) => comparison.status !== 'regression'),
    policy,
    comparisons,
  }
}

function round(value, digits) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
