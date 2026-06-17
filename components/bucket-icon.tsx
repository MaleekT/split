import {
  Wallet, Utensils, PiggyBank, Home, Car, Plane, Heart, ShoppingCart,
  Briefcase, GraduationCap, Gift, Coins, Landmark, HeartPulse, Plug, Gamepad2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Slug → lucide icon. Slugs must match the API guard /^[a-z0-9-]{1,32}$/.
// Shared by the bucket card (display) and the Add/Edit modals (picker).
export const BUCKET_ICONS: Record<string, LucideIcon> = {
  wallet:    Wallet,
  utensils:  Utensils,
  savings:   PiggyBank,
  home:      Home,
  car:       Car,
  travel:    Plane,
  health:    HeartPulse,
  heart:     Heart,
  shopping:  ShoppingCart,
  work:      Briefcase,
  education: GraduationCap,
  gift:      Gift,
  invest:    Coins,
  tax:       Landmark,
  bills:     Plug,
  fun:       Gamepad2,
}

export const BUCKET_ICON_SLUGS = Object.keys(BUCKET_ICONS)

export function bucketIconFor(slug?: string): LucideIcon {
  return (slug && BUCKET_ICONS[slug]) || Wallet
}
