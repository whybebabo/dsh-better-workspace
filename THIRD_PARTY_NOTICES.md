# Third-Party Notices

dsh-better-workspace 是独立实现(MIT),**没有复制任何第三方插件的源码**。以下记录了实现过程中参考的外部资料与其许可边界。

## 图标几何

`client/widgets.jsx` 中的描边图标在 24×24 网格、2px 描边、圆角线帽的体系下手绘,该体系与 [Lucide](https://lucide.dev)(ISC License)一致,部分路径形状参考了 Lucide 的图形语言。

> ISC License — Copyright (c) Lucide Contributors
>
> Permission to use, copy, modify, and/or distribute this software for any
> purpose with or without fee is hereby granted, provided that the above
> copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
> WITH REGARD TO THIS SOFTWARE.

## 运行时依赖(未打包,由宿主提供)

客户端 bundle 外部化并在运行时 `require` 两个宿主模块:

- `react` —— 使用宿主已加载的实例(0.2.1 为 React 18.3.1),避免第二份 React;
- `@deepseek-ai/dsh-client-ui-primitives` —— 仅取用原生图标 `IconFolderOpenRegular`、
  `IconFolderCloseRegular`、`IconTriangleRightFillRegular`,使分组行的文件夹开合与折叠三角
  和官方列表完全一致。每个取值都带本地回退字形,导出被改名或删除时不会拖垮整个面板。

宿主 API 名称(`shell.overlay` 槽、`ctx.uiWorkspace.archiveSession/unarchiveSession/pinSession`、
`ctx.workspaces`、`ctx.sessions`、`ctx.connection.fetch`、`webServer.register`)均依据
DeepSeek Harness 0.2.1-rc.2 随包分发的 `@deepseek-ai/*` 模块核对,这些模块版权归 DeepSeek 所有,
本插件仅按其公开行为调用,未包含其代码、图标路径数据或其他资源。

样式使用宿主设计令牌(`--dsw-alias-*`、`--dsw-specific-sidebar-fill`、`--dsw-radius-*`),
并为每个 `var()` 提供回退值。

## 未采用的方案

原计划移植 `dsh-session-manager@0.7.2`(MIT)的 `session-files.js` 与删除流程。实现过程中在
0.2.1-rc.2 运行时上直接核对到了更可靠的落盘事实(`session.v3.jsonl[.zstd]` 头部含 `id`,
`archiveSession(id, {stopActivity})` 为官方命令),因此删除逻辑改为自行实现,
最终**没有复制**该插件的任何代码;若后续引入其代码,需在此处补记其 MIT 版权声明。

本插件不引用、不兼容任何 GPL 许可的同类实现。
