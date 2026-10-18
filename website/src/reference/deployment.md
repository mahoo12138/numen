---
description: 从源码或 Docker 启动 Numen，配置 Credential 主密钥，并备份 SQLite 与资源。
---

# 部署与运维

当前提供源码运行与本地 Docker 构建。默认配置包含官方集成，但已有用户配置不会因升级被自动改写。以下命令部署的是 Numen Runtime，文档站本身是独立静态站点。

## 从源码运行

要求 Node.js **22+**、pnpm **10+**。仓库使用 `packageManager` 锁定 pnpm 版本。

```sh
git clone https://github.com/Mahoo12138/numen.git
cd numen
pnpm install
pnpm build
pnpm numen key generate
```

最后一条命令输出 Base64 编码的 32 字节 Credential 主密钥。将它保存在你的秘密管理方式中，并通过运行环境注入 `NUMEN_MASTER_KEY`。开发时可在当前终端设置：

```sh
export NUMEN_MASTER_KEY='替换为刚生成的密钥'
pnpm numen config validate
pnpm numen doctor
pnpm numen start --print-launch-url
```

保持同一数据目录使用同一主密钥；每次启动生成新密钥会使旧凭据无法解密。源码 CLI 不会因为目录里存在 `.env` 就自动读取它，需显式注入环境变量。

默认地址是 `http://127.0.0.1:5140`。启动输出的 **Workbench launch URL** 是私有引导链接，首次打开后由 Workbench 交换凭据；不要把它复制到公开日志或截图中。凭据放在 URL fragment 中，不会包含在浏览器首次 HTTP 请求中。

已构建的程序也可直接运行编译入口：

```sh
node packages/cli/dist/bin.js start --config numen.config.yml --print-launch-url
```

## Docker Compose

仓库提供本地镜像构建，不假定存在已发布的公共镜像：

```sh
docker build -t numen:local .
cp .env.example .env
docker run --rm numen:local key generate
```

把输出的密钥填入 `.env` 的 `NUMEN_MASTER_KEY`，然后：

```sh
docker compose up --build -d
docker compose logs numen
```

Compose 使用名为 `numen-data` 的数据卷保存 `/var/lib/numen`，默认只将 Workbench 映射到宿主回环地址 `127.0.0.1:5140`。启动日志会显示私有引导 URL。若要让外部服务调用 Webhook，部署者需配置可达入口、反向代理与 TLS。

`NUMEN_HTTP_PROXY` 可为使用宿主 HTTP 客户端的集成设置 HTTP(S) / SOCKS 代理，`NO_PROXY` 声明直连目标，例如 `localhost,127.0.0.1,::1,.home.arpa`。MQTT 与 SMTP 使用各自的协议传输，不应假设它们会使用 HTTP 代理。

## 检查服务

| 入口或命令 | 用途 |
| --- | --- |
| `GET /api/health` | 进程存活 |
| `GET /api/ready` | 判断数据库与契约注册表是否就绪，并附带其他服务的状态 |
| `pnpm numen config validate --config <path>` | 校验配置结构与插件条目 |
| `pnpm numen doctor --config <path>` | 检查数据目录与主密钥等运行条件 |
| `pnpm numen start --safe --config <path>` | 以 safe mode 启动以诊断插件问题 |

`/api/ready` 不会证明远程 SMTP 已认证、MQTT 已订阅或某条流程可运行。部署后创建一个 **Cron Schedule → Echo** 流程，发布、激活、启用，检查实际 Run，再测试需要真实账号的外部集成。

## 持久化与备份

完整恢复至少需要同一时间点的 SQLite 数据、Resource 目录、配置及原 Credential 主密钥。数据库包含秘密密文；主密钥应单独保护，不能随普通诊断包分发。

当前以停止写入后的冷备为基础。首次备份可执行：

```sh
mkdir -p backups
docker compose stop numen
docker compose cp numen:/var/lib/numen ./backups/numen-data
docker compose start numen
curl --fail http://127.0.0.1:5140/api/ready
```

后续每次备份使用新的目标目录，避免混合多个时间点。恢复必须在服务停止时进行，目标是空的新卷或已归档的旧卷；不要只替换 `numen.db` 却留下另一个时间点的 `resources/`。恢复后先验证 readiness 和一次 Run，再开放自动触发。

升级前保留当前 Git revision / 镜像标识、锁文件、配置与冷备。数据库迁移和程序回退是两件事，不能仅换回旧镜像就宣称已完成数据回滚。

## 运行边界

同一个数据库当前只支持**单个活跃 Scheduler**，不要启动多个 worker 或共享同一数据卷的活跃副本。MQTT 的默认 client ID 也来自持久 Connection ID，复制数据库后并行运行会产生连接身份冲突。

并发限制、队列及已接受 Run 可以恢复；停机时未被接受的 Cron 计划或 MQTT 消息并不保证补发。外部副作用中断后可能结果不确定，需要在人工重试前检查接收方。

更多操作依据：[Dockerfile](https://github.com/Mahoo12138/numen/blob/main/Dockerfile)、[Compose](https://github.com/Mahoo12138/numen/blob/main/compose.yml)、[CLI 命令](https://github.com/Mahoo12138/numen/blob/main/packages/cli/src/cli.ts)、[工程与运维记录](https://github.com/Mahoo12138/numen/blob/main/docs/13-engineering-operations.md)。
