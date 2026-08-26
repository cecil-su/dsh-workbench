/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'com.dshworkbench.desktop',
  artifactName: 'dsh-workbench-${version}-${os}-${arch}-unsigned-ci.${ext}',
  asar: false,
  electronFuses: {
    enableCookieEncryption: true,
    enableEmbeddedAsarIntegrityValidation: false,
    enableNodeCliInspectArguments: false,
    enableNodeOptionsEnvironmentVariable: false,
    grantFileProtocolExtraPrivileges: false,
    loadBrowserProcessSpecificV8Snapshot: false,
    onlyLoadAppFromAsar: false,
    resetAdHocDarwinSignature: true,
    runAsNode: true,
  },
  electronVersion: '43.4.1',
  executableName: 'dsh-workbench',
  files: [
    'build/icon.png',
    'lib/**/*',
    'node_modules/**/*',
    'package.json',
  ],
  linux: {
    category: 'Development',
    executableName: 'dsh-workbench',
    icon: 'icon.png',
    target: ['AppImage', 'tar.gz', 'zip'],
  },
  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'icon.icns',
    identity: null,
    target: ['dmg', 'zip'],
  },
  npmRebuild: false,
  nsis: {
    allowToChangeInstallationDirectory: true,
    oneClick: false,
    perMachine: false,
    runAfterFinish: false,
  },
  productName: 'DSH Workbench',
  win: {
    executableName: 'dsh-workbench',
    icon: 'icon.ico',
    target: ['nsis', 'zip'],
  },
}

export default config
