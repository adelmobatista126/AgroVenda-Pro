// src/fila.js v3.3
// Fila de notificações Telegram com:
// - worker separado (não bloqueia servidor)
// - anti-duplicação por tipo + janela de tempo
// - reenvio automático até 3 tentativas
// - log de erro por mensagem

const fetch = require('node-fetch');

// Enviar mensagem Telegram (server-side — sem CORS)
async function enviarTelegram(botToken, chatId, mensagem) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: mensagem, parse_mode: 'HTML' }),
      timeout: 15000
    });
    const data = await res.json();
    return { ok: data.ok, erro: data.ok ? null : (data.description || 'Erro desconhecido') };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

// Adicionar mensagem na fila
async function enfileirar(supabase, { perfil_id, tipo, mensagem, destino_bot, destino_chat, agendado_para }) {
  if (!perfil_id || !tipo || !mensagem || !destino_bot || !destino_chat) {
    console.error('enfileirar: parâmetros obrigatórios faltando');
    return null;
  }

  const { data, error } = await supabase.from('fila_notificacoes').insert({
    perfil_id,
    tipo,
    canal: 'telegram',
    destino_bot,
    destino_chat,
    mensagem: mensagem.substring(0, 4000), // limite de tamanho
    status: 'pendente',
    tentativas: 0,
    agendado_para: agendado_para || new Date().toISOString() // corrigido: toISOString() completo
  }).select().single();

  if (error) console.error('Erro ao enfileirar:', error.message);
  return data || null;
}

// Processar fila — chamado pelo cron a cada 5 minutos
async function processarFila(supabase) {
  const agora = new Date().toISOString();

  const { data: itens, error } = await supabase
    .from('fila_notificacoes')
    .select('*')
    .in('status', ['pendente', 'falha'])
    .lt('tentativas', 3)
    .lte('agendado_para', agora)
    .order('criado_em', { ascending: true })
    .limit(20);

  if (error) { console.error('Erro ao buscar fila:', error.message); return; }
  if (!itens?.length) return;

  console.log(`📨 Processando ${itens.length} mensagens na fila`);

  for (const item of itens) {
    // Marcar como processando — evita duplo envio em reinicializações
    const { error: errUpdate } = await supabase
      .from('fila_notificacoes')
      .update({ status: 'processando', tentativas: item.tentativas + 1 })
      .eq('id', item.id)
      .eq('status', item.status); // CAS — só atualiza se ainda no estado esperado

    if (errUpdate) continue; // Outro processo já pegou este item

    const resultado = await enviarTelegram(item.destino_bot, item.destino_chat, item.mensagem);
    const novoStatus = resultado.ok
      ? 'enviado'
      : (item.tentativas + 1 >= 3 ? 'falha_definitiva' : 'falha');

    await supabase.from('fila_notificacoes').update({
      status: novoStatus,
      erro: resultado.erro || null,
      processado_em: resultado.ok ? new Date().toISOString() : null
    }).eq('id', item.id);

    if (resultado.ok) {
      // Atualizar alerta correspondente como enviado
      await supabase.from('alertas')
        .update({ telegram_enviado: true })
        .eq('perfil_id', item.perfil_id)
        .eq('tipo', item.tipo.replace('alerta_preco_', 'preco_atingido'))
        .is('telegram_enviado', false)
        .gte('criado_em', new Date(Date.now() - 3600000).toISOString());

      console.log(`✅ Enviado: ${item.tipo} → perfil ${item.perfil_id}`);
    } else {
      console.warn(`⚠️ Falha (${item.tentativas + 1}/3): ${resultado.erro} — item ${item.id}`);
    }
  }
}

// Anti-spam: verificar se já enviou alerta recente para este produtor + cultura
async function jaEnviouRecentemente(supabase, perfil_id, cultura, horas = 6) {
  const limite = new Date(Date.now() - horas * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from('fila_notificacoes')
    .select('id')
    .eq('perfil_id', perfil_id)
    .eq('tipo', 'alerta_preco_' + cultura)
    .in('status', ['enviado', 'pendente', 'processando'])
    .gte('criado_em', limite)
    .limit(1);

  return (data?.length || 0) > 0;
}

module.exports = { enviarTelegram, enfileirar, processarFila, jaEnviouRecentemente };
