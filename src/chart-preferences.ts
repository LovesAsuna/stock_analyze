import { useCallback, useState } from 'react';

/** K 线显示偏好；仅影响展示，不包含复权方式或行情数据。 */
export interface ChartPreferences {
  /** 十字线吸附至数据点，或自由移动。 */
  crosshair: 'magnet' | 'normal';
  /** 是否显示图表网格。 */
  grid: boolean;
  /** 上涨 K 线是否使用空心柱。 */
  hollowUp: boolean;
  /** 价格轴使用线性、对数或百分比展示。 */
  priceScale: 'normal' | 'log' | 'percent';
}

/** 首次使用或存储内容无效时采用的显示偏好。 */
export const DEFAULT_CHART_PREFERENCES: ChartPreferences = Object.freeze({
  crosshair: 'magnet',
  grid: false,
  hollowUp: true,
  priceScale: 'normal',
});

const STORAGE_KEY = 'market-lens-chart-preferences-v1';
const STORAGE_VERSION = 1;
const MAX_STORED_LENGTH = 2048;
const PREFERENCE_KEYS = ['crosshair', 'grid', 'hollowUp', 'priceScale'];

interface PreferenceState {
  preferences: ChartPreferences;
  error: string;
}

/**
 * 判断边界输入是否为普通的非数组对象。
 * @param value 尚未信任的输入。
 * @returns 输入为非空对象且不是数组时返回 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 校验完整显示偏好，拒绝缺失字段、额外字段和未知枚举。
 * @param value 来自本机存储或调用方的未信任输入。
 * @returns 输入符合当前偏好结构时返回 true。
 */
function isPreferences(value: unknown): value is ChartPreferences {
  return isRecord(value) && Object.keys(value).length === PREFERENCE_KEYS.length &&
    PREFERENCE_KEYS.every((key) => Object.hasOwn(value, key)) &&
    (value.crosshair === 'magnet' || value.crosshair === 'normal') &&
    typeof value.grid === 'boolean' && typeof value.hollowUp === 'boolean' &&
    (value.priceScale === 'normal' || value.priceScale === 'log' || value.priceScale === 'percent');
}

/**
 * 复制四个已验证字段，避免与调用方或默认对象共享可变引用。
 * @param preferences 已通过结构校验的显示偏好。
 * @returns 可独立更新的偏好对象。
 */
function copyPreferences(preferences: ChartPreferences): ChartPreferences {
  return {
    crosshair: preferences.crosshair,
    grid: preferences.grid,
    hollowUp: preferences.hollowUp,
    priceScale: preferences.priceScale,
  };
}

/**
 * 读取版本化本机偏好；损坏或不受支持的数据回退默认值，错误不携带原始内容。
 * @returns 已验证的偏好和可供页面显示的中文错误；无浏览器环境时使用默认值。
 */
function loadPreferences(): PreferenceState {
  const fallback = copyPreferences(DEFAULT_CHART_PREFERENCES);
  if (typeof window === 'undefined') return { preferences: fallback, error: '' };
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    console.warn('K 线显示偏好读取失败：浏览器本机存储不可用。');
    return { preferences: fallback, error: '无法读取本机图表偏好，已使用默认设置。' };
  }
  if (stored === null) return { preferences: fallback, error: '' };
  try {
    // 限制解析体积，并同时校验信封版本与偏好结构；绝不输出存储值或解析异常。
    if (stored.length > MAX_STORED_LENGTH) throw new Error('invalid-preferences');
    const envelope: unknown = JSON.parse(stored);
    if (!isRecord(envelope) || Object.keys(envelope).length !== 2 ||
      envelope.version !== STORAGE_VERSION || !isPreferences(envelope.preferences)) {
      throw new Error('invalid-preferences');
    }
    return { preferences: copyPreferences(envelope.preferences), error: '' };
  } catch {
    console.warn('K 线显示偏好校验失败：内容损坏或版本不受支持，已使用默认设置。');
    return { preferences: fallback, error: '本机图表偏好格式或版本无效，已使用默认设置。' };
  }
}

/**
 * 管理显示偏好及版本化本机保存；写入失败时仍在当前页面应用有效设置。
 * @returns preferences 当前偏好、setPreferences 完整替换入口和 error 安全错误提示。
 */
export function useChartPreferences() {
  const [state, setState] = useState<PreferenceState>(loadPreferences);

  /**
   * 校验并应用完整偏好，同时尝试保存；失败不泄露输入或浏览器异常内容。
   * @param next 调用方提供的完整偏好对象。
   * @returns 无返回值；结果与错误通过 Hook 状态提供。
   */
  const setPreferences = useCallback((next: ChartPreferences): void => {
    if (!isPreferences(next)) {
      console.warn('K 线显示偏好更新失败：输入结构无效。');
      setState((previous) => ({ ...previous, error: '图表偏好无效，请重新选择设置。' }));
      return;
    }
    const preferences = copyPreferences(next);
    let error = '';
    try {
      if (typeof window === 'undefined') throw new Error('storage-unavailable');
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, preferences }));
    } catch {
      console.warn('K 线显示偏好保存失败：本次设置仅在当前页面生效。');
      error = '图表设置已在当前页面生效，但无法保存到本机；刷新后可能丢失。';
    }
    setState({ preferences, error });
  }, []);

  return { preferences: state.preferences, setPreferences, error: state.error };
}
