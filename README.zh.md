# DSH Workbench

[English](README.md)

一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
的插件优先桌面工作台。

DSH Workbench 保持上游 Harness 可替换：Electron 只负责桌面生命周期和原生安全边界，
产品功能进入 Cordis/DSH 插件，上游包全部使用精确版本。

> 当前状态：早期工程骨架。DeepSeek Harness 仍处于开发者预览阶段，可能包含破坏性变更。

长期定位、产品支柱和路线阶段见[产品方向](docs/product-direction.md)。

## 架构

```text
Electron 桌面宿主
        |
        +-- @dsh-workbench/runtime
        |       `-- @deepseek-ai/dsh@0.1.1-rc.2
        |
        +-- DSH Web UI（仅本机）
        |
        `-- 产品插件
                +-- desktop-core
                `-- oauth-ui
```

本项目不 fork、不直接修改 DSH Core。任何不得不使用的上游临时补丁，都必须在
`patches/` 中记录对应 Issue、受影响版本和删除条件。

## 环境要求

- Node.js `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`
- 支持 Electron 的 macOS、Windows 或 Linux

## 本地开发

```sh
pnpm install
pnpm check
pnpm dev
```

`pnpm dev` 会构建本地包、让 DSH Web Host 使用操作系统分配的本机端口，验证完整
Web UI 后再在开启沙箱的 Electron 窗口中加载页面。DSH 用户数据独立保存在
Electron 应用的 `userData` 目录中。桌面宿主还会加载 Workbench 自己的
`desktop-core` overlay，但不会修改用户的 DSH profile。

Settings > Profiles 页面可以创建和切换彼此隔离的 DSH Home、工作目录与持久化浏览器
分区。迁移、恢复以及凭据归属边界见 [Workbench Profiles](docs/profiles.md)。

Settings > Sign-in & authorization 会把服务商登录及本地退出登录交给锁定版 DSH
的官方服务处理；Workbench 不持有也不返回凭据值。详见
[授权边界](docs/authorization.md)。

运行 `pnpm test:integration` 可以验证真实 DSH 进程、动态端口、Workbench overlay、
Web 载荷和 IPC 优雅关闭。

运行 `pnpm package:dir && pnpm test:package` 可构建自包含应用，并把完整应用复制到
工作区之外、使用隔离状态执行验收。`pnpm package:artifacts` 会生成当前平台的未签名
CI 分发格式与校验和。产物矩阵、冒烟保证和签名边界见[打包与发布验收](docs/packaging.md)。

## 目录

```text
apps/desktop/          Electron 主进程与 preload
packages/runtime/      DSH 子进程生命周期与就绪检测
plugins/desktop-core/  第一方 Cordis 插件入口
plugins/oauth-ui/      DSH 官方授权控制界面
docs/                  架构和维护决策
patches/               仅允许临时的上游兼容补丁
upstream/              上游精确版本记录
```

## 工程原则

1. 能通过 DSH/Cordis 插件实现，就不修改 Core。
2. 所有 DSH 包使用精确版本。
3. patch 只能是临时兼容桥梁。
4. Electron Renderer 开启沙箱，并禁用 Node Integration。
5. 每次上游升级使用独立的兼容性 Pull Request。

## 许可证

项目暂未选择开源许可证；添加许可证前，版权仍归各贡献者所有。
