// src/pagamento.js
// Webhooks de pagamento: Mercado Pago, Asaas, Stripe
// Idempotente: processa cada evento apenas uma vez

const fetch = require('node-fetch');
const { log, EVENTOS } = require('./logs');

// ── Verificar idempotência ────────────────────────────────────
async function jaProcessado(supabase, gateway, eventId) {
  const { data } = await supabase
    .from('webhooks_recebidos')
    .select('id, processado')
    .eq('gateway', gateway)
    .eq('gateway_event_id', String(eventId))
    .single();
  return data || null;
}

async function marcarProcessado(supabase, gateway, eventId, payload) {
  await supabase.from('webhooks_recebidos').upsert({
    gateway,
    gateway_event_id: String(eventId),
    payload,
    processado: true
  }, { onConflict: 'gateway,gateway_event_id' });
}

// ── Ativar plano no banco ─────────────────────────────────────
async function ativarPlano(supabase, { perfil_id, gateway, gateway_id, valor, plano, periodo_meses }) {
  const { error } = await supabase.from('pagamentos').insert({
    perfil_id, gateway, gateway_id,
    valor, plano, periodo_meses: periodo_meses || 1,
    status: 'pago',
    pago_em: new Date().toISOString()
  });
  if (error) throw new Error('Erro ao registrar pagamento: ' + error.message);
  // Trigger do Supabase cuida de ativar o plano automaticamente
}

// ── MERCADO PAGO ──────────────────────────────────────────────
async function processarMercadoPago(supabase, body, headers) {
  const tipo = body.type || body.action;
  const eventId = body.data?.id || body.id;

  if (!eventId) return { ok: false, msg: 'ID do evento não encontrado' };

  // Idempotência
  const existente = await jaProcessado(supabase, 'mercadopago', eventId);
  if (existente?.processado) {
    await log(supabase, { evento: EVENTOS.WEBHOOK_DUPLICADO, nivel: 'aviso',
      detalhe: { gateway: 'mercadopago', event_id: eventId } });
    return { ok: true, msg: 'Já processado' };
  }

  // Apenas pagamentos aprovados
  if (!['payment', 'payment.updated'].includes(tipo)) {
    return { ok: true, msg: `Tipo ${tipo} ignorado` };
  }

  try {
    // Consultar detalhes do pagamento na API do MP
    const res = await fetch(`https://api.mercadopago.com/v1/payments/${eventId}`, {
      headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` },
      timeout: 10000
    });
    const pagamento = await res.json();

    if (pagamento.status !== 'approved') {
      await marcarProcessado(supabase, 'mercadopago', eventId, body);
      return { ok: true, msg: `Status ${pagamento.status} — ignorado` };
    }

    // Extrair dados do metadata definido na criação do pagamento
    const meta = pagamento.metadata || {};
    const perfil_id = meta.perfil_id;
    const plano = meta.plano || 'mensal';
    const periodo = parseInt(meta.periodo_meses) || 1;

    if (!perfil_id) return { ok: false, msg: 'perfil_id não encontrado no metadata' };

    await ativarPlano(supabase, {
      perfil_id, gateway: 'mercadopago',
      gateway_id: String(eventId),
      valor: pagamento.transaction_amount,
      plano, periodo_meses: periodo
    });

    await marcarProcessado(supabase, 'mercadopago', eventId, pagamento);
    await log(supabase, { perfil_id, evento: EVENTOS.PAGAMENTO_RECEBIDO, nivel: 'info',
      detalhe: { gateway: 'mercadopago', valor: pagamento.transaction_amount, plano } });

    return { ok: true, msg: `Plano ${plano} ativado para ${perfil_id}` };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

// ── ASAAS ─────────────────────────────────────────────────────
async function processarAsaas(supabase, body, headers = {}) {
  // FIX 5: validar token Asaas — configura no painel: Configurações → Integrações → Webhook
  const tokenRecebido = headers['asaas-access-token'];
  if (!tokenRecebido || tokenRecebido !== process.env.ASAAS_WEBHOOK_TOKEN) {
    console.error('Asaas webhook token inválido');
    await log(supabase, { evento: 'webhook_asaas_invalido', nivel: 'critico',
      detalhe: { token_presente: !!tokenRecebido } }).then(null, () => {});
    return { ok: false, msg: 'Token Asaas inválido — possível fraude' };
  }

  const evento = body.event;
  const eventId = body.payment?.id || body.id;

  if (!eventId) return { ok: false, msg: 'ID não encontrado' };

  const existente = await jaProcessado(supabase, 'asaas', eventId);
  if (existente?.processado) return { ok: true, msg: 'Já processado' };

  // Apenas pagamentos confirmados
  if (!['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'].includes(evento)) {
    await marcarProcessado(supabase, 'asaas', eventId, body);
    return { ok: true, msg: `Evento ${evento} ignorado` };
  }

  try {
    const pag = body.payment;
    const meta = pag.externalReference ? JSON.parse(pag.externalReference) : {};
    const perfil_id = meta.perfil_id;
    const plano = meta.plano || 'mensal';
    const periodo = parseInt(meta.periodo_meses) || 1;

    if (!perfil_id) return { ok: false, msg: 'perfil_id não encontrado em externalReference' };

    await ativarPlano(supabase, {
      perfil_id, gateway: 'asaas',
      gateway_id: eventId, valor: pag.value,
      plano, periodo_meses: periodo
    });

    await marcarProcessado(supabase, 'asaas', eventId, body);
    await log(supabase, { perfil_id, evento: EVENTOS.PAGAMENTO_RECEBIDO, nivel: 'info',
      detalhe: { gateway: 'asaas', valor: pag.value, plano } });

    return { ok: true, msg: `Plano ${plano} ativado` };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

// ── STRIPE ────────────────────────────────────────────────────
async function processarStripe(supabase, body, rawBody, signature) {
  // Verificação de assinatura Stripe (segurança)
  let evento;
  try {
    if (process.env.STRIPE_WEBHOOK_SECRET && signature) {
      // Verificação manual de assinatura sem SDK
      const crypto = require('crypto');
      const parts = signature.split(',');
      const t = parts.find(p => p.startsWith('t=')).split('=')[1];
      const v1 = parts.find(p => p.startsWith('v1=')).split('=')[1];
      const payload = `${t}.${rawBody}`;
      const expected = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
        .update(payload).digest('hex');
      if (expected !== v1) return { ok: false, msg: 'Assinatura Stripe inválida' };
    }
    evento = body;
  } catch (e) {
    return { ok: false, msg: 'Erro na verificação Stripe: ' + e.message };
  }

  const eventId = evento.id;
  const existente = await jaProcessado(supabase, 'stripe', eventId);
  if (existente?.processado) return { ok: true, msg: 'Já processado' };

  if (evento.type !== 'checkout.session.completed') {
    await marcarProcessado(supabase, 'stripe', eventId, body);
    return { ok: true, msg: `Evento ${evento.type} ignorado` };
  }

  try {
    const session = evento.data.object;
    const meta = session.metadata || {};
    const perfil_id = meta.perfil_id;
    const plano = meta.plano || 'mensal';
    const periodo = parseInt(meta.periodo_meses) || 1;

    if (!perfil_id) return { ok: false, msg: 'perfil_id não encontrado nos metadata' };

    await ativarPlano(supabase, {
      perfil_id, gateway: 'stripe',
      gateway_id: eventId,
      valor: (session.amount_total || 0) / 100,
      plano, periodo_meses: periodo
    });

    await marcarProcessado(supabase, 'stripe', eventId, body);
    await log(supabase, { perfil_id, evento: EVENTOS.PAGAMENTO_RECEBIDO, nivel: 'info',
      detalhe: { gateway: 'stripe', valor: session.amount_total / 100, plano } });

    return { ok: true, msg: `Plano ${plano} ativado` };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

// ── Criar link de pagamento Mercado Pago ──────────────────────
async function criarLinkMP(perfil_id, plano, periodo_meses) {
  const config = {
    trial:  { valor: 0,   titulo: 'AgroVenda Pro — Trial 7 dias' },
    basico: { valor: 49,  titulo: 'AgroVenda Pro — Plano Básico'  },
    mensal: { valor: 97,  titulo: 'AgroVenda Pro — Plano Mensal'  },
    anual:  { valor: 797, titulo: 'AgroVenda Pro — Plano Anual'   },
  };
  const cfg = config[plano] || config.mensal;

  const body = {
    items: [{ title: cfg.titulo, quantity: 1, unit_price: cfg.valor }],
    metadata: { perfil_id, plano, periodo_meses: String(periodo_meses || 1) },
    back_urls: {
      success: `${process.env.FRONTEND_URL || 'https://agrovenda.netlify.app'}?status=pago`,
      failure: `${process.env.FRONTEND_URL || 'https://agrovenda.netlify.app'}?status=falhou`,
    },
    auto_return: 'approved',
    notification_url: `${process.env.RAILWAY_URL}/pagamentos/mercadopago`
  };

  const res = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`
    },
    body: JSON.stringify(body),
    timeout: 10000
  });
  const data = await res.json();
  if (!data.init_point) throw new Error('Erro ao criar link MP: ' + JSON.stringify(data));
  return data.init_point;
}

module.exports = { processarMercadoPago, processarAsaas, processarStripe, criarLinkMP };
