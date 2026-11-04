import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';

/** 本应用设置的版本化读取结果；错误仅包含固定提示，不输出原始存储。 */
export interface LocalSetting<T> { value: T; error: string }

/** 判断输入是否为非数组对象。参数：未知边界值；返回：可安全读取字段的对象类型。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取并校验单项设置。参数：本应用键、默认值、校验器；返回：有效值或默认值及错误。 */
export function readLocalSetting<T>(key: string, fallback: T, validate: (value: unknown) => value is T): LocalSetting<T> {
  if (typeof window === 'undefined') return { value: fallback, error: '' };
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return { value: fallback, error: '' };
    if (stored.length > 131072) throw new Error('setting-too-large');
    const envelope: unknown = JSON.parse(stored);
    if (!isRecord(envelope) || envelope.version !== 1 || !validate(envelope.value)) throw new Error('invalid-setting');
    return { value: envelope.value, error: '' };
  } catch {
    console.warn('工作台设置读取失败：本机存储不可用、内容损坏或版本无效。');
    return { value: fallback, error: '部分本机设置无法读取，已使用默认值。重新调整后可再次保存。' };
  }
}

/** 写入已验证设置。参数：本应用键、值、校验器；返回：成功为空，失败为安全提示。 */
export function writeLocalSetting<T>(key: string, value: T, validate: (value: unknown) => value is T): string {
  try {
    if (!validate(value)) throw new Error('invalid-setting');
    const stored = JSON.stringify({ version: 1, value });
    if (stored.length > 131072) throw new Error('setting-too-large');
    window.localStorage.setItem(key, stored);
    return '';
  } catch {
    console.warn('工作台设置保存失败：本次调整仅在当前页面有效。');
    return '设置已应用，但无法保存到浏览器；刷新后可能丢失，请检查本地存储权限或空间。';
  }
}

/** 管理持久设置。参数：应用键、默认值、校验器；返回：当前值、更新入口、可见错误。 */
export function useLocalSetting<T>(key: string, fallback: T, validate: (value: unknown) => value is T, restore?: (value: T) => T) {
  /** 首次恢复可重算相对日期。参数：无；返回：当前上下文的有效设置。 */
  const load = () => {
    const loaded = readLocalSetting(key, fallback, validate);
    return { key, ...loaded, value: restore ? restore(loaded.value) : loaded.value, dirty: false };
  };
  const [state, setState] = useState(load);
  const pending = useRef<(() => string) | null>(null);
  // 切换证券上下文时同步读取，不能先把上个证券的状态写入新键。
  if (state.key !== key) setState(load());
  const setValue = useCallback((next: SetStateAction<T>) => {
    setState(previous => {
      const current = previous.key === key ? previous : { key, ...readLocalSetting(key, fallback, validate), dirty: false };
      const value = typeof next === 'function' ? (next as (previous: T) => T)(current.value) : next;
      if (!validate(value)) return { ...current, error: '设置内容无效，请重新选择。' };
      return Object.is(value, current.value) ? current : { key, value, error: current.error, dirty: true };
    });
  }, [key, fallback, validate]);
  useEffect(() => {
    if (!state.dirty || state.key !== key) return;
    pending.current = () => writeLocalSetting(state.key, state.value, validate);
    const timer = window.setTimeout(() => {
      const error = pending.current?.() ?? ''; pending.current = null;
      setState(previous => ({ ...previous, error }));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [state.key, state.value, state.dirty, key, validate]);
  useEffect(() => {
    /** 页面离开时同步落盘最后一次调整。参数：无；返回：无，失败由写入函数记录。 */
    const flush = () => { pending.current?.(); pending.current = null; };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, [key]);
  return [state.value, setValue, state.error] as const;
}

/** 校验布尔开关。参数：未知值；返回：是否为严格布尔值。 */
export function isBoolean(value: unknown): value is boolean { return typeof value === 'boolean'; }
