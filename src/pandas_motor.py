"""Pandas executor: validated plans, no eval/exec, no arbitrary generated code."""
import json
import re
import unicodedata
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Literal
import pandas as pd
from pydantic import BaseModel, ConfigDict, Field


def norm(value):
    text = ''.join(c for c in unicodedata.normalize('NFKD', str(value)) if not unicodedata.combining(c))
    return re.sub(r'\s+', ' ', text).strip().casefold()


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Filter(Strict):
    column: str
    op: Literal['eq', 'ne', 'contains', 'in', 'gt', 'ge', 'lt', 'le', 'is_null', 'not_null']
    value: str | float | bool | list[str] | None = None


class Metric(Strict):
    name: str = Field(pattern=r'^[a-zA-Z_][a-zA-Z0-9_]{0,50}$')
    op: Literal['rows', 'count', 'nunique', 'sum', 'mean', 'min', 'max']
    column: str | None = None


class Derived(Strict):
    name: str = Field(pattern=r'^[a-zA-Z_][a-zA-Z0-9_]{0,50}$')
    op: Literal['subtract', 'add', 'ratio', 'days_between']
    left: str
    right: str  # dates can use @today


class Sort(Strict):
    column: str
    descending: bool = False


class Plan(Strict):
    clarification: str | None = None
    filters: list[Filter] = Field(default_factory=list, max_length=30)
    any_filters: list[Filter] = Field(default_factory=list, max_length=30)
    derived: list[Derived] = Field(default_factory=list, max_length=10)
    group_by: list[str] = Field(default_factory=list, max_length=5)
    metrics: list[Metric] = Field(default_factory=list, max_length=10)
    select: list[str] = Field(default_factory=list, max_length=20)
    sort: list[Sort] = Field(default_factory=list, max_length=5)
    limit: int = Field(default=50, ge=1, le=200)
    offset: int = Field(default=0, ge=0, le=1000000)


def number(value, locale):
    if pd.isna(value) or str(value).strip() == '':
        return None
    if isinstance(value, (int, float, Decimal)) and not isinstance(value, bool):
        return Decimal(str(value))
    raw = str(value).strip().replace('R$', '').replace('%', '').replace(' ', '')
    if locale == 'pt_BR':
        pattern = r'[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?'
        raw_number = raw.replace('.', '').replace(',', '.')
    else:
        pattern = r'[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?'
        raw_number = raw.replace(',', '')
    if not re.fullmatch(pattern, raw):
        raise ValueError(f'Número inválido para {locale}: {value!r}')
    result = Decimal(raw_number)
    if not result.is_finite():
        raise ValueError('Número não finito')
    return result


def prepare(raw, config):
    df = raw.copy().replace(r'^\s*$', None, regex=True)
    df.columns = [str(c).strip() for c in df.columns]
    if df.columns.duplicated().any():
        raise ValueError('Cabeçalhos duplicados: corrija a planilha.')
    df = df.rename(columns=config.get('rename', {}))
    if df.columns.duplicated().any():
        raise ValueError('Mapeamento de colunas duplicado.')
    warnings = []
    for col, spec in config.get('columns', {}).items():
        if col not in df:
            continue
        kind = spec['type']
        if kind in ('money', 'number', 'percent'):
            converted = []
            for value in df[col]:
                v = number(value, spec.get('locale', 'en_US'))
                multiplier = Decimal(str(spec.get('multiplier', 1)))
                converted.append(None if v is None else v * multiplier)
            df[col] = pd.Series(converted, index=df.index, dtype=object)
            if kind == 'percent' and any(v is not None and abs(v) > 100 for v in converted):
                warnings.append(f'{col}: percentual fora de 0–100; confira a escala na fonte.')
        elif kind == 'date':
            fmt = spec.get('format', '%d/%m/%Y')
            converted = pd.to_datetime(df[col], format=fmt, errors='coerce')
            if (df[col].notna() & converted.isna()).any():
                raise ValueError(f'{col}: data inválida; formato esperado {fmt}.')
            df[col] = converted
        elif kind == 'bool':
            mapping = {'true': True, 'false': False, 'sim': True, 'nao': False, '1': True, '0': False}
            def boolean(v):
                if pd.isna(v): return None
                if norm(v) not in mapping: raise ValueError(f'{col}: booleano inválido {v!r}')
                return mapping[norm(v)]
            df[col] = df[col].map(boolean)
        elif kind != 'text':
            raise ValueError(f'Tipo desconhecido em {col}')
    if df.duplicated().any():
        warnings.append('Há linhas duplicadas; contagem usa registros, sem excluir duplicatas automaticamente.')
    return df, warnings


def profile(df, config):
    out = {}
    for c in df:
        s = df[c]
        samples = [str(v)[:140] for v in s.dropna().unique()[:8]]
        out[c] = {'type': config.get('columns', {}).get(c, {}).get('type', 'text'),
                  'missing': int(s.isna().sum()), 'distinct': int(s.nunique()), 'examples': samples,
                  'examples_complete': s.nunique() <= 8}
    return out


def execute(df, config, plan):
    if plan.clarification:
        return {'status': 'clarification', 'resposta': plan.clarification, 'plan': plan.model_dump()}
    work = df.copy()
    types = {c: config.get('columns', {}).get(c, {}).get('type', 'text') for c in df}
    def column(c):
        if c not in work: raise ValueError(f'Coluna inexistente: {c}')
    def numeric(c):
        column(c)
        if types[c] not in ('money', 'number', 'percent'): raise ValueError(f'{c}: configure o tipo numérico antes de calcular.')
    for d in plan.derived:
        if d.name in work: raise ValueError('Nome derivado sobrescreve coluna existente.')
        column(d.left)
        if d.right != '@today': column(d.right)
        if d.op == 'days_between':
            if types[d.left] != 'date' or (d.right != '@today' and types[d.right] != 'date'):
                raise ValueError('Diferença em dias exige datas configuradas.')
            right = pd.Timestamp(datetime.now(timezone.utc).date()) if d.right == '@today' else work[d.right]
            work[d.name] = (right - work[d.left]).dt.days.map(lambda v: None if pd.isna(v) else Decimal(str(v)))
        else:
            numeric(d.left); numeric(d.right)
            def calc(a, b):
                if pd.isna(a) or pd.isna(b): return None
                if d.op == 'add': return a + b
                if d.op == 'subtract': return a - b
                return None if b == 0 else a / b
            work[d.name] = [calc(a,b) for a,b in zip(work[d.left],work[d.right])]
        types[d.name] = 'number'
    def mask(f):
        column(f.column)
        s = work[f.column]
        if f.op == 'is_null': return s.isna()
        if f.op == 'not_null': return s.notna()
        if f.value is None: raise ValueError('Filtro precisa de valor.')
        kind = types[f.column]
        if f.op in ('contains', 'in'):
            if f.op == 'in':
                if not isinstance(f.value, list): raise ValueError('in exige lista de textos.')
                return s.map(lambda v: False if pd.isna(v) else norm(v) in [norm(x) for x in f.value])
            if kind != 'text': raise ValueError('contains exige texto.')
            return s.map(lambda v: False if pd.isna(v) else norm(f.value) in norm(v))
        if kind == 'text':
            if f.op not in ('eq','ne'): raise ValueError('Ordenação numérica exige configurar tipo da coluna.')
            left = s.map(lambda v: None if pd.isna(v) else norm(v)); right = norm(f.value)
        elif kind in ('money','number','percent'):
            left = s; right = number(f.value, 'en_US')
        elif kind == 'date':
            left = s; right = pd.to_datetime(f.value, format='%Y-%m-%d', errors='raise')
        else:
            if not isinstance(f.value, bool): raise ValueError('Filtro booleano exige true/false.')
            if f.op not in ('eq','ne'): raise ValueError('Booleano aceita apenas eq/ne.')
            left=s; right=f.value
        funcs = {'eq': lambda a,b:a==b,'ne':lambda a,b:a!=b,'gt':lambda a,b:a>b,'ge':lambda a,b:a>=b,'lt':lambda a,b:a<b,'le':lambda a,b:a<=b}
        return left.map(lambda v: False if pd.isna(v) else funcs[f.op](v,right))
    keep = pd.Series(True, index=work.index)
    for f in plan.filters: keep &= mask(f)
    if plan.any_filters:
        union = pd.Series(False,index=work.index)
        for f in plan.any_filters: union |= mask(f)
        keep &= union
    work = work.loc[keep]
    matched = len(work)
    used = set(plan.select + plan.group_by + [f.column for f in plan.filters + plan.any_filters] + [m.column for m in plan.metrics if m.column])
    for c in used: column(c)
    missing = {c: int(work[c].isna().sum()) for c in used if work[c].isna().any()}
    for m in plan.metrics:
        if m.op != 'rows' and not m.column: raise ValueError('Métrica exige coluna.')
        if m.op in ('sum','mean'): numeric(m.column)
    names = [m.name for m in plan.metrics]
    if len(names) != len(set(names)) or set(names) & set(plan.group_by): raise ValueError('Nomes de métricas duplicados.')
    def agg(frame,m):
        if m.op == 'rows': return len(frame)
        s=frame[m.column].dropna()
        if m.op == 'count': return len(s)
        if m.op == 'nunique': return s.nunique()
        if s.empty: return None
        if m.op == 'sum': return sum(s,Decimal(0))
        if m.op == 'mean': return sum(s,Decimal(0))/Decimal(len(s))
        return s.min() if m.op=='min' else s.max()
    if plan.metrics:
        if plan.select: raise ValueError('Use select apenas em listagens; métricas retornam seus próprios campos.')
        rows=[]
        if plan.group_by:
            for key,g in work.groupby(plan.group_by,dropna=False,sort=False):
                key=key if isinstance(key,tuple) else (key,)
                rows.append(dict(zip(plan.group_by,key)) | {m.name:agg(g,m) for m in plan.metrics})
        else: rows=[{m.name:agg(work,m) for m in plan.metrics}]
        result=pd.DataFrame(rows,columns=plan.group_by+names)
    else:
        if plan.group_by: raise ValueError('Agrupamento exige métricas.')
        result=work
    for order in reversed(plan.sort):
        if order.column not in result: raise ValueError(f'Ordenação inválida: {order.column}')
        result=result.sort_values(order.column,ascending=not order.descending,kind='stable',na_position='last')
    if plan.select: result=result[plan.select]
    total=len(result)
    result=result.iloc[plan.offset:plan.offset+plan.limit]
    def serial(v):
        if pd.isna(v): return None
        if isinstance(v,Decimal): return format(v,'f')
        if isinstance(v,pd.Timestamp): return v.isoformat()
        if hasattr(v,'item'): return v.item()
        return v
    records=[{c:serial(v) for c,v in row.items()} for row in result.to_dict('records')]
    messages=[]
    if not matched: messages.append('Nenhum registro corresponde aos filtros. Isso não confirma que a obra não exista fora desta fonte.')
    if missing: messages.append('Há dados ausentes; cálculos ignoram campos vazios e não os tratam como zero.')
    if total > plan.offset+plan.limit: messages.append('Resultado parcial: há mais linhas. Use offset para continuar.')
    text='Registros encontrados: '+str(matched)+'.\n'
    text+='\n'.join(' • '+'; '.join(f'{c}: {v if v is not None else "não informado"}' for c,v in row.items()) for row in records)
    text+='\n'+'\n'.join(messages)
    return {'status':'ok','resposta':text.strip(),'matched_rows':matched,'total_result_rows':total,
            'rows':records,'missing':missing,'warnings':messages,'plan':plan.model_dump()}
