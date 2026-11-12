import { SELF, env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { handleWebhookBatch } from '../src/queue/webhook-consumer'
import { queueBatches, type MetaWebhookEvent } from '../src/api/webhook'

const WABA = '102290129340398'
const PHONE_ID = '106540352242922'
const BUSINESS = '15550783881'
let seq = 0
const customerPhone = () =>
  `55419${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}${seq++ % 10}`
const wamid = () => `wamid.coex.${Date.now()}.${seq++}.${Math.random().toString(36).slice(2)}`

async function sign(secret: string, body: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return 'sha256=' + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function envelope(field: string, value: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: WABA, time: 1739321024, changes: [{ field, value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: BUSINESS, phone_number_id: PHONE_ID },
      ...value,
    } }] }],
  }
}

async function post(payload: unknown) {
  const body = JSON.stringify(payload)
  const sendBatch = vi.spyOn(env.WEBHOOK_QUEUE, 'sendBatch')
  try {
    const response = await SELF.fetch('https://x.com/webhook', {
      method: 'POST', body,
      headers: { 'x-hub-signature-256': await sign('dev-meta-secret', body) },
    })
    const events = sendBatch.mock.calls.flatMap((call) =>
      Array.from(call[0]).map((item) => item.body as MetaWebhookEvent))
    return { status: response.status, events, calls: sendBatch.mock.calls.length }
  } finally {
    sendBatch.mockRestore()
  }
}

async function messagesOf(phone: string) {
  const rows = await env.DB.prepare(
    `SELECT m.id, m.direction, m.message_type, m.text_body, c.unread_count
     FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
     JOIN contacts k ON k.id = m.contact_id
     WHERE k.wa_id = ?1 ORDER BY m.meta_timestamp`,
  ).bind(phone).all<{ id: string; direction: string; message_type: string; text_body: string | null; unread_count: number }>()
  return rows.results
}

describe('POST /webhook coexistência', () => {
  it('guarda o corpo bruto no R2 antes de interpretar, e ignora campos comuns', async () => {
    const day = new Date().toISOString().slice(0, 10)
    const before = await env.MEDIA.list({ prefix: `coex-raw/${day}/history/` })
    const payload = envelope('history', { history: [{ metadata: { phase: 0, chunk_order: 9, progress: 1 }, threads: [] }] })
    expect((await post(payload)).status).toBe(200)
    const after = await env.MEDIA.list({ prefix: `coex-raw/${day}/history/` })
    expect(after.objects.length).toBe(before.objects.length + 1)
    const fresh = after.objects.find((o) => !before.objects.some((b) => b.key === o.key))!
    const stored = await env.MEDIA.get(fresh.key)
    expect(await stored!.text()).toBe(JSON.stringify(payload))

    const others = await env.MEDIA.list({ prefix: 'coex-raw/' })
    await post(envelope('messages', { messages: [] }))
    expect((await env.MEDIA.list({ prefix: 'coex-raw/' })).objects.length).toBe(others.objects.length)
  })

  it('extrai histórico com direção correta e não rejeita mensagem estranha', async () => {
    const user = customerPhone()
    const [m1, m2, m3] = [wamid(), wamid(), wamid()]
    const { status, events } = await post(envelope('history', {
      history: [{
        metadata: { phase: 0, chunk_order: 1, progress: 55 },
        threads: [{
          id: user,
          context: { wa_id: user, user_id: 'BR.1234567890' },
          messages: [
            { from: BUSINESS, id: m1, timestamp: '1739230955', type: 'text',
              text: { body: 'Olá, segue a cotação' }, history_context: { status: 'READ' } },
            { from: BUSINESS, id: m2, timestamp: '1739230960', type: 'media_placeholder',
              history_context: { status: 'PLAYED' } },
            { from: user, from_user_id: 'BR.1234567890', id: m3, timestamp: '1739230970',
              type: 'text', text: { body: 'Obrigado!' }, history_context: { status: 'READ' } },
            { from: user, type: 'text' }, // sem id/timestamp: descartada, lote segue
          ],
        }],
      }],
    }))
    expect(status).toBe(200)
    const coex = events.filter((e) => e.kind === 'coex_message')
    expect(coex).toHaveLength(3)
    expect(coex.map((e) => e.kind === 'coex_message' && e.direction))
      .toEqual(['outbound', 'outbound', 'inbound'])
    expect(coex.every((e) => e.kind === 'coex_message' && e.customer?.phone === user)).toBe(true)
    expect(events.some((e) => e.kind === 'platform_event' && e.field === 'history'
      && e.summary.progress === 55)).toBe(true)
  })

  it('registra recusa de compartilhamento do histórico como erro de plataforma', async () => {
    const { status, events } = await post(envelope('history', {
      history: [{ errors: [{ code: 2593109, title: 'History sync is turned off',
        message: 'History sync is turned off', error_data: { details: 'disabled' } }] }],
    }))
    expect(status).toBe(200)
    expect(events).toEqual([expect.objectContaining({
      kind: 'platform_error', scope: 'history.errors',
      error: expect.objectContaining({ code: 2593109 }),
    })])
  })

  it('extrai eco enviado pelo celular como saída para o cliente', async () => {
    const user = customerPhone()
    const id = wamid()
    const { status, events } = await post(envelope('smb_message_echoes', {
      contacts: [{ wa_id: user, user_id: 'BR.555' }],
      message_echoes: [{ from: BUSINESS, to: user, to_user_id: 'BR.555', id,
        timestamp: '1739321024', type: 'text', text: { body: 'Respondi pelo celular' } }],
    }))
    expect(status).toBe(200)
    expect(events).toEqual([expect.objectContaining({
      kind: 'coex_message', source: 'echo', direction: 'outbound',
      customer: expect.objectContaining({ phone: user, userId: 'BR.555' }),
      message: expect.objectContaining({ id, textBody: 'Respondi pelo celular' }),
    })])
  })

  it('extrai contatos da agenda do app', async () => {
    const user = customerPhone()
    const { status, events } = await post(envelope('smb_app_state_sync', {
      state_sync: [
        { type: 'contact', contact: { full_name: 'Dra. Ana Clínica', first_name: 'Ana',
          phone_number: user }, action: 'add', metadata: { timestamp: '1739321024' } },
        { type: 'contact', contact: { phone_number: user }, action: 'remove',
          metadata: { timestamp: '1739321025' } },
        { type: 'other', action: 'add' },
      ],
    }))
    expect(status).toBe(200)
    expect(events.map((e) => e.kind === 'coex_contact' && e.action)).toEqual(['add', 'remove'])
    expect(events[0]).toEqual(expect.objectContaining({ fullName: 'Dra. Ana Clínica', timestamp: 1739321024 }))
  })

  it('aceita chunk de histórico acima de 1000 mensagens em vários lotes da Queue', async () => {
    const user = customerPhone()
    const messages = Array.from({ length: 1500 }, (_, i) => ({
      from: i % 2 ? BUSINESS : user, id: `wamid.big.${Date.now()}.${i}`,
      timestamp: String(1739000000 + i), type: 'text', text: { body: `mensagem ${i}` },
    }))
    const { status, events, calls } = await post(envelope('history', {
      history: [{ metadata: { phase: 1, chunk_order: 3, progress: 80 },
        threads: [{ id: user, context: { wa_id: user }, messages }] }],
    }))
    expect(status).toBe(200)
    expect(events.filter((e) => e.kind === 'coex_message')).toHaveLength(1500)
    expect(calls).toBeGreaterThanOrEqual(15)
  })

  it('mídia de histórico enviada pela empresa no campo messages não vira inbound', async () => {
    const id = wamid()
    const { status, events } = await post(envelope('messages', {
      messages: [{ from: BUSINESS, id, timestamp: '1739230960', type: 'image',
        image: { id: '987654321', mime_type: 'image/jpeg', sha256: 'abc' } }],
    }))
    expect(status).toBe(200)
    expect(events).toEqual([expect.objectContaining({
      kind: 'coex_message', source: 'history', direction: 'outbound',
      message: expect.objectContaining({ id, type: 'image' }),
    })])
    expect(events[0]).not.toHaveProperty('customer')
  })
})

describe('queueBatches', () => {
  it('respeita 100 itens e o teto de bytes por lote', () => {
    const big = 'x'.repeat(4000)
    const events: MetaWebhookEvent[] = Array.from({ length: 250 }, (_, i) => ({
      kind: 'coex_message', wabaId: WABA, phoneNumberId: PHONE_ID, source: 'history',
      direction: 'inbound', message: { id: `m${i}`, timestamp: '1', type: 'text', textBody: big },
    }))
    const batches = queueBatches(events)
    expect(batches.flat()).toHaveLength(250)
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(100)
      expect(new TextEncoder().encode(JSON.stringify(batch)).byteLength).toBeLessThan(256_000)
    }
  })
})

describe('consumer da coexistência', () => {
  const coex = (
    phone: string, id: string, direction: 'inbound' | 'outbound',
    message: Partial<{ type: string; textBody: string; timestamp: string; content: Record<string, unknown> }> = {},
    source: 'history' | 'echo' = 'history',
  ): MetaWebhookEvent => ({
    kind: 'coex_message', wabaId: WABA, phoneNumberId: PHONE_ID, source, direction,
    customer: { phone },
    message: { id, timestamp: message.timestamp ?? '1739230955', type: message.type ?? 'text',
      ...(message.textBody ? { textBody: message.textBody } : {}),
      ...(message.content ? { content: message.content } : {}) },
  })

  it('grava histórico nos dois sentidos sem contar como não lido nem disparar automação', async () => {
    const phone = customerPhone()
    const automation = vi.spyOn(env.AUTOMATION_QUEUE, 'send')
    try {
      const [a, b, c] = [wamid(), wamid(), wamid()]
      await handleWebhookBatch([
        coex(phone, a, 'outbound', { textBody: 'Bom dia', timestamp: '1739230955' }),
        coex(phone, b, 'inbound', { textBody: 'Quero cotar', timestamp: '1739230960' }),
        coex(phone, c, 'outbound', { textBody: 'Pelo celular', timestamp: '1739230970' }, 'echo'),
      ], env)
      const rows = await messagesOf(phone)
      expect(rows.map((r) => [r.id, r.direction])).toEqual([[a, 'outbound'], [b, 'inbound'], [c, 'outbound']])
      expect(rows[0].unread_count).toBe(0)
      expect(automation).not.toHaveBeenCalled()
      // Reentrega da Meta não duplica.
      await handleWebhookBatch([coex(phone, b, 'inbound', { textBody: 'Quero cotar' })], env)
      expect(await messagesOf(phone)).toHaveLength(3)
    } finally {
      automation.mockRestore()
    }
  })

  it('completa o media_placeholder quando a mídia chega depois, mesmo sem cliente', async () => {
    const phone = customerPhone()
    const id = wamid()
    await handleWebhookBatch([coex(phone, id, 'outbound', { type: 'media_placeholder' })], env)
    expect((await messagesOf(phone))[0].message_type).toBe('media_placeholder')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('mídia expirada'))
    try {
      await handleWebhookBatch([{
        kind: 'coex_message', wabaId: WABA, phoneNumberId: PHONE_ID, source: 'history',
        direction: 'outbound',
        message: { id, timestamp: '1739230955', type: 'image', textBody: 'Apólice',
          content: { mediaId: '987654321', mimeType: 'image/jpeg' } },
      }], env)
    } finally {
      fetchSpy.mockRestore()
    }
    const [row] = await messagesOf(phone)
    expect(row.message_type).toBe('image')
    expect(row.text_body).toBe('Apólice')
  })

  it('eco recente tira o robô da conversa; eco antigo não mexe', async () => {
    const phone = customerPhone()
    const now = Math.floor(Date.now() / 1000)
    await handleWebhookBatch([coex(phone, wamid(), 'inbound', { textBody: 'Oi', timestamp: String(now - 10) })], env)
    const conv = () => env.DB.prepare(
      'SELECT c.id, c.mode, c.handoff_reason FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE k.wa_id = ?1',
    ).bind(phone).first<{ id: string; mode: string; handoff_reason: string | null }>()
    await env.DB.prepare("UPDATE conversations SET mode = 'bot' WHERE id = ?1").bind((await conv())!.id).run()

    await handleWebhookBatch([coex(phone, wamid(), 'outbound', { textBody: 'velho', timestamp: String(now - 7200) }, 'echo')], env)
    expect((await conv())?.mode).toBe('bot')

    await handleWebhookBatch([coex(phone, wamid(), 'outbound', { textBody: 'Pode deixar', timestamp: String(now) }, 'echo')], env)
    expect(await conv()).toEqual(expect.objectContaining({
      mode: 'human', handoff_reason: 'Respondido pelo app WhatsApp Business no celular',
    }))
  })

  it('aplica o nome da agenda do app ao contato e ignora remoção', async () => {
    const phone = customerPhone()
    const contactEvent = (action: 'add' | 'remove', fullName?: string): MetaWebhookEvent => ({
      kind: 'coex_contact', wabaId: WABA, phoneNumberId: PHONE_ID, action,
      customer: { phone }, ...(fullName ? { fullName } : {}), timestamp: 1739321024 + seq++,
    })
    await handleWebhookBatch([contactEvent('add', 'Dr. Paulo Vet')], env)
    const read = () => env.DB.prepare('SELECT name FROM contacts WHERE wa_id = ?1')
      .bind(phone).first<{ name: string }>()
    expect((await read())?.name).toBe('Dr. Paulo Vet')
    await handleWebhookBatch([contactEvent('remove')], env)
    expect((await read())?.name).toBe('Dr. Paulo Vet')
  })
})
