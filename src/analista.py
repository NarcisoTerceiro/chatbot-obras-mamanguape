#!/usr/bin/env python3
# ============================================================
# analista.py - ANALISTA PYTHON (pandas) do agente de obras
# ============================================================
# Recebe via stdin um JSON {"codigo": "...", "dados": [ {...}, ... ]}
# Monta um DataFrame `df` (com as chaves de dados_extras viradas colunas),
# executa o codigo pandas gerado pela IA em ambiente restrito e devolve
# via stdout um JSON {"ok": true, "resultado": [...], "tipo": "..."}.
#
# Referencias da abordagem:
# - Program-of-Thoughts (Chen et al., 2022): o LLM escreve codigo e o
#   interpretador faz o calculo -> elimina erro aritmetico do modelo.
# - PandasAI / LangChain create_pandas_dataframe_agent: LLM gera pandas
#   sobre um DataFrame descrito por schema + amostra.
# - Self-Debugging (Chen et al., 2023): o traceback real volta pro LLM
#   para corrigir o codigo (feito no agente.js).
# - Chain-of-Table (Wang et al., 2024): operacoes tabulares encadeadas.
# ============================================================
import ast
import json
import re
import sys
import unicodedata
import signal
import math
import datetime as _dt

import numpy as np
import pandas as pd

TIMEOUT_S = 12
MAX_LINHAS_SAIDA = 500

NOMES_PROIBIDOS = {
    "open", "exec", "eval", "compile", "__import__", "input", "globals", "locals",
    "vars", "getattr", "setattr", "delattr", "breakpoint", "exit", "quit", "help",
    "memoryview", "os", "sys", "subprocess", "socket", "shutil", "pathlib", "importlib",
    "builtins", "to_pickle", "read_pickle", "to_csv", "to_excel", "to_parquet",
    "read_csv", "read_excel", "read_sql", "to_sql", "read_html", "read_json", "to_json",
    "eval_", "query_",
}


def sem_acento(s):
    s = "" if s is None else str(s)
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn").lower().strip()


def nome_coluna(k):
    k = sem_acento(k)
    k = re.sub(r"[^a-z0-9]+", "_", k).strip("_")
    return k or "campo"


def numero_br(v):
    """Converte 'R$ 1.234,56', '45%', '1234.5' em float. Retorna NaN se nao der."""
    if v is None:
        return np.nan
    if isinstance(v, (int, float, np.number)) and not isinstance(v, bool):
        return float(v)
    s = str(v).strip()
    if not s:
        return np.nan
    s = re.sub(r"[^0-9,.\-]", "", s)
    if not s or s in {"-", ".", ","}:
        return np.nan
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    elif s.count(".") > 1:
        s = s.replace(".", "")
    try:
        return float(s)
    except ValueError:
        return np.nan


def data_br(v):
    """Converte dd/mm/aaaa, aaaa-mm-dd ou datetime em Timestamp."""
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return pd.NaT
    s = str(v).strip()
    if not s:
        return pd.NaT
    if re.match(r"^\d{4}-\d{2}-\d{2}", s):
        return pd.to_datetime(s[:10], errors="coerce")
    return pd.to_datetime(s, dayfirst=True, errors="coerce")


def contem(serie, termo):
    """Busca tolerante a acento/caixa: contem(df.objeto, 'ubs')."""
    t = sem_acento(termo)
    return serie.astype(str).map(sem_acento).str.contains(re.escape(t), na=False)


def montar_df(dados):
    linhas = []
    mapa_extras = {}
    for r in dados or []:
        r = dict(r or {})
        extras = r.pop("dados_extras", None)
        if isinstance(extras, str):
            try:
                extras = json.loads(extras)
            except Exception:
                extras = None
        if isinstance(extras, dict):
            for k, v in extras.items():
                col = nome_coluna(k)
                if col in r:
                    col = f"extra_{col}"
                mapa_extras[col] = k
                r[col] = v
        linhas.append(r)
    df = pd.DataFrame(linhas)
    # Converte automaticamente colunas claramente numericas/financeiras
    for c in df.columns:
        if df[c].dtype == object and re.search(r"(valor|percentual|preco|custo|total|qtd|quantidade|area_m|metragem)", c):
            conv = df[c].map(numero_br)
            if conv.notna().sum() >= max(1, int(df[c].notna().sum() * 0.6)):
                df[c] = conv
    return df, mapa_extras


def validar_codigo(codigo):
    arvore = ast.parse(codigo, mode="exec")
    for no in ast.walk(arvore):
        if isinstance(no, (ast.Import, ast.ImportFrom, ast.Global, ast.Nonlocal, ast.With, ast.AsyncWith, ast.Delete)):
            raise ValueError(f"Construcao proibida: {type(no).__name__}")
        if isinstance(no, ast.Name) and (no.id in NOMES_PROIBIDOS or no.id.startswith("__")):
            raise ValueError(f"Nome proibido: {no.id}")
        if isinstance(no, ast.Attribute) and (no.attr.startswith("_") or no.attr in NOMES_PROIBIDOS):
            raise ValueError(f"Atributo proibido: {no.attr}")
    return compile(arvore, "<analise>", "exec")


def serializar(v):
    if isinstance(v, pd.DataFrame):
        d = v.reset_index() if not isinstance(v.index, pd.RangeIndex) else v
        d = d.head(MAX_LINHAS_SAIDA)
        return "tabela", json.loads(d.to_json(orient="records", date_format="iso", force_ascii=False))
    if isinstance(v, pd.Series):
        nome = v.name or "valor"
        d = v.head(MAX_LINHAS_SAIDA).reset_index()
        d.columns = [str(c) if str(c) != "0" else str(nome) for c in d.columns]
        return "tabela", json.loads(d.to_json(orient="records", date_format="iso", force_ascii=False))
    if isinstance(v, (list, tuple)):
        if v and all(isinstance(x, dict) for x in v):
            return "tabela", json.loads(json.dumps(list(v)[:MAX_LINHAS_SAIDA], default=str, ensure_ascii=False))
        return "lista", json.loads(json.dumps(list(v)[:MAX_LINHAS_SAIDA], default=str, ensure_ascii=False))
    if isinstance(v, dict):
        return "objeto", json.loads(json.dumps(v, default=str, ensure_ascii=False))
    if isinstance(v, (np.integer,)):
        return "valor", int(v)
    if isinstance(v, (np.floating, float)):
        return "valor", None if math.isnan(float(v)) else float(v)
    if isinstance(v, (pd.Timestamp, _dt.date)):
        return "valor", v.strftime("%d/%m/%Y")
    return "valor", json.loads(json.dumps(v, default=str, ensure_ascii=False))


def _timeout(*_):
    raise TimeoutError(f"Analise excedeu {TIMEOUT_S}s")


def main():
    entrada = json.loads(sys.stdin.read() or "{}")
    codigo = str(entrada.get("codigo") or "")
    modo = entrada.get("modo") or "executar"
    df, mapa = montar_df(entrada.get("dados") or [])

    if modo == "perfil":
        perfil = []
        for c in df.columns:
            s = df[c]
            info = {"coluna": c, "origem": mapa.get(c, "coluna"), "preenchidos": int(s.notna().sum() - (s.astype(str).str.strip() == "").sum())}
            if pd.api.types.is_numeric_dtype(s):
                info.update({"tipo": "numero", "min": None if s.dropna().empty else float(s.min()), "max": None if s.dropna().empty else float(s.max())})
            else:
                vals = s.dropna().astype(str).str.strip()
                vals = vals[vals != ""]
                info.update({"tipo": "texto", "distintos": int(vals.nunique()), "exemplos": vals.value_counts().head(8).index.tolist()})
            perfil.append(info)
        print(json.dumps({"ok": True, "linhas": len(df), "perfil": perfil}, ensure_ascii=False, default=str))
        return

    ambiente = {
        "__builtins__": {
            n: __builtins__[n] if isinstance(__builtins__, dict) else getattr(__builtins__, n)
            for n in ["len", "sum", "min", "max", "abs", "round", "sorted", "range", "enumerate", "zip",
                      "list", "dict", "set", "tuple", "str", "int", "float", "bool", "any", "all",
                      "map", "filter", "isinstance", "print", "reversed", "Exception", "ValueError", "KeyError"]
        },
        "pd": pd, "np": np, "df": df.copy(), "re": re, "math": math,
        "numero_br": numero_br, "data_br": data_br, "contem": contem, "sem_acento": sem_acento,
        "HOJE": pd.Timestamp(_dt.date.today()),
    }
    signal.signal(signal.SIGALRM, _timeout)
    signal.alarm(TIMEOUT_S)
    try:
        exec(validar_codigo(codigo), ambiente)
    finally:
        signal.alarm(0)
    if "resultado" not in ambiente:
        raise ValueError("O codigo precisa atribuir a variavel `resultado`.")
    tipo, valor = serializar(ambiente["resultado"])
    print(json.dumps({"ok": True, "tipo": tipo, "resultado": valor}, ensure_ascii=False, default=str))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # erro real volta para o self-debugging no Node
        print(json.dumps({"ok": False, "erro": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
