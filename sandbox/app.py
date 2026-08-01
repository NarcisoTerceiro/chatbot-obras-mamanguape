# -*- coding: utf-8 -*-
"""
Sandbox de execucao de codigo - Chatbot de Obras de Mamanguape
================================================================
Microsservico ISOLADO cuja unica funcao e receber um trecho de codigo Python
(gerado pela IA) + os dados das obras, executar esse codigo de forma contida,
e devolver o resultado. NUNCA roda no mesmo processo do bot.

Camadas de seguranca (conforme o guia):
  1. Bloqueio de palavras-chave perigosas ANTES de executar.
  2. Builtins restritos - a IA nao acessa arquivo, rede nem exec/eval.
  3. Timeout curto (5s) - evita loop infinito travar o servico.
  4. Token compartilhado (SANDBOX_TOKEN) - so o bot pode chamar.
  5. (No deploy) container sem privilegio e, de preferencia, sem egress.

Contrato HTTP:
  POST /run   { "codigo": "<python>", "obras": [ {...}, ... ] }
      -> 200  { "ok": true,  "resultado": <valor> }
      -> 200  { "ok": false, "erro": "<motivo>" }
  GET  /health -> { "ok": true }
"""

import os
import json
import contextlib
from io import StringIO

from flask import Flask, request, jsonify

try:
    import pandas as pd  # noqa: F401  (fica disponivel para o codigo da IA)
except Exception:  # pandas e obrigatorio; se faltar, o servico avisa no health
    pd = None

app = Flask(__name__)

# Token compartilhado: o bot envia no cabecalho X-Sandbox-Token. Se estiver
# configurado aqui, so aceitamos requisicoes que tragam o mesmo valor.
SANDBOX_TOKEN = os.environ.get("SANDBOX_TOKEN", "")

# Tempo maximo de execucao do codigo, em segundos.
TIMEOUT_SEG = int(os.environ.get("SANDBOX_TIMEOUT", "5"))

# --------------------------------------------------------------------------
# 1) Bloqueio de palavras-chave perigosas
# --------------------------------------------------------------------------
# Se qualquer um destes trechos aparecer no codigo, recusamos ANTES de rodar.
PROIBIDOS = [
    "import", "__import__", "open(", "exec(", "eval(", "compile(",
    "os.", "sys.", "subprocess", "socket", "requests", "urllib",
    "shutil", "pathlib", "globals(", "locals(", "getattr(", "setattr(",
    "__builtins__", "__globals__", "__class__", "__subclasses__",
    "input(", "breakpoint(", "exit(", "quit(", "help(",
]


def contem_proibido(codigo: str):
    baixo = codigo.lower()
    for termo in PROIBIDOS:
        if termo.lower() in baixo:
            return termo
    return None


# --------------------------------------------------------------------------
# 2) Builtins restritos - so o essencial e seguro
# --------------------------------------------------------------------------
BUILTINS_SEGUROS = {
    "abs": abs, "min": min, "max": max, "sum": sum, "len": len,
    "round": round, "sorted": sorted, "range": range, "enumerate": enumerate,
    "zip": zip, "map": map, "filter": filter, "list": list, "dict": dict,
    "set": set, "tuple": tuple, "str": str, "int": int, "float": float,
    "bool": bool, "any": any, "all": all, "print": print,
}


# --------------------------------------------------------------------------
# 3) Timeout via processo separado. Roda o codigo num processo-filho e o
#    mata se passar do tempo. Funciona em qualquer thread (o signal.alarm
#    so funciona na thread principal, o que quebra sob gunicorn) e isola
#    ainda mais a execucao do codigo gerado pela IA.
# --------------------------------------------------------------------------
import multiprocessing


class TempoEsgotado(Exception):
    pass


def _worker(codigo, obras, fila):
    """Executado no processo-filho: roda o codigo e devolve (ok, valor)."""
    try:
        df = pd.DataFrame(obras)
        escopo = {
            "__builtins__": BUILTINS_SEGUROS,
            "df": df,
            "pd": pd,
            "resultado": None,
        }
        with contextlib.redirect_stdout(StringIO()):
            exec(codigo, escopo)  # noqa: S102 - exec controlado e isolado
        fila.put(("ok", _serializavel(escopo.get("resultado", None))))
    except Exception as e:  # erro no codigo gerado pela IA
        fila.put(("erro", f"{type(e).__name__}: {e}"))


def executar_codigo(codigo: str, obras: list):
    """Valida a seguranca e executa o codigo num processo isolado com timeout.
    Retorna (ok, valor_ou_erro)."""
    if pd is None:
        return False, "pandas nao disponivel no sandbox"

    termo = contem_proibido(codigo)
    if termo:
        return False, f"codigo rejeitado por seguranca (termo proibido: {termo})"

    fila = multiprocessing.Queue()
    proc = multiprocessing.Process(target=_worker, args=(codigo, obras, fila))
    proc.start()
    proc.join(TIMEOUT_SEG)

    if proc.is_alive():
        proc.terminate()
        proc.join()
        return False, f"tempo de execucao excedido ({TIMEOUT_SEG}s)"

    if fila.empty():
        return False, "execucao terminou sem resultado"

    status, valor = fila.get()
    if status == "ok":
        return True, valor
    return False, f"erro ao executar: {valor}"


def _serializavel(valor):
    """Converte o resultado para algo que vira JSON (trata objetos do pandas)."""
    try:
        import numpy as np
    except Exception:
        np = None

    if valor is None:
        return None
    # tipos do pandas/numpy -> tipos Python simples
    if pd is not None and isinstance(valor, (pd.Series,)):
        return valor.to_dict()
    if pd is not None and isinstance(valor, (pd.DataFrame,)):
        return valor.to_dict(orient="records")
    if np is not None and isinstance(valor, (np.integer,)):
        return int(valor)
    if np is not None and isinstance(valor, (np.floating,)):
        return float(valor)
    # ja e serializavel?
    try:
        json.dumps(valor)
        return valor
    except (TypeError, ValueError):
        return str(valor)


# --------------------------------------------------------------------------
# Rotas HTTP
# --------------------------------------------------------------------------
@app.get("/health")
def health():
    return jsonify({"ok": True, "pandas": pd is not None})


@app.post("/run")
def run():
    # Autenticacao simples por token compartilhado.
    if SANDBOX_TOKEN:
        enviado = request.headers.get("X-Sandbox-Token", "")
        if enviado != SANDBOX_TOKEN:
            return jsonify({"ok": False, "erro": "nao autorizado"}), 401

    dados = request.get_json(silent=True) or {}
    codigo = dados.get("codigo", "")
    obras = dados.get("obras", [])

    if not isinstance(codigo, str) or not codigo.strip():
        return jsonify({"ok": False, "erro": "codigo vazio"}), 400
    if not isinstance(obras, list):
        return jsonify({"ok": False, "erro": "obras deve ser uma lista"}), 400
    # Limite de tamanho, evita abuso de memoria.
    if len(obras) > 500:
        obras = obras[:500]

    ok, valor = executar_codigo(codigo, obras)
    if ok:
        return jsonify({"ok": True, "resultado": valor})
    return jsonify({"ok": False, "erro": valor})


if __name__ == "__main__":
    porta = int(os.environ.get("PORT", "8000"))
    app.run(host="0.0.0.0", port=porta)
