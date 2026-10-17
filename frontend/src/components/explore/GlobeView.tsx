import { useEffect, useMemo, useRef, useState } from 'react'
import Globe, { type GlobeMethods } from 'react-globe.gl'
import { MeshPhongMaterial } from 'three'
import type { CountryFeature } from './geo'

export interface GlobeArc {
  from: { lat: number; lng: number }
  to: { lat: number; lng: number }
  color: string
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * Interactive 3D globe: drag to rotate, scroll or pinch to zoom, click a country.
 * Colours and labels come from the page; this only draws and reports clicks.
 */
export default function GlobeView({
  features,
  colorOf,
  dimmed,
  labelOf,
  selected,
  highlighted,
  arcs = [],
  focus,
  onSelect,
}: {
  features: CountryFeature[]
  colorOf: (code: string) => string
  dimmed: (code: string) => boolean
  /** Plain text tooltip lines: [title, subtitle]. */
  labelOf: (code: string) => [string, string]
  selected?: string
  /** Countries to raise and outline, e.g. the alternatives to the selected one. */
  highlighted?: Set<string>
  /** Animated arcs, e.g. from the selected country to its alternatives. */
  arcs?: GlobeArc[]
  /** Where to turn the camera; changes trigger a smooth move. */
  focus?: { lat: number; lng: number; altitude: number }
  onSelect: (code: string) => void
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const globe = useRef<GlobeMethods | undefined>(undefined)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hover, setHover] = useState<string | undefined>()
  // Ocean: a lit blue sphere, so the land colours sit on something that reads as a real globe.
  const material = useMemo(() => new MeshPhongMaterial({ color: '#1f5f99', emissive: '#0a2a4a', shininess: 18 }), [])

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ width: e.contentRect.width, height: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Slow spin until the user picks something; zoom limits keep the globe in view.
  useEffect(() => {
    const controls = globe.current?.controls()
    if (!controls) return
    controls.autoRotate = !selected
    controls.autoRotateSpeed = 0.35
    controls.minDistance = 130
    controls.maxDistance = 520
  }, [selected, size.width])

  useEffect(() => {
    if (focus) globe.current?.pointOfView(focus, 900)
  }, [focus])

  return (
    <div ref={wrap} className="absolute inset-0 cursor-grab active:cursor-grabbing">
      {size.width > 0 && (
        <Globe
          ref={globe}
          width={size.width}
          height={size.height}
          backgroundColor="rgba(0,0,0,0)"
          globeMaterial={material}
          showAtmosphere
          atmosphereColor="#8fd0ff"
          atmosphereAltitude={0.18}
          polygonsData={features}
          polygonCapColor={(f) => {
            const code = (f as CountryFeature).properties.code
            return dimmed(code) ? 'rgba(226,236,245,0.22)' : colorOf(code)
          }}
          polygonSideColor={() => 'rgba(6,24,44,0.45)'}
          polygonStrokeColor={(f) => {
            const code = (f as CountryFeature).properties.code
            return code === selected ? '#ffffff' : highlighted?.has(code) ? 'rgba(255,255,255,0.8)' : 'rgba(6,24,44,0.55)'
          }}
          polygonAltitude={(f) => {
            const code = (f as CountryFeature).properties.code
            return code === selected ? 0.05 : code === hover ? 0.025 : highlighted?.has(code) ? 0.022 : 0.008
          }}
          polygonsTransitionDuration={250}
          polygonLabel={(f) => {
            const [title, sub] = labelOf((f as CountryFeature).properties.code)
            return `<div style="background:#03100a;color:#fff;padding:6px 10px;border-radius:10px;font:13px Onest,sans-serif"><b>${escape(title)}</b><br/><span style="color:#d8a9a9">${escape(sub)}</span></div>`
          }}
          arcsData={arcs}
          arcStartLat={(a) => (a as GlobeArc).from.lat}
          arcStartLng={(a) => (a as GlobeArc).from.lng}
          arcEndLat={(a) => (a as GlobeArc).to.lat}
          arcEndLng={(a) => (a as GlobeArc).to.lng}
          arcColor={(a: object) => ['rgba(255,255,255,0.9)', (a as GlobeArc).color]}
          arcStroke={0.6}
          arcAltitudeAutoScale={0.35}
          arcDashLength={0.45}
          arcDashGap={0.15}
          arcDashAnimateTime={2200}
          arcsTransitionDuration={400}
          onPolygonHover={(f) => setHover((f as CountryFeature | null)?.properties.code)}
          onPolygonClick={(f) => onSelect((f as CountryFeature).properties.code)}
        />
      )}
    </div>
  )
}
