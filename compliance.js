// src/compliance.js v9.0
// Governança, transparência e redução de riscos jurídicos
// Aplica linguagem moderada, registra consentimentos, loga recomendações

// ── Disclaimer padrão (texto que aparece antes de recomendações) ───
const DISCLAIMER = {
  texto:
    '⚖️ Esta análise é gerada por inteligência artificial com base nos dados ' +
    'disponíveis. Ela serve como apoio à tomada de decisão e não garante preço, ' +
    'lucro ou resultado futuro. O cenário pode mudar por fatores imprevisíveis. ' +
    'Você é responsável pela decisão final.',
  versao: '1.0',
};

// ── Linguagem moderada — substituições automáticas ────────────
// Nunca usar linguagem assertiva sobre o futuro
const SUBSTITUICOES_LINGUAGEM = [
  // Assertivas de alta — proibidas
  { de: /\bvenda agora\b/gi,           para: 'os dados sugerem avaliar venda' },
  { de: /\bvender agora\b/gi,          para: 'considere avaliar venda' },
  { de: /\bvai subir\b/gi,             para: 'o cenário indica possibilidade de valorização' },
  { de: /\birá subir\b/gi,             para: 'existe possibilidade de valorização' },
  { de: /\bpode subir\b/gi,            para: 'pode apresentar valorização' },
  { de: /\bvocê deve vender\b/gi,      para: 'o cenário atual sugere avaliar venda' },
  { de: /\bvender agora é ideal\b/gi,  para: 'os indicadores favorecem avaliação de venda' },
  // Assertivas de queda — proibidas
  { de: /\bvai cair\b/gi,              para: 'o cenário indica maior exposição ao risco de queda' },
  { de: /\birá cair\b/gi,              para: 'existe risco de correção de preços' },
  { de: /\bcertamente cairá\b/gi,      para: 'há indicação de pressão de baixa' },
  // Garantias — proibidas
  { de: /\bgarantido\b/gi,             para: 'indicado pelos dados' },
  { de: /\bcom certeza\b/gi,           para: 'com base nos dados disponíveis' },
  { de: /\bsem dúvida\b/gi,            para: 'os indicadores sugerem' },
  // Recomendações — moderadas
  { de: /\bVENDA AGORA\b/g,            para: 'CENÁRIO FAVORÁVEL PARA AVALIAR VENDA' },
  { de: /\bVENDER AGORA\b/g,           para: 'CENÁRIO FAVORÁVEL PARA AVALIAR VENDA' },
  { de: /\bOPORTUNIDADE — agir agora\b/gi, para: 'CENÁRIO FAVORÁVEL — avaliar ação' },
  { de: /\bagir agora\b/gi,            para: 'avaliar ação imediata' },
];

function moderarLinguagem(texto) {
  if (!texto) return texto;
  let moderado = texto;
  for (const sub of SUBSTITUICOES_LINGUAGEM) {
    moderado = moderado.replace(sub.de, sub.para);
  }
  return moderado;
}

// Verificar se texto contém linguagem proibida
function verificarLinguagem(texto) {
  const proibidas = [
    /\bvenda agora\b/i, /\bvai subir\b/i, /\bvai cair\b/i,
    /\birá subir\b/i,   /\birá cair\b/i,  /\bgarantido\b/i,
    /\bcom certeza\b/i, /\bsem dúvida\b/i, /\bvocê deve vender\b/i,
  ];
  const encontradas = proibidas.filter(r => r.test(texto)).map(r => r.toString());
  return { ok: encontradas.length === 0, frases_proibidas: encontradas };
}

// ── Análise de riscos estruturada ────────────────────────────
function gerarAnaliseRiscos(scoreResult, probabilidades, dados, cultura) {
  const p15 = probabilidades?.horizonte_15d;
  const p30 = probabilidades?.horizonte_30d;
  const itens = scoreResult?.itens || {};

  const riscos_positivos = [];
  const riscos_negativos = [];

  // Fatores positivos do score
  Object.entries(itens).forEach(([k, v]) => {
    if (v.status === 'positivo') riscos_positivos.push(v.desc);
    if (v.status === 'negativo') riscos_negativos.push(v.desc);
  });

  // Probabilidades
  if (p15) {
    if (p15.prob_alta > 55)
      riscos_positivos.push(`Probabilidade de valorização em 15 dias: ${p15.prob_alta}%`);
    if (p15.prob_queda > 50)
      riscos_negativos.push(`Risco de queda em 15 dias: ${p15.prob_queda}%`);
  }

  // Câmbio
  if (dados?.dolar_media_30d && dados?.dolar_ptax) {
    const varCambio = ((dados.dolar_ptax - dados.dolar_media_30d) / dados.dolar_media_30d * 100).toFixed(1);
    if (parseFloat(varCambio) < -2)
      riscos_negativos.push(`Dólar em queda (${varCambio}% vs média 30d) — pressão de baixa nos preços em R$`);
    if (parseFloat(varCambio) > 2)
      riscos_positivos.push(`Dólar valorizado (${varCambio}% vs média 30d) — sustentação dos preços em R$`);
  }

  // Clima
  if (dados?.clima_impacto === 'positivo')
    riscos_positivos.push('Condições climáticas adversas nas regiões produtoras podem reduzir a oferta');
  if (dados?.clima_impacto === 'negativo')
    riscos_negativos.push('Clima favorável à produção pode aumentar oferta e pressionar preços');

  // Incertezas sempre presentes
  const incertezas = [
    'Eventos climáticos extremos podem alterar preços rapidamente',
    'Decisões de política agrícola (Brasil e exterior) são imprevisíveis',
    'Variações cambiais podem inverter cenários em horas',
    'Esta análise reflete o cenário no momento da geração — condições podem mudar',
  ];

  return {
    riscos_positivos:   riscos_positivos.slice(0, 5),
    riscos_negativos:   riscos_negativos.slice(0, 5),
    incertezas_sempre_presentes: incertezas,
    nivel_geral: riscos_negativos.length > riscos_positivos.length ? 'elevado'
               : riscos_negativos.length === 0 ? 'baixo' : 'moderado',
    nota_legal: 'Esta análise não elimina os riscos inerentes ao mercado de commodities.',
  };
}

// ── Registrar consentimento ───────────────────────────────────
async function registrarConsentimento(supabase, user_id, tipo, versao, ip, user_agent) {
  const { data: doc } = await supabase.from('legal_documents')
    .select('id').eq('tipo', tipo).eq('versao', versao).single();

  const { data, error } = await supabase.from('user_consents').upsert({
    user_id, document_type: tipo, document_version: versao,
    document_id: doc?.id || null,
    accepted: true, accepted_at: new Date().toISOString(),
    ip: ip || null, user_agent: user_agent || null
  }, { onConflict: 'user_id,document_type,document_version' }).select().single();

  if (error) throw new Error('Erro ao registrar consentimento: ' + error.message);
  return data;
}

// Verificar se usuário aceitou todos os documentos obrigatórios
async function verificarConsentimentos(supabase, user_id) {
  const { data } = await supabase.rpc('verificar_consentimento', { p_user_id: user_id });
  return data;
}

// ── Logar recomendação exibida ────────────────────────────────
async function logarRecomendacao(supabase, {
  user_id, cultura, recomendacao_exibida,
  preco_momento, dolar_momento, score, market_timing_score,
  probabilidade_alta, probabilidade_queda, confianca,
  indicadores, fatores_externos, contexto_produtor,
  tokens_usados, disclaimer_exibido
}) {
  // Verificar linguagem antes de salvar
  const verificacao = verificarLinguagem(recomendacao_exibida);
  const textoModerado = moderarLinguagem(recomendacao_exibida);

  const { data, error } = await supabase.from('ai_decision_logs').insert({
    user_id, cultura,
    recomendacao_exibida: textoModerado,
    linguagem_verificada: verificacao.ok,
    preco_momento, dolar_momento, score, market_timing_score,
    probabilidade_alta, probabilidade_queda, confianca,
    indicadores, fatores_externos, contexto_produtor,
    disclaimer_exibido: !!disclaimer_exibido,
    disclaimer_aceito: false,
    tokens_usados: tokens_usados || 0,
    versao_ia: '9.0',
  }).select('id').single();

  if (error) {
    console.warn('logarRecomendacao:', error.message);
    return null;
  }
  return data?.id;
}

// Registrar aceite do disclaimer pelo usuário
async function registrarAceiteDisclaimer(supabase, log_id) {
  if (!log_id) return;
  await supabase.from('ai_decision_logs').update({
    disclaimer_aceito: true,
    disclaimer_aceito_em: new Date().toISOString()
  }).eq('id', log_id).catch(() => {});
}

// Registrar ação do usuário após recomendação
async function registrarAcaoUsuario(supabase, log_id, acao) {
  const acoes_validas = ['visualizou','ignorou','vendeu','travou','esperou'];
  if (!log_id || !acoes_validas.includes(acao)) return;
  await supabase.from('ai_decision_logs').update({
    acao_usuario: acao,
    acao_registrada_em: new Date().toISOString()
  }).eq('id', log_id).catch(() => {});
}

// ── Exportar dados do usuário (LGPD) ─────────────────────────
async function exportarDadosUsuario(supabase, user_id) {
  const { data, error } = await supabase.rpc('exportar_dados_usuario', { p_user_id: user_id });
  if (error) throw new Error('Erro ao exportar dados: ' + error.message);
  return data;
}

// Solicitar exclusão de conta (prazo 30 dias)
async function solicitarExclusaoConta(supabase, user_id, motivo) {
  const prazo = new Date();
  prazo.setDate(prazo.getDate() + 30);

  await supabase.from('privacy_settings').upsert({
    user_id,
    solicitou_exclusao: true,
    exclusao_solicitada_em: new Date().toISOString(),
    exclusao_agendada_em: prazo.toISOString(),
  }, { onConflict: 'user_id' });

  // Registrar como incidente para acompanhamento admin
  await supabase.from('incident_reports').insert({
    user_id, tipo: 'solicitacao_exclusao',
    titulo: 'Solicitação de exclusão de conta (LGPD)',
    descricao: motivo || 'Usuário solicitou exclusão de conta.',
    severidade: 'media', status: 'aberto'
  }).catch(() => {});

  return { prazo_exclusao: prazo.toISOString(), mensagem: 'Sua conta será excluída em até 30 dias. Você receberá confirmação por e-mail.' };
}

// ── Confirmação de decisão comercial ─────────────────────────
const TEXTO_CONFIRMACAO_DECISAO =
  'Você confirma que esta decisão comercial foi tomada por você, ' +
  'considerando sua realidade financeira, custos de produção, ' +
  'necessidade de caixa e estratégia pessoal? ' +
  'O AgroVenda oferece apoio analítico, mas a decisão final é sempre sua.';

async function confirmarDecisaoComercial(supabase, user_id, decisaoData) {
  // Salvar decisão com flag de confirmação explícita
  const { data, error } = await supabase.from('decisoes').insert({
    perfil_id: user_id,
    cultura:            decisaoData.cultura,
    decisao:            decisaoData.decisao,
    quantidade_sacas:   decisaoData.quantidade_sacas,
    preco_executado:    decisaoData.preco_executado,
    score_no_momento:   decisaoData.score_no_momento,
    recomendacao_recebida: decisaoData.recomendacao_recebida,
    data_decisao:       new Date().toISOString().split('T')[0],
    aprendizado:        'Decisão confirmada explicitamente pelo produtor.',
  }).select().single();

  if (error) throw new Error(error.message);

  // Logar ação no ai_decision_logs se tiver log_id
  if (decisaoData.log_id) {
    await registrarAcaoUsuario(supabase, decisaoData.log_id, decisaoData.decisao === 'vendeu' ? 'vendeu' : 'travou');
  }

  return data;
}

module.exports = {
  DISCLAIMER,
  moderarLinguagem,
  verificarLinguagem,
  gerarAnaliseRiscos,
  registrarConsentimento,
  verificarConsentimentos,
  logarRecomendacao,
  registrarAceiteDisclaimer,
  registrarAcaoUsuario,
  exportarDadosUsuario,
  solicitarExclusaoConta,
  confirmarDecisaoComercial,
  TEXTO_CONFIRMACAO_DECISAO,
};
