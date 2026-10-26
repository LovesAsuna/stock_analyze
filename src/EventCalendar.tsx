import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { EventData, EventKind } from '../shared/events';
import { eventDay, monthDays, shiftMonth } from './event-calendar';
import './event-calendar.css';

interface Props {
  data: EventData;
  filter: 'all' | EventKind;
  selected: string | null;
  onSelect: (day: string | null) => void;
}

/** 可点击的事件月历。参数：事件快照、当前分类、选中日期和回调；返回：周一开始、显示数量并联动列表的日期格子。 */
export function EventCalendar({ data, filter, selected, onSelect }: Props) {
  // 今天按当前北京时间判断，与行情或演示快照的获取日期无关。
  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  const [month, setMonth] = useState(today.slice(0, 7));
  const counts = new Map<string, number>();
  for (const item of data.events) {
    const day = eventDay(item);
    if (day && (filter === 'all' || filter === item.kind)) counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const firstMonth = [data.window.start, ...counts.keys()].sort()[0].slice(0, 7);
  const lastMonth = [data.window.end, ...counts.keys()].sort().at(-1)!.slice(0, 7);
  const label = `${month.slice(0, 4)}年${Number(month.slice(5))}月`;
  /** 切换月历时清除日期筛选。参数：月数偏移；返回：更新月份和列表选择。 */
  function navigate(offset: number): void {
    setMonth(shiftMonth(month, offset));
    onSelect(null);
  }
  return <section className="event-calendar" aria-label="事件月历">
    <div className="event-calendar-heading"><div><h3>{label}</h3><span>按日期查事件</span></div>
      <div className="event-calendar-navigation">
        <button type="button" className="icon-button" aria-label="上个月" disabled={month <= firstMonth} onClick={() => navigate(-1)}><ChevronLeft size={16} aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label="下个月" disabled={month >= lastMonth} onClick={() => navigate(1)}><ChevronRight size={16} aria-hidden="true" /></button>
      </div>
    </div>
    <div className="event-calendar-weekdays" aria-hidden="true">{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div>
    <div className="event-calendar-days">{monthDays(month).map((day, index) => {
      if (!day) return <span className="event-calendar-placeholder" key={`blank-${index}`} />;
      const count = counts.get(day) ?? 0;
      const outside = (day < data.window.start || day > data.window.end) && count === 0;
      const description = outside ? '查询范围外' : count ? `${count}条事件` : '当前结果无条目';
      return <button type="button" key={day} className={`event-calendar-day${count ? ' has-events' : ''}`}
        disabled={outside} aria-label={`${day}，${description}`} aria-pressed={selected === day}
        aria-current={day === today ? 'date' : undefined} title={`${day}${day === today ? ' · 今天' : ''} · ${description}`}
        onClick={() => onSelect(selected === day ? null : day)}>
        <span>{Number(day.slice(8))}</span>
        {day === today && <small className="event-calendar-today-label">今天</small>}
        {(day !== today || count > 0) && <small>{outside ? '—' : count ? `${count}条` : '·'}</small>}
      </button>;
    })}</div>
    <p className="event-calendar-legend"><span><i aria-hidden="true" />有事件 · 数字为条数</span><span>— 查询范围外</span></p>
    <p className="event-calendar-note">计数随上方分类变化，仅统计已获取的条目。新闻与宏观时刻按北京时间归日；仅日期的财报保留来源当地日期。无条目不代表当天没有事件。</p>
    <div className="event-calendar-selection" role="status"><span>{selected ? `正在查看 ${selected}` : '点击日期筛选下方列表'}</span>
      {selected && <button type="button" onClick={() => onSelect(null)}>查看全部日期</button>}
    </div>
  </section>;
}
