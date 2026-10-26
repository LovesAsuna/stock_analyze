import { useState } from 'react';
import type { PathPoint } from '../shared/backtest';
import { formatNumber, formatPercent } from './format';

/**
 * 历史交易相对入场的路径分布，使用单一百分比轴、分位区间与中位线。
 * @param points 每个持有长度的存续样本统计，offset0 是入场开盘。
 * @returns 支持鼠标、键盘和完整数据表的 SVG 图形。
 */
export function PathExplorer({ points }: { points: PathPoint[] }) {
  const [active, setActive] = useState<number | null>(null);
  const visible = points.slice(0, 61);
  const width = 700; const height = 260; const left = 55; const right = 75; const top = 25; const bottom = 35;
  const values = visible.flatMap((point) => [point.p25, point.p75, point.mean]);
  const minimum = Math.min(-1, ...values); const maximum = Math.max(1, ...values);
  const padding = (maximum - minimum) * 0.12;
  const low = minimum - padding; const high = maximum + padding;
  const x = (offset: number) => left + offset / Math.max(1, visible.at(-1)?.offset ?? 1) * (width - left - right);
  const y = (value: number) => top + (high - value) / (high - low) * (height - top - bottom);
  const path = (key: 'mean' | 'median' | 'p25' | 'p75') => visible.map((point, index) => `${index ? 'L' : 'M'}${x(point.offset)},${y(point[key])}`).join(' ');
  const band = `${path('p75')} ${[...visible].reverse().map((point) => `L${x(point.offset)},${y(point.p25)}`).join(' ')} Z`;
  const selected = visible.find((point) => point.offset === active) ?? visible.at(-1);
  return <div className="path-explorer">
    <div className="section-header"><div><h3>入场后的价格路径</h3><p>按持有长度对齐 · 原始价格变化 · 最多展示 60 根</p></div></div>
    {visible.length > 1 ? <>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="历史交易入场后的价格路径：中位数实线、均值虚线和25至75分位区间" onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const position = (event.clientX - bounds.left) / bounds.width * width;
        const index = Math.round((position - left) / (width - left - right) * (visible.length - 1));
        setActive(visible[Math.max(0, Math.min(visible.length - 1, index))]?.offset ?? null);
      }} onPointerLeave={() => setActive(null)}>
        {[low, 0, high].map((value) => <g key={value}><line className="path-grid" x1={left} x2={width - right} y1={y(value)} y2={y(value)} /><text className="path-axis" x={left - 8} y={y(value) + 4} textAnchor="end">{formatNumber(value, 1)}%</text></g>)}
        <path className="path-band" d={band} /><path className="path-median" d={path('median')} /><path className="path-mean" d={path('mean')} />
        <text className="path-axis" x={left} y={height - 10}>入场</text><text className="path-axis" x={width - right} y={height - 10} textAnchor="end">{visible.at(-1)?.offset} 根</text>
        {selected && <><line className="path-crosshair" x1={x(selected.offset)} x2={x(selected.offset)} y1={top} y2={height - bottom} /><circle className="path-dot" cx={x(selected.offset)} cy={y(selected.median)} r={4} /><text className="path-axis" x={width - right + 8} y={top}>中位数</text></>}
      </svg>
      <div className="path-legend"><span><i className="key key-blue" />中位数（实线）</span><span><i className="key key-orange" />均值（虚线）</span><span>阴影：25–75 分位</span></div>
      <label className="path-slider">检查持有长度<input type="range" aria-label="路径检查柱数" min={0} max={visible.length - 1} value={selected?.offset ?? 0} onChange={(event) => setActive(Number(event.target.value))} /></label>
      <output className="path-readout">第 {selected?.offset} 根 · 样本 {selected?.count} · 中位数 {formatPercent(selected?.median)} · 均值 {formatPercent(selected?.mean)} · 25–75 分位 {formatPercent(selected?.p25)} 至 {formatPercent(selected?.p75)}</output>
    </> : <p className="empty-state">尚无足够的模拟持仓路径。可编辑条件或扩大计划有效区间。</p>}
    <p className="method-note">第 0 根为入场开盘；第 1 根为入场柱收盘。仅统计仍在持仓中的历史路径，较长持有期样本通常更少。未扣费用与滑点，不是未来预测。</p>
    <details><summary>查看路径统计数据</summary><div className="table-scroll"><table><thead><tr>{['持有柱数', '样本量', '均值', '中位数', '25分位', '75分位'].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{points.map((point) => <tr key={point.offset}><td>{point.offset}</td><td>{point.count}</td><td>{formatPercent(point.mean)}</td><td>{formatPercent(point.median)}</td><td>{formatPercent(point.p25)}</td><td>{formatPercent(point.p75)}</td></tr>)}</tbody></table></div></details>
  </div>;
}
