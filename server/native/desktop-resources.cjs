'use strict';
const { openSync, readSync, closeSync, fstatSync } = require('node:fs');

/**
 * 只读已安装ASAR中的主进程成员，不执行包内代码或读取用户目录。
 * @param {string} asarPath 同版桌面资源路径。
 * @returns {string} 完整主进程源码；布局、大小或读取失败时抛错。
 */
function readDesktopMain(asarPath) {
  const descriptor = openSync(asarPath, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (readSync(descriptor, prefix, 0, 16, 0) !== 16) throw new Error('桌面 ASAR 头部不完整');
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    if (jsonSize > 64 * 1024 * 1024 || jsonSize < 2 || headerSize < jsonSize + 8) throw new Error('桌面 ASAR 头部大小无效');
    const header = Buffer.alloc(jsonSize);
    if (readSync(descriptor, header, 0, jsonSize, 16) !== jsonSize) throw new Error('桌面 ASAR 成员目录不完整');
    const entry = JSON.parse(header.toString('utf8')).files?.dist?.files?.main?.files?.['index.js'];
    const offset = typeof entry?.offset === 'string' && /^\d+$/.test(entry.offset) ? Number(entry.offset) : NaN;
    const size = entry?.size;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size <= 0 || size > 32 * 1024 * 1024 || entry.unpacked || 8 + headerSize + offset + size > fstatSync(descriptor).size) throw new Error('桌面 ASAR 主进程成员无效');
    const source = Buffer.alloc(size);
    if (readSync(descriptor, source, 0, size, 8 + headerSize + offset) !== size) throw new Error('桌面 ASAR 主进程代码不完整');
    return new TextDecoder('utf-8', { fatal: true }).decode(source);
  } finally { closeSync(descriptor); }
}

module.exports = { readDesktopMain };
