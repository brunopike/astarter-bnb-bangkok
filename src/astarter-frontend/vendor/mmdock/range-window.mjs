/** View coordinates only: never changes source samples, totals, or trading drafts. */
export function clampRange(view, domain, minimumSpan = 0) {
  const total = domain.max - domain.min;
  if (!Number.isFinite(total) || total <= 0) return domain;
  const floor = Math.min(total, Math.max(total * 1e-9, minimumSpan));
  const span = Math.min(total, Math.max(floor, view.max - view.min));
  const min = Math.max(domain.min, Math.min(domain.max - span, view.min));
  return {min, max: min + span};
}

export function adjustRange(view, domain, minimumSpan, action, delta) {
  const current = clampRange(view, domain, minimumSpan);
  const floor = Math.min(domain.max - domain.min, minimumSpan);
  if (action === 'start') return {min: Math.max(domain.min, Math.min(current.max - floor, current.min + delta)), max: current.max};
  if (action === 'end') return {min: current.min, max: Math.min(domain.max, Math.max(current.min + floor, current.max + delta))};
  return clampRange({min: current.min + delta, max: current.max + delta}, domain, minimumSpan);
}
