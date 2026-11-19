import Add from '@mui/icons-material/Add'
import ArrowBack from '@mui/icons-material/ArrowBack'
import ArrowDownward from '@mui/icons-material/ArrowDownward'
import ArrowUpward from '@mui/icons-material/ArrowUpward'
import Fastfood from '@mui/icons-material/Fastfood'
import Cloud from '@mui/icons-material/Cloud'
import Hotel from '@mui/icons-material/Hotel'
import LocalCafe from '@mui/icons-material/LocalCafe'
import LocalGasStation from '@mui/icons-material/LocalGasStation'
import LocalShipping from '@mui/icons-material/LocalShipping'
import LocalParking from '@mui/icons-material/LocalParking'
import LocalPharmacy from '@mui/icons-material/LocalPharmacy'
import MyLocation from '@mui/icons-material/MyLocation'
import Place from '@mui/icons-material/Place'
import Remove from '@mui/icons-material/Remove'
import Restaurant from '@mui/icons-material/Restaurant'
import SatelliteAlt from '@mui/icons-material/SatelliteAlt'
import Settings from '@mui/icons-material/Settings'
import Train from '@mui/icons-material/Train'
import type { SvgIconComponent } from '@mui/icons-material'

type IconName = 'currentLocation' | 'plus' | 'minus' | 'arrowUp' | 'arrowDown' | 'arrowLeft' | 'mapPin' | 'truck' | 'settings' | 'satellite' | 'weather' | 'gasStation' | 'restaurant' | 'trainStation' | 'pharmacy' | 'hotel' | 'parking' | 'fastFood' | 'cafe'

const icons: Record<IconName, SvgIconComponent> = {
  currentLocation: MyLocation,
  plus: Add,
  minus: Remove,
  arrowUp: ArrowUpward,
  arrowDown: ArrowDownward,
  arrowLeft: ArrowBack,
  mapPin: Place,
  truck: LocalShipping,
  settings: Settings,
  satellite: SatelliteAlt,
  weather: Cloud,
  gasStation: LocalGasStation,
  restaurant: Restaurant,
  trainStation: Train,
  pharmacy: LocalPharmacy,
  hotel: Hotel,
  parking: LocalParking,
  fastFood: Fastfood,
  cafe: LocalCafe,
}

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  const MaterialIcon = icons[name]
  return <MaterialIcon className={className} aria-hidden="true" sx={{ display: 'block', fontSize: size }} />
}
