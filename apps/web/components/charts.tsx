'use client';
/** Dependency-free SVG charts. */
import { useState } from 'react';

export function BarChart({ data, keys, colors, height = 200, label }: { data: Record<string, any>[]; keys: string[]; colors: string[]; height?: number; label: (d: any) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => keys.reduce((s, k) => s + (d[k] ?? 0), 0)));
  const w = 100 / Math.max(data.length, 1);
  return (
    <div className="relative">
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img" aria-label="Bar chart">
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1="0" x2="100" y1={height * g} y2={height * g} className="stroke-slate-200 dark:stroke-slate-800" strokeWidth="0.3" vectorEffect="non-scaling-stroke" />)}
        {data.map((d, i) => {
          let y = height;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={i * w} y={0} width={w} height={height} fill="transparent" />
              {keys.map((k, j) => {
                const h = ((d[k] ?? 0) / max) * (height - 8);
                y -= h;
                return <rect key={k} x={i * w + w * 0.18} y={y} width={w * 0.64} height={h} fill={colors[j]} rx="0.6" opacity={hover === null || hover === i ? 1 : 0.55} />;
              })}
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex justify-between text-[10px] text-slate-400">{data.filter((_, i) => i % Math.ceil(data.length / 7 || 1) === 0).map((d, i) => <span key={i}>{label(d)}</span>)}</div>
      {hover !== null && data[hover] && (
        <div className="pointer-events-none absolute top-0 rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow" style={{ left: `${Math.min(hover * w, 75)}%` }}>
          <div className="font-medium">{label(data[hover])}</div>
          {keys.map((k, j) => <div key={k} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: colors[j] }} />{k}: {data[hover][k] ?? 0}</div>)}
        </div>
      )}
    </div>
  );
}

export function Donut({ segments, size = 140 }: { segments: { label: string; value: number; color: string }[]; size?: number }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  let acc = 0;
  const r = 15.9155;
  return (
    <div className="flex items-center gap-5">
      <svg viewBox="0 0 42 42" style={{ width: size, height: size }} role="img" aria-label="Donut chart">
        <circle cx="21" cy="21" r={r} fill="none" className="stroke-slate-100 dark:stroke-slate-800" strokeWidth="5" />
        {segments.map((s) => {
          const pct = (s.value / total) * 100;
          const el = <circle key={s.label} cx="21" cy="21" r={r} fill="none" stroke={s.color} strokeWidth="5" strokeDasharray={`${pct} ${100 - pct}`} strokeDashoffset={25 - acc} />;
          acc += pct;
          return el;
        })}
        <text x="21" y="22.5" textAnchor="middle" className="fill-slate-700 text-[6px] font-semibold dark:fill-slate-200">{total}</text>
      </svg>
      <ul className="space-y-1.5 text-sm">{segments.map((s) => <li key={s.label} className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />{s.label}<span className="ml-auto pl-4 tabular-nums text-slate-500">{Math.round((s.value / total) * 100)}%</span></li>)}</ul>
    </div>
  );
}

export function Meter({ value, max = 100, color = '#3b6cf6' }: { value: number; max?: number; color?: string }) {
  return <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-1.5 rounded-full" style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: color }} /></div>;
}
