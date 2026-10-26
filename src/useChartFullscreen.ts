import { useCallback, useEffect, useState, type RefObject } from 'react';

/** 同步浏览器真实全屏状态并处理退出。参数：图表宿主；返回：状态、异步切换与可见错误。 */
export function useChartFullscreen(ref: RefObject<HTMLElement | null>) {
  const [fullscreen, setFullscreen] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === (ref.current?.closest('.analysis-panel') ?? ref.current));
    document.addEventListener('fullscreenchange', update); update();
    return () => document.removeEventListener('fullscreenchange', update);
  }, [ref]);
  const toggle = useCallback(async (): Promise<void> => {
    try {
      if (!ref.current) throw new Error('图表尚未挂载');
      // 使用稳定的分析面板宿主，切换周期或分时时不会因图表重挂载而退出全屏。
      const target = ref.current.closest('.analysis-panel') ?? ref.current;
      if (document.fullscreenElement === target) await document.exitFullscreen();
      else await target.requestFullscreen();
      setError('');
    } catch {
      console.warn('图表全屏请求失败，浏览器未授予全屏显示。');
      setError('无法切换全屏，请确认当前浏览器允许全屏后重试。');
    }
  }, [ref]);
  return { fullscreen, toggle, error };
}
