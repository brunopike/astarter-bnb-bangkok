# Advanced Stats

Directly adapted from UI Layouts' Advanced Stats, the component requested at https://21st.dev/@uilayout.contact/components/advanced-stats (21st demo 19070). MIT; original copyright and license are in LICENSE.

Original repository: https://github.com/ui-layouts/uilayouts/tree/88d827d7ec342917ca06f6894e5add65fabbe5d8

- packages/blocks/src/stats-section/advanced-stats/index.tsx → advanced-stats.jsx
- packages/blocks/src/stats-section/advanced-stats/charts.tsx → charts.jsx
- apps/ui-layout/components/ui/timeline-animation.tsx → timeline-animation.jsx

The 21st MCP returned the main component but omitted its custom chart and timeline helpers. Those helpers were retrieved from the original author's repository, pinned above. Unmodified originals are retained in the existing N2 task reference directory.

Retained: Recharts monotone area, clipped foreground plus ghost curve, pointer readout, Motion spring and TimelineAnimation. Real immutable signal observations replace example revenue; scoped CSS replaces Tailwind utilities using Astarter tokens. The AdvancedStats composition is adapted into a record quote, compact chart and flat metadata for repeated signal cards, rather than embedding the source dashboard's seven nested panels in every row. The record price, change, first price, observation count, strategy, identity and validity stay available without duplicate tiles. Full evidence, risk, history and source remain in analysis. Missing history has no plot placeholder, and no score or goal is fabricated.

The local ResponsiveContainer replaces the monorepo's ChartContainer wrapper. Unique chart IDs, keyboard exploration, system/app reduced motion and native route cleanup are retained. The source blur/long stagger is removed so content is visible immediately.

2026-11-09 density revision: the user rejected the full dashboard-sized bento inside every signal. The same AdvancedStats, ClippedAreaChart and TimelineAnimation modules now form a compact quote / chart / flat KPI composition. Repeated state, source and current-price tiles are removed; the main record price remains visible, and full evidence, validity, risk and original history remain in analysis. No empty chart placeholder for records without history. Original area / clipped foreground / ghost curve / spring and keyboard exploration are retained, with a smaller plotting window and readable axes.
