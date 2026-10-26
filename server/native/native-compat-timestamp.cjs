'use strict';

/**
 * 复用当前已安装桌面的 console.timeStamp 桥接约定。
 * 只读安装包代码，不读取桌面会话；不执行 ASAR 主进程代码。
 * 使用方应在全新配置目录中的独立子进程内、首个 HTTP/WS 请求前安装。
 */
const { openSync, readSync, closeSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const desktopAsar = join(process.env.LONGBRIDGE_INSTALL_DIR || 'C:/Program Files (x86)/Longbridge Pro', 'resources', 'app.asar');

/**
 * 从已安装 ASAR 中读取指定主进程成员。
 * 参数：无；返回：主进程源字符串；格式、长度或读取不完整时抛出错误。
 */
function readDesktopMain() {
  const descriptor = openSync(desktopAsar, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (readSync(descriptor, prefix, 0, 16, 0) !== 16) throw new Error('桌面 ASAR 头部不完整');
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    if (jsonSize > 64 * 1024 * 1024 || jsonSize < 2 || headerSize < jsonSize) throw new Error('桌面 ASAR 头部大小无效');
    const header = Buffer.alloc(jsonSize);
    if (readSync(descriptor, header, 0, jsonSize, 16) !== jsonSize) throw new Error('桌面 ASAR 成员目录不完整');
    const entry = JSON.parse(header.toString('utf8')).files?.dist?.files?.main?.files?.['index.js'];
    const offset = Number(entry?.offset);
    const size = entry?.size;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size <= 0 || size > 32 * 1024 * 1024 || entry.unpacked) throw new Error('桌面 ASAR 主进程成员无效');
    const source = Buffer.alloc(size);
    if (readSync(descriptor, source, 0, size, 8 + headerSize + offset) !== size) throw new Error('桌面 ASAR 主进程代码不完整');
    return source.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

/**
 * 安装桌面原有的时间戳桥接；不生成 token、不改变认证结果。
 * 参数：native 为此安装包对应的原生导出对象。
 * 返回：恢复原属性的函数；包装约定不匹配时立即抛错，禁止猜测降级。
 */
function installDesktopTimestamp(native) {
  if (!native || typeof native.sha256 !== 'function') throw new TypeError('需要当前桌面引擎的 sha256 导出');
  const source = readDesktopMain();
  // 只接受已经静态验证的完整公式，避免升级后误取其它代码或常量。
  const pattern = /var W="([a-f0-9]{32})",Z=function\(A,e\)\{var g=\[W,A,e\]\.join\("\|"\);return n\.qn\.sha256\(g\)\};console\.timeStamp=Z;/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error('当前桌面 timeStamp 桥接格式发生变化，需要重新核对，已停止安装');
  const timestampPrefix = matches[0][1];
  const descriptor = Object.getOwnPropertyDescriptor(console, 'timeStamp');
  if (descriptor && !descriptor.configurable) throw new Error('console.timeStamp 不可配置，无法安全安装或恢复');

  /** 桌面桥接函数。参数：value 与 context 为原生传入值；返回：原包装定义的 SHA-256 字符串。 */
  function desktopTimestamp(value, context) {
    const result = native.sha256([timestampPrefix, value, context].join('|'));
    if (typeof result !== 'string' || !/^[a-f0-9]{64}$/i.test(result)) throw new TypeError('原生 sha256 未返回有效字符串');
    return result;
  }

  // 本地交叉校验原生散列约定，不发送校验数据，也不输出包中的内部常量。
  const testValue = 'native-compat-local';
  const expected = createHash('sha256').update([timestampPrefix, testValue, testValue].join('|')).digest('hex');
  if (desktopTimestamp(testValue, testValue) !== expected) throw new Error('当前原生 sha256 与桌面桥接算法不匹配');
  Object.defineProperty(console, 'timeStamp', { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? true, value: desktopTimestamp });

  /** 恢复安装前的属性。参数：无；返回：void；若属性被后续代码替换则抛错。 */
  return function restoreDesktopTimestamp() {
    if (console.timeStamp !== desktopTimestamp) throw new Error('console.timeStamp 已被其它代码替换，拒绝覆盖');
    if (descriptor) Object.defineProperty(console, 'timeStamp', descriptor);
    else delete console.timeStamp;
  };
}

module.exports = { installDesktopTimestamp };
