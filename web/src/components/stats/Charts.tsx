'use client';

import {
  Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid,
  Pie, PieChart, Cell, Line, LineChart, Legend,
} from 'recharts';

const PALETTE = [
  'oklch(0.78 0.14 75)',   // amber
  'oklch(0.62 0.13 245)',  // steel blue
  'oklch(0.65 0.10 200)',  // teal
  'oklch(0.70 0.10 95)',   // gold
  'oklch(0.65 0.13 15)',   // rose
  'oklch(0.50 0.04 250)',  // slate
  'oklch(0.55 0.10 280)',  // violet
  'oklch(0.78 0.14 130)',  // sage
];

const tooltipStyle = {
  background: 'oklch(15% 0.025 245)',
  border: '1px solid oklch(28% 0.030 240)',
  borderRadius: '8px',
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  color: 'oklch(94% 0.005 245)',
};

interface BarSpec {
  data: Array<{ band?: string; archetype?: string; source?: string; count: number }>;
  xKey: 'band' | 'archetype' | 'source';
}

export function StatsBar({ data, xKey }: BarSpec) {
  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 16 }}>
          <CartesianGrid stroke="oklch(28% 0.030 240)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey={xKey}
            tick={{ fill: 'oklch(60% 0.015 245)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
            axisLine={{ stroke: 'oklch(28% 0.030 240)' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: 'oklch(60% 0.015 245)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
            axisLine={{ stroke: 'oklch(28% 0.030 240)' }}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: 'oklch(0.78 0.14 75 / 0.06)' }}
            contentStyle={tooltipStyle}
          />
          <Bar dataKey="count" fill={PALETTE[0]} radius={[4, 4, 0, 0]} maxBarSize={48} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StatsPie({
  data,
}: {
  data: Array<{ archetype: string; count: number }>;
}) {
  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip contentStyle={tooltipStyle} />
          <Pie
            data={data}
            dataKey="count"
            nameKey="archetype"
            cx="50%"
            cy="50%"
            innerRadius={50}
            outerRadius={100}
            paddingAngle={2}
            stroke="oklch(11% 0.025 245)"
            strokeWidth={2}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
          <Legend
            wrapperStyle={{
              fontFamily: 'var(--font-sans)',
              fontSize: '11px',
              color: 'oklch(60% 0.015 245)',
            }}
            iconType="square"
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StatsLine({
  data,
}: {
  data: Array<{ date: string; count: number }>;
}) {
  return (
    <div className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 24, left: 0, bottom: 16 }}>
          <CartesianGrid stroke="oklch(28% 0.030 240)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: 'oklch(60% 0.015 245)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
            axisLine={{ stroke: 'oklch(28% 0.030 240)' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: 'oklch(60% 0.015 245)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
            axisLine={{ stroke: 'oklch(28% 0.030 240)' }}
            tickLine={false}
          />
          <Tooltip contentStyle={tooltipStyle} />
          <Line
            type="monotone"
            dataKey="count"
            stroke={PALETTE[0]}
            strokeWidth={2}
            dot={{ r: 2.5, fill: PALETTE[0], stroke: 'oklch(11% 0.025 245)', strokeWidth: 2 }}
            activeDot={{ r: 4, fill: PALETTE[0] }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
