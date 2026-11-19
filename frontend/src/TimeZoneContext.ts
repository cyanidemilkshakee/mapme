import { createContext } from 'react'
import { DEVICE_TIME_ZONE } from './timeZone'

export const TimeZoneContext = createContext(DEVICE_TIME_ZONE)
