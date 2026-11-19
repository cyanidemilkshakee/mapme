import type { Risk } from './weatherRisk'

type DistanceUnit = 'mi' | 'km'
type ClassifiedRisk = Exclude<Risk, 'Unavailable'>
const MILES_TO_KILOMETERS = 1.609344
const POUNDS_TO_KILOGRAMS = 0.45359237

function riskThresholdRows(unit: DistanceUnit) {
  const wind = (mph: number) => unit === 'km' ? (mph * MILES_TO_KILOMETERS).toFixed(1) : String(mph)
  const rain = (inches: number) => unit === 'km' ? (inches * 25.4).toFixed(1) : inches.toFixed(2)
  const snow = (inches: number) => unit === 'km' ? (inches * 25.4).toFixed(1) : inches.toFixed(1)
  const speedUnit = unit === 'km' ? 'km/h' : 'mph'
  const precipitationUnit = unit === 'km' ? 'mm/hr' : 'in/hr'

  return {
    speedUnit,
    precipitationUnit,
    rows: [
      { risk: 'Low', wind: `< ${wind(25)}`, rain: `< ${rain(0.1)}`, snow: `< ${snow(0.5)}` },
      { risk: 'Moderate', wind: `${wind(25)}–<${wind(35)}`, rain: `${rain(0.1)}–<${rain(0.25)}`, snow: `${snow(0.5)}–<${snow(1)}` },
      { risk: 'High', wind: `${wind(35)}–<${wind(45)}`, rain: `${rain(0.25)}–<${rain(0.5)}`, snow: `${snow(1)}–<${snow(2)}` },
      { risk: 'Severe', wind: `${wind(45)}–<${wind(55)}`, rain: `${rain(0.5)}–${rain(1)}`, snow: `${snow(2)}–${snow(3)}` },
      { risk: 'No Travel', wind: `≥ ${wind(55)}`, rain: `> ${rain(1)}`, snow: `> ${snow(3)}` },
    ] satisfies { risk: ClassifiedRisk; wind: string; rain: string; snow: string }[],
  }
}

export default function WeatherThresholdGuide({ unit }: { unit: DistanceUnit }) {
  const { rows, speedUnit, precipitationUnit } = riskThresholdRows(unit)
  const loadUnit = unit === 'km' ? 'kg' : 'lb'
  const load = (pounds: number) => unit === 'km'
    ? (pounds * POUNDS_TO_KILOGRAMS).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    : pounds.toLocaleString()

  return <section className="risk-threshold-guide" aria-labelledby="risk-threshold-heading">
    <h2 id="risk-threshold-heading" className="risk-threshold-title">How weather risk is calculated</h2>
    <div className="risk-threshold-intro">
      <h3>At each checkpoint</h3>
      <p>We use the highest level triggered by sustained wind, rain, snow, or the truck’s load. Gusts are not used.</p>
    </div>
    <div className="risk-table-wrap">
      <table className="risk-threshold-table">
        <thead><tr><th scope="col">Level</th><th scope="col">Wind <small>{speedUnit}</small></th><th scope="col">Rain <small>{precipitationUnit}</small></th><th scope="col">Snow <small>{precipitationUnit}</small></th></tr></thead>
        <tbody>{rows.map((row) => <tr className={`threshold-${row.risk.toLowerCase().replaceAll(' ', '-')}`} key={row.risk}>
          <th scope="row" className="risk-text" data-risk={row.risk}><span className="risk-threshold-name"><i aria-hidden="true" />{row.risk}</span></th>
          <td data-label={`Wind · ${speedUnit}`}>{row.wind}</td><td data-label={`Rain · ${precipitationUnit}`}>{row.rain}</td><td data-label={`Snow · ${precipitationUnit}`}>{row.snow}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <div className="risk-load-rules">
      <h4>Weight changes the wind limit</h4>
      <ul>
        <li><span>Any load · ≥{unit === 'km' ? (55 * MILES_TO_KILOMETERS).toFixed(1) : 55} {speedUnit}</span><strong>No Travel</strong></li>
        <li><span>Over {load(30000)} {loadUnit} · {unit === 'km' ? `${(45 * MILES_TO_KILOMETERS).toFixed(1)}–<${(55 * MILES_TO_KILOMETERS).toFixed(1)}` : '45–<55'} {speedUnit}</span><strong>No Travel</strong></li>
        <li><span>Over {load(40000)} {loadUnit} · {unit === 'km' ? `${(35 * MILES_TO_KILOMETERS).toFixed(1)}–<${(45 * MILES_TO_KILOMETERS).toFixed(1)}` : '35–<45'} {speedUnit}</span><strong>Severe</strong></li>
      </ul>
    </div>
    <p className="risk-threshold-note">Ice, hail, mixed precipitation, or missing forecast data may show as unavailable. Forecasts are estimates between sampled checkpoints.</p>
  </section>
}

