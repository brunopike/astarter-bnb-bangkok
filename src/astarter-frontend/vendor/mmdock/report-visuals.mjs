/** Display-only geometry. Source accounting and exported decimals remain untouched. */
export const reportFinite = value => typeof value === 'number' && Number.isFinite(value);

function finiteSum(values) {
  let sum = 0, correction = 0;
  for (const value of values) {
    const adjusted = value - correction;
    const next = sum + adjusted;
    correction = (next - sum) - adjusted;
    sum = next;
  }
  return reportFinite(sum) ? sum : null;
}

export function reportDomain(values) {
  const available = values.filter(reportFinite);
  const low = Math.min(0, ...available), high = Math.max(0, ...available);
  const scale = Math.max(Math.abs(low), Math.abs(high));
  if (!scale) return { min: -1, max: 1 };
  // Normalize first so subtraction cannot overflow for large opposing values.
  const margin = (high / scale - low / scale) * .12;
  return {
    min: low < 0 ? Math.max(-Number.MAX_VALUE, (low / scale - margin) * scale) : 0,
    max: high > 0 ? Math.min(Number.MAX_VALUE, (high / scale + margin) * scale) : 0,
  };
}

export function reportPosition(value, domain) {
  const scale = Math.max(Math.abs(domain.min), Math.abs(domain.max), Number.MIN_VALUE);
  return (value / scale - domain.min / scale) / (domain.max / scale - domain.min / scale);
}

export function contributionModel(start, steps, end) {
  const valid = value => reportFinite(value) ? value : null;
  const rows = [{ ...start, value: valid(start.value), kind: 'start', from: reportFinite(start.value) ? 0 : null, to: valid(start.value) }];
  const values = [start.value];
  let current = valid(start.value);
  for (const step of steps) {
    const value = valid(step.value), from = current;
    values.push(step.value);
    current = from !== null && value !== null ? finiteSum(values) : null;
    rows.push({ ...step, value, kind: 'change', from: current !== null ? from : null, to: current });
  }
  const ending = valid(end.value);
  rows.push({ ...end, value: ending, kind: 'end', from: ending !== null ? 0 : null, to: ending });
  const difference = current !== null && ending !== null ? finiteSum([ending, -current]) : null;
  const magnitude = Math.max(1, ...values.filter(reportFinite).map(Math.abs), Math.abs(ending ?? 0));
  const tolerance = magnitude * Number.EPSILON * (steps.length + 2) * 8;
  const status = difference === null ? 'incomplete' : Math.abs(difference) <= tolerance ? 'balanced' : 'mismatch';
  return { rows, expected: current, difference, status, domain: reportDomain(rows.flatMap(row => [row.from, row.to])) };
}

export function rankedModel(rows) {
  const sorted = rows.map((row, index) => ({ ...row, index, value: reportFinite(row.value) ? row.value : null })).sort((a, b) => {
    if (a.value === null) return b.value === null ? a.index - b.index : 1;
    if (b.value === null) return -1;
    return b.value - a.value || a.index - b.index;
  });
  const complete = sorted.every(row => row.value !== null);
  const total = complete ? finiteSum(sorted.map(row => row.value)) : null;
  const shares = complete && total !== null && total > 0 && sorted.every(row => row.value >= 0);
  return { rows: sorted.map(row => ({ ...row, share: shares && row.value > 0 ? row.value / total : null })), total, shares, domain: reportDomain(sorted.map(row => row.value)) };
}
