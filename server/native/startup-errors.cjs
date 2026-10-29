'use strict';

// 仅传递固定诊断，不输出原生异常原文、用户路径或会话内容。
const messages = {
  ISOLATION: '隔离用户目录校验失败',
  INSTALL_SCAN: '无法扫描 /Applications，请检查目录权限或设置 LONGBRIDGE_INSTALL_DIR',
  INSTALL_MULTIPLE: '发现多个可用长桥应用，请设置 LONGBRIDGE_INSTALL_DIR 指定 .app',
  INSTALL_MISSING: '未找到当前运行架构对应的桌面引擎及 app.asar，请检查安装或 LONGBRIDGE_INSTALL_DIR',
  INSTALL_ACCESS: '无法读取桌面安装资源，请检查目录权限',
  PLATFORM: '当前系统或进程架构不受支持',
  NATIVE_ARCH: '原生模块架构不匹配，请核对 Bun 与桌面引擎的 arm64/x64 架构',
  NATIVE_DEPENDENCY: '原生模块依赖库缺失或无法加载，请检查桌面应用是否完整安装',
  NATIVE_SIGNATURE: 'macOS 拒绝加载原生模块，请检查应用签名或系统安全提示',
  NATIVE_LOAD: '原生模块加载失败，请核对桌面版本、运行时及架构兼容性',
  TIMESTAMP_COMPAT: '当前桌面 app.asar 的 timeStamp 桥接格式或算法不兼容，需要核对该桌面版本',
  ENGINE_INIT: '原生模块已加载，但引擎初始化失败',
  ENDPOINT_CONFIG: '当前桌面 app.asar 的生产端点配置无法唯一识别，需要核对该桌面版本',
  ENDPOINT_UNAVAILABLE: '桌面提供的生产行情端点均不可连接，请检查网络或代理',
  HTTP_INIT: '原生引擎已初始化，但行情 HTTP 客户端创建失败',
  SESSION_CHECK: '隔离行情会话检查失败，已停止连接',
  STARTUP_UNKNOWN: '本机原生引擎初始化失败，失败阶段未知',
};

/** 将初始化失败归类为固定诊断。参数：stage阶段、error原始异常；返回：可安全传输的错误。 */
function startupFailure(stage, error) {
  const text = typeof error?.message === 'string' ? error.message : '';
  let code = stage;
  if (stage === 'INSTALL_MISSING') {
    if (/暂不支持/.test(text)) code = 'PLATFORM';
    else if (/无法扫描/.test(text)) code = 'INSTALL_SCAN';
    else if (/多个可用/.test(text)) code = 'INSTALL_MULTIPLE';
    else if (/无法读取/.test(text)) code = 'INSTALL_ACCESS';
  } else if (stage === 'NATIVE_LOAD') {
    if (/incompatible architecture|wrong architecture|mach-o.*(?:arm64|x86_64)|NODE_MODULE_VERSION|not a valid Win32/i.test(text)) code = 'NATIVE_ARCH';
    else if (/code signature|not valid for use in process|system policy|library load disallowed/i.test(text)) code = 'NATIVE_SIGNATURE';
    else if (/Library not loaded|image not found|dependent libraries|specified module could not be found/i.test(text)) code = 'NATIVE_DEPENDENCY';
  }
  return readStartupFailure({ code });
}

/** 从IPC或异常恢复白名单诊断，拒绝任意错误原文。参数：value诊断对象；返回：安全Error。 */
function readStartupFailure(value) {
  const code = typeof value?.code === 'string' && Object.hasOwn(messages, value.code) ? value.code : 'STARTUP_UNKNOWN';
  return Object.assign(new Error(`原生引擎初始化失败 [${code}]：${messages[code]}（${process.platform}/${process.arch}）`), { code });
}

/** 检查异常是否为本地固定初始化诊断。参数：error异常；返回：布尔。 */
function isStartupFailure(error) {
  return typeof error?.code === 'string' && Object.hasOwn(messages, error.code);
}

module.exports = { startupFailure, readStartupFailure, isStartupFailure };
