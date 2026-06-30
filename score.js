// src/score.js v4.0
const VERSAO = '4.0';
const PESOS = { cambio:16, preco_vs_media:16, tendencia:12, sazonalidade:12, estoque:9, margem:12, volatilidade:8, clima:8, perfil_risco:7 };

const CLASSIFICACAO = (score) => {
  if (score <= 30) return { label:'risco_alto',   emoji:'🔴', acao:'Evitar vender agora' };
  if (score <= 60) return { label:'neutro',        emoji:'🟡', acao:'Aguardar sinal mais claro' };
  if (score <= 80) return { label:'favoravel',     emoji:'🟢', acao:'Condições favoráveis para venda' };
  return              { label:'oportunidade',  emoji:'🏆', acao:'Oportunidade — agir agora' };
};

// Custo de referência CONAB por cultura (R$/saca) — usado quando produtor não informou
// Atualizar periodicamente com dados CONAB mais recentes
const CUSTO_REFERENCIA_CONAB = {
  cafe:    680,   // café arábica beneficiado, custo médio BR 2024
  soja:    105,   // soja, custo médio MT 2024
  milho:   48,    // milho, custo médio PR 2024
  boi:     210,   // boi gordo, custo médio por @ 2024
  acucar:  80,    // açúcar cristal, custo médio SP 2024
  algodao: 165,   // algodão em pluma, custo médio BA 2024
  trigo:   75,    // trigo, custo médio PR 2024
};
const FONTE_CUSTO = 'CONAB/2024 (estimativa de referência)';

const SAZONALIDADE = {
  cafe:    [0.7,0.8,0.9,0.8,0.6,0.5,0.5,0.6,0.7,0.8,0.8,0.7],
  soja:    [0.9,0.8,0.5,0.4,0.4,0.5,0.7,0.8,0.9,0.9,0.8,0.8],
  milho:   [0.5,0.5,0.4,0.4,0.6,0.8,0.9,0.9,0.8,0.7,0.6,0.5],
  boi:     [0.7,0.7,0.6,0.5,0.5,0.6,0.8,0.9,0.9,0.8,0.7,0.7],
  algodao: [0.6,0.7,0.8,0.8,0.7,0.6,0.5,0.5,0.6,0.7,0.7,0.6],
  trigo:   [0.5,0.5,0.5,0.6,0.7,0.7,0.8,0.9,0.9,0.7,0.6,0.5],
  acucar:  [0.6,0.7,0.8,0.9,0.8,0.7,0.6,0.5,0.5,0.6,0.7,0.7],
};
const MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

function calcularScore(params) {
  const { cultura, precoAtual, precoMedia60d, preco7dAtras, dolar, dolarMedia30d,
    custoProd, estoqueStatus, volatilidadeAlta, climaImpacto,
    objetivoProd, perfilRisco, dividaAtiva, precisaCaixa } = params;

  const mes = new Date().getMonth();
  const itens = {};
  let total = 0;

  // 1. CÂMBIO
  if (dolar && dolarMedia30d) {
    const v = (dolar - dolarMedia30d) / dolarMedia30d;
    const pts = v > 0.02 ? 16 : v > 0 ? 12 : v > -0.02 ? 7 : 2;
    itens.cambio = { pts, max:16, status: pts>=12?'positivo':pts>=7?'neutro':'negativo',
      desc: `Dólar ${v>0?'+':''}${(v*100).toFixed(1)}% vs média 30d` };
  } else {
    itens.cambio = { pts:8, max:16, status:'neutro', desc:'Câmbio sem histórico' };
  }
  total += itens.cambio.pts;

  // 2. PREÇO VS MÉDIA 60D
  if (precoAtual && precoMedia60d) {
    const v = (precoAtual - precoMedia60d) / precoMedia60d;
    const pts = v>0.10?16: v>0.05?13: v>0.01?10: v>0?7: v>-0.05?4: 0;
    itens.preco_vs_media = { pts, max:16, status: pts>=11?'positivo':pts>=6?'neutro':'negativo',
      desc: `Preço ${v>0?'+':''}${(v*100).toFixed(1)}% vs média 60 dias` };
  } else {
    itens.preco_vs_media = { pts:8, max:16, status:'neutro', desc:'Sem histórico suficiente' };
  }
  total += itens.preco_vs_media.pts;

  // 3. TENDÊNCIA 7D
  if (precoAtual && preco7dAtras) {
    const t = (precoAtual - preco7dAtras) / preco7dAtras;
    let pts, desc;
    if (t>0.04)       { pts=5;  desc='Alta acelerada — risco de realização'; }
    else if (t>0.01)  { pts=9;  desc='Alta moderada — bom momento'; }
    else if (t>=-0.01){ pts=12; desc='Estabilidade — mercado seguro para vender'; }
    else if (t>-0.03) { pts=5;  desc='Queda leve — aguardar'; }
    else              { pts=0;  desc='Queda forte — evitar vender'; }
    itens.tendencia = { pts, max:12, status: pts>=9?'positivo':pts>=5?'neutro':'negativo', desc };
  } else {
    itens.tendencia = { pts:6, max:12, status:'neutro', desc:'Tendência não calculada' };
  }
  total += itens.tendencia.pts;

  // 4. SAZONALIDADE
  const fator = (SAZONALIDADE[cultura]||SAZONALIDADE.soja)[mes];
  const ptsSazon = Math.round(fator * 12);
  itens.sazonalidade = { pts:ptsSazon, max:12,
    status: fator>0.7?'positivo':fator>0.4?'neutro':'negativo',
    desc: `${MESES[mes]}: historicamente ${fator>0.7?'favorável':fator>0.4?'neutro':'desfavorável'} para ${cultura}` };
  total += ptsSazon;

  // 5. ESTOQUES
  const ptsEst = estoqueStatus==='apertado'?9: estoqueStatus==='neutro'?5: 0;
  itens.estoque = { pts:ptsEst, max:9,
    status: ptsEst>=7?'positivo':ptsEst>=4?'neutro':'negativo',
    desc: `Estoques ${estoqueStatus||'neutros'} mundialmente` };
  total += ptsEst;

  // 6. MARGEM — usa custo CONAB de referência quando produtor não informou
  const custoProdEfetivo = custoProd || CUSTO_REFERENCIA_CONAB[cultura];
  const usandoCustoRef   = !custoProd && !!custoProdEfetivo;
  if (custoProdEfetivo && precoAtual) {
    const mg = (precoAtual - custoProdEfetivo) / custoProdEfetivo;
    const pts = mg>0.35?12: mg>0.20?10: mg>0.10?8: mg>0.05?5: mg>0?3: 0;
    const sufixo = usandoCustoRef ? ` (ref. CONAB — configure o seu para precisão)` : '';
    itens.margem = { pts, max:12, status: pts>=8?'positivo':pts>=4?'neutro':'negativo',
      desc: `Margem ${(mg*100).toFixed(1)}% sobre custo R$ ${custoProdEfetivo.toLocaleString('pt-BR')}/saca${sufixo}`,
      usando_custo_referencia: usandoCustoRef };
  } else {
    itens.margem = { pts:6, max:12, status:'neutro', desc:'Configure custo no perfil para análise precisa' };
  }
  total += itens.margem.pts;

  // 7. VOLATILIDADE
  const ptsVol = volatilidadeAlta?2:8;
  itens.volatilidade = { pts:ptsVol, max:8,
    status: ptsVol>=6?'positivo':'negativo',
    desc: volatilidadeAlta?'Alta volatilidade — risco de reversão':'Mercado estável' };
  total += ptsVol;

  // 8. CLIMA
  const imp = climaImpacto||'neutro';
  const ptsClima = imp==='positivo'?8: imp==='neutro'?4: 0;
  itens.clima = { pts:ptsClima, max:8, status:imp,
    desc: imp==='positivo'?'Clima reduz oferta → pressão de alta':
          imp==='negativo'?'Clima favorece produção → pressão de baixa':
          'Clima sem impacto relevante' };
  total += ptsClima;

  // 9. PERFIL DO PRODUTOR (v4)
  let ptsPerfil = 4;
  let descPerfil = 'Perfil padrão moderado';
  if (dividaAtiva || precisaCaixa) {
    ptsPerfil = 7; descPerfil = 'Necessidade financeira — vender mesmo com score médio';
  } else if (objetivoProd==='maximizar_preco' && perfilRisco==='arrojado') {
    ptsPerfil = 2; descPerfil = 'Perfil arrojado — aguarda melhor oportunidade';
  } else if (objetivoProd==='minimizar_risco' || perfilRisco==='conservador') {
    ptsPerfil = 6; descPerfil = 'Perfil conservador — prioriza segurança';
  }
  itens.perfil_risco = { pts:ptsPerfil, max:7, status:'neutro', desc:descPerfil };
  total += ptsPerfil;

  const score = Math.min(Math.max(Math.round(total), 0), 100);
  const classif = CLASSIFICACAO(score);

  let percentual = 0;
  if (score>=81)      percentual = dividaAtiva?70:50;
  else if (score>=61) percentual = dividaAtiva?40:30;
  else if (score>=45) percentual = dividaAtiva?20:0;

  const dadosDisp = [precoAtual,precoMedia60d,preco7dAtras,dolar,dolarMedia30d,custoProd,climaImpacto].filter(Boolean).length;

  return {
    score, classificacao: classif.label, emoji: classif.emoji,
    acao: classif.acao, percentual_venda: percentual,
    confianca: Math.round((dadosDisp/7)*100),
    itens, versao: VERSAO,
    metodologia: 'Câmbio(16)+Preço vs média(16)+Tendência(12)+Sazonalidade(12)+Margem(12)+Estoques(9)+Clima(8)+Volatilidade(8)+Perfil(7)'
  };
}

function gerarContextoParaIA(scoreResult, cultura, precoAtual, dolar) {
  const { score, classificacao, itens, confianca } = scoreResult;
  const pos = Object.values(itens).filter(v=>v.status==='positivo').map(v=>v.desc);
  const neg = Object.values(itens).filter(v=>v.status==='negativo').map(v=>v.desc);
  return { score, classificacao, confianca, cultura, preco_atual:precoAtual, dolar_atual:dolar,
    fatores_positivos:pos, fatores_negativos:neg,
    resumo_tecnico: `Score ${score}/100 (${classificacao}). `
      + (pos.length?`Positivo: ${pos.slice(0,2).join('; ')}. `:'')
      + (neg.length?`Atenção: ${neg.slice(0,2).join('; ')}.`:'') };
}

module.exports = { calcularScore, gerarContextoParaIA, CLASSIFICACAO, SAZONALIDADE, VERSAO, CUSTO_REFERENCIA_CONAB };
