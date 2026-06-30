// src/simulacao.js v4.0
// Simulador financeiro: receita, lucro, margem, risco

function simular({ quantidade, preco, custo, prazo_dias = 0, dolar, taxaJurosMensal = 0.01 }) {
  if (!quantidade || !preco || !custo) {
    return { erro: 'quantidade, preco e custo são obrigatórios.' };
  }

  const receita = quantidade * preco;
  const custoTotal = quantidade * custo;
  const lucro = receita - custoTotal;
  const margem = ((preco - custo) / custo * 100);
  const viavel = preco > custo;

  // Custo de oportunidade: se esperar X dias com financiamento
  const custoOportunidade = prazo_dias > 0
    ? custoTotal * taxaJurosMensal * (prazo_dias / 30)
    : 0;

  const lucroLiquido = lucro - custoOportunidade;

  // Cenários
  const cenarios = [
    { label: 'Pessimista (-15%)',  preco: preco * 0.85, cor: 'vermelho' },
    { label: 'Conservador (-5%)', preco: preco * 0.95, cor: 'laranja' },
    { label: 'Atual',             preco: preco,         cor: 'verde' },
    { label: 'Otimista (+10%)',   preco: preco * 1.10,  cor: 'azul' },
  ].map(c => ({
    ...c,
    preco: Math.round(c.preco),
    lucro: Math.round(quantidade * (c.preco - custo)),
    margem: (((c.preco - custo) / custo) * 100).toFixed(1),
    viavel: c.preco > custo
  }));

  // Ponto de equilíbrio
  const breakEven = custo;
  const distanciaBreakEven = ((preco - custo) / custo * 100).toFixed(1);

  // Classificação de risco
  let risco, descRisco;
  if (margem >= 30)      { risco = 'baixo';  descRisco = 'Margem confortável — recomendado vender'; }
  else if (margem >= 15) { risco = 'medio';  descRisco = 'Margem razoável — acompanhar mercado'; }
  else if (margem >= 5)  { risco = 'alto';   descRisco = 'Margem estreita — atenção ao custo'; }
  else if (margem >= 0)  { risco = 'critico';descRisco = 'Margem mínima — risco de prejuízo com imprevistos'; }
  else                   { risco = 'prejuizo';descRisco = 'Preço abaixo do custo — aguardar alta'; }

  return {
    // Inputs
    quantidade, preco, custo, prazo_dias, dolar,
    // Resultados principais
    receita:         Math.round(receita),
    custo_total:     Math.round(custoTotal),
    lucro:           Math.round(lucro),
    lucro_liquido:   Math.round(lucroLiquido),
    margem:          parseFloat(margem.toFixed(2)),
    custo_oportunidade: Math.round(custoOportunidade),
    // Análise
    viavel,
    risco,
    descricao_risco: descRisco,
    break_even: Math.round(breakEven),
    distancia_break_even_pct: parseFloat(distanciaBreakEven),
    // Cenários
    cenarios,
    // Formatado para exibição
    resumo: viavel
      ? `Vendendo ${quantidade.toLocaleString('pt-BR')} sacas a R$ ${preco.toLocaleString('pt-BR')}: `
        + `receita de R$ ${Math.round(receita).toLocaleString('pt-BR')}, `
        + `lucro de R$ ${Math.round(lucro).toLocaleString('pt-BR')} (margem ${margem.toFixed(1)}%).`
      : `Preço atual (R$ ${preco}) abaixo do custo (R$ ${custo}). Aguardar alta de pelo menos R$ ${Math.ceil(custo - preco)}/saca.`
  };
}

module.exports = { simular };
