export type RouteMetrics = {
  no_travel_miles: number
  no_travel_checkpoints: number
  severe_miles: number
  high_miles: number
  unknown_miles: number
  unknown_checkpoints: number
  average_risk: number | null
  duration_minutes: number
}

function compareEligibleRoutes(left: RouteMetrics, right: RouteMetrics) {
  return left.severe_miles - right.severe_miles
    || left.high_miles - right.high_miles
    || (left.average_risk ?? 99) - (right.average_risk ?? 99)
    || left.duration_minutes - right.duration_minutes
}

export function recommendRoute<T extends { metrics_by_hour: RouteMetrics[] }>(routes: T[], hour: number) {
  let best: { route: T; metrics: RouteMetrics } | null = null
  for (const route of routes) {
    const metrics = route.metrics_by_hour[hour]
    if (!metrics) return { complete: false, recommended: null }
    if (metrics.no_travel_miles || metrics.no_travel_checkpoints || metrics.unknown_miles || metrics.unknown_checkpoints) continue
    if (best === null || compareEligibleRoutes(metrics, best.metrics) < 0) best = { route, metrics }
  }
  return { complete: true, recommended: best?.route ?? null }
}
