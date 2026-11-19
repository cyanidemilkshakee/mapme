export const riskNames = ['Low', 'Moderate', 'High', 'Severe', 'No Travel', 'Unavailable'] as const
export type Risk = (typeof riskNames)[number]

export const riskColors: Record<Risk, string> = {
  Low: '#397b5e',
  Moderate: '#df8a31',
  High: '#d16d3f',
  Severe: '#b64037',
  'No Travel': '#9b3562',
  Unavailable: '#596775',
}
