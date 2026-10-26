import type { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve('artifacts/longbridge-runtime-20261021-c');
const resources = {
  '/chart-lab/runtime.js': { file: 'script-0-lbquotemodule_runtime_99fefd.js', type: 'text/javascript', hash: 'fe1f876da2d1e38041ed05ee87a995158f0054df0da7a326f70c8aa4fb35c182' },
  '/chart-lab/runtime.wasm': { file: 'lbquotemodule_runtime_99fefd.wasm', type: 'application/wasm', hash: '784b9c66459939098bcde055fffeed624220e87f62cc06f311beeab2f8c07a7b' },
} as const;
const bridgeHash = '0906c50ac299a1dca5233ca6096e0cc15f040da8ac7d1c436d6e36ae75bce200';

/** 读取固定资源并验证采集摘要。参数：文件名与哈希；返回：可信版本的字节，失败抛错。 */
async function verified(file: string, hash: string): Promise<Buffer> {
  const bytes = await readFile(resolve(root, file));
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('图表实验资源校验失败。');
  return bytes;
}

/** 输出受 sandbox 与 CSP 限制的合成数据页面。参数：桥接代码；返回：HTML，不请求真实行情。 */
function laboratory(bridge: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:clip;background:#111213}canvas{display:block;width:100%;height:100%}
</style></head><body theme="#111213"><canvas id="canvas" oncontextmenu="event.preventDefault()"></canvas>
<script>${bridge}</script><script>
window.removeEventListener('message',receiveMessage);
sendMessage = function() {};
const values=new Map();
Module.chartGetInt=(key,fallback)=>values.get(key)??fallback;
Module.chartGetString=(key,fallback)=>values.get(key)??fallback;
Module.chartSetInt=(key,value)=>values.set(key,value);
Module.chartSetString=(key,value)=>values.set(key,value);
Module.handleApiRequest=async()=>({code:-1,message:'Only synthetic data is available',data:{}});
Module.chartAsyncGetSquashValue=async()=>({});
Module.forwardInputUiActions=false;
Module.print=function(){};
const parentOrigin=new URL(document.referrer).origin;
const periods={day:[1,1010],week:[1,1011],month:[1,1012],quarter:[1,1014],year:[1,1013],
'1m':[1,1000],'5m':[1,1002],'15m':[1,1003],'30m':[1,1004],'60m':[1,1005],intraday:[0,5],'five-day':[0,1]};
const initialPeriod=new URLSearchParams(location.hash.slice(1)).get('period');
let active=Object.hasOwn(periods,initialPeriod)?initialPeriod:'day',pending=false,attempts=0;
function notify(state,extra={}){parent.postMessage({type:'chart-lab',state,period:active,...extra},parentOrigin)}
function waitForData(){
 if(!pending)return;
 try{const ranges=JSON.parse(Module.getChartVisibleRange());
  if(ranges.some(range=>range.yMaxValue>range.yMinValue&&range.yMaxValue>1)){
   pending=false;notify('ready',{ranges});return;
  }
 }catch{console.warn('图表实验等待有效可见区间。')}
 if(++attempts<100)setTimeout(waitForData,100);else{pending=false;notify('error')}
}
function changePeriod(period){
 const pair=periods[period];if(!pair)return;
 active=period;Module.setCounterID('ST/US/AAPL');Module.setChartType(...pair);
 Module.refreshData();Module.setNextForceUpdate();pending=true;attempts=0;notify('loading');setTimeout(waitForData,100);
}
Module.postRun.unshift(function(){setTimeout(()=>{
 try{Module.sendChartEvent('debug_setting','{"request":2,"push":0,"cache":1}');changePeriod(active)}
 catch{notify('error')}
},0)});
window.addEventListener('error',()=>notify('error'));
window.addEventListener('unhandledrejection',()=>notify('error'));
</script><script src="/chart-lab/runtime.js"></script></body></html>`;
}

/** 仅提供固定资源。参数：响应、请求URL、可选父页来源；返回：响应完成，失败以503呈现。 */
export async function handleChartLab(response: ServerResponse, url: URL, referer?: string): Promise<void> {
  try {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (Object.hasOwn(resources, url.pathname)) {
      const resource = resources[url.pathname as keyof typeof resources];
      response.setHeader('Content-Type', resource.type);
      // opaque-origin sandbox只能匿名读取此固定公开二进制，不能访问账户API。
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.end(await verified(resource.file, resource.hash)); return;
    }
    if (url.pathname !== '/chart-lab/frame') { response.writeHead(404); response.end('Not found'); return; }
    const candidateOrigin = referer ? new URL(referer).origin : url.origin;
    const origin = ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:8787', 'http://localhost:8787'].includes(candidateOrigin)
      ? candidateOrigin : url.origin;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${origin}/chart-lab/runtime.js; connect-src ${origin}/chart-lab/runtime.wasm; style-src 'unsafe-inline'; img-src data:; worker-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts`);
    const bridge = (await verified('entry-inline.js', bridgeHash)).toString('utf8');
    // 将默认WASM路径固定到受限白名单；不开放任意文件或上游代理。
    const html = laboratory(bridge).replace('Module.forwardInputUiActions=false;', `Module.forwardInputUiActions=false;Module.locateFile=()=>${JSON.stringify(`${origin}/chart-lab/runtime.wasm`)};`);
    response.end(html);
  } catch {
    console.error('原版图表实验资源不可用或完整性校验失败。');
    if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('图表实验暂不可用，请检查本地分析资源。');
  }
}
