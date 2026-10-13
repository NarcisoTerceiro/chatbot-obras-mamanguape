"""Execução restrita de análises sobre registros JSON; sem I/O no código recebido."""
import ast
import datetime
import decimal
import json
import sys
import unicodedata

MAX_INPUT = 16 * 1024 * 1024
MAX_ROWS = 10000
MAX_OUTPUT = 256 * 1024

try:
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (4, 4))
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
except ImportError:
    pass  # Windows: o processo pai ainda impõe prazo e limites de entrada/saída.

ALLOWED_ATTRIBUTES = {
    "get", "items", "keys", "values", "setdefault", "copy", "pop",
    "append", "extend", "sort", "index", "count", "remove",
    "strip", "lstrip", "rstrip", "lower", "upper", "casefold", "split",
    "replace", "startswith", "endswith", "join", "capitalize", "title",
    "isoformat", "days", "year", "month", "day", "quantize", "is_finite",
}
FORBIDDEN_NODES = (
    ast.Import, ast.ImportFrom, ast.ClassDef, ast.With, ast.AsyncWith,
    ast.AsyncFunctionDef, ast.Await, ast.Global, ast.Nonlocal,
    ast.Delete, ast.Try, ast.Raise, ast.Yield, ast.YieldFrom,
)

def normalizar(value):
    value = unicodedata.normalize("NFD", str(value or ""))
    return " ".join("".join(c for c in value if not unicodedata.combining(c)).lower().split())

def dinheiro(value):
    if value is None or str(value).strip() == "":
        return None
    text = str(value).strip().replace("R$", "").replace(" ", "")
    if "," in text:
        text = text.replace(".", "").replace(",", ".")
    result = decimal.Decimal(text)
    if not result.is_finite():
        raise ValueError("Valor monetário não finito")
    return result

def data(value):
    if value is None or str(value).strip() == "":
        return None
    for pattern in ("%d/%m/%Y", "%Y-%m-%d", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.datetime.strptime(str(value)[:19], pattern).date()
        except ValueError:
            pass
    raise ValueError("Data não reconhecida")

def intervalo(*args):
    r = range(*args)
    if len(r) > 100000:
        raise ValueError("Intervalo excede o limite da análise")
    return r

def validar_codigo(code):
    if not isinstance(code, str) or len(code) > 20000:
        raise ValueError("Código ausente ou muito extenso")
    tree = ast.parse(code, mode="exec")
    if len(list(ast.walk(tree))) > 4000:
        raise ValueError("Análise muito extensa")
    for node in ast.walk(tree):
        if isinstance(node, FORBIDDEN_NODES):
            raise ValueError("Recurso indisponível na análise restrita: " + type(node).__name__)
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise ValueError("Acesso a nomes internos bloqueado")
        if isinstance(node, ast.arg) and node.arg.startswith("_"):
            raise ValueError("Argumento interno bloqueado")
        if isinstance(node, ast.Attribute) and node.attr not in ALLOWED_ATTRIBUTES:
            raise ValueError("Método não disponível: " + node.attr)
        if isinstance(node, ast.Constant) and isinstance(node.value, (str, bytes)) and len(node.value) > 20000:
            raise ValueError("Constante muito extensa")
    return tree

def converter(value, depth=0):
    if depth > 12:
        raise ValueError("Resultado muito aninhado")
    if isinstance(value, decimal.Decimal):
        if not value.is_finite():
            raise ValueError("Resultado numérico inválido")
        return str(value)
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.isoformat()
    if value is None or isinstance(value, (bool, int, float, str)):
        if isinstance(value, str) and len(value) > 4000:
            raise ValueError("Texto de resultado muito extenso")
        return value
    if isinstance(value, (list, tuple)):
        if len(value) > 200:
            raise ValueError("Retorne até 200 resultados ou agregue antes de responder")
        return [converter(v, depth + 1) for v in value]
    if isinstance(value, dict):
        if len(value) > 200:
            raise ValueError("Resultado com chaves demais")
        return {str(k): converter(v, depth + 1) for k, v in value.items()}
    raise ValueError("Retorne resultado como dicionário, lista ou valor simples")

def main():
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ValueError("Dados excedem o limite da análise")
    request = json.loads(raw)
    rows = request.get("dados")
    if not isinstance(rows, list) or len(rows) > MAX_ROWS or any(not isinstance(r, dict) for r in rows):
        raise ValueError("Conjunto de dados inválido")
    tree = validar_codigo(request.get("codigo"))
    safe_builtins = {
        "len": len, "sum": sum, "min": min, "max": max, "sorted": sorted,
        "list": list, "dict": dict, "set": set, "tuple": tuple,
        "str": str, "int": int, "float": float, "bool": bool,
        "round": round, "abs": abs, "any": any, "all": all,
        "enumerate": enumerate, "zip": zip, "range": intervalo,
    }
    scope = {"__builtins__": safe_builtins, "dados": rows,
             "Decimal": decimal.Decimal, "dinheiro": dinheiro,
             "data": data, "normalizar": normalizar}
    exec(compile(tree, "<analise>", "exec"), scope, scope)
    if "resultado" not in scope:
        raise ValueError("Atribua a resposta calculada à variável resultado")
    response = {"ok": True, "resultado": converter(scope["resultado"])}
    output = json.dumps(response, ensure_ascii=False, allow_nan=False)
    if len(output.encode("utf-8")) > MAX_OUTPUT:
        raise ValueError("Resultado excede o limite de transporte")
    print(output)

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "erro": type(error).__name__ + ": " + str(error)}, ensure_ascii=False))
        sys.exit(1)
