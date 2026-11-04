import type { Candle } from '../shared/types';

/** 图表逻辑下标范围；允许小数下标及柱外留白。 */
export interface ViewportRange { from: number; to: number }

type ViewportCandles = readonly Pick<Candle, 'time'>[];
interface ViewportEntry {
  key: string;
  anchor: number;
  offset: number;
  span: number;
  latest: boolean;
}
interface ViewportStore { version: 1; entries: ViewportEntry[] }

const STORAGE_KEY = 'market-lens-chart-viewports-v1';
const MAX_KEYS = 64;
const MAX_JSON_LENGTH = 65536;
const MAX_KEY_LENGTH = 256;
const MAX_SPAN = 100000;
const MAX_RIGHT_GAP = 1000;
const INVALID_ERROR = '图表视野无效，无法保存到本机。';
const STORAGE_ERROR = '图表视野无法保存到本机，本次调整仅在当前页面生效。';

/**
 * 校验由来源、证券和周期组成的不透明键，拒绝空白、控制字符和危险属性名。
 * @param key 调用方构造的隔离键，最长 256 个字符。
 * @returns 键可用于保存时返回 true；模块不拆解键内的分隔符。
 */
function validKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH &&
    key.trim() === key && !/[\u0000-\u001f\u007f]/.test(key) &&
    !['__proto__', 'prototype', 'constructor'].includes(key);
}

/**
 * 校验 UTC Unix 秒时间，保持在 JavaScript 日期可表达的范围内。
 * @param time 未信任的时间值。
 * @returns 有限安全整数秒且日期范围有效时返回 true。
 */
function validTime(time: unknown): time is number {
  return typeof time === 'number' && Number.isSafeInteger(time) && Math.abs(time) <= 8640000000000;
}

/**
 * 校验柱时间序列，防止不完整或乱序数据产生错误锚点。
 * @param candles 按 UTC 时间严格递增的实际柱；只读取 time 字段。
 * @returns 非空且每个时间均有效、不重复时返回 true。
 */
function validCandles(candles: ViewportCandles): boolean {
  if (!Array.isArray(candles) || candles.length === 0) return false;
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index];
    if (!candle || !validTime(candle.time) || (index > 0 && candle.time <= candles[index - 1].time)) return false;
  }
  return true;
}

/**
 * 校验逻辑范围，允许与实际柱相交或在末柱右侧保留有限空白。
 * @param range 待校验的起终下标。
 * @param count 实际柱数量。
 * @returns 起终有限、跨度为 2 至 100000 且位置合理时返回 true。
 */
function validRange(range: ViewportRange, count: number): boolean {
  if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return false;
  const span = range.to - range.from;
  if (span < 2 || span > MAX_SPAN || range.to < 0) return false;
  return range.from <= count - 1 + Math.min(span, MAX_RIGHT_GAP);
}

/**
 * 校验持久化单项，拒绝额外字段、无效跨度和无法由保存逻辑生成的偏移。
 * @param value 从 JSON 解析的未信任单项。
 * @returns 单项符合 version 1 结构时返回 true。
 */
function validEntry(value: unknown): value is ViewportEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as ViewportEntry;
  return Object.keys(entry).length === 5 && validKey(entry.key) && validTime(entry.anchor) &&
    typeof entry.latest === 'boolean' && Number.isFinite(entry.span) && entry.span >= 2 &&
    entry.span <= MAX_SPAN && Number.isFinite(entry.offset) && entry.offset >= 0 &&
    (entry.latest ? entry.offset <= entry.span + MAX_RIGHT_GAP : entry.offset < 1);
}

/**
 * 读取并校验存储信封，任何损坏均整体拒绝，日志不携带存储原文或异常对象。
 * @returns 有效存储或空的 version 1 信封；本机存储被禁用时抛给公共入口处理。
 */
function readStore(): ViewportStore {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === null) return { version: 1, entries: [] };
  try {
    if (raw.length > MAX_JSON_LENGTH) throw new Error();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const store = value as ViewportStore;
    if (Object.keys(store).length !== 2 || store.version !== 1 || !Array.isArray(store.entries) ||
      store.entries.length > MAX_KEYS || !store.entries.every(validEntry) ||
      new Set(store.entries.map((entry) => entry.key)).size !== store.entries.length) throw new Error();
    return store;
  } catch {
    console.warn('图表视野读取失败：本机内容损坏或版本无效，已忽略。');
    return { version: 1, entries: [] };
  }
}

/**
 * 读取本机视野：历史位置按 UTC 时间精确定位，最新位置以当前末柱恢复。
 * @param key 来源、证券和周期组成的隔离键，应与 saveViewport 使用同一个值。
 * @param candles 按时间严格递增的当前实际柱，只使用 UTC Unix 秒 time 字段。
 * @returns 已验证的逻辑范围；无记录、锚点已丢失、输入无效或存储不可用时返回 null。
 */
export function loadViewport(key: string, candles: ViewportCandles): ViewportRange | null {
  if (!validKey(key) || !validCandles(candles) || typeof window === 'undefined') return null;
  try {
    const entry = readStore().entries.find((item) => item.key === key);
    if (!entry) return null;
    const index = entry.latest ? candles.length - 1 : candles.findIndex((candle) => candle.time === entry.anchor);
    if (index < 0) return null;
    const to = index + entry.offset;
    const range = { from: to - entry.span, to };
    return validRange(range, candles.length) ? range : null;
  } catch {
    console.warn('图表视野读取失败：浏览器本机存储不可用。');
    return null;
  }
}

/**
 * 保存本机视野，记录右端附近实际柱的 UTC 时间、相对偏移和跨度；保留最近保存的 64 个键。
 * @param key 来源、证券和周期组成的隔离键，最长 256 字符，不得为空或含控制字符。
 * @param candles 按时间严格递增的当前实际柱，只使用 UTC Unix 秒 time 字段。
 * @param range 有限逻辑起终下标，跨度为 2 至 100000，须覆盖实际柱或合理右侧留白。
 * @returns 保存成功返回空字符串；输入或存储无效时返回安全中文提示，绝不包含原始数据。
 */
export function saveViewport(key: string, candles: ViewportCandles, range: ViewportRange): string {
  if (!validKey(key) || !validCandles(candles) || !validRange(range, candles.length)) return INVALID_ERROR;
  try {
    if (typeof window === 'undefined') throw new Error();
    const index = Math.min(candles.length - 1, Math.floor(range.to));
    const entry: ViewportEntry = {
      key, anchor: candles[index].time, offset: range.to - index,
      span: range.to - range.from, latest: range.to >= candles.length - 1,
    };
    const entries = readStore().entries.filter((item) => item.key !== key);
    entries.push(entry);
    const json = JSON.stringify({ version: 1, entries: entries.slice(-MAX_KEYS) });
    if (json.length > MAX_JSON_LENGTH) throw new Error();
    window.localStorage.setItem(STORAGE_KEY, json);
    return '';
  } catch {
    console.warn('图表视野保存失败：浏览器本机存储不可用。');
    return STORAGE_ERROR;
  }
}
