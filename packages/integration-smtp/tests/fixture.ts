import { readFile } from 'node:fs/promises'
import { SMTPServer } from 'smtp-server'
import type { SmtpConnectionConfig } from '../src/index.js'

export interface CapturedSmtpMessage {
  from: string
  to: string[]
  raw: string
  secure: boolean
}

export interface SmtpFixtureOptions {
  tls?: 'tls' | 'starttls'
  username?: string
  password?: string
  rejectRecipients?: string[]
  finalResponse?: 'accept' | 'hold' | 'disconnect' | ((message: CapturedSmtpMessage) => 'accept' | 'hold' | 'disconnect')
  disableStartTls?: boolean
}

/** Real loopback SMTP/TLS fixture. Its committed key is test-only and must never be used in a deployment. */
export async function startSmtpFixture(options: SmtpFixtureOptions = {}) {
  const [key, caPem] = await Promise.all([
    readFile(new URL('./fixtures/localhost-key.pem', import.meta.url), 'utf8'),
    readFile(new URL('./fixtures/localhost-cert.pem', import.meta.url), 'utf8'),
  ])
  const messages: CapturedSmtpMessage[] = []
  const errors: string[] = []
  const credential = { username: options.username ?? 'numen-test-user', password: options.password ?? 'numen-test-password' }
  const tls = options.tls ?? 'tls'
  let authCount = 0
  const server = new SMTPServer({
    secure: tls === 'tls', key, cert: caPem, logger: false, authOptional: false,
    disabledCommands: options.disableStartTls ? ['STARTTLS'] : [],
    allowInsecureAuth: false, closeTimeout: 100, socketTimeout: 10_000,
    onAuth(auth, _session, callback) {
      authCount += 1
      if (auth.username !== credential.username || auth.password !== credential.password) {
        callback(new Error('Fixture rejected credentials.'))
      } else callback(null, { user: credential.username })
    },
    onRcptTo(address, _session, callback) {
      if (options.rejectRecipients?.includes(address.address)) {
        callback(Object.assign(new Error('Fixture rejected recipient.'), { responseCode: 550 }))
      } else callback()
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)))
      stream.on('error', () => callback(new Error('Fixture stream failed.')))
      stream.on('end', () => {
        const message = {
          from: session.envelope.mailFrom && session.envelope.mailFrom.address || '',
          to: session.envelope.rcptTo.map(address => address.address),
          raw: Buffer.concat(chunks).toString('utf8'),
          secure: session.secure,
        }
        messages.push(message)
        const response = typeof options.finalResponse === 'function' ? options.finalResponse(message) : options.finalResponse ?? 'accept'
        if (response === 'hold') return
        if (response === 'disconnect') {
          // Deliberately drop the transport after DATA but before the final SMTP acceptance response.
          for (const connection of server.connections) {
            if (connection.session.id === session.id) connection._socket.destroy()
          }
          return
        }
        callback(null, 'Fixture accepted message.')
      })
    },
  })
  server.on('error', error => errors.push(error instanceof Error ? error.name : 'SMTP fixture error'))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.server.address()
  if (!address || typeof address === 'string') throw new Error('Expected loopback SMTP address.')
  const config: SmtpConnectionConfig = { host: '127.0.0.1', port: address.port, tls, from: 'sender@example.test', caPem }
  let closed = false
  return {
    config, credential, messages, errors,
    get authCount() { return authCount },
    get activeConnections() { return server.connections.size },
    async close() {
      if (closed) return
      closed = true
      // smtp-server owns the TLS wrappers as well as sessions still handshaking.
      // Destroying its underlying net.Socket directly can crash Node's TLS native layer.
      await new Promise<void>(resolve => server.close(resolve))
    },
  }
}
