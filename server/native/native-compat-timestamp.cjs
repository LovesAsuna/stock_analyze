'use strict';
/** 只读桌面时间戳桥接约定；不生成token、不读取桌面会话、不执行ASAR代码。 */
const { createHash } = require('node:crypto');
const { resolveDesktopInstallation } = require('./desktop-installation.cjs');
const { readDesktopMain } = require('./desktop-resources.cjs');

/** 从源码唯一匹配已验证桥接公式，复制短前缀以免保留整份ASAR源码。参数：source主进程源码；返回：独立的32字符前缀。 */
function desktopTimestampPrefix(source) {
  if (typeof source !== 'string') throw new TypeError('桌面 timeStamp 源码必须为字符串');
  const pattern = /var W="([a-f0-9]{32})",Z=function\(A,e\)\{var g=\[W,A,e\]\.join\("\|"\);return n\.qn\.sha256\(g\)\};console\.timeStamp=Z;/g;
  const match = pattern.exec(source);
  if (!match || pattern.exec(source)) throw new Error('当前桌面 timeStamp 桥接格式发生变化，需要重新核对，已停止安装');
  return Buffer.from(match[1], 'ascii').toString('ascii');
}

/** 构建只持有引擎及短前缀的桥接函数。参数：native原生散列引擎、prefix短前缀；返回：与桌面公式一致的函数。 */
function createDesktopTimestamp(native, prefix) {
  return function desktopTimestamp(value, context) {
    const result = native.sha256([prefix, value, context].join('|'));
    if (typeof result !== 'string' || !/^[a-f0-9]{64}$/i.test(result)) throw new TypeError('原生 sha256 未返回有效字符串');
    return result;
  };
}

/** 校验并安装桥接，闭包不持有源文件或正则匹配结果。参数：native引擎、prefix短前缀；返回：恢复原属性的函数。 */
function installTimestampBridge(native, prefix) {
  const descriptor = Object.getOwnPropertyDescriptor(console, 'timeStamp');
  if (descriptor && !descriptor.configurable) throw new Error('console.timeStamp 不可配置，无法安全安装或恢复');
  const timestamp = createDesktopTimestamp(native, prefix);
  const testValue = 'native-compat-local';
  const expected = createHash('sha256').update([prefix, testValue, testValue].join('|')).digest('hex');
  if (timestamp(testValue, testValue) !== expected) throw new Error('当前原生 sha256 与桌面桥接算法不匹配');
  Object.defineProperty(console, 'timeStamp', { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? true, value: timestamp });
  /** 恢复安装前属性。参数：无；返回：无；属性被替换时拒绝覆盖。 */
  return function restoreDesktopTimestamp() {
    if (console.timeStamp !== timestamp) throw new Error('console.timeStamp 已被其它代码替换，拒绝覆盖');
    if (descriptor) Object.defineProperty(console, 'timeStamp', descriptor);
    else delete console.timeStamp;
  };
}

/** 从已读取的源码安装时间戳，供启动层共享一次ASAR读取。参数：native原生导出、source主进程源码；返回：恢复函数。 */
function installDesktopTimestampFromSource(native, source) {
  if (!native || typeof native.sha256 !== 'function') throw new TypeError('需要当前桌面引擎的 sha256 导出');
  return installTimestampBridge(native, desktopTimestampPrefix(source));
}

/** 从同版ASAR安装时间戳；兼容独立调用方。参数：native原生导出、asarPath可选同版资源；返回：恢复函数。 */
function installDesktopTimestamp(native, asarPath) {
  if (!native || typeof native.sha256 !== 'function') throw new TypeError('需要当前桌面引擎的 sha256 导出');
  return installDesktopTimestampFromSource(native, readDesktopMain(asarPath ?? resolveDesktopInstallation().asarPath));
}

module.exports = { installDesktopTimestamp, installDesktopTimestampFromSource, desktopTimestampPrefix };
