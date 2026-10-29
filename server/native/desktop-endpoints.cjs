'use strict';
const tls = require('node:tls');
const https = require('node:https');
const { readDesktopMain } = require('./desktop-resources.cjs');

/** 解析有界的字符串/对象字面量，不使用eval或加载桌面主进程。参数：源码、起点；返回：配置对象，动态表达式明确拒绝。 */
function readLiteralObject(source, start) {
  const text = source.slice(start, start + 16384);
  let position = 0; let fields = 0;
  /** 跳过空白。参数：无；返回：无。 */
  const whitespace = () => { while (/\s/.test(text[position] ?? '') && position < text.length) position += 1; };
  /** 读取不含转义的静态字符串。参数：无；返回：字符串。 */
  const string = () => {
    const match = /^(?:"[^"\\\r\n]*"|'[^'\\\r\n]*')/.exec(text.slice(position));
    if (!match) throw new Error('桌面端点配置包含非静态字符串');
    position += match[0].length; return match[0].slice(1, -1);
  };
  /** 递归读取对象。参数：depth嵌套深度；返回：无原型对象。 */
  const object = depth => {
    if (depth > 4 || text[position++] !== '{') throw new Error('桌面端点配置对象无效');
    const result = Object.create(null);
    whitespace();
    while (text[position] !== '}') {
      const match = /^(?:[A-Za-z_$][\w$]*|"[^"\\\r\n]*"|'[^'\\\r\n]*')/.exec(text.slice(position));
      if (!match || ++fields > 128) throw new Error('桌面端点配置字段无效');
      const key = /^["']/.test(match[0]) ? match[0].slice(1, -1) : match[0];
      if (['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(result, key)) throw new Error('桌面端点配置包含重复或危险字段');
      position += match[0].length; whitespace();
      if (text[position++] !== ':') throw new Error('桌面端点配置字段缺少值');
      whitespace(); result[key] = text[position] === '{' ? object(depth + 1) : string(); whitespace();
      if (text[position] === '}') break;
      if (text[position++] !== ',') throw new Error('桌面端点配置包含动态表达式');
      whitespace();
    }
    position += 1; return result;
  };
  return object(0);
}

/** 校验桌面端点，仅允许长桥官方HTTPS/WSS域名，不接受凭证、非标准端口或查询参数。参数：value地址、protocol协议；返回：规范URL。 */
function validateDesktopEndpoint(value, protocol) {
  if (typeof value !== 'string' || value.length > 512) throw new Error('桌面端点地址无效');
  const url = new URL(value);
  if (url.protocol !== protocol || url.username || url.password || url.port || url.search || url.hash || !/^(?:[a-z0-9-]+\.)*(?:lbkrs\.com|lbctrl\.com|longbridge\.com)$/.test(url.hostname) || !/^\/[A-Za-z0-9/_-]*$/.test(url.pathname)) throw new Error('桌面端点地址不在允许的生产域名范围');
  return url.toString();
}

/** 提取当前global桌面引擎的唯一生产配置，排除预发及美区专用配置。参数：主进程源码；返回：同版HTTP/双WS配套的区域候选。 */
function parseDesktopEndpoints(source) {
  if (typeof source !== 'string' || source.length > 32 * 1024 * 1024) throw new Error('桌面主进程源码无效');
  const profiles = [];
  // 已验证的global生产配置为数字版本及hk/bj对象；美区版本带-lbus，预发使用单地址。
  for (const match of source.matchAll(/\{\s*(?:version|"version"|'version')\s*:\s*(["'])v\d+\1\s*,/g)) {
    const profile = readLiteralObject(source, match.index);
    if (profile.api && typeof profile.api === 'object' && profile.ws?.quoteGateway && typeof profile.ws.quoteGateway === 'object') profiles.push(profile);
  }
  if (profiles.length !== 1) throw new Error('当前桌面生产端点配置缺失或存在歧义，需要核对该桌面版本');
  const profile = profiles[0];
  const geoTest = validateDesktopEndpoint(profile.geoTest, 'https:');
  const regions = Object.keys(profile.api);
  if (!regions.length || regions.some(region => !['hk', 'bj'].includes(region))) throw new Error('桌面生产端点区域无效');
  return regions.map(region => ({ region, geoTest, api: validateDesktopEndpoint(profile.api[region], 'https:'),
    quoteGateway: validateDesktopEndpoint(profile.ws.quoteGateway[region], 'wss:'), lbGatewayWS: validateDesktopEndpoint(profile.ws.lbGatewayWS?.[region], 'wss:') }));
}

/** 从唯一安装的同版ASAR提取端点，不读取持久化域名设置或桌面登录。参数：asarPath安装资源；返回：区域候选数组。 */
function discoverDesktopEndpoints(asarPath) { return parseDesktopEndpoints(readDesktopMain(asarPath)); }

/** 限时验证端点DNS/TLS连通性，不发送行情请求或凭证。参数：地址、毫秒期限、可注入TLS连接器；返回：是否完成有效TLS握手。 */
function probeDesktopEndpoint(value, timeoutMs = 5000, connect = tls.connect) {
  const url = new URL(validateDesktopEndpoint(value, value.startsWith('wss:') ? 'wss:' : 'https:'));
  return new Promise(resolve => {
    let socket; let settled = false;
    /** 完成并清理连接。参数：available握手结果；返回：无。 */
    const finish = available => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket?.destroy(); resolve(available);
    };
    const timer = setTimeout(() => finish(false), timeoutMs); timer.unref?.();
    try {
      socket = connect({ host: url.hostname, servername: url.hostname, port: 443, rejectUnauthorized: true });
      socket.once('secureConnect', () => finish(socket.authorized === true));
      socket.once('error', () => finish(false)); socket.once('close', () => finish(false));
    } catch { finish(false); }
  });
}

/** 复用桌面geoTest的code=0/status=200地域规则；失败返回未知，不输出响应正文。参数：地址、期限、可注入GET；返回：bj/hk/null。 */
function detectDesktopRegion(value, timeoutMs = 5000, request = https.get) {
  const url = validateDesktopEndpoint(value, 'https:');
  return new Promise(resolve => {
    let transport; let settled = false;
    /** 完成并回收请求。参数：region地域结果；返回：无。 */
    const finish = region => {
      if (settled) return;
      settled = true; clearTimeout(timer); transport?.destroy(); resolve(region);
    };
    const timer = setTimeout(() => finish(null), timeoutMs); timer.unref?.();
    try {
      transport = request(url, response => {
        response.once('error', () => finish(null)); response.once('aborted', () => finish(null));
        response.once('close', () => finish(null));
        if (response.statusCode !== 200) { response.destroy(); finish(null); return; }
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 4096) { response.destroy(); finish(null); } else chunks.push(Buffer.from(chunk));
        });
        response.once('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!data || typeof data !== 'object' || Array.isArray(data)) { finish(null); return; }
            finish(data.code === 0 || data.status === 200 ? 'bj' : 'hk');
          } catch { finish(null); }
        });
      });
      transport.once('error', () => finish(null));
    } catch { finish(null); }
  });
}

/** 按桌面地域优先选择可用的整组端点，不混用不同区域的HTTP/WS。参数：候选及可注入探测器；返回：配套端点，无可用区域时固定报错。 */
async function selectDesktopEndpoints(candidates, { probe = probeDesktopEndpoint, detectRegion = detectDesktopRegion, timeoutMs = 5000 } = {}) {
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 2 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('桌面端点探测参数无效');
  const regions = new Set();
  for (const candidate of candidates) {
    if (!candidate || !['hk', 'bj'].includes(candidate.region) || regions.has(candidate.region)) throw new Error('桌面端点候选区域无效或重复');
    regions.add(candidate.region);
    validateDesktopEndpoint(candidate.geoTest, 'https:'); validateDesktopEndpoint(candidate.api, 'https:');
    validateDesktopEndpoint(candidate.quoteGateway, 'wss:'); validateDesktopEndpoint(candidate.lbGatewayWS, 'wss:');
  }
  const [region, available] = await Promise.all([
    detectRegion(candidates[0].geoTest, timeoutMs).catch(() => null),
    Promise.all(candidates.map(async candidate => {
      const results = await Promise.all([candidate.api, candidate.quoteGateway, candidate.lbGatewayWS].map(url => probe(url, timeoutMs).catch(() => false)));
      return results.every(result => result === true);
    })),
  ]);
  const preferred = region === 'bj' ? 'bj' : 'hk';
  const index = candidates.findIndex((candidate, position) => candidate.region === preferred && available[position]);
  const selected = index >= 0 ? index : available.findIndex(Boolean);
  if (selected < 0) throw Object.assign(new Error('桌面生产行情端点均不可连接，请检查网络或代理'), { code: 'ENDPOINT_UNAVAILABLE' });
  return candidates[selected];
}

module.exports = { discoverDesktopEndpoints, parseDesktopEndpoints, validateDesktopEndpoint, selectDesktopEndpoints, probeDesktopEndpoint, detectDesktopRegion };
