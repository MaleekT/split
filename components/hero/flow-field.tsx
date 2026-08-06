'use client'

import { useEffect, useRef } from 'react'

type Rgb = readonly [number, number, number]

const COLS = 58
const ROWS = 30
const FREQ = 0.065
const MAX_DPR = 2

const DEEP: Rgb = [12, 31, 20]
const MID: Rgb = [29, 158, 117]
const BRIGHT: Rgb = [150, 255, 205]

function hash(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return h - Math.floor(h)
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = x0 + 1
  const y1 = y0 + 1
  const sx = smoothstep(x - x0)
  const sy = smoothstep(y - y0)
  const n00 = hash(x0, y0)
  const n10 = hash(x1, y0)
  const n01 = hash(x0, y1)
  const n11 = hash(x1, y1)

  return lerp(lerp(n00, n10, sx), lerp(n01, n11, sx), sy)
}

function fbm(x: number, y: number): number {
  return valueNoise(x, y) * 0.6
    + valueNoise(x * 2.13 + 40, y * 2.13 + 40) * 0.4
}

function mixColor(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]
}

function paletteFor(n: number): Rgb {
  if (n < 0.5) return mixColor(DEEP, MID, n * 2)
  return mixColor(MID, BRIGHT, (n - 0.5) * 2)
}

interface FlowFieldProps {
  className?: string
}

export function FlowField({ className }: FlowFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let width = 0
    let height = 0
    let animationFrame = 0
    let start: number | null = null

    function resize() {
      width = canvas!.clientWidth
      height = canvas!.clientHeight
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)

      canvas!.width = Math.round(width * dpr)
      canvas!.height = Math.round(height * dpr)
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    function draw(timestamp: number) {
      if (start === null) start = timestamp
      const t = (timestamp - start) / 1000

      ctx!.clearRect(0, 0, width, height)

      const cellW = width / COLS
      const cellH = height / ROWS

      for (let row = 0; row < ROWS; row++) {
        const ny = row * FREQ * 1.6

        for (let col = 0; col < COLS; col++) {
          const nx = col * FREQ

          const warpX = fbm(nx * 0.5 + t * 0.05, ny * 0.5 - t * 0.04)
          const warpY = fbm(nx * 0.5 + 50 - t * 0.045, ny * 0.5 + 50 + t * 0.05)
          const sx = nx + warpX * 1.8 + t * 0.09
          const sy = ny + warpY * 1.8 - t * 0.06
          const n = fbm(sx, sy)

          const cx = (col + 0.5) * cellW
          const cy = (row + 0.5) * cellH

          const dx = Math.abs(cx / width - 0.5)
          const mask = 0.62
            + 0.24 * smoothstep(Math.min(Math.max(dx / 0.45, 0), 1))
          const dy = Math.abs(cy / height - 0.5)
          const vmask = 1
            - smoothstep(Math.min(Math.max((dy - 0.30) / 0.5, 0), 1)) * 0.25

          const inCenterX = Math.max(0, 1 - dx / 0.30)
          const bandDist = (cy - 0.27 * height) / (0.14 * height)
          const vertBandFactor = Math.exp(-bandDist * bandDist / 2)
          const textDip = 1 - 0.8 * inCenterX * vertBandFactor

          if (mask * vmask < 0.03) continue

          const ambient = 0.05
          let eff = ambient
            + (1 - ambient) * Math.pow(Math.max(0, (n - 0.42) / 0.58), 1.5)
          eff *= mask * vmask * textDip

          const radius = Math.min(cellW, cellH) * (0.047 + 0.28 * eff)
          const color = paletteFor(Math.min(1, n))
          const alpha = Math.min(0.95, 0.10 + 0.75 * eff)

          ctx!.beginPath()
          ctx!.fillStyle = `rgba(${color[0] | 0},${color[1] | 0},${color[2] | 0},${alpha.toFixed(3)})`
          ctx!.arc(cx, cy, radius, 0, Math.PI * 2)
          ctx!.fill()
        }
      }

      animationFrame = requestAnimationFrame(draw)
    }

    function stop() {
      if (animationFrame) cancelAnimationFrame(animationFrame)
      animationFrame = 0
    }

    function syncMotionPreference() {
      stop()
      if (reducedMotion.matches) {
        canvas!.style.display = 'none'
        return
      }

      canvas!.style.display = ''
      resize()
      animationFrame = requestAnimationFrame(draw)
    }

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(canvas)
    reducedMotion.addEventListener('change', syncMotionPreference)
    syncMotionPreference()

    return () => {
      stop()
      resizeObserver.disconnect()
      reducedMotion.removeEventListener('change', syncMotionPreference)
    }
  }, [])

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />
}
