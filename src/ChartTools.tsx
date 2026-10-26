import { useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  ArrowRightToLine, ChartNoAxesCombined, ChevronDown, ChevronUp, Crosshair,
  Maximize, Minimize, Minus, Plus, Scan, Settings2, X,
} from 'lucide-react';
import type { ChartPreferences } from './chart-preferences';
import './chart-tools.css';

/** 由宿主图表执行的视口动作。 */
export type ChartAction = 'zoom-in' | 'zoom-out' | 'fit' | 'latest';

/** 工具栏的受控状态与真实动作回调。 */
export interface ChartToolsProps {
  /** 当前显示偏好。 */
  preferences: ChartPreferences;
  /** 完整替换显示偏好。 */
  onPreferences: (next: ChartPreferences) => void;
  /** 执行真实图表视口动作。 */
  onAction: (action: ChartAction) => void;
  /** 指标面板当前是否展开，由宿主维护。 */
  indicatorsOpen: boolean;
  /** 切换指标面板。 */
  onIndicators: () => void;
  /** 宿主当前的真实全屏状态。 */
  fullscreen: boolean;
  /** 请求进入或退出全屏。 */
  onFullscreen: () => void;
  /** 可展示的安全错误信息。 */
  error?: string;
  /** 固定分时轴隐藏视野控制，避免提供不可执行的缩放或平移入口。 */
  fixedViewport?: boolean;
}

type PreferenceControlsProps = Pick<ChartToolsProps, 'preferences' | 'onPreferences'>;
interface ChartSettingsProps extends PreferenceControlsProps {
  dialogRef: RefObject<HTMLDialogElement | null>;
  id: string;
  error?: string;
}

const VIEW_ACTIONS = [
  { action: 'zoom-out', label: '缩小', Icon: Minus },
  { action: 'zoom-in', label: '放大', Icon: Plus },
  { action: 'fit', label: '适应全部', Icon: Scan },
  { action: 'latest', label: '回到最新', Icon: ArrowRightToLine },
] as const;

/**
 * 渲染即时生效的显示设置；原生控件只提交受支持的偏好枚举。
 * @param props 当前偏好与完整替换回调。
 * @returns 带可见中文标签的网格、涨柱和价轴设置。
 */
function PreferenceControls({ preferences, onPreferences }: PreferenceControlsProps) {
  return <div className="chart-tools-settings-fields">
    <label className="chart-tools-check">
      <span><strong>显示网格</strong><small>显示横向与纵向参考线</small></span>
      <input type="checkbox" checked={preferences.grid} aria-label="显示网格"
        onChange={(event) => onPreferences({ ...preferences, grid: event.currentTarget.checked })} />
    </label>
    <label className="chart-tools-check">
      <span><strong>空心涨柱</strong><small>上涨 K 线使用空心样式</small></span>
      <input type="checkbox" checked={preferences.hollowUp} aria-label="空心涨柱"
        onChange={(event) => onPreferences({ ...preferences, hollowUp: event.currentTarget.checked })} />
    </label>
    <fieldset className="chart-tools-price-scale">
      <legend>价轴模式</legend>
      <div className="chart-tools-scale-options">
        <label><input type="radio" name="price-scale" value="normal" checked={preferences.priceScale === 'normal'}
          onChange={() => onPreferences({ ...preferences, priceScale: 'normal' })} />普通（线性）</label>
        <label><input type="radio" name="price-scale" value="log" checked={preferences.priceScale === 'log'}
          onChange={() => onPreferences({ ...preferences, priceScale: 'log' })} />对数</label>
        <label><input type="radio" name="price-scale" value="percent" checked={preferences.priceScale === 'percent'}
          onChange={() => onPreferences({ ...preferences, priceScale: 'percent' })} />百分比</label>
      </div>
      <p>对数价轴适用于正价格；百分比以当前可见范围首个有效值为基准，仅改变价轴显示。</p>
    </fieldset>
  </div>;
}

/**
 * 渲染原生模态设置窗口，由浏览器处理 Escape、焦点约束与关闭后的焦点恢复。
 * @param props 对话框引用、唯一标识、当前偏好、修改回调与安全错误。
 * @returns 带表单关闭操作与数据口径说明的原生 dialog。
 */
function ChartSettings({ dialogRef, id, preferences, onPreferences, error }: ChartSettingsProps) {
  return <dialog ref={dialogRef} id={id} className="chart-tools-dialog"
    aria-labelledby={`${id}-title`} aria-describedby={`${id}-note`}>
    <form method="dialog">
      <header className="chart-tools-dialog-header">
        <div><h2 id={`${id}-title`}>K 线设置</h2><p>显示偏好 · 修改即时生效</p></div>
        <button type="submit" className="chart-tools-button chart-tools-close" aria-label="关闭 K 线设置" title="关闭设置">
          <X size={16} aria-hidden="true" /><span>关闭</span>
        </button>
      </header>
      <PreferenceControls preferences={preferences} onPreferences={onPreferences} />
      <p className="chart-tools-data-note" id={`${id}-note`}>
        <strong>不复权</strong> · 以上设置仅改变图表显示，不改变行情数据，不进行复权或重算。
      </p>
      {error && <p className="chart-tools-error" role="alert">{error}</p>}
      <footer className="chart-tools-dialog-footer">
        <span>偏好保存在当前浏览器</span>
        <button type="submit" className="chart-tools-button chart-tools-primary" autoFocus>完成</button>
      </footer>
    </form>
  </dialog>;
}

/**
 * 渲染受控的紧凑 K 线工具栏；每项动作均交由宿主执行，设置使用原生模态窗口。
 * @param props 显示偏好、指标展开状态、全屏状态、动作回调及安全错误。
 * @returns 含中文可见标签、可访问状态与显示设置弹窗的工具栏。
 */
export function ChartTools({ preferences, onPreferences, onAction, indicatorsOpen, onIndicators,
  fullscreen, onFullscreen, error, fixedViewport = false }: ChartToolsProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dialogId = useId();
  const [dialogError, setDialogError] = useState('');
  const visibleError = dialogError || error;

  /**
   * 打开原生模态设置窗口，失败时提供不包含底层异常内容的提示。
   * @returns 无返回值；打开失败时更新可见错误。
   */
  function openSettings(): void {
    try {
      const dialog = dialogRef.current;
      if (!dialog || typeof dialog.showModal !== 'function') throw new Error('dialog-unavailable');
      if (!dialog.open) dialog.showModal();
      setDialogError('');
    } catch {
      console.warn('K 线设置窗口打开失败：原生对话框暂不可用。');
      setDialogError('无法打开图表设置，请使用支持原生对话框的浏览器后重试。');
    }
  }

  return <div className="chart-tools">
    <div className="chart-tools-bar" role="group" aria-label="K 线图表工具">
      <button type="button" className="chart-tools-button" aria-expanded={indicatorsOpen}
        aria-label={indicatorsOpen ? '收起指标' : '展开指标'} onClick={onIndicators}>
        <ChartNoAxesCombined size={15} aria-hidden="true" /><span>指标</span>
        {indicatorsOpen ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
      </button>
      <label className="chart-tools-crosshair">
        <Crosshair size={14} aria-hidden="true" /><span>十字线</span>
        <select aria-label="十字线模式" value={preferences.crosshair} onChange={(event) => {
          const crosshair = event.currentTarget.value;
          if (crosshair === 'magnet' || crosshair === 'normal') onPreferences({ ...preferences, crosshair });
        }}>
          <option value="magnet">磁吸</option><option value="normal">自由</option>
        </select>
      </label>
      {!fixedViewport && <div className="chart-tools-actions" role="group" aria-label="图表视野">
        {VIEW_ACTIONS.map(({ action, label, Icon }) => <button key={action} type="button"
          className="chart-tools-button" onClick={() => onAction(action)} aria-label={label} title={label}>
          <Icon size={15} aria-hidden="true" /><span>{label}</span>
        </button>)}
      </div>}
      <div className="chart-tools-utilities" role="group" aria-label="显示选项">
        <button type="button" className="chart-tools-button" onClick={openSettings}
          aria-haspopup="dialog" aria-controls={dialogId} aria-label="打开 K 线设置">
          <Settings2 size={15} aria-hidden="true" /><span>设置</span>
        </button>
        <button type="button" className="chart-tools-button" onClick={onFullscreen} aria-pressed={fullscreen}
          aria-label={fullscreen ? '退出全屏' : '进入全屏'} title={fullscreen ? '退出全屏' : '进入全屏'}>
          {fullscreen ? <Minimize size={15} aria-hidden="true" /> : <Maximize size={15} aria-hidden="true" />}
          <span>{fullscreen ? '退出全屏' : '全屏'}</span>
        </button>
      </div>
    </div>
    {visibleError && <p className="chart-tools-error" role="alert">{visibleError}</p>}
    <ChartSettings dialogRef={dialogRef} id={dialogId} preferences={preferences}
      onPreferences={onPreferences} error={visibleError} />
  </div>;
}
