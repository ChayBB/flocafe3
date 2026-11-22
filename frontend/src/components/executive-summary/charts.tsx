'use client';

import { useEffect, useRef, useState } from 'react';

export const SERIES_CLASSES = [
  {
    fill: 'fill-[#2a78d6] dark:fill-[#3987e5]',
    stroke: 'stroke-[#2a78d6] dark:stroke-[#3987e5]',
    bg: 'bg-[#2a78d6] dark:bg-[#3987e5]',
  },
  {
    fill: 'fill-[#eb6834] dark:fill-[#d95926]',
    stroke: 'stroke-[#eb6834] dark:stroke-[#d95926]',
    bg: 'bg-[#eb6834] dark:bg-[#d95926]',
  },
  {
    fill: 'fill-[#1baf7a] dark:fill-[#199e70]',
    stroke: 'stroke-[#1baf7a] dark:stroke-[#199e70]',
    bg: 'bg-[#1baf7a] dark:bg-[#199e70]',
  },
  {
    fill: 'fill-[#eda100] dark:fill-[#c98500]',
    stroke: 'stroke-[#eda100] dark:stroke-[#c98500]',
    bg: 'bg-[#eda100] dark:bg-[#c98500]',
  },
  {
    fill: 'fill-[#e87ba4] dark:fill-[#d55181]',
    stroke: 'stroke-[#e87ba4] dark:stroke-[#d55181]',
    bg: 'bg-[#e87ba4] dark:bg-[#d55181]',
  },
  {
    fill: 'fill-[#008300] dark:fill-[#0ca30c]',
    stroke: 'stroke-[#008300] dark:stroke-[#0ca30c]',
    bg: 'bg-[#008300] dark:bg-[#0ca30c]',
  },
];
export const OTHER_CLASSES = {
  fill: 'fill-muted-foreground/50',
  stroke: 'stroke-muted-foreground/50',
  bg: 'bg-muted-foreground/50',
};
const PRIMARY_STROKE = 'stroke-[#2a78d6] dark:stroke-[#3987e5]';
const PRIMARY_FILL = 'fill-[#2a78d6] dark:fill-[#3987e5]';

export interface TrendPoint {
  label: string;
  current: number | null;
  previous: number | null;
  currentLabel: string;
  previousLabel: string | null;
}

/** Current-period line over a dashed comparison line, with a crosshair tooltip. */
export function TrendChart({
  points,
  format,
  currentName,
  previousName,
}: {
  points: TrendPoint[];
  format: (value: number) => string;
  currentName: string;
  previousName: string | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(240, Math.round(entry.contentRect.width))),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const height = 220;
  const pad = { top: 12, right: 12, bottom: 26, left: 12 };
  const values = points.flatMap((p) => [p.current ?? 0, p.previous ?? 0]);
  const max = Math.max(1, ...values) * 1.1;
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const x = (i: number) =>
    pad.left + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;
  const path = (key: 'current' | 'previous') =>
    points
      .map((p, i) => (p[key] === null ? null : `${x(i)},${y(p[key] as number)}`))
      .filter(Boolean)
      .map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt}`)
      .join(' ');
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(width / 70))));
  const active = hover !== null ? points[hover] : null;

  return (
    <div ref={containerRef} className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="block max-w-full overflow-visible"
        role="img"
        aria-label={currentName}
        onMouseLeave={() => setHover(null)}
      >
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={pad.left}
            x2={width - pad.right}
            y1={pad.top + innerH * (1 - f)}
            y2={pad.top + innerH * (1 - f)}
            className="stroke-border"
            strokeWidth={1}
          />
        ))}
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={pad.top + innerH}
          y2={pad.top + innerH}
          className="stroke-muted-foreground/40"
        />
        {previousName && (
          <path
            d={path('previous')}
            fill="none"
            className="stroke-muted-foreground/60"
            strokeWidth={2}
            strokeDasharray="5 4"
          />
        )}
        <path
          d={path('current')}
          fill="none"
          className={PRIMARY_STROKE}
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {points.map((p, i) =>
          i % labelEvery === 0 || i === points.length - 1 ? (
            <text
              key={`l${i}`}
              x={x(i)}
              y={height - 6}
              textAnchor="middle"
              className="fill-muted-foreground text-[11px]"
            >
              {p.label}
            </text>
          ) : null,
        )}
        {hover !== null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={pad.top}
              y2={pad.top + innerH}
              className="stroke-muted-foreground/50"
            />
            {active?.current !== null && active?.current !== undefined && (
              <circle
                cx={x(hover)}
                cy={y(active.current)}
                r={4.5}
                className={`${PRIMARY_FILL} stroke-card`}
                strokeWidth={2}
              />
            )}
          </>
        )}
        {points.map((_, i) => (
          <rect
            key={`h${i}`}
            x={x(i) - innerW / Math.max(1, points.length - 1) / 2}
            y={0}
            width={innerW / Math.max(1, points.length - 1)}
            height={height}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onTouchStart={() => setHover(i)}
          />
        ))}
      </svg>
      {active && hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-36 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md"
          style={{ left: `${(x(hover) / width) * 100}%` }}
        >
          <div className="font-medium text-foreground">{active.currentLabel}</div>
          <div className="mt-1 flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className={`inline-block h-0.5 w-3 ${SERIES_CLASSES[0].bg}`} />
              {currentName}
            </span>
            <span className="font-semibold tabular-nums text-foreground">
              {active.current === null ? '—' : format(active.current)}
            </span>
          </div>
          {previousName && (
            <div className="mt-0.5 flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="inline-block h-0.5 w-3 border-t-2 border-dashed border-muted-foreground/60" />
                {active.previousLabel ?? previousName}
              </span>
              <span className="tabular-nums text-foreground">
                {active.previous === null ? '—' : format(active.previous)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  percent: number | null;
  colorIndex: number | null;
}

/** Category share donut; slices keep a 2px surface gap. */
export function Donut({
  slices,
  centerLabel,
  centerValue,
}: {
  slices: DonutSlice[];
  centerLabel: string;
  centerValue: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const r = 70;
  const stroke = 22;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg
      viewBox="0 0 180 180"
      className="mx-auto h-44 w-44 shrink-0"
      role="img"
      aria-label={centerLabel}
    >
      <g transform="rotate(-90 90 90)">
        {total > 0 &&
          slices.map((s) => {
            const length = (s.value / total) * circumference;
            const gap = slices.length > 1 ? Math.min(2, length / 2) : 0;
            const classes = s.colorIndex === null ? OTHER_CLASSES : SERIES_CLASSES[s.colorIndex];
            const node = (
              <circle
                key={s.key}
                cx={90}
                cy={90}
                r={r}
                fill="none"
                strokeWidth={hover === s.key ? stroke + 4 : stroke}
                className={classes.stroke}
                strokeDasharray={`${Math.max(0, length - gap)} ${circumference}`}
                strokeDashoffset={-offset}
                onMouseEnter={() => setHover(s.key)}
                onMouseLeave={() => setHover(null)}
              >
                <title>{`${s.label}: ${s.percent ?? 0}%`}</title>
              </circle>
            );
            offset += length;
            return node;
          })}
      </g>
      <text x={90} y={84} textAnchor="middle" className="fill-muted-foreground text-[11px]">
        {centerLabel}
      </text>
      <text
        x={90}
        y={104}
        textAnchor="middle"
        className="fill-foreground text-[15px] font-semibold"
      >
        {centerValue}
      </text>
    </svg>
  );
}

/** Single-series bars per hour with per-bar hover tooltip. */
export function HourBars({
  bars,
  format,
  hourLabel,
}: {
  bars: { hour: number; value: number; detail: string }[];
  format: (value: number) => string;
  hourLabel: (hour: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...bars.map((b) => b.value));
  const active = bars.find((b) => b.hour === hover);
  return (
    <div className="relative">
      <div className="flex h-40 items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
        {bars.map((b) => (
          <div
            key={b.hour}
            className="flex h-full flex-1 cursor-default flex-col justify-end"
            onMouseEnter={() => setHover(b.hour)}
            onTouchStart={() => setHover(b.hour)}
          >
            <div
              className={`rounded-t-[4px] ${SERIES_CLASSES[0].bg} ${hover === b.hour ? 'opacity-100' : 'opacity-85'}`}
              style={{ height: `${Math.max(b.value > 0 ? 2 : 0, (b.value / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px] border-t border-muted-foreground/40 pt-1">
        {bars.map((b, i) => (
          <span
            key={b.hour}
            className="flex-1 text-center text-[10px] text-muted-foreground tabular-nums"
          >
            {i % Math.max(1, Math.ceil(bars.length / 8)) === 0 ? hourLabel(b.hour) : ''}
          </span>
        ))}
      </div>
      {active && (
        <div className="pointer-events-none absolute -top-2 end-0 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
          <div className="font-medium text-foreground">{hourLabel(active.hour)}</div>
          <div className="tabular-nums text-foreground">{format(active.value)}</div>
          <div className="text-muted-foreground">{active.detail}</div>
        </div>
      )}
    </div>
  );
}

/** Half-circle gauge for a 0-100 rate. */
export function Gauge({ percent, label }: { percent: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const r = 70;
  const length = Math.PI * r;
  return (
    <svg viewBox="0 0 180 104" className="mx-auto h-28 w-52" role="img" aria-label={label}>
      <path
        d="M20 94 A70 70 0 0 1 160 94"
        fill="none"
        strokeWidth={16}
        strokeLinecap="round"
        className="stroke-muted"
      />
      <path
        d="M20 94 A70 70 0 0 1 160 94"
        fill="none"
        strokeWidth={16}
        strokeLinecap="round"
        className={PRIMARY_STROKE}
        strokeDasharray={`${(clamped / 100) * length} ${length}`}
      />
      <text x={90} y={88} textAnchor="middle" className="fill-foreground text-[22px] font-semibold">
        {label}
      </text>
    </svg>
  );
}
