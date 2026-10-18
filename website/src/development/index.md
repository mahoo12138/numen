---
description: 使用 Cordis、Capability Contract 和 Provider 编写可由 Numen 加载的本地插件。
---

# 编写第一个插件

Numen 插件是 Cordis 插件。最小后端插件定义输入输出 Schema，注册 Capability Contract，再提供实现。Workbench 根据 Schema 生成字段表单；只有需要额外展示时才添加前端 Entry。

下面的本地 Action 写入一条固定类型的运行日志。注册方式与现有 [Echo 插件](https://github.com/Mahoo12138/numen/blob/main/packages/integration-demo/src/index.ts)相同；Echo 本身是无副作用的 Query。

## 创建 workspace 包

在仓库的 `packages/integration-marker/` 下创建：

```text
integration-marker/
├── package.json
├── tsconfig.json
└── src/index.ts
```

`package.json`：

```json
{
  "name": "@numenjs/integration-marker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "peerDependencies": { "cordis": "4.0.0-rc.8" },
  "dependencies": {
    "@numenjs/core": "workspace:*",
    "schemastery": "^3.18.0"
  }
}
```

这是当前仓库内的依赖方式，不是 npm 发布说明。`tsconfig.json` 复用现有编译配置：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../core" }]
}
```

## 定义 Action 与 Provider

`src/index.ts`：

```ts
import { defineCapability, type CapabilityProvider } from '@numenjs/core'
import type { Context } from 'cordis'
import z from 'schemastery'

interface MarkerInput { marker: 'check' | 'notice' }
interface MarkerOutput { recorded: boolean }

export const markerCapability = defineCapability({
  id: 'example:write-marker',
  version: 1,
  kind: 'action',
  title: 'Write Marker',
  description: 'Write a fixed marker to the host log.',
  input: z.object({
    marker: z.union(['check', 'notice']).required(),
  }),
  output: z.object({
    recorded: z.boolean().required()
      .extra('extra', { numen: { execution: 'public' } }),
  }),
  semantics: {
    sideEffect: true,
    idempotent: false,
    retrySafe: false,
  },
})

export function apply(ctx: Context): void {
  ctx.capabilities.define(ctx, markerCapability)
  ctx.capabilities.provide(ctx, markerCapability, {
    async invoke({ input, signal }) {
      signal.throwIfAborted()
      ctx.logger('example:marker').info('Workflow marker: %s', input.marker)
      return { recorded: true }
    },
  } satisfies CapabilityProvider<MarkerInput, MarkerOutput>)
}

apply.inject = ['capabilities']
export default apply
```

`define` 注册稳定契约，`provide` 注册当前实现，首个参数 `ctx` 表明生命周期归属。卸载后注册随所属 Context 释放，无需自行维护全局注册表。

`semantics` 描述真实行为：本例记录日志会产生副作用，重复执行会重复记录。输出只有不含业务数据的布尔状态，因此明确标为公开可检查字段。不要为了启用重试把发送邮件、发布消息等操作声明为幂等。需要耗时 I/O 时，把 `signal` 传给底层客户端并真正停止操作。

## 构建与加载

在仓库根目录执行：

```sh
pnpm install
pnpm build
pnpm exec tsc -b packages/integration-marker
```

在现有 `numen.config.yml` 的 `plugins` 下加入实例，替换成你机器上的绝对路径：

```yaml
plugins:
  # 保留已有核心服务和产品插件。
  marker:
    $package: /absolute/path/to/numen/packages/integration-marker/dist/index.js
```

然后验证配置并启动：

```sh
pnpm numen config validate
pnpm numen start --print-launch-url
```

在 Workbench 添加 **Write Marker** 节点，选择 `check`，保存并运行草稿测试。检查 Run 输出 `{ "recorded": true }`，以及关联日志。再发布并启用带 Trigger 的流程，验证正式执行路径。

同一 `id@version` 只能注册一次。不要同时通过内建别名和 `$package` 加载同一份 Contract；破坏输入输出兼容性的变更应使用新版本。

## 接入外部服务

把秘密放在 Credential，连接配置放在 Connection，由 Adapter 创建运行时对象，再从 `invoke({ connections })` 取得已就绪的对象。参见[凭据与连接](./connections)。

Trigger 使用 `ctx.capabilities.provideTrigger(ctx, definition, provider)`，通过 `activate({ binding, signal, connections, emit })` 建立订阅并返回清理函数。调用 `emit()` 后检查 `accepted`、`duplicate` 或 `stale`，需要持久接受后确认的协议应等待它完成。长连接可通过 `reportStatus?.('ERROR')` / `reportStatus?.('READY')` 更新健康状态。

前端 Entry 是可选增强。[Webhook](https://github.com/Mahoo12138/numen/blob/main/packages/integration-webhook/src/index.ts)的后端接收不依赖 Workbench，入口复制由独立前端贡献提供。共享组件的独立构建示例见 [examples/components-plugin](https://github.com/Mahoo12138/numen/tree/main/examples/components-plugin)。

## 验证插件生命周期

先用真实 Context 和临时 SQLite 验证注册、发布、执行及恢复，再检查边界：非法输入、连接不可用、取消、超时、凭据轮换、卸载后在途回调，以及外部操作成功但响应丢失。

本地协议测试可参考 [MQTT 测试](https://github.com/Mahoo12138/numen/tree/main/packages/integration-mqtt/tests)与 [SMTP 测试](https://github.com/Mahoo12138/numen/tree/main/packages/integration-smtp/tests)。这些测试使用本地服务，真实账号权限、限流及外网投递仍需单独验证。
