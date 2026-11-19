import type { CSSProperties } from 'react'
import { riskColors, riskNames } from './weatherRisk'

export default function WeatherRiskKey() {
  return <div className="weather-key" aria-label="Weather risk map key">
    {riskNames.map((risk) => <span key={risk}>
      <i aria-hidden="true" data-risk={risk} style={{ '--risk-stroke': riskColors[risk] } as CSSProperties} />{risk}
    </span>)}
  </div>
}
