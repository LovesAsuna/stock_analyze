'use strict';
const { readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

/** 检查安装资源是否为普通文件。参数：path候选路径；返回：存在且为文件，权限错误明确抛出。 */
function isFile(path) {
  try { return statSync(path).isFile(); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    throw new Error(`无法读取长桥安装资源（${error.code || '未知文件错误'}），请检查目录权限`);
  }
}

/** 核验候选应用中的同版资源。参数：root安装目录、platform系统、arch运行架构；返回：完整资源路径或null。 */
function inspectInstallation(root, platform, arch) {
  const candidates = platform === 'darwin' ? [join(root, 'Contents', 'Resources'), root] : [join(root, 'resources'), root];
  for (const resources of candidates) {
    const asarPath = join(resources, 'app.asar');
    const addonPath = join(resources, 'app.asar.unpacked', 'node_modules', '@lb-public', 'engine-neon', 'addons', platform === 'darwin' ? 'mac' : 'win', arch, 'engine_neon.node');
    if (isFile(asarPath) && isFile(addonPath)) return { resources, asarPath, addonPath };
  }
  return null;
}

/** 定位桌面引擎与配套ASAR，不加载或启动应用。参数：可选系统、架构、手动目录和应用扫描目录；返回：唯一匹配安装的资源路径。 */
function resolveDesktopInstallation({ platform = process.platform, arch = process.arch, installRoot = process.env.LONGBRIDGE_INSTALL_DIR, applicationsDir = '/Applications' } = {}) {
  const supported = platform === 'darwin' ? ['arm64', 'x64'] : platform === 'win32' ? ['x64', 'ia32'] : [];
  if (!supported.includes(arch)) throw new Error(`桌面原生行情暂不支持 ${platform}/${arch}`);
  if (installRoot !== undefined) {
    if (typeof installRoot !== 'string' || !installRoot.trim()) throw new Error('LONGBRIDGE_INSTALL_DIR必须为非空安装目录');
    const installation = inspectInstallation(installRoot, platform, arch);
    if (!installation) throw new Error(`指定的长桥安装目录缺少 ${platform}/${arch} 引擎或配套app.asar，请检查LONGBRIDGE_INSTALL_DIR`);
    return installation;
  }
  if (platform === 'win32') {
    const installation = inspectInstallation('C:/Program Files (x86)/Longbridge Pro', platform, arch);
    if (!installation) throw new Error(`未找到本机Longbridge Pro ${arch}引擎或配套app.asar`);
    return installation;
  }
  let entries;
  try { entries = readdirSync(applicationsDir, { withFileTypes: true }); }
  catch (error) { throw new Error(`无法扫描macOS应用目录（${error.code || '未知文件错误'}），请检查/Applications或设置LONGBRIDGE_INSTALL_DIR`); }
  const applications = entries.filter(entry => /\.app$/i.test(entry.name) && /longbridge|longport|长桥|長橋/i.test(entry.name));
  const installations = applications.map(entry => inspectInstallation(join(applicationsDir, entry.name), platform, arch)).filter(Boolean);
  if (installations.length > 1) throw new Error('发现多个可用长桥桌面应用，请用LONGBRIDGE_INSTALL_DIR指定要使用的.app目录');
  if (!installations.length) throw new Error(`未在/Applications找到包含mac/${arch}引擎及app.asar的长桥桌面应用，请安装匹配架构的桌面端或设置LONGBRIDGE_INSTALL_DIR`);
  return installations[0];
}

module.exports = { resolveDesktopInstallation };
