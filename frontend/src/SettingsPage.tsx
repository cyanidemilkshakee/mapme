import { useEffect, useMemo, useRef, useState } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Link from '@mui/material/Link'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { Icon } from './MaterialIcons'
import WeatherRiskKey from './WeatherRiskKey'
import WeatherThresholdGuide from './WeatherThresholdGuide'
import { fahrenheitFromCelsius, TEMPERATURE_GRADIENT, TEMPERATURE_STOPS } from './temperatureHeatmap'
import { availableTimeZones, DEVICE_TIME_ZONE, timeZoneLabel } from './timeZone'

const temperatureNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
const coldest = TEMPERATURE_STOPS[0].celsius
const hottest = TEMPERATURE_STOPS[TEMPERATURE_STOPS.length - 1].celsius

function TemperatureLegend({ unit }: { unit: 'c' | 'f' }) {
  const suffix = unit === 'c' ? '°C' : '°F'
  const label = (celsius: number) => `${temperatureNumber.format(unit === 'c' ? celsius : fahrenheitFromCelsius(celsius))}${suffix}`
  return <div className="settings-info-block">
    <Typography id="temperature-legend-heading" component="h3">Temperature heatmap</Typography>
    <Typography component="p" variant="body2">Colors estimate current air temperature from Google Weather readings over land. World views blend more widely spaced readings. Zoom in for local detail. Water and areas too far from a reading stay clear.</Typography>
    <div className="temperature-gradient" style={{ backgroundImage: TEMPERATURE_GRADIENT }} aria-hidden="true" />
    <ul className="temperature-legend" aria-labelledby="temperature-legend-heading">
      {TEMPERATURE_STOPS.map(({ celsius, color }) => {
        const temperature = label(celsius)
        const anchor = celsius === coldest ? `${temperature} and below` : celsius === hottest ? `${temperature} and above` : temperature
        return <li key={celsius}><span className="temperature-swatch" style={{ backgroundColor: color }} aria-hidden="true" />{anchor}</li>
      })}
    </ul>
  </div>
}

export default function SettingsPage({
  theme,
  distanceUnit,
  temperatureUnit,
  timeZone,
  onSave,
  onBack,
}: {
  theme: 'light' | 'dark'
  distanceUnit: 'mi' | 'km'
  temperatureUnit: 'c' | 'f'
  timeZone: string
  onSave: (settings: { theme: 'light' | 'dark'; distanceUnit: 'mi' | 'km'; temperatureUnit: 'c' | 'f'; timeZone: string }) => void
  onBack: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const [draftTheme, setDraftTheme] = useState(theme)
  const [draftUnit, setDraftUnit] = useState(distanceUnit)
  const [draftTemperatureUnit, setDraftTemperatureUnit] = useState(temperatureUnit)
  const [draftTimeZone, setDraftTimeZone] = useState(timeZone)
  const [saved, setSaved] = useState(false)
  const zones = useMemo(() => availableTimeZones(draftTimeZone), [draftTimeZone])
  const dirty = draftTheme !== theme || draftUnit !== distanceUnit || draftTemperatureUnit !== temperatureUnit || draftTimeZone !== timeZone
  useEffect(() => heading.current?.focus(), [])
  return (
    <Box className="app-shell settings-shell" data-theme={theme}>
      <Box component="main" className="settings-page">
        <Button className="settings-back" type="button" variant="text" startIcon={<Icon name="arrowLeft" size={20} />} onClick={onBack}>Map</Button>
        <Typography component="h1" variant="h4" ref={heading} tabIndex={-1}>Settings</Typography>
        <section className="settings-section" aria-labelledby="theme-heading">
          <div><Typography id="theme-heading" component="h2" variant="h6">Theme</Typography><Typography component="p" variant="body2">Choose the interface appearance.</Typography></div>
          <div className="settings-choice-group" role="group" aria-label="Theme">
            {(['light', 'dark'] as const).map((option) => <ButtonBase key={option} type="button" className={draftTheme === option ? 'active' : ''} aria-pressed={draftTheme === option} onClick={() => { setDraftTheme(option); setSaved(false) }}>{option === 'light' ? 'Light' : 'Dark'}</ButtonBase>)}
          </div>
        </section>
        <section className="settings-section" aria-labelledby="units-heading">
          <div><Typography id="units-heading" component="h2" variant="h6">Measurement units</Typography><Typography component="p" variant="body2">Distances, speeds, precipitation, and load weight follow this setting.</Typography></div>
          <div className="settings-choice-group" role="group" aria-label="Measurement units">
            {(['mi', 'km'] as const).map((option) => <ButtonBase key={option} type="button" className={draftUnit === option ? 'active' : ''} aria-pressed={draftUnit === option} onClick={() => { setDraftUnit(option); setSaved(false) }}>{option === 'mi' ? 'Miles' : 'Kilometers'}</ButtonBase>)}
          </div>
        </section>
        <section className="settings-section" aria-labelledby="temperature-unit-heading">
          <div><Typography id="temperature-unit-heading" component="h2" variant="h6">Temperature</Typography><Typography component="p" variant="body2">Choose how temperatures appear in the map and location details.</Typography></div>
          <div className="settings-choice-group" role="group" aria-label="Temperature units">
            {(['f', 'c'] as const).map((option) => <ButtonBase key={option} type="button" className={draftTemperatureUnit === option ? 'active' : ''} aria-pressed={draftTemperatureUnit === option} onClick={() => { setDraftTemperatureUnit(option); setSaved(false) }}>{option === 'f' ? 'Fahrenheit °F' : 'Celsius °C'}</ButtonBase>)}
          </div>
        </section>
        <section className="settings-section" aria-labelledby="shortcuts-heading">
          <div><Typography id="shortcuts-heading" component="h2" variant="h6">Keyboard shortcuts</Typography><Typography component="p" variant="body2">Available on the map. Shortcuts pause while you type in a field.</Typography></div>
          <dl className="settings-shortcut-list">
            <div><dt><kbd>/</kbd></dt><dd>Focus destination search</dd></div>
            <div><dt><kbd>+</kbd><span>or</span><kbd>=</kbd></dt><dd>Zoom in</dd></div>
            <div><dt><kbd>-</kbd></dt><dd>Zoom out</dd></div>
            <div><dt><kbd>S</kbd></dt><dd>Toggle satellite view</dd></div>
            <div><dt><kbd>H</kbd></dt><dd>Toggle weather heatmap</dd></div>
            <div><dt><kbd>Esc</kbd></dt><dd>Close location details or suggestions</dd></div>
          </dl>
        </section>
        <section className="settings-section" aria-labelledby="time-zone-heading">
          <div><Typography id="time-zone-heading" component="h2" variant="h6">Time zone</Typography><Typography component="p" variant="body2">Trip times and forecasts use this time zone.</Typography></div>
          <Autocomplete
            className="settings-time-zone"
            options={[DEVICE_TIME_ZONE, ...zones]}
            value={draftTimeZone}
            disableClearable
            autoHighlight
            groupBy={(zone) => zone === DEVICE_TIME_ZONE ? 'Suggested' : zone.split('/')[0]}
            getOptionLabel={timeZoneLabel}
            onChange={(_, value) => { setDraftTimeZone(value); setSaved(false) }}
            slotProps={{
              paper: {
                className: 'settings-time-zone-menu',
                elevation: 0,
                sx: { border: 1, borderColor: 'divider', borderRadius: 0, boxShadow: 'none' },
              },
              listbox: { sx: { maxHeight: 'min(42vh, 420px)', py: 0 } },
            }}
            renderInput={(params) => <TextField {...params} label="Search time zones" size="small" />}
          />
        </section>
        <div className="settings-actions">
          <span role="status">{saved ? 'Settings saved.' : dirty ? 'Changes not saved.' : ''}</span>
          <Button type="button" variant="contained" disableElevation disabled={!dirty} onClick={() => { onSave({ theme: draftTheme, distanceUnit: draftUnit, temperatureUnit: draftTemperatureUnit, timeZone: draftTimeZone }); setSaved(true) }}>Save</Button>
        </div>
        <section className="settings-section settings-info" aria-labelledby="info-heading">
          <Typography id="info-heading" component="h2" variant="h6">Info</Typography>
          <TemperatureLegend unit={draftTemperatureUnit} />
          <div className="settings-info-block">
            <Typography component="h3">Route weather risk</Typography>
            <Typography component="p" variant="body2">Colors and patterns used on routes and forecast checkpoints.</Typography>
            <WeatherRiskKey />
          </div>
          <WeatherThresholdGuide unit={distanceUnit} />
          <div className="settings-info-block api-credits">
            <Typography component="h3">API credits</Typography>
            <Typography component="p" variant="body2">Map, route, place, and weather data are provided by <Link href="https://mapsplatform.google.com/" target="_blank" rel="noreferrer">Google Maps Platform</Link>.</Typography>
            <ul>
              <li>Maps JavaScript API for map and satellite imagery</li>
              <li>Routes API for routes and directions</li>
              <li>Places API and Geocoding API for places and location details</li>
              <li>Weather API for current conditions and forecasts</li>
              <li><Link href="https://www.naturalearthdata.com/downloads/10m-physical-vectors/" target="_blank" rel="noreferrer">Natural Earth</Link> coastlines and lakes limit the temperature overlay to land</li>
            </ul>
          </div>
        </section>
      </Box>
    </Box>
  )
}
