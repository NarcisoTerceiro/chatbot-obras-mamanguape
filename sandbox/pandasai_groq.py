# -*- coding: utf-8 -*-
"""
Motor de perguntas do sandbox usando PandasAI (v3) + Groq via HTTP.
================================================================
A IA escreve SQL (rodando em DuckDB por baixo) e EXECUTA sobre as abas
da planilha, com auto-correcao - a mesma ideia do Data Formulator, mas
leve: NAO usa litellm, so a biblioteca `requests`.

Fluxo:
  responder(pergunta, abas, regras) ->
    para cada aba, cria um pandasai.DataFrame com NOME = nome da aba e
    DESCRICAO = significado; a IA entao consulta cada aba pelo nome certo.

O adaptador GroqLLM so faz uma chamada HTTP ao endpoint compativel com
OpenAI do Groq. Pode ser trocado por qualquer outro provedor igual.
"""
import os
import requests
import pandas as pd
import pandasai as pai
from pandasai.llm.base import LLM

GROQ_URL = os.environ.get(
    "GROQ_URL", "https://api.groq.com/openai/v1/chat/completions"
)


class GroqLLM(LLM):
    """Adaptador leve: manda o prompt do PandasAI ao Groq e devolve o texto."""

    def __init__(self, api_key=None, model=None, timeout=90):
        self.api_key = api_key or os.environ.get("GROQ_API_KEY", "")
        self.model = model or os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
        self.timeout = timeout

    @property
    def type(self):
        return "groq"

    def call(self, instruction, context=None):
        prompt = instruction.to_string()
        if not self.api_key:
            raise RuntimeError("GROQ_API_KEY nao configurada no sandbox")
        resp = requests.post(
            GROQ_URL,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": self.model,
                "temperature": 0,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]


def _serializavel(valor):
    """Converte o resultado do PandasAI para algo que vira JSON."""
    if isinstance(valor, pd.DataFrame):
        return valor.to_dict(orient="records")
    if isinstance(valor, pd.Series):
        return valor.to_dict()
    try:
        import numpy as np
        if isinstance(valor, np.integer):
            return int(valor)
        if isinstance(valor, np.floating):
            return float(valor)
    except Exception:
        pass
    return valor


def _render_texto(tipo, valor):
    """Renderizacao simples do resultado (o Node redige a frase final)."""
    if isinstance(valor, list):
        linhas = []
        for item in valor[:200]:
            if isinstance(item, dict):
                linhas.append(" — ".join(f"{k}: {v}" for k, v in item.items()))
            else:
                linhas.append(str(item))
        return "\n".join(linhas)
    return str(valor)


def responder(pergunta, abas, regras="", llm=None):
    """
    pergunta : str
    abas     : [ {"nome": str, "descricao": str, "registros": [ {...}, ... ]} ]
    regras   : str  (regras de interpretacao/resposta, opcional)
    llm      : LLM  (injetavel para teste; por padrao usa GroqLLM do ambiente)
    Retorna  : {"ok": bool, "tipo": str, "valor": <json>, "texto": str, "erro"?: str}
    """
    if llm is None:
        llm = GroqLLM()
    pai.config.set({"llm": llm, "save_logs": False})

    dfs = []
    for aba in abas or []:
        registros = aba.get("registros") or []
        if not registros:
            continue
        nome = str(aba.get("nome") or "aba")
        df = pai.DataFrame(registros)
        df.schema.name = pai.sanitize_sql_table_name(nome)
        descricao = str(aba.get("descricao") or f"Aba {nome} da planilha.")
        df.schema.description = f"Aba {nome}. {descricao}"
        dfs.append(df)

    if not dfs:
        return {"ok": False, "erro": "nenhuma aba com dados"}

    texto_pergunta = pergunta
    if regras:
        texto_pergunta = (
            f"{pergunta}\n\n"
            f"Regras para interpretar e calcular (siga estritamente):\n{regras}"
        )

    resposta = pai.chat(texto_pergunta, *dfs)
    valor = _serializavel(getattr(resposta, "value", resposta))
    tipo = getattr(resposta, "type", None)
    return {"ok": True, "tipo": tipo, "valor": valor, "texto": _render_texto(tipo, valor)}
