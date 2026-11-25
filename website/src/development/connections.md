---
description: 通过 Credential、Connection Type 和 Adapter 隔离秘密、配置与可重建的连接运行时。
---

# 凭据与连接

Capability 声明需要哪种连接协议，Adapter 负责创建协议的运行时实现，Credential 保存秘密。工作流只保存 Connection ID，不保存密码、socket 或客户端实例。

| 对象 | 保存什么 | 示例 |
| --- | --- | --- |
| Credential Type | 秘密的 Schema | `smtp:password@1` 的用户名和密码 |
| Credential | 加密秘密与版本 | 用户填写的 SMTP 账号 |
| Connection Type | 稳定运行时协议 | `smtp:transport@1` |
| Adapter | 配置 Schema、凭据类型及 `open()` 实现 | `smtp:password@1` |
| Connection | Adapter、非秘密配置、Credential ID、启用状态 | 主机、端口、固定发件人 |
| Runtime | 进程内、可关闭的客户端对象 | `send()` 方法与连接资源 |

## 一个最小 Adapter

下面只演示契约与生命周期，返回令牌头供后端 Provider 使用，不发出网络请求。其返回对象不能序列化到节点输出或日志中。

```ts
import type {
  ConnectionAdapterDefinition,
  ConnectionTypeDefinition,
} from '@numenjs/connections'
import type { CredentialTypeDefinition } from '@numenjs/credentials'
import type { Context } from 'cordis'
import z from 'schemastery'

interface TokenRuntime {
  authorization(): string
}

const credentialType: CredentialTypeDefinition = {
  id: 'example:token',
  version: 1,
  title: 'Example Token',
  secret: z.object({
    token: z.string().min(1).max(4096)
      .pattern(/^[\x21-\x7e]+$/).role('secret').required(),
  }),
}

const connectionType: ConnectionTypeDefinition<TokenRuntime> = {
  id: 'example:client',
  version: 1,
  title: 'Example Client',
}

const adapter: ConnectionAdapterDefinition = {
  id: 'example:token',
  version: 1,
  title: 'Example with Token',
  type: connectionType,
  credentialType: credentialType.id,
  config: z.object({}),
}

export function apply(ctx: Context): void {
  ctx.credentials.defineType(ctx, credentialType)
  ctx.connections.defineType(ctx, connectionType)
  ctx.connections.defineAdapter(ctx, adapter)
  ctx.connections.provideAdapter(ctx, adapter, {
    async open({ credential, signal }) {
      const token = credential?.value.token
      if (typeof token !== 'string' || !token) {
        throw new Error('Example credential is unavailable.')
      }
      signal.throwIfAborted()
      let closed = false
      return {
        value: {
          authorization() {
            signal.throwIfAborted()
            if (closed) throw new Error('Example connection is closed.')
            return `Bearer ${token}`
          },
        } satisfies TokenRuntime,
        close() { closed = true },
      }
    },
  })
}

apply.inject = ['credentials', 'connections']
export default apply
```

此例需在插件的依赖中加入 `@numenjs/connections` 和 `@numenjs/credentials`（工作区使用 `workspace:*`），并在 TypeScript 项目引用中加入相应目录。实际网络 Adapter 的 `close()` 还必须关闭 socket、定时器和待处理操作。

## 声明 Capability 的连接槽位

在 Capability 定义中添加：

```ts
connections: [
  { name: 'client', required: true, accepts: ['example:client@1'] },
],
```

Provider 通过 `invoke({ input, connections, signal })` 获取 `connections.client`。宿主按槽位校验 Connection Type，并只注入 READY Runtime 的 `value`。Capability 不应从数据库读取密文，也不应该自己打开另一个 Credential 客户端绕过管理。

槽位依赖的是 Connection **Type**，不是某个 Adapter ID。这使密码、OAuth 等不同 Adapter 将来能够实现同一种稳定协议；当前没有通用 OAuth 授权流程，不应假定它已经可用。

## 启用与凭据轮换

新建 Connection 默认停用。用户选择 Credential、保存非秘密配置并启用后，ConnectionService 调用 `open({ connection, credential, signal })`；`credential` 是带 `secretVersion` 的固定快照。

停用、配置变更、凭据轮换和插件卸载会使旧 Runtime 失效。宿主通过 generation 隔离旧的异步 `open()` 结果，Provider 也必须响应 `signal`，避免旧回调向新订阅投递。

**READY 的含义由适配器的初始化边界决定。** SMTP READY 表示可创建发送会话，不表示远端已经认证；MQTT READY 也不等于 Broker 当前在线，应继续查看 Trigger 订阅健康状态。

## 秘密与错误处理

- `NUMEN_MASTER_KEY` 必须可解码为 32 字节，用于加密 Credential；保留原密钥才能解密旧数据。
- `role('secret')` 提供字段展示语义，秘密仍必须交给 Credential 存储，不能仅靠遮罩保护普通配置。
- 错误返回固定、安全的说明，不包含令牌、完整服务器回复或原始请求体。
- 匿名访问应通过显式配置或独立 Adapter 表达，不能在缺少 Credential 时静默降级。
- 第三方库、连接对象和函数不属于可持久化的节点值；输出应为 Numen 支持的值或合法 Resource 引用。

查看实际实现：[Webhook Adapter](https://github.com/Mahoo12138/numen/blob/main/packages/integration-webhook/src/index.ts)、[MQTT 双 Adapter](https://github.com/Mahoo12138/numen/blob/main/packages/integration-mqtt/src/index.ts)、[ConnectionService](https://github.com/Mahoo12138/numen/blob/main/packages/connections/src/service.ts)、[CredentialService](https://github.com/Mahoo12138/numen/blob/main/packages/credentials/src/service.ts)。
