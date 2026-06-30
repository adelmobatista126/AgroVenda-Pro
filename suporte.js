// src/suporte.js v1.0
// Módulo de suporte e sucesso do cliente — sem dependência de atendimento humano
// Assistente IA de suporte (diferente do agente comercial)

const fetch = require('node-fetch');

const CATEGORIAS = {
  primeiros_passos:          'Primeiros passos',
  propriedades:              'Cadastro de propriedades',
  producao:                  'Cadastro de produção',
  como_funciona_ia:          'Como funciona a IA AgroVenda',
  interpretar_recomendacoes: 'Como interpretar recomendações',
  venda_travamento:          'Venda e travamento',
  alertas:                   'Alertas',
  problemas_tecnicos:        'Problemas técnicos',
};

// ── Onboarding: calcular e atualizar progresso ────────────────
async function calcularOnboarding(supabase, perfil_id) {
  // Verificar cada passo com dados reais do banco
  const [fazendas, ppData, analises, alertas, telegramRow] = await Promise.all([
    supabase.from('fazendas').select('id').eq('perfil_id', perfil_id).limit(1),
    supabase.from('produtor_perfil').select('culturas,objetivo').eq('perfil_id', perfil_id).single(),
    supabase.from('analises').select('id').eq('perfil_id', perfil_id).limit(1),
    supabase.from('configuracoes_alertas').select('id').eq('perfil_id', perfil_id).limit(1),
    supabase.from('perfis').select('telegram_chat_id,culturas_interesse').eq('id', perfil_id).single()
  ]);

  const pp      = ppData.data;
  const perfil  = telegramRow.data;

  const passos = {
    passo_1_propriedade: (fazendas.data?.length || 0) > 0,
    passo_2_cultura:     !!(pp?.culturas && Object.keys(pp.culturas).length > 0),
    passo_3_producao:    !!(pp?.culturas && Object.values(pp.culturas).some(c => c.producao_prevista_sc || c.estoque_atual)),
    passo_4_objetivo:    !!(pp?.objetivo),
    passo_5_analise:     (analises.data?.length || 0) > 0,
    passo_6_alerta:      (alertas.data?.length || 0) > 0,
    passo_7_telegram:    !!perfil?.telegram_chat_id,
  };

  const pctCompleto = Math.round(
    Object.values(passos).filter(Boolean).length / Object.keys(passos).length * 100
  );
  const concluido = pctCompleto === 100;

  // Upsert no banco
  await supabase.from('onboarding_progresso').upsert({
    perfil_id,
    ...passos,
    concluido,
    concluido_em: concluido ? new Date().toISOString() : null,
    atualizado_em: new Date().toISOString()
  }, { onConflict: 'perfil_id' });

  // Próximo passo sugerido
  const proximoPasso = gerarProximoPasso(passos, pctCompleto);

  return { passos, pct_completo: pctCompleto, concluido, proximo_passo: proximoPasso };
}

function gerarProximoPasso(passos, pct) {
  if (!passos.passo_1_propriedade)
    return { numero: 1, titulo: 'Cadastre sua fazenda', descricao: 'Adicione o nome, município e estado da sua propriedade.', rota: '/fazendas' };
  if (!passos.passo_2_cultura)
    return { numero: 2, titulo: 'Informe sua cultura e custo', descricao: 'Diga qual cultura você produz e quanto custa por saca.', rota: '/perfil/produtor' };
  if (!passos.passo_3_producao)
    return { numero: 3, titulo: 'Informe sua produção', descricao: 'Adicione quanto você produz e seu estoque atual.', rota: '/perfil/produtor' };
  if (!passos.passo_4_objetivo)
    return { numero: 4, titulo: 'Defina seu objetivo', descricao: 'Quer maximizar preço ou garantir liquidez? Isso personaliza as análises.', rota: '/perfil/produtor' };
  if (!passos.passo_5_analise)
    return { numero: 5, titulo: 'Receba sua primeira análise', descricao: 'Clique em "Analisar" para ver a recomendação de hoje.', rota: '/score' };
  if (!passos.passo_6_alerta)
    return { numero: 6, titulo: 'Configure um alerta de preço', descricao: 'Defina um preço alvo e receba aviso quando o mercado atingir.', rota: '/alertas' };
  if (!passos.passo_7_telegram)
    return { numero: 7, titulo: 'Conecte o Telegram', descricao: 'Receba análises diárias e alertas direto no seu celular.', rota: '/telegram' };
  return null;
}

// ── Criar ticket com diagnóstico automático ───────────────────
async function criarTicket(supabase, perfil_id, dados) {
  const { tela, acao, mensagem_erro, descricao, categoria, urgencia } = dados;

  // Coletar contexto automático do perfil
  const [perfilRow, usoRow, ultimaAnalise] = await Promise.all([
    supabase.from('perfis').select('plano,culturas_interesse,ativo,validade').eq('id', perfil_id).single(),
    supabase.from('uso_ia').select('analises,custo_usd').eq('perfil_id', perfil_id)
      .eq('data', new Date().toISOString().split('T')[0]).single(),
    supabase.from('analises').select('cultura,score,criado_em').eq('perfil_id', perfil_id)
      .order('criado_em', { ascending: false }).limit(1).single()
  ]);

  const contexto = {
    plano:              perfilRow.data?.plano,
    culturas:           perfilRow.data?.culturas_interesse,
    analises_hoje:      usoRow.data?.analises || 0,
    ultima_analise:     ultimaAnalise.data ? { cultura: ultimaAnalise.data.cultura, score: ultimaAnalise.data.score } : null,
    timestamp:          new Date().toISOString(),
    user_agent:         dados.user_agent || null,
  };

  // Tentar sugerir artigo automaticamente
  let artigo_sugerido = null;
  if (descricao || mensagem_erro) {
    const texto = (descricao || mensagem_erro || '').split(' ').slice(0, 5).join(' ');
    const { data: artigoId } = await supabase.rpc('sugerir_artigo', { p_texto: texto });
    artigo_sugerido = artigoId;
  }

  const { data: ticket, error } = await supabase.from('tickets_suporte').insert({
    perfil_id, tela, acao, mensagem_erro, descricao,
    categoria: categoria || 'outro',
    urgencia: urgencia || 'normal',
    contexto,
    artigo_sugerido,
    auto_resolvido: !!artigo_sugerido,
    status: 'aberto'
  }).select().single();

  if (error) throw new Error('Erro ao criar ticket: ' + error.message);

  // Buscar artigo sugerido se houver
  let artigo = null;
  if (artigo_sugerido) {
    const { data } = await supabase.from('help_articles')
      .select('titulo, conteudo_resumido, slug').eq('id', artigo_sugerido).single();
    artigo = data;
  }

  return { ticket, artigo_sugerido: artigo };
}

// ── Assistente IA de suporte ──────────────────────────────────
// Diferente do chat comercial — foca em ajudar a usar o sistema
async function assistenteSuporteIA(supabase, perfil_id, pergunta, anthropicKey) {
  // 1. Buscar artigos relevantes da base de conhecimento
  const { data: artigos } = await supabase
    .from('help_articles')
    .select('titulo, conteudo_resumido, conteudo, categoria')
    .eq('ativo', true)
    .or(`titulo.ilike.%${pergunta}%,conteudo.ilike.%${pergunta}%`)
    .order('visualizacoes', { ascending: false })
    .limit(3);

  // 2. Buscar contexto do produtor para resposta personalizada
  const [perfilRow, onbRow, ppRow] = await Promise.all([
    supabase.from('perfis').select('nome,plano,culturas_interesse').eq('id', perfil_id).single(),
    supabase.from('onboarding_progresso').select('*').eq('perfil_id', perfil_id).single(),
    supabase.from('produtor_perfil').select('objetivo,perfil_risco,culturas').eq('perfil_id', perfil_id).single()
  ]);

  const perfil  = perfilRow.data;
  const onb     = onbRow.data;
  const pp      = ppRow.data;
  const nome    = perfil?.nome?.split(' ')[0] || 'produtor';

  // 3. Montar contexto para a IA
  const baseConhecimento = artigos?.length
    ? `\nBASE DE CONHECIMENTO RELEVANTE:\n` +
      artigos.map(a => `[${a.titulo}]\n${a.conteudo}`).join('\n\n---\n\n')
    : '';

  const contextoProdutor =
    `PRODUTOR: ${nome} | Plano: ${perfil?.plano || 'N/D'}\n` +
    `Culturas: ${(perfil?.culturas_interesse || []).join(', ') || 'não informadas'}\n` +
    `Objetivo: ${pp?.objetivo || 'não definido'} | Risco: ${pp?.perfil_risco || 'moderado'}\n` +
    `Onboarding: ${onb?.pct_completo || 0}% completo`;

  const sistPrompt =
    `Você é o Assistente AgroVenda, suporte especializado do sistema AgroVenda Pro AI.\n` +
    `Seu trabalho é ajudar produtores rurais a entender e usar o sistema.\n\n` +
    `REGRAS:\n` +
    `- Linguagem simples, como se explicasse para um agricultor experiente mas não técnico\n` +
    `- Respostas diretas e práticas, máximo 3 parágrafos\n` +
    `- Se souber a resposta, responda. Se não souber, diga que vai verificar\n` +
    `- Nunca invente dados de mercado ou preços\n` +
    `- Se a pergunta for sobre decisão comercial (vender/esperar), redirecione para a análise do sistema\n` +
    `- Se o problema for técnico sem solução clara, oriente a usar "Relatar Problema"\n\n` +
    contextoProdutor + baseConhecimento;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: sistPrompt,
        messages: [{ role: 'user', content: pergunta }]
      }),
      timeout: 20000
    });

    const data = await res.json();
    const resposta = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

    // Registrar pergunta para FAQ automático
    await registrarDuvidaFrequente(supabase, pergunta, artigos?.[0]?.id || null);

    // Atualizar contador de visualizações dos artigos usados
    if (artigos?.length) {
      const ids = artigos.map(a => a.id).filter(Boolean);
      // Sem RPC de incremento: fazer update simples
      await Promise.all(
        artigos.filter(a=>a.id).map(a => supabase.from('help_articles').update({ visualizacoes: (a.visualizacoes||0)+1 }).eq('id',a.id).catch(()=>{}))
      );
    }

    return {
      resposta,
      artigos_relacionados: artigos?.map(a => ({ titulo: a.titulo, categoria: a.categoria })) || [],
      tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
    };
  } catch (e) {
    // Fallback: resposta da base de conhecimento sem IA
    if (artigos?.length) {
      return {
        resposta: `${artigos[0].conteudo_resumido || artigos[0].conteudo.substring(0, 300)}\n\nPara mais detalhes, consulte o artigo "${artigos[0].titulo}" na Central de Ajuda.`,
        artigos_relacionados: artigos.map(a => ({ titulo: a.titulo, categoria: a.categoria })),
        tokens: 0,
        fonte: 'base_conhecimento'
      };
    }
    return {
      resposta: `Olá, ${nome}! Não consegui encontrar uma resposta automática para sua dúvida. Por favor, use o botão "Relatar Problema" e nossa equipe vai te ajudar em breve.`,
      artigos_relacionados: [],
      tokens: 0,
      fonte: 'fallback'
    };
  }
}

// ── Registrar dúvida para FAQ automático ─────────────────────
async function registrarDuvidaFrequente(supabase, pergunta, artigo_id) {
  try {
    const padrao = pergunta.toLowerCase().trim().substring(0, 100);
    await supabase.from('duvidas_frequentes').upsert({
      pergunta_padrao: padrao,
      exemplos: [pergunta],
      artigo_id,
      ultima_vez: new Date().toISOString(),
    }, { onConflict: 'pergunta_padrao' });
  } catch (e) { /* não crítico */ }
}

// ── Registrar feedback de análise ────────────────────────────
async function registrarFeedback(supabase, perfil_id, { analise_id, sinal_id, cultura, util, motivo }) {
  const { data, error } = await supabase.from('feedback_analises').insert({
    perfil_id, analise_id: analise_id || null, sinal_id: sinal_id || null,
    cultura, util, motivo: util ? null : motivo
  }).select().single();
  if (error) throw new Error(error.message);

  // Incrementar contador no artigo se feedback negativo com motivo
  if (!util && motivo) {
    await registrarDuvidaFrequente(supabase, motivo, null);
  }

  return data;
}

// ── Buscar artigos por categoria ─────────────────────────────
async function listarArtigos(supabase, categoria = null) {
  let q = supabase.from('help_articles')
    .select('id,categoria,slug,titulo,conteudo_resumido,video_url,visualizacoes,util_sim,util_nao')
    .eq('ativo', true)
    .order('categoria')
    .order('ordem');
  if (categoria) q = q.eq('categoria', categoria);
  const { data } = await q;
  return data || [];
}

async function buscarArtigo(supabase, slug) {
  const { data } = await supabase.from('help_articles')
    .select('*').eq('slug', slug).eq('ativo', true).single();

  if (data) {
    // Incrementar visualizações (fire and forget)
    supabase.from('help_articles')
      .update({ visualizacoes: (data.visualizacoes || 0) + 1 })
      .eq('id', data.id).catch(() => {});
  }
  return data;
}

module.exports = {
  calcularOnboarding,
  criarTicket,
  assistenteSuporteIA,
  registrarFeedback,
  listarArtigos,
  buscarArtigo,
  registrarDuvidaFrequente,
  CATEGORIAS,
};
