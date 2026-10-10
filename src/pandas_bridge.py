"""Persistent Python worker. Cache and query snapshots stay in memory."""
import json
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from decimal import Decimal
import pandas as pd
from pandas_motor import Plan, prepare, profile, execute

BASE={
    'columns':{'valor_total':{'type':'money'},'valor_executado':{'type':'money'},
        'id_registro':{'type':'text'},'aba':{'type':'text'},'tipo_registro':{'type':'text'},
        'objeto':{'type':'text'},'rua':{'type':'text'},'bairro':{'type':'text'},
        'status':{'type':'text'},'engenheiro':{'type':'text'},'empresa':{'type':'text'}},
    'business_rules':[]
}
CACHE={}
SNAPSHOTS={}


def build(records_in):
    if not isinstance(records_in,list) or not records_in:
        raise ValueError('Snapshot vazio ou inválido.')
    path=Path(__file__).with_name('pandas-config.json')
    override=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    config=BASE | override
    config['columns']=BASE['columns'] | override.get('columns',{})
    records=[]
    warnings=[]
    for record in records_in:
        r={k:v for k,v in record.items() if k not in ('dados_originais','valor_total_centavos','valor_total_formatado','valor_executado_centavos')}
        for k,v in record.get('dados_originais',{}).items():
            name='original:'+k
            r[name]=v
            if isinstance(v,(int,float)) and not isinstance(v,bool) and name not in config['columns']:
                config['columns'][name]={'type':'number'}
        for label in ('valor_total','valor_executado'):
            cents=record.get(label+'_centavos')
            r[label]=None if cents is None else Decimal(cents)/Decimal(100)
            if record.get(label+'_invalido'):
                warnings.append(f'Há {label.replace("_"," ")} inválido; análise financeira pode ficar parcial.')
        records.append(r)
    df,issues=prepare(pd.DataFrame(records),config)
    warnings=list(dict.fromkeys(warnings+issues))
    metadata={'columns':profile(df,config),'rows':len(df),'warnings':warnings,
              'business_rules':config.get('business_rules',[])}
    return df,config,metadata


def run(payload):
    action=payload.get('acao')
    namespace=str(payload.get('cache_key','default'))
    if action=='carregar':
        # Build fully before replacing a good snapshot. Existing leases keep their version.
        df,config,metadata=build(payload.get('dados'))
        version=uuid.uuid4().hex
        CACHE[namespace]={'df':df,'config':config,'metadata':metadata,'created':time.monotonic(),
                          'loaded_at':datetime.now(timezone.utc).isoformat(),'version':version}
        if len(CACHE)>64:
            oldest=min((k for k in CACHE if k!=namespace),key=lambda k:CACHE[k]['created'])
            del CACHE[oldest]
        return {'status':'loaded','version':version,'rows':len(df)}
    if action=='invalidar':
        CACHE.pop(namespace,None)
        return {'status':'invalidated'}
    if action=='estrutura':
        entry=CACHE.get(namespace)
        ttl=max(1,min(float(payload.get('cache_seconds',60)),86400))
        if entry is None or time.monotonic()-entry['created']>=ttl:
            return {'status':'precisa_dados'}
        if len(SNAPSHOTS)>=128:
            raise ValueError('Muitas análises simultâneas; tente novamente.')
        token=uuid.uuid4().hex
        # A lease pins the exact frame/config for all planning and validation rounds.
        SNAPSHOTS[token]=entry
        return {'status':'ok',**entry['metadata'],'snapshot_id':token,'version':entry['version'],
                'loaded_at':entry['loaded_at'],'cache_age_seconds':round(time.monotonic()-entry['created'],3)}
    if action=='liberar':
        SNAPSHOTS.pop(payload.get('snapshot_id'),None)
        return {'status':'released'}
    if action=='executar':
        entry=SNAPSHOTS.get(payload.get('snapshot_id'))
        if entry is None:
            raise ValueError('Snapshot expirou ou processo reiniciou. Refaça a pergunta.')
        result=execute(entry['df'],entry['config'],Plan.model_validate(payload['plano']))
        result['warnings']=list(dict.fromkeys(result.get('warnings',[])+entry['metadata']['warnings']))
        result['version']=entry['version']
        result['loaded_at']=entry['loaded_at']
        return result
    raise ValueError('Ação inválida.')


if __name__=='__main__':
    for line in sys.stdin:
        request_id=None
        try:
            payload=json.loads(line)
            request_id=payload.pop('request_id',None)
            result=run(payload)
            output={'request_id':request_id,'result':result}
            encoded=json.dumps(output,ensure_ascii=False,allow_nan=False)
        except Exception as e:
            encoded=json.dumps({'request_id':request_id,'error':str(e)[:600]},ensure_ascii=False)
        print(encoded,flush=True)
