type Row = Record<string, unknown>;

/** 安全读取对象。参数：未知上游值；返回：字段对象，非对象返回空对象。 */
export function object(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

/** 提取非空文本。参数：未知字段；返回：去除首尾空白的文本或 null。 */
export function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 校验自然日。参数：未知日期；返回：真实 YYYY-MM-DD 日期或 null，拒绝日期自动进位。 */
export function dateLabel(value: unknown): string | null {
  const label = text(value);
  if (!label || !/^\d{4}-\d{2}-\d{2}$/.test(label)) return null;
  const milliseconds = Date.parse(`${label}T00:00:00Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === label ? label : null;
}

/** 严格解析时间。参数：带时区 ISO 或正 Unix 秒；返回：有效 ISO，拒绝空值、布尔值和无时区文本。 */
export function isoTime(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  let milliseconds: number;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    milliseconds = Number(raw) * 1000;
    if (milliseconds <= 0) return null;
  } else {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)
      || !dateLabel(raw.slice(0, 10)) || Number(raw.slice(11, 13)) > 23
      || Number(raw.slice(14, 16)) > 59 || Number(raw.slice(17, 19)) > 59) return null;
    milliseconds = Date.parse(raw);
  }
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1970 && date.getUTCFullYear() <= 9999
    ? date.toISOString() : null;
}

/** 提取稳定原 ID。参数：上游 ID；返回：非空字符串或 null，禁止生成与标题相关的伪 ID。 */
export function originalId(value: unknown): string | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value);
}
