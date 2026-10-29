import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NativeQuoteWorker } = require('../../server/native/worker.cjs');

/** 固定测试端点，仅供内存假引擎使用，不触发安装扫描或网络探测。 */
export const testDesktopEndpoints = { region: 'bj', geoTest: 'https://geotest.lbctrl.com/', api: 'https://api.lbctrl.com/',
  quoteGateway: 'wss://quote.lbctrl.com/', lbGatewayWS: 'wss://ws.lbctrl.com/v1' };

/** 创建注入静态端点的内存worker。参数：原生替身、事件消费者；返回：真实worker实例，不加载原生模块。 */
export function createNativeWorker(native: unknown, send: (event: string, data: any) => void): any {
  return new NativeQuoteWorker(native, send, testDesktopEndpoints);
}
