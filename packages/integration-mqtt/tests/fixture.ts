import { Aedes } from 'aedes'
import { createServer, type Socket } from 'node:net'

/** Real in-memory MQTT 3.1.1 broker, reusable by integration and browser tests. */
export async function startMqttFixture(options: { anonymous?: boolean } = {}) {
  const broker = await Aedes.createBroker()
  const credential = { username: 'numen-fixture', password: 'mqtt-fixture-password' }
  broker.authenticate = (_client, username, password, callback) => {
    callback(null, options.anonymous === true || (username === credential.username && password?.toString() === credential.password))
  }
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    broker.handle(socket)
  })
  let port = 0
  let listening = false
  async function start() {
    if (listening) return
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
    })
    port = (server.address() as { port: number }).port
    listening = true
  }
  async function stop() {
    for (const socket of sockets) socket.destroy()
    if (!listening) return
    listening = false
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  await start()
  let closed = false
  return {
    broker, credential,
    get url() { return `mqtt://127.0.0.1:${port}` },
    async publish(topic: string, payload: string | Buffer, options: { qos?: 0 | 1; retain?: boolean } = {}) {
      await new Promise<void>((resolve, reject) => broker.publish({ cmd: 'publish', topic, payload: Buffer.from(payload), qos: options.qos ?? 1, retain: options.retain ?? false, dup: false }, error => error ? reject(error) : resolve()))
    },
    start, stop,
    async restart() { await stop(); await start() },
    async close() {
      if (closed) return
      closed = true
      await stop()
      await new Promise<void>(resolve => broker.close(resolve))
    },
  }
}
